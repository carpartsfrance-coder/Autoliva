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
  } catch (e) {
    out.uploaded30dError = String((e && e.message) || e).slice(0, 300);
  }

  return res.json(out);
}

module.exports = { getAdsDiagnostic };
