// @ts-check
const { test, expect } = require('@playwright/test');

test.describe('Validation inline étape 4 (VIN/plaque) et étape 3 (description)', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/sav');
    // Aller direct étape 4 via brouillon
    await page.evaluate(() => {
      localStorage.setItem('sav:draft:v2', JSON.stringify({
        step: 4, furthest: 4,
        fields: { email: 'v@t.fr', pieceType: 'mecatronique_dq200', dateMontage: '2026-01-15', garageNom: 'G', reglageBase: 'oui', description: 'Description suffisamment longue pour passer la validation' },
        codes: ['P0741'],
      }));
    });
    await page.reload();
  });

  test('VIN 16 chars → erreur', async ({ page }) => {
    await page.fill('#vin', '1HGBH41JXMN10918');
    await page.locator('#vin').blur();
    await expect(page.locator('[data-error-for="vin"]')).toContainText('VIN invalide');
    await expect(page.locator('#vin')).toHaveClass(/sav-input--invalid/);
  });

  test('VIN avec I → erreur', async ({ page }) => {
    await page.fill('#vin', 'IHGBH41JXMN109186');
    await page.locator('#vin').blur();
    await expect(page.locator('[data-error-for="vin"]')).toContainText('I/O/Q');
  });

  test('VIN valide → bordure verte', async ({ page }) => {
    await page.fill('#vin', '1HGBH41JXMN109186');
    await page.locator('#vin').blur();
    await expect(page.locator('#vin')).toHaveClass(/sav-input--valid/);
  });

  test('Plaque mauvais format → erreur', async ({ page }) => {
    await page.fill('#immatriculation', 'XXXXX');
    await page.locator('#immatriculation').blur();
    await expect(page.locator('[data-error-for="immatriculation"]')).toContainText('invalide');
  });

  test('Plaque AA-123-AA → ok', async ({ page }) => {
    await page.fill('#immatriculation', 'AA-123-AA');
    await page.locator('#immatriculation').blur();
    await expect(page.locator('#immatriculation')).toHaveClass(/sav-input--valid/);
  });
});

test.describe('Validation description ≥ 20 caractères', () => {
  test('description courte → erreur', async ({ page }) => {
    await page.goto('/sav');
    await page.evaluate(() => {
      localStorage.setItem('sav:draft:v2', JSON.stringify({ step: 3, furthest: 3, fields: { email: 'v@t.fr' }, codes: [] }));
    });
    await page.reload();
    await page.fill('#description', 'court');
    await page.locator('#description').blur();
    await expect(page.locator('[data-error-for="description"]')).toContainText('20 caractères');
  });
});
