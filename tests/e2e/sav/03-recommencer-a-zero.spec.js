// @ts-check
const { test, expect } = require('@playwright/test');

test('Recommencer à zéro : modale → confirmation → reset complet', async ({ page }) => {
  await page.goto('/sav');
  await page.evaluate(() => {
    localStorage.setItem('sav:draft:v2', JSON.stringify({
      step: 2, furthest: 2, fields: { email: 'r@test.fr', pieceType: 'mecatronique_dq200', garageNom: 'X' }, codes: [],
    }));
  });
  await page.reload();
  await expect(page.locator('#sav-restore-banner')).toBeVisible();
  await page.click('#sav-reset-btn');
  await expect(page.locator('#sav-reset-modal')).toBeVisible();
  await page.click('#sav-reset-confirm');
  await expect(page.locator('#sav-reset-modal')).not.toBeVisible();
  await expect(page.locator('.sav-form-step--active')).toHaveAttribute('data-step', '1');
  await expect(page.locator('#sav-restore-banner')).not.toBeVisible();
  // localStorage doit être vide
  const draft = await page.evaluate(() => localStorage.getItem('sav:draft:v2'));
  expect(draft).toBeNull();
});
