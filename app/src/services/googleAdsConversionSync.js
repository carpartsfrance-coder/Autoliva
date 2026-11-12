'use strict';

/**
 * Synchronisation des conversions hors-ligne vers Google Ads.
 *
 * Remonte, à partir du clic pub (gclid / gbraid / wbraid) déjà capté :
 *   - LEAD  : demande de devis (landings moteurs / boîtes / ponts)
 *   - DEVIS : devis envoyé au client (étage qualité intermédiaire)
 *   - VENTE : lead passé « gagné » dans l'outil devis — marge du devis
 *   - ACHAT : commande payée sur le site après un clic pub — MARGE de la
 *             commande (margeCommande.js), et non plus le prix TTC
 *   - VENTE APRÈS DEMANDE DE DEVIS : commande sans clic pub propre (souvent
 *             saisie au téléphone) d'un client qui avait fait une demande de
 *             devis après un clic pub — marge, action « Vente devis »
 *   - CORRECTIONS : remboursement, annulation, prix d'achat saisi après coup →
 *             la valeur envoyée est corrigée chez Google (même identifiant de
 *             transaction = le n° de commande)
 *
 * Idempotent : des marques sur le lead (`googleAdsUpload.*`) et sur la
 * commande (`googleAdsConversion`) empêchent tout double envoi ; Google
 * déduplique en plus sur l'identifiant de transaction. Tourne en différé
 * (cron horaire :40) ; fenêtre du clic ~90 jours.
 *
 * Sûr : si Google Ads n'est pas configuré, renvoie immédiatement (no-op).
 */

const AbandonedCart = require('../models/AbandonedCart');
const Order = require('../models/Order');
const User = require('../models/User');
const gAds = require('./googleAdsConversions');
const { margeCommande, tauxMargeParDefaut, CHAMPS_MARGE } = require('./margeCommande');
const { normalizePhone } = require('./enhancedConversionData');

const LEAD_WINDOW_DAYS = 80;            // marge sous la fenêtre gclid de 90 j
const LEAD_SOURCES = ['landing_moteurs', 'landing_boites', 'landing_ponts'];
const SALE_STATUSES = ['won', 'acompte_recu'];
// Un devis a été envoyé : statut courant OU trace d'envoi dans l'historique
// (les statuts avals 'acompte_recu'/'won' impliquent que le lead a été qualifié).
const QUOTE_SENT_STATUSES = ['quote_sent', 'acompte_recu', 'won'];
// Commandes considérées payées (aligné sur visitorTimeline.PAID_ORDER_STATUSES).
const PAID_ORDER_STATUSES = ['paid', 'processing', 'label_created', 'shipped', 'delivered', 'completed'];
// Ventes à envoyer : payées, ou remboursées en partie (la marge en tient compte).
const STATUTS_ENCAISSES = [...PAID_ORDER_STATUSES, 'partially_refunded'];
// Corrections de valeur : au-delà, Google n'en tient plus compte pour les enchères.
const CORRECTION_WINDOW_DAYS = 85;

function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }
function leadValue() {
  const v = Number(process.env.GOOGLE_ADS_LEAD_VALUE);
  return isFinite(v) && v > 0 ? v : 0;   // 0 par défaut → conversion "lead" sans valeur (volume)
}
function quoteValue() {
  const v = Number(process.env.GOOGLE_ADS_QUOTE_VALUE);
  return isFinite(v) && v > 0 ? v : 0;   // 0 par défaut → conversion "devis" sans valeur (signal qualité)
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
async function syncConversions({ dryRun = true, limit = 200, now = new Date() } = {}) {
  const report = {
    configured: gAds.isConfigured(),
    dryRun,
    leads: { eligible: 0, uploaded: 0, errors: 0 },
    quotes: { eligible: 0, uploaded: 0, errors: 0 },
    sales: { eligible: 0, uploaded: 0, errors: 0 },
    purchases: { eligible: 0, uploaded: 0, errors: 0 },
    ventesCommandes: { eligible: 0, uploaded: 0, errors: 0 },
    ajustements: { eligible: 0, uploaded: 0, errors: 0 },
    details: [],
  };
  if (!report.configured) { report.reason = 'not_configured'; return report; }

  const since = new Date(now.getTime() - LEAD_WINDOW_DAYS * 86400000);

  // ── LEADS : devis moteur avec click id Ads, jamais remontés, dans la fenêtre ──
  const leadCandidates = await AbandonedCart.find({
    captureSource: { $in: LEAD_SOURCES },
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

  // ── DEVIS ENVOYÉS : étage qualité intermédiaire (≈ dizaines/mois là où les
  // ventes se comptent en unités) — apprend au smart bidding à viser les leads
  // qui décrochent, pas juste ceux qui remplissent le formulaire.
  // ⚠️ HAS_CLICK_ID renvoie déjà un $or → $and obligatoire pour composer avec
  // le $or « trace d'envoi » (deux clés $or au même niveau s'écraseraient).
  const quoteCandidates = await AbandonedCart.find({
    captureSource: { $in: LEAD_SOURCES },
    $and: [
      HAS_CLICK_ID('attribution.'),
      { $or: [
        { 'engineQuote.sentQuotes.0': { $exists: true } },
        { 'engineQuote.status': { $in: QUOTE_SENT_STATUSES } },
      ] },
    ],
    'googleAdsUpload.quoteAt': { $in: [null, undefined] },
    createdAt: { $gte: since },
  }).select('_id attribution createdAt lastActivityAt email phone engineQuote.sentQuotes engineQuote.updatedAt').sort({ createdAt: 1 }).limit(limit).lean();

  report.quotes.eligible = quoteCandidates.length;
  for (const c of quoteCandidates) {
    const ids = clickIds(c.attribution);
    if (!hasAnyClickId(ids)) continue;
    // Horodatage = dernier envoi de devis (postérieur au clic), replis prudents.
    const sq = (c.engineQuote && Array.isArray(c.engineQuote.sentQuotes) && c.engineQuote.sentQuotes.length)
      ? c.engineQuote.sentQuotes[c.engineQuote.sentQuotes.length - 1] : null;
    const when = (sq && sq.sentAt) || (c.engineQuote && c.engineQuote.updatedAt) || c.lastActivityAt || new Date();
    try {
      const r = await gAds.uploadConversion({ ...ids, email: c.email, phone: c.phone, action: 'quote', value: quoteValue(), dateTime: when, dryRun });
      if (r.ok) {
        if (!dryRun) await AbandonedCart.updateOne({ _id: c._id }, { $set: { 'googleAdsUpload.quoteAt': new Date() } });
        report.quotes.uploaded += 1;
      } else if (r.skipped && r.reason === 'no_action_for_quote') {
        // GOOGLE_ADS_QUOTE_ACTION absent → étage devis en veille, sans bruit.
        report.quotes.eligible = 0;
        report.quotes.skipped = 'no_quote_action';
        break;
      } else {
        report.quotes.errors += 1;
        report.details.push({ id: String(c._id), type: 'quote', error: r.error || r.partialFailureError || r.reason });
      }
    } catch (e) {
      report.quotes.errors += 1;
      report.details.push({ id: String(c._id), type: 'quote', error: String((e && e.message) || e) });
    }
  }

  // Prix d'achat HT des fiches produits, pour la marge des commandes.
  const coutsProduits = new Map();
  async function chargerCouts(orders) {
    const ids = new Set();
    for (const o of orders) {
      for (const it of (o.items || [])) {
        const id = it && it.productId ? String(it.productId) : '';
        if (id && !coutsProduits.has(id)) ids.add(id);
      }
    }
    if (!ids.size) return;
    const Product = require('../models/Product');
    const produits = await Product.find({ _id: { $in: [...ids] } }).select('_id costCents').lean();
    for (const id of ids) coutsProduits.set(id, null);
    for (const p of produits) {
      coutsProduits.set(String(p._id), Number.isFinite(p.costCents) ? p.costCents : null);
    }
  }
  const marge = (o) => margeCommande(o, { couts: coutsProduits });

  // ── VENTES : devis gagnés avec click id Ads, jamais remontés ──
  const saleCandidates = await AbandonedCart.find({
    captureSource: { $in: LEAD_SOURCES },
    'engineQuote.status': { $in: SALE_STATUSES },
    ...HAS_CLICK_ID('attribution.'),
    'googleAdsUpload.saleAt': { $in: [null, undefined] },
  }).select('_id attribution lastActivityAt engineQuote requested email phone').limit(limit).lean();

  // Valeur remontée = MARGE NETTE (achat + frais + contrôle + TVA sur marge
  // déduits), pas le prix de vente : le tROAS optimisera la vraie rentabilité.
  // Prix d'achat pas encore saisi : marge ESTIMÉE (taux par défaut × prix de
  // vente) — calcMargin rendrait alors le prix de vente entier comme « marge ».
  // Lazy require pour éviter tout cycle controller ↔ service.
  const { calcMargin, leadIsReconditionne } = require('../controllers/engineQuoteAdminController');

  report.sales.eligible = saleCandidates.length;
  for (const c of saleCandidates) {
    const ids = clickIds(c.attribution);
    if (!hasAnyClickId(ids)) continue;
    const eq = c.engineQuote || {};
    const pricing = eq.pricing || {};
    let value = null;
    if (num(pricing.purchasePrice) > 0) {
      try {
        // Devis à perte : 0, pas une estimation flatteuse.
        value = Math.max(0, num(calcMargin(pricing, leadIsReconditionne(eq, c)).marginEur));
      } catch (_) { value = null; /* marge incalculable → estimation */ }
    }
    if (value == null) value = Math.round(num(pricing.sellPrice) * tauxMargeParDefaut() * 100) / 100;
    const ref = String((c.requested && c.requested.ref) || c._id).trim();
    try {
      const r = await gAds.uploadConversion({
        ...ids, email: c.email, phone: c.phone, action: 'sale', value,
        dateTime: c.lastActivityAt || new Date(), dryRun, transactionId: `DEVIS-${ref}`,
      });
      if (r.ok) {
        if (!dryRun) {
          await AbandonedCart.updateOne({ _id: c._id }, { $set: { 'googleAdsUpload.saleAt': new Date(), 'googleAdsUpload.saleVia': 'devis' } });
        }
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
  // Valeur = MARGE (margeCommande.js), et non plus le prix TTC : TVA, port et
  // consigne n'étaient pas du bénéfice. N° de commande = identifiant de transaction :
  // la valeur pourra être corrigée (remboursement, prix d'achat saisi après).
  const purchaseCandidates = await Order.find({
    status: { $in: STATUTS_ENCAISSES },
    deletedAt: null,
    ...HAS_CLICK_ID('attribution.lastTouch.'),
    'attribution.uploadedToGoogleAdsAt': { $in: [null, undefined] },
    createdAt: { $gte: since },
  }).select(`_id number createdAt userId attribution.lastTouch shippingAddress.phone ${CHAMPS_MARGE}`).sort({ createdAt: 1 }).limit(limit).lean();
  await chargerCouts(purchaseCandidates);

  // Email client pour Enhanced Conversions : l'email vit sur le compte User
  // (Order.userId est requis, y compris pour les guests → compte fantôme).
  const emailByUser = new Map();
  const purchaseUserIds = [...new Set(purchaseCandidates.map((o) => String(o.userId || '')).filter(Boolean))];
  if (purchaseUserIds.length) {
    const users = await User.find({ _id: { $in: purchaseUserIds } }).select('email').lean();
    for (const u of users) emailByUser.set(String(u._id), String(u.email || ''));
  }

  report.purchases.eligible = purchaseCandidates.length;
  for (const o of purchaseCandidates) {
    const ids = clickIds(o.attribution && o.attribution.lastTouch);
    if (!hasAnyClickId(ids)) continue;
    const m = marge(o);
    const email = emailByUser.get(String(o.userId || '')) || '';
    const phone = String((o.shippingAddress && o.shippingAddress.phone) || '');
    try {
      const r = await gAds.uploadConversion({
        ...ids, email, phone, action: 'purchase', value: m.margeCents / 100,
        dateTime: o.createdAt, dryRun, transactionId: o.number,
      });
      if (r.ok) {
        if (!dryRun) {
          const maintenant = new Date();
          await Order.updateOne({ _id: o._id }, {
            $set: {
              'attribution.uploadedToGoogleAdsAt': maintenant,
              googleAdsConversion: {
                action: 'purchase', transactionId: o.number, conversionAt: o.createdAt, uploadedAt: maintenant,
                valueCents: m.margeCents, estimated: m.estimee, clickIds: ids, leadId: null, restatedAt: null, final: false,
              },
            },
          });
        }
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

  // ── VENTES APRÈS DEMANDE DE DEVIS : la commande (souvent par téléphone)
  // d'un client venu par un clic pub et une demande de devis ──
  //
  // Diagnostic du 08/11/2026 : 187 demandes de devis en 30 jours, presque
  // toutes via Google Ads ; 186 jamais chiffrées dans l'outil devis, aucune
  // vente remontée à Google. Les ventes se concluent au téléphone et la
  // commande est saisie à la main, sans lien avec la demande : pour Google, les
  // campagnes Ponts / Boîtes de transfert ne produisaient que des formulaires
  // à 1 €. Ici, une commande sans clic pub propre est rattachée à la demande du
  // même client — n° de dossier saisi dans la commande (AUT-…), sinon même
  // téléphone ou même e-mail — faite AVANT la commande, dans la fenêtre de
  // Google. La vente part avec la marge et le clic de la demande ; rien d'autre
  // sur le client (le clic suffit, pas de données personnelles en plus).
  const fenetreMs = LEAD_WINDOW_DAYS * 86400000;
  const leadsPool = await AbandonedCart.find({
    $and: [
      HAS_CLICK_ID('attribution.'),
      { $or: [{ email: { $nin: ['', null] } }, { phone: { $nin: ['', null] } }, { 'requested.ref': { $nin: ['', null] } }] },
    ],
    createdAt: { $gte: new Date(now.getTime() - 2 * fenetreMs) },
  }).select('_id email phone requested.ref attribution createdAt googleAdsUpload engineQuote.status').lean();

  const parTel = new Map();
  const parEmail = new Map();
  const parRef = new Map();
  const ajouter = (map, cle, lead) => {
    if (!cle) return;
    if (!map.has(cle)) map.set(cle, []);
    map.get(cle).push(lead);
  };
  for (const l of leadsPool) {
    const up = l.googleAdsUpload || {};
    // Lead « gagné » dans l'outil devis : sa vente part par la partie VENTES
    // ci-dessus (avec la marge du devis) — même si cet envoi a échoué ou n'a
    // pas encore eu lieu. Ne pas la compter une 2e fois via une commande.
    if (l.engineQuote && SALE_STATUSES.includes(l.engineQuote.status)) continue;
    if (up.saleAt && up.saleVia !== 'commande') continue;
    if (!hasAnyClickId(clickIds(l.attribution))) continue;
    ajouter(parTel, normalizePhone(String(l.phone || '')), l);
    ajouter(parEmail, normaliserEmail(l.email), l);
    ajouter(parRef, normaliserRef(l.requested && l.requested.ref), l);
  }

  if (parTel.size || parEmail.size || parRef.size) {
    const commandes = await Order.find({
      status: { $in: STATUTS_ENCAISSES },
      deletedAt: null,
      createdAt: { $gte: since },
      'attribution.uploadedToGoogleAdsAt': { $in: [null, undefined] },
      'googleAdsConversion.uploadedAt': { $in: [null, undefined] },
      // Clic pub propre → partie « achats » ci-dessus.
      'attribution.lastTouch.gclid': { $in: ['', null] },
      'attribution.lastTouch.gbraid': { $in: ['', null] },
      'attribution.lastTouch.wbraid': { $in: ['', null] },
    }).select(`_id number createdAt userId quoteReference shippingAddress.phone billingAddress.phone ${CHAMPS_MARGE}`).sort({ createdAt: 1 }).lean();

    const usersVentes = new Map();
    const idsUsers = [...new Set(commandes.map((o) => String(o.userId || '')).filter(Boolean))];
    if (idsUsers.length) {
      const users = await User.find({ _id: { $in: idsUsers } }).select('email phone').lean();
      for (const u of users) usersVentes.set(String(u._id), u);
    }

    const aEnvoyer = [];
    for (const o of commandes) {
      const u = usersVentes.get(String(o.userId || '')) || {};
      const quand = new Date(o.createdAt).getTime();
      const dansLaFenetre = (l) => {
        const t = new Date(l.createdAt).getTime();
        return t <= quand && quand - t <= fenetreMs;
      };
      const parReference = (parRef.get(normaliserRef(o.quoteReference)) || []).filter(dansLaFenetre);
      const parContact = [
        ...[o.shippingAddress && o.shippingAddress.phone, o.billingAddress && o.billingAddress.phone, u.phone]
          .flatMap((t) => parTel.get(normalizePhone(String(t || ''))) || []),
        ...(parEmail.get(normaliserEmail(u.email)) || []),
      ].filter(dansLaFenetre);
      // Le n° de dossier saisi sur la commande prime ; sinon la demande la plus récente.
      const lead = (parReference.length ? parReference : parContact)
        .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0];
      if (lead) aEnvoyer.push({ o, lead });
    }

    report.ventesCommandes.eligible = aEnvoyer.length;
    await chargerCouts(aEnvoyer.map((x) => x.o));
    for (const { o, lead } of aEnvoyer.slice(0, limit)) {
      const ids = clickIds(lead.attribution);
      const m = marge(o);
      try {
        const r = await gAds.uploadConversion({
          ...ids, action: 'sale', value: m.margeCents / 100,
          dateTime: o.createdAt, dryRun, transactionId: o.number,
        });
        if (r.ok) {
          if (!dryRun) {
            const maintenant = new Date();
            await Order.updateOne({ _id: o._id }, {
              $set: {
                googleAdsConversion: {
                  action: 'sale', transactionId: o.number, conversionAt: o.createdAt, uploadedAt: maintenant,
                  valueCents: m.margeCents, estimated: m.estimee, clickIds: ids, leadId: lead._id, restatedAt: null, final: false,
                },
              },
            });
            await AbandonedCart.updateOne({ _id: lead._id }, {
              $set: { 'googleAdsUpload.saleAt': maintenant, 'googleAdsUpload.saleVia': 'commande' },
              $addToSet: { 'googleAdsUpload.saleOrderIds': o._id },
            });
          }
          report.ventesCommandes.uploaded += 1;
        } else if (r.skipped && r.reason === 'no_action_for_sale') {
          report.ventesCommandes.skipped = 'no_sale_action';
          break;
        } else {
          report.ventesCommandes.errors += 1;
          report.details.push({ id: String(o._id), type: 'vente_commande', error: r.error || r.partialFailureError || r.reason });
        }
      } catch (e) {
        report.ventesCommandes.errors += 1;
        report.details.push({ id: String(o._id), type: 'vente_commande', error: String((e && e.message) || e) });
      }
    }
  }

  // ── CORRECTIONS : la valeur déjà envoyée n'est plus la bonne ──
  // Remboursement (total → 0, partiel → marge réduite), annulation, prix
  // d'achat saisi après coup (marge estimée → marge exacte). Même identifiant
  // de transaction = Google corrige la conversion au lieu d'en créer une 2e.
  // Une valeur ramenée à 0 est définitive (Google ignore toute correction
  // suivante). Seulement les ventes envoyées avec un identifiant (depuis le
  // 08/11/2026) : sans lui, Google créerait une conversion de plus.
  const aCorriger = await Order.find({
    'googleAdsConversion.uploadedAt': { $ne: null },
    'googleAdsConversion.transactionId': { $nin: ['', null] },
    'googleAdsConversion.final': { $ne: true },
    'googleAdsConversion.conversionAt': { $gte: new Date(now.getTime() - CORRECTION_WINDOW_DAYS * 86400000) },
  }).select(`_id number googleAdsConversion ${CHAMPS_MARGE}`).lean();
  await chargerCouts(aCorriger);

  const corrections = [];
  for (const o of aCorriger) {
    const g = o.googleAdsConversion || {};
    const m = marge(o);
    const envoye = Number.isFinite(g.valueCents) ? g.valueCents : null;
    // 1 € d'écart minimum : pas d'aller-retour pour des arrondis.
    if (envoye != null && Math.abs(m.margeCents - envoye) < 100 && !(m.margeCents === 0 && envoye !== 0)) continue;
    corrections.push({ o, m });
  }
  report.ajustements.eligible = corrections.length;
  for (const { o, m } of corrections.slice(0, limit)) {
    const g = o.googleAdsConversion;
    const ids = clickIds(g.clickIds);
    if (!hasAnyClickId(ids)) continue;
    try {
      const r = await gAds.uploadConversion({
        ...ids, action: g.action, value: m.margeCents / 100, valeurExplicite: true,
        dateTime: g.conversionAt, dryRun, transactionId: g.transactionId,
      });
      if (r.ok) {
        if (!dryRun) {
          await Order.updateOne({ _id: o._id }, {
            $set: {
              'googleAdsConversion.valueCents': m.margeCents,
              'googleAdsConversion.estimated': m.estimee,
              'googleAdsConversion.restatedAt': new Date(),
              'googleAdsConversion.final': m.margeCents === 0,
            },
          });
        }
        report.ajustements.uploaded += 1;
      } else {
        report.ajustements.errors += 1;
        report.details.push({ id: String(o._id), type: 'ajustement', error: r.error || r.partialFailureError || r.reason });
      }
    } catch (e) {
      report.ajustements.errors += 1;
      report.details.push({ id: String(o._id), type: 'ajustement', error: String((e && e.message) || e) });
    }
  }

  return report;
}

function normaliserEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) ? e : '';
}

function normaliserRef(ref) {
  return String(ref || '').trim().toUpperCase();
}

module.exports = { syncConversions, STATUTS_ENCAISSES };
