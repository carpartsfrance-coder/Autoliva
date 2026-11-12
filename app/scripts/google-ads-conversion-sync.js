'use strict';

/**
 * Import manuel des conversions hors-ligne vers Google Ads.
 *
 * Sert à : (1) tester la configuration API, (2) backfiller les leads moteur
 * déjà reçus (le cron horaire ne traite que le flux courant + la fenêtre 80 j).
 *
 * Le cron in-process (src/jobs/scheduler.js, :40) fait la même chose en
 * continu une fois les variables d'env posées — ce script est surtout pour
 * vérifier/backfiller à la main.
 *
 * Usage (DRY-RUN par défaut, n'envoie rien, n'écrit rien) :
 *   MONGODB_URI="mongodb+srv://..." \
 *   GOOGLE_ADS_DEVELOPER_TOKEN="..." GOOGLE_ADS_CLIENT_ID="..." \
 *   GOOGLE_ADS_CLIENT_SECRET="..." GOOGLE_ADS_REFRESH_TOKEN="..." \
 *   GOOGLE_ADS_CUSTOMER_ID="9562598225" GOOGLE_ADS_LOGIN_CUSTOMER_ID="8306316896" \
 *   GOOGLE_ADS_LEAD_ACTION="<id>" GOOGLE_ADS_SALE_ACTION="<id>" \
 *   node scripts/google-ads-conversion-sync.js
 *
 * Pour envoyer pour de vrai (et marquer les leads comme remontés) :
 *   APPLY=1 node scripts/google-ads-conversion-sync.js
 */

const mongoose = require('mongoose');
const gAds = require('../src/services/googleAdsConversions');
const { syncConversions } = require('../src/services/googleAdsConversionSync');

async function main() {
  const apply = process.env.APPLY === '1';
  const dryRun = !apply;

  console.log('— Import conversions Google Ads —');
  console.log('Mode :', dryRun ? 'DRY-RUN (validateOnly, aucune écriture)' : 'APPLY (envoi réel + flags)');
  console.log('Config API présente :', gAds.isConfigured());
  if (!gAds.isConfigured()) {
    console.error('\n✗ Variables GOOGLE_ADS_* incomplètes — rien à faire.');
    console.error('  Requis : GOOGLE_ADS_DEVELOPER_TOKEN, _CLIENT_ID, _CLIENT_SECRET, _REFRESH_TOKEN,');
    console.error('           _CUSTOMER_ID, et au moins _LEAD_ACTION ou _SALE_ACTION.');
    process.exit(1);
  }

  const uri = (process.env.MONGODB_URI || '').trim();
  if (!uri) { console.error('✗ MONGODB_URI manquant.'); process.exit(1); }
  await mongoose.connect(uri);
  console.log('✓ connecté à', mongoose.connection.name, '\n');

  const report = await syncConversions({ dryRun });

  console.log('LEADS  :', JSON.stringify(report.leads));
  console.log('DEVIS  :', JSON.stringify(report.quotes));
  console.log('VENTES :', JSON.stringify(report.sales));
  console.log('ACHATS :', JSON.stringify(report.purchases));
  if (report.details.length) {
    console.log('\nDétails (erreurs/échantillon) :');
    for (const d of report.details.slice(0, 20)) console.log(' -', JSON.stringify(d));
  }
  console.log(dryRun
    ? '\nDRY-RUN terminé. Relance avec APPLY=1 pour envoyer réellement.'
    : '\n✓ Envoi terminé. Les leads remontés sont marqués (pas de double-envoi).');

  await mongoose.disconnect();
}

main().catch((e) => { console.error('Erreur:', e && e.message || e); process.exit(1); });
