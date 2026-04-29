const cron = require('node-cron');

const { detectAbandonedCarts } = require('./detectAbandonedCarts');
const { sendAbandonedCartReminders } = require('./sendAbandonedCartReminders');
const { expireDraftOrders } = require('./expireDraftOrders');
const { purgeTrashedOrders } = require('./purgeTrashedOrders');
const { checkOrderAlerts } = require('./checkOrderAlerts');
const { sendConsigneReminders } = require('./sendConsigneReminders');
const { checkSavSlaEscalation, runSavDailyReminders, runSavAutomations } = require('./savCronJobs');
const { reconcileScalapayOrders } = require('./reconcileScalapayOrders');

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

  console.log('[scheduler] CRON paniers abandonnés programmé (détection :00, relances :05)');
  console.log('[scheduler] CRON SAV programmé (SLA :15, relances 09:05)');
  console.log('[scheduler] CRON alertes commandes programmé (:10)');
  console.log('[scheduler] CRON relances consigne programmé (09:00 quotidien)');
  console.log('[scheduler] CRON expiration brouillons programmé (03:00 quotidien)');
  console.log('[scheduler] CRON réconciliation Scalapay programmé (toutes les 15 min)');
  console.log('[scheduler] CRON purge corbeille J+30 programmé (03:37 quotidien)');
}

module.exports = { startScheduler };
