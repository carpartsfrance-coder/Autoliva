// @ts-check
// Spec : restauration du brouillon localStorage entre 2 sessions

const { test, expect } = require('@playwright/test');

test('brouillon localStorage : remplir 3 étapes, recharger, vérifier reprise', async ({ page, context }) => {
  await page.goto('/sav');
  // On navigue jusqu'à l'étape 3 sans soumettre
  await page.evaluate(() => {
    localStorage.setItem('sav:draft:v2', JSON.stringify({
      step: 3,
      furthest: 3,
      fields: {
        email: 'brouillon@test.fr',
        numeroCommande: 'CP-DRAFT-001',
        pieceType: 'mecatronique_dq200',
        garageNom: 'Garage Brouillon',
      },
      codes: ['P0741', 'P189C'],
    }));
  });
  await page.reload();
  await expect(page.locator('#sav-restore-banner')).toBeVisible();
  await expect(page.locator('.sav-form-step--active')).toHaveAttribute('data-step', '3');
  await expect(page.locator('#garageNom')).toHaveValue('Garage Brouillon');
  // Tags OBD doivent être restaurés
  await expect(page.locator('#obdTagBox .sav-tag')).toHaveCount(2);
});
