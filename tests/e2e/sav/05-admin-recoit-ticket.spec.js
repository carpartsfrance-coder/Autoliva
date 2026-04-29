// @ts-check
const { test, expect } = require('@playwright/test');

const ADMIN_EMAIL = process.env.E2E_ADMIN_EMAIL || 'e2e+admin@carpartsfrance.fr';
const ADMIN_PASS = process.env.E2E_ADMIN_PASS || 'e2eAdminPass!';

test('Admin voit le ticket dans la liste', async ({ page }) => {
  await page.goto('/admin/connexion');
  await page.fill('input[name="email"]', ADMIN_EMAIL);
  await page.fill('input[name="password"]', ADMIN_PASS);
  await page.click('button[type="submit"]');
  // Si 2FA activée, sauter (les comptes E2E ne devraient pas l'avoir)
  await expect(page).toHaveURL(/\/admin/);

  await page.goto('/admin/sav/tickets');
  await expect(page.locator('h1, [class*="font-semibold"]').first()).toContainText(/Tickets|SAV/);
  // La liste doit charger au moins 1 ligne
  await page.waitForSelector('#sav-tickets-tbody tr[data-row], #sav-tickets-cards a');
  const count = await page.locator('#sav-tickets-tbody tr[data-row], #sav-tickets-cards a').count();
  expect(count).toBeGreaterThan(0);
});
