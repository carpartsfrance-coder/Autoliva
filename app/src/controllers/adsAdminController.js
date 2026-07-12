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

  return res.json(out);
}

module.exports = { getAdsDiagnostic };
