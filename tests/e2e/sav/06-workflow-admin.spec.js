// @ts-check
const { test, expect } = require('@playwright/test');

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || 'e2e+admin@carpartsfrance.fr';
const ADMIN_PASS = process.env.E2E_ADMIN_PASS || 'e2eAdminPass!';

// Hypothèse : un ticket de test SAV-E2E-0001 existe
const E2E_TICKET = process.env.E2E_TICKET_NUMERO || 'SAV-E2E-0001';

test('Workflow admin : changer statut → diagnostic → facturer 149€ (mock)', async ({ page }) => {
  await page.goto('/admin/connexion');
  await page.fill('input[name="email"]', ADMIN_EMAIL);
  await page.fill('input[name="password"]', ADMIN_PASS);
  await page.click('button[type="submit"]');
  await expect(page).toHaveURL(/\/admin/);

  await page.goto('/admin/sav/tickets/' + encodeURIComponent(E2E_TICKET));

  // 1) Changer statut → "Pièce reçue atelier"
  await page.click('[data-action-statut="recu_atelier"]');
  await expect(page.locator('#sav-statut-badge')).toContainText('recu_atelier', { timeout: 5000 });

  // 2) Onglet Diagnostic banc → conclusion non défectueuse
  await page.click('[data-tab="diagnostic"]');
  await page.selectOption('#sav-diag-form select[name="conclusion"]', 'non_defectueux');
  await page.click('#sav-diag-form button[type="submit"]');

  // 3) Sidebar : statut paiement doit basculer en "a_facturer" automatiquement (déclenché par /diagnostic)
  await expect(page.locator('#sav-paiement')).toContainText('a_facturer', { timeout: 5000 });

  // 4) Clôturer (avec confirmation)
  await page.click('[data-action-statut="clos"]');
  await page.click('#sav-confirm-ok'); // accepte la modale destructive
  await expect(page.locator('#sav-statut-badge')).toContainText('clos');
});
