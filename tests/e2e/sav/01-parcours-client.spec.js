// @ts-check
// Spec : parcours complet client SAV (login → wizard 6 étapes → upload → confirmation)
//
// Pré-requis : Playwright installé + serveur Express + MongoDB up + compte e2e + commande e2e.
// Voir tests/e2e/sav/README.md pour les variables d'env.

const { test, expect } = require('@playwright/test');
const path = require('path');

const CLIENT_EMAIL = process.env.E2E_CLIENT_EMAIL || 'e2e+client@example.com';
const CLIENT_PASS = process.env.E2E_CLIENT_PASS || 'e2eClientPass!';
const ORDER_NUMBER = process.env.E2E_ORDER_NUMBER || 'CP-E2E-0001';

test.describe('Parcours SAV client heureux', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/compte/connexion');
    await page.fill('input[name="email"]', CLIENT_EMAIL);
    await page.fill('input[name="password"]', CLIENT_PASS);
    await page.click('button[type="submit"]');
    await expect(page).toHaveURL(/\/compte/);
  });

  test('crée un ticket SAV de A à Z', async ({ page }) => {
    await page.goto('/sav');
    await expect(page.locator('h1')).toContainText(/Ouvrir une demande SAV|Open a service request/);

    // Étape 1 : sélectionner la commande
    await page.locator(`label[data-order-number="${ORDER_NUMBER}"]`).click();
    await page.locator('[data-action="next"][data-validate-step="1"]').click();

    // Étape 2 : pièce + montage + réglage de base
    await page.selectOption('#pieceType', 'mecatronique_dq200');
    await page.fill('#dateMontage', '2026-01-15');
    await page.fill('#garageNom', 'Garage Test E2E');
    await page.locator('input[name="reglageBase"][value="oui"]').check();
    await page.locator('[data-action="next"][data-validate-step="2"]').click();

    // Étape 3 : symptômes + OBD + description
    await page.locator('input[name="symptomes"][value="Mode dégradé"]').check();
    await page.fill('#obdInput', 'P0741');
    await page.keyboard.press('Enter');
    await page.fill('#description', 'À-coups en passage de 2e à 3e depuis 2 semaines, mode dégradé après 30 km');
    await page.locator('[data-action="next"][data-validate-step="3"]').click();

    // Étape 4 : drop 2 fichiers (facture + photo pièce) + VIN
    const facture = path.join(__dirname, 'fixtures', 'facture-test.pdf');
    const photo = path.join(__dirname, 'fixtures', 'photo-piece.jpg');
    await page.locator('#sav-file-input').setInputFiles([facture, photo]);
    // Catégoriser : 1er fichier = factureMontage (par défaut depuis le nom), 2e = photoPiece
    await page.fill('#vin', 'WAUZZZ8K0BA000001');
    await page.fill('#vMarque', 'Audi');
    await page.fill('#vModele', 'A4');
    await page.fill('#kilometrage', '145000');
    await page.locator('[data-action="next"][data-validate-step="4"]').click();

    // Étape 5 : engagement
    await page.check('#cgvSav');
    await page.check('#accept149');
    await page.check('#rgpdSav');
    await page.locator('[data-action="next"][data-validate-step="5"]').click();

    // Étape 6 : récap + envoi
    await expect(page.locator('#sav-recap')).toContainText('Audi');
    await page.click('#sav-submit');

    // Confirmation
    await expect(page).toHaveURL(/\/sav\/confirmation\/SAV-/);
    await expect(page.locator('h1')).toContainText(/Demande enregistrée|Request submitted/);
  });
});
