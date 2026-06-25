const cron = require('node-cron');

const { detectAbandonedCarts } = require('./detectAbandonedCarts');
const { sendAbandonedCartReminders } = require('./sendAbandonedCartReminders');
const { expireDraftOrders } = require('./expireDraftOrders');
const { purgeTrashedOrders } = require('./purgeTrashedOrders');
const { checkOrderAlerts } = require('./checkOrderAlerts');
const { sendConsigneReminders } = require('./sendConsigneReminders');
const { checkSavSlaEscalation, runSavDailyReminders, runSavAutomations } = require('./savCronJobs');
const { reconcileScalapayOrders } = require('./reconcileScalapayOrders');
const { syncShipmentTracking } = require('./syncShipmentTracking');
const { runEngineQuoteReminders } = require('./sendEngineQuoteReminders');
const { processScheduledAutoDevis } = require('./processScheduledAutoDevis');
const { syncConversions } = require('../services/googleAdsConversionSync');
const { isConfigured: googleAdsConfigured } = require('../services/googleAdsConversions');

function startScheduler() {
  // Detect abandoned carts every hour (at minute 0)
  cron.schedule('0 * * * *', async () => {
    console.log('[scheduler] Lancement détection paniers abandonnés...');
    try {
      await detectAbandonedCarts();
    } catch (err) {
      console.error('[scheduler] Erreur détection paniers abandonnés:', err.message || err);
    }
  });

  // Send abandoned cart reminders every hour (at minute 5, after detection)
  cron.schedule('5 * * * *', async () => {
    console.log('[scheduler] Lancement envoi relances paniers abandonnés...');
    try {
      await sendAbandonedCartReminders();
    } catch (err) {
      console.error('[scheduler] Erreur envoi relances paniers abandonnés:', err.message || err);
    }
  });

  // Expire draft orders daily at 3:00 AM
  cron.schedule('0 3 * * *', async () => {
    console.log('[scheduler] Vérification brouillons expirés...');
    try {
      await expireDraftOrders();
    } catch (err) {
      console.error('[scheduler] Erreur expiration brouillons:', err.message || err);
    }
  });

  // Purge automatique corbeille J+30 (quotidien à 03:37)
  cron.schedule('37 3 * * *', async () => {
    console.log('[scheduler] Purge corbeille J+30...');
    try {
      await purgeTrashedOrders();
    } catch (err) {
      console.error('[scheduler] Erreur purge corbeille:', err.message || err);
    }
  });

  // Check order alerts every hour (at minute 10)
  cron.schedule('10 * * * *', async () => {
    console.log('[scheduler] Vérification alertes commandes...');
    try {
      await checkOrderAlerts();
    } catch (err) {
      console.error('[scheduler] Erreur vérification alertes commandes:', err.message || err);
    }
  });

  // Send consigne reminders daily at 9:00 AM
  cron.schedule('0 9 * * *', async () => {
    console.log('[scheduler] Envoi relances consigne...');
    try {
      await sendConsigneReminders();
    } catch (err) {
      console.error('[scheduler] Erreur relances consigne:', err.message || err);
    }
  });

  // SAV — escalade SLA toutes les heures (minute 15)
  cron.schedule('15 * * * *', async () => {
    console.log('[scheduler] SAV: vérification SLA...');
    try {
      const r = await checkSavSlaEscalation();
      console.log('[scheduler] SAV SLA:', r);
    } catch (err) {
      console.error('[scheduler] Erreur SAV SLA:', err.message || err);
    }
  });

  // SAV — moteur d'automatisations toutes les 30 min
  cron.schedule('25,55 * * * *', async () => {
    try {
      await runSavAutomations();
    } catch (err) {
      console.error('[scheduler] Erreur SAV automations:', err.message || err);
    }
  });

  // SAV — relances quotidiennes 09:05
  cron.schedule('5 9 * * *', async () => {
    console.log('[scheduler] SAV: relances quotidiennes...');
    try {
      await runSavDailyReminders();
    } catch (err) {
      console.error('[scheduler] Erreur SAV relances:', err.message || err);
    }
  });

  // Réconciliation Scalapay toutes les 15 min — capture les commandes
  // autorisées qui n'ont pas été capturées (typiquement quand le client
  // n'est pas revenu sur le site après validation Scalapay).
  cron.schedule('*/15 * * * *', async () => {
    try {
      await reconcileScalapayOrders();
    } catch (err) {
      console.error('[scheduler] Erreur réconciliation Scalapay:', err.message || err);
    }
  });

  // Sync des suivis JUMiNGO toutes les 20 min : « Étiquette créée » → « Expédiée »
  // au scan transporteur (départ réel). No-op tant que JUMINGO_API_KEY +
  // JUMINGO_SYNC_ENABLED=true ne sont pas définis.
  cron.schedule('8,28,48 * * * *', async () => {
    try {
      await syncShipmentTracking();
    } catch (err) {
      console.error('[scheduler] Erreur sync suivis Jumingo:', err.message || err);
    }
  });

  // Devis instantanés DIFFÉRÉS : chaque minute, envoie ceux arrivés à échéance.
  // L'accusé de réception part à la soumission, le devis suit ~5 min après.
  cron.schedule('* * * * *', async () => {
    try {
      const r = await processScheduledAutoDevis();
      if (r && r.processed) console.log('[scheduler] auto-devis différés envoyés:', r.processed);
    } catch (err) {
      console.error('[scheduler] Erreur auto-devis différés:', err.message || err);
    }
  });

  // Relances devis moteurs : tous les jours à 09:30 (J+3, J+7, J+14 auto-lost)
  cron.schedule('30 9 * * *', async () => {
    console.log('[scheduler] Lancement relances devis moteurs...');
    try {
      await runEngineQuoteReminders();
    } catch (err) {
      console.error('[scheduler] Erreur relances devis moteurs:', err.message || err);
    }
  });

  // Import de conversions hors-ligne vers Google Ads : toutes les heures à :40.
  // Remonte les VRAIES conversions du tunnel moteur (lead devis + vente gagnée)
  // via le gclid déjà capté. No-op TOTAL tant que les variables GOOGLE_ADS_*
  // ne sont pas définies (isConfigured() = false) → sûr à déployer avant l'onboarding API.
  cron.schedule('40 * * * *', async () => {
    if (!googleAdsConfigured()) return;
    try {
      const r = await syncConversions({ dryRun: false });
      console.log('[scheduler] Google Ads conversions:', JSON.stringify({ leads: r.leads, sales: r.sales }));
    } catch (err) {
      console.error('[scheduler] Erreur sync conversions Google Ads:', err.message || err);
    }
  });

  console.log('[scheduler] CRON paniers abandonnés programmé (détection :00, relances :05)');
  console.log('[scheduler] CRON relances devis moteurs programmé (09:30 quotidien)');
  console.log('[scheduler] CRON auto-devis différés programmé (chaque minute)');
  console.log('[scheduler] CRON SAV programmé (SLA :15, relances 09:05)');
  console.log('[scheduler] CRON alertes commandes programmé (:10)');
  console.log('[scheduler] CRON relances consigne programmé (09:00 quotidien)');
  console.log('[scheduler] CRON expiration brouillons programmé (03:00 quotidien)');
  console.log('[scheduler] CRON réconciliation Scalapay programmé (toutes les 15 min)');
  console.log('[scheduler] CRON purge corbeille J+30 programmé (03:37 quotidien)');
}

module.exports = { startScheduler };
