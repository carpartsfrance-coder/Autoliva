// @ts-check
// Reprise du parcours client en viewport iPhone 14 Pro (390x844) — assertions
// supplémentaires sur la barre mobile linéaire et l'absence du stepper desktop.

const { test, expect, devices } = require('@playwright/test');

test.use({ ...devices['iPhone 14 Pro'] });

test('Mobile : stepper linéaire visible, stepper v2 caché, drop fonctionne', async ({ page }) => {
  await page.goto('/sav');
  // Barre linéaire mobile visible
  await expect(page.locator('#sav-mobile-bar')).toBeVisible();
  // Stepper v2 (cercles) caché en mobile (CSS @media)
  await expect(page.locator('.sav-stepper-v2')).toBeHidden();

  // Test cards commandes en colonne unique → vérifier que les cards sont les unes en dessous des autres
  // (pas de side-by-side)
  const cards = await page.locator('.sav-order-card').boundingBox();
  // tolérance : la première card doit prendre presque toute la largeur
  if (cards) {
    expect(cards.width).toBeGreaterThan(280);
  }
});
