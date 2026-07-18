'use strict';

/**
 * Synchronisation des conversions hors-ligne vers Google Ads.
 *
 * Parcourt les leads moteur (captureSource='landing_moteurs') porteurs d'un
 * `gclid` et remonte :
 *   - LEAD  : à la création du lead (demande de devis)  → action "Lead - Devis"
 *   - VENTE : quand le lead passe 'won'/'acompte_recu' → action "Vente moteur"
 *             avec la valeur réelle (engineQuote.pricing.sellPrice)
 *
 * Idempotent : un flag `googleAdsUpload.{leadAt,saleAt}` sur le lead empêche
 * tout double-envoi. Conçu pour tourner en différé (cron horaire) — l'import
 * hors-ligne n'a pas besoin d'être temps réel (fenêtre gclid ~90 j).
 *
 * Sûr : si Google Ads n'est pas configuré, renvoie immédiatement (no-op).
 */

const AbandonedCart = require('../models/AbandonedCart');
const Order = require('../models/Order');
const gAds = require('./googleAdsConversions');

const LEAD_WINDOW_DAYS = 80;            // marge sous la fenêtre gclid de 90 j
const SALE_STATUSES = ['won', 'acompte_recu'];
// Commandes considérées payées (aligné sur visitorTimeline.PAID_ORDER_STATUSES).
const PAID_ORDER_STATUSES = ['paid', 'processing', 'label_created', 'shipped', 'delivered', 'completed'];

function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }
function leadValue() {
  const v = Number(process.env.GOOGLE_ADS_LEAD_VALUE);
  return isFinite(v) && v > 0 ? v : 0;   // 0 par défaut → conversion "lead" sans valeur (volume)
}

/* Un clic Google Ads porte gclid (web) OU gbraid/wbraid (iOS14+) : une
   conversion est remontable dès qu'UN des trois est présent. */
const HAS_CLICK_ID = (prefix) => ({
  $or: [
    { [`${prefix}gclid`]: { $nin: ['', null] } },
    { [`${prefix}gbraid`]: { $nin: ['', null] } },
    { [`${prefix}wbraid`]: { $nin: ['', null] } },
  ],
});

function clickIds(att) {
  const a = att || {};
  return {
    gclid: String(a.gclid || '').trim(),
    gbraid: String(a.gbraid || '').trim(),
    wbraid: String(a.wbraid || '').trim(),
  };
}
function hasAnyClickId(ids) { return !!(ids.gclid || ids.gbraid || ids.wbraid); }

/**
 * @param {Object} opts
 * @param {boolean} [opts.dryRun=true]  true → validateOnly côté Google + aucune écriture du flag
 * @param {number}  [opts.limit=200]    plafond par type et par run
 * @returns rapport { configured, dryRun, leads:{eligible,uploaded,errors}, sales:{...}, details:[] }
 */
async function syncConversions({ dryRun = true, limit = 200 } = {}) {
  const report = {
    configured: gAds.isConfigured(),
    dryRun,
    leads: { eligible: 0, uploaded: 0, errors: 0 },
    sales: { eligible: 0, uploaded: 0, errors: 0 },
    purchases: { eligible: 0, uploaded: 0, errors: 0 },
    details: [],
  };
  if (!report.configured) { report.reason = 'not_configured'; return report; }

  const since = new Date(Date.now() - LEAD_WINDOW_DAYS * 86400000);

  // ── LEADS : devis moteur avec click id Ads, jamais remontés, dans la fenêtre ──
  const leadCandidates = await AbandonedCart.find({
    captureSource: { $in: ['landing_moteurs', 'landing_boites', 'landing_ponts'] },
    ...HAS_CLICK_ID('attribution.'),
    'googleAdsUpload.leadAt': { $in: [null, undefined] },
    createdAt: { $gte: since },
  }).select('_id attribution createdAt email phone').sort({ createdAt: 1 }).limit(limit).lean();

  report.leads.eligible = leadCandidates.length;
  for (const c of leadCandidates) {
    const ids = clickIds(c.attribution);
    if (!hasAnyClickId(ids)) continue;
    try {
      const r = await gAds.uploadConversion({ ...ids, email: c.email, phone: c.phone, action: 'lead', value: leadValue(), dateTime: c.createdAt, dryRun });
      if (r.ok) {
        if (!dryRun) await AbandonedCart.updateOne({ _id: c._id }, { $set: { 'googleAdsUpload.leadAt': new Date() } });
        report.leads.uploaded += 1;
      } else {
        report.leads.errors += 1;
        report.details.push({ id: String(c._id), type: 'lead', error: r.error || r.partialFailureError || r.reason });
      }
    } catch (e) {
      report.leads.errors += 1;
      report.details.push({ id: String(c._id), type: 'lead', error: String((e && e.message) || e) });
    }
  }

  // ── VENTES : devis gagnés avec click id Ads, jamais remontés ──
  const saleCandidates = await AbandonedCart.find({
    captureSource: { $in: ['landing_moteurs', 'landing_boites', 'landing_ponts'] },
    'engineQuote.status': { $in: SALE_STATUSES },
    ...HAS_CLICK_ID('attribution.'),
    'googleAdsUpload.saleAt': { $in: [null, undefined] },
  }).select('_id attribution lastActivityAt engineQuote requested email phone').limit(limit).lean();

  // Valeur remontée = MARGE NETTE (achat + frais + contrôle + TVA sur marge
  // déduits), pas le prix de vente : le tROAS optimisera la vraie rentabilité.
  // Repli si marge inconnue/négative : prix de vente (mieux qu'aucune valeur).
  // Lazy require pour éviter tout cycle controller ↔ service.
  const { calcMargin, leadIsReconditionne } = require('../controllers/engineQuoteAdminController');

  report.sales.eligible = saleCandidates.length;
  for (const c of saleCandidates) {
    const ids = clickIds(c.attribution);
    if (!hasAnyClickId(ids)) continue;
    const eq = c.engineQuote || {};
    let value = 0;
    try {
      const m = calcMargin(eq.pricing, leadIsReconditionne(eq, c));
      value = num(m && m.marginEur);
    } catch (_) { /* marge incalculable → repli prix */ }
    if (!(value > 0)) value = num(eq.pricing && eq.pricing.sellPrice);
    try {
      const r = await gAds.uploadConversion({ ...ids, email: c.email, phone: c.phone, action: 'sale', value, dateTime: c.lastActivityAt || new Date(), dryRun });
      if (r.ok) {
        if (!dryRun) await AbandonedCart.updateOne({ _id: c._id }, { $set: { 'googleAdsUpload.saleAt': new Date() } });
        report.sales.uploaded += 1;
      } else {
        report.sales.errors += 1;
        report.details.push({ id: String(c._id), type: 'sale', error: r.error || r.partialFailureError || r.reason });
      }
    } catch (e) {
      report.sales.errors += 1;
      report.details.push({ id: String(c._id), type: 'sale', error: String((e && e.message) || e) });
    }
  }

  // ── ACHATS SITE : commandes payées avec click id Ads, jamais remontées ──
  // Règle le « faux Achats » côté serveur : la VRAIE valeur (total TTC) part
  // via l'API avec le click id du dernier clic, indépendamment de GTM/du navigateur.
  const purchaseCandidates = await Order.find({
    status: { $in: PAID_ORDER_STATUSES },
    ...HAS_CLICK_ID('attribution.lastTouch.'),
    'attribution.uploadedToGoogleAdsAt': { $in: [null, undefined] },
    createdAt: { $gte: since },
  }).select('_id number totalCents createdAt userId attribution.lastTouch shippingAddress.phone').sort({ createdAt: 1 }).limit(limit).lean();

  // Email client pour Enhanced Conversions : l'email vit sur le compte User
  // (Order.userId est requis, y compris pour les guests → compte fantôme).
  const emailByUser = new Map();
  const purchaseUserIds = [...new Set(purchaseCandidates.map((o) => String(o.userId || '')).filter(Boolean))];
  if (purchaseUserIds.length) {
    const User = require('../models/User');
    const users = await User.find({ _id: { $in: purchaseUserIds } }).select('email').lean();
    for (const u of users) emailByUser.set(String(u._id), String(u.email || ''));
  }

  report.purchases.eligible = purchaseCandidates.length;
  for (const o of purchaseCandidates) {
    const ids = clickIds(o.attribution && o.attribution.lastTouch);
    if (!hasAnyClickId(ids)) continue;
    const value = num(o.totalCents) / 100;
    const email = emailByUser.get(String(o.userId || '')) || '';
    const phone = String((o.shippingAddress && o.shippingAddress.phone) || '');
    try {
      const r = await gAds.uploadConversion({ ...ids, email, phone, action: 'purchase', value, dateTime: o.createdAt, dryRun });
      if (r.ok) {
        if (!dryRun) await Order.updateOne({ _id: o._id }, { $set: { 'attribution.uploadedToGoogleAdsAt': new Date() } });
        report.purchases.uploaded += 1;
      } else if (r.skipped && r.reason === 'no_action_for_purchase') {
        // GOOGLE_ADS_PURCHASE_ACTION absent → partie achats en veille, sans bruit.
        report.purchases.eligible = 0;
        report.purchases.skipped = 'no_purchase_action';
        break;
      } else {
        report.purchases.errors += 1;
        report.details.push({ id: String(o._id), type: 'purchase', error: r.error || r.partialFailureError || r.reason });
      }
    } catch (e) {
      report.purchases.errors += 1;
      report.details.push({ id: String(o._id), type: 'purchase', error: String((e && e.message) || e) });
    }
  }

  return report;
}

module.exports = { syncConversions };
