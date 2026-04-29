// @ts-check
// Spec : pré-alertes SLA 24h/12h. Pour rendre le test reproductible sans
// modifier l'horloge, on appelle directement l'endpoint cron interne via
// Bearer (SAV_API_TOKEN) après avoir patché un ticket en DB pour avoir
// sla.dateLimite à T+11h.

const { test, expect } = require('@playwright/test');

test.skip('SLA tiered alerts (à réécrire avec un mock DB direct)', async ({ page }) => {
  // TODO :
  // 1. Insérer un SavTicket statut=en_analyse, sla.dateLimite = now + 11h
  // 2. Appeler savCronJobs.checkSavSlaEscalation() (via un endpoint admin
  //    /admin/api/sav/_internal/run-sla-check qui n'existe pas encore)
  // 3. Vérifier que le ticket a bien slaAlerts.alert12h défini
  // 4. Réessayer 1h plus tard → ne doit PAS re-déclencher (anti-doublon)
  //
  // Cette spec est marquée test.skip tant que l'endpoint d'introspection
  // n'est pas créé — elle existe pour documenter l'intention.
});
