'use strict';

/**
 * Diagnostic Google Ads (admin) — GET /admin/api/ads/diagnostic
 *
 * Vérifie toute la chaîne d'import de conversions hors-ligne SANS rien écrire :
 *   - configuration présente (env GOOGLE_ADS_*) — booléens seulement, jamais les valeurs
 *   - authentification réelle (OAuth refresh → access token)
 *   - dry-run du sync (validateOnly côté Google : compte les éligibles, valide
 *     le format des conversions, n'enregistre RIEN et ne pose aucun flag)
 *
 * Sert à valider le déploiement immédiatement au lieu d'attendre le cron :40.
 */

const gAds = require('../services/googleAdsConversions');
const { syncConversions } = require('../services/googleAdsConversionSync');

async function getAdsDiagnostic(req, res) {
  const c = gAds.config();
  const out = {
    api: 'data-manager',                      // events:ingest (l'ancienne UploadClickConversions est fermée aux nouveaux comptes)
    configured: gAds.isConfigured(),
    env: {
      clientId: !!c.clientId,
      clientSecret: !!c.clientSecret,
      refreshToken: !!c.refreshToken,
      customerId: c.customerId || null,       // identifiant de compte, pas un secret
      leadAction: c.leadAction || null,       // id d'action de conversion, pas un secret
      quoteAction: c.quoteAction || null,     // absent → étage « Devis envoyé » en veille
      saleAction: c.saleAction || null,
      purchaseAction: c.purchaseAction || null,
    },
    auth: { ok: false },
    dryRun: null,
  };

  if (!out.configured) {
    out.reason = 'Variables GOOGLE_ADS_* incomplètes — le cron reste en veille (no-op).';
    return res.json(out);
  }

  try {
    await gAds.getAccessToken();
    out.auth.ok = true;
  } catch (e) {
    out.auth.error = String((e && e.message) || e).slice(0, 300);
    return res.json(out);
  }

  try {
    out.dryRun = await syncConversions({ dryRun: true, limit: 25 });
  } catch (e) {
    out.dryRunError = String((e && e.message) || e).slice(0, 300);
  }

  // Google accepte-t-il une correction à 0 (vente remboursée) ? Essai à blanc
  // (validateOnly : rien n'est enregistré) sur le clic d'une commande récente.
  try {
    const Order = require('../models/Order');
    const recente = await Order.findOne({ 'attribution.lastTouch.gclid': { $nin: ['', null] } })
      .sort({ createdAt: -1 }).select('createdAt attribution.lastTouch.gclid').lean();
    if (recente) {
      const r = await gAds.uploadConversion({
        gclid: recente.attribution.lastTouch.gclid, action: 'purchase', value: 0, valeurExplicite: true,
        transactionId: 'VALIDATION-CORRECTION-0', dateTime: recente.createdAt, dryRun: true,
      });
      out.essaiCorrectionAZero = { ok: !!r.ok, status: r.status || null, error: r.ok ? null : JSON.stringify(r.error || r.reason || '').slice(0, 300) };
    }
  } catch (e) {
    out.essaiCorrectionAZero = { ok: false, error: String((e && e.message) || e).slice(0, 300) };
  }

  // Dénominateur réel : ce qui a été ENVOYÉ à Google sur 30 j — à comparer au
  // compteur « conversions » de l'interface Ads pour mesurer le taux de match.
  try {
    const AbandonedCart = require('../models/AbandonedCart');
    const Order = require('../models/Order');
    const since30 = new Date(Date.now() - 30 * 86400000);
    const [leads30, quotes30, sales30, purchases30, purchasesClickIdTotal30] = await Promise.all([
      AbandonedCart.countDocuments({ 'googleAdsUpload.leadAt': { $gte: since30 } }),
      AbandonedCart.countDocuments({ 'googleAdsUpload.quoteAt': { $gte: since30 } }),
      AbandonedCart.countDocuments({ 'googleAdsUpload.saleAt': { $gte: since30 } }),
      Order.countDocuments({ 'attribution.uploadedToGoogleAdsAt': { $gte: since30 } }),
      Order.countDocuments({
        createdAt: { $gte: since30 },
        $or: [
          { 'attribution.lastTouch.gclid': { $nin: ['', null] } },
          { 'attribution.lastTouch.gbraid': { $nin: ['', null] } },
          { 'attribution.lastTouch.wbraid': { $nin: ['', null] } },
        ],
      }),
    ]);
    out.uploaded30d = {
      leads: leads30,
      quotes: quotes30,
      sales: sales30,
      purchases: purchases30,
      note: 'comparer purchases au compteur « Achat site » de Google Ads (30 j) pour le taux de match',
      ordersWithClickId30d: purchasesClickIdTotal30,
    };
    // Depuis le 08/11/2026 : ventes envoyées avec leur marge, ventes rattachées
    // à une demande de devis, valeurs corrigées (remboursements, prix d'achat).
    const [margeEnvoyees, ventesViaDemande, corrigees, remisesAZero] = await Promise.all([
      Order.countDocuments({ 'googleAdsConversion.uploadedAt': { $gte: since30 } }),
      Order.countDocuments({ 'googleAdsConversion.action': 'sale', 'googleAdsConversion.uploadedAt': { $gte: since30 } }),
      Order.countDocuments({ 'googleAdsConversion.restatedAt': { $gte: since30 } }),
      Order.countDocuments({ 'googleAdsConversion.final': true, 'googleAdsConversion.restatedAt': { $gte: since30 } }),
    ]);
    out.uploaded30d.avecMarge = margeEnvoyees;
    out.uploaded30d.ventesApresDemandeDeDevis = ventesViaDemande;
    out.uploaded30d.valeursCorrigees = corrigees;
    out.uploaded30d.remisesAZero = remisesAZero;
  } catch (e) {
    out.uploaded30dError = String((e && e.message) || e).slice(0, 300);
  }

  return res.json(out);
}

module.exports = { getAdsDiagnostic };
