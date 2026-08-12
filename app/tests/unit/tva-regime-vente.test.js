/**
 * Tests unitaires — régime de TVA décidé vente par vente.
 *
 * Lancé par : npm test  (aucune base de données, aucun appel réseau)
 *
 * Le sujet : jusqu'ici tout partait à 20 % — facture client, export comptable,
 * tableau de bord — y compris les pièces achetées sous le régime de la marge.
 * Sur une vente sous marge, appliquer 20 % au prix ENTIER au lieu de la seule
 * marge fait reverser au Trésor de la TVA qui n'est pas due. Ces tests
 * verrouillent les trois endroits où le régime doit maintenant se lire.
 */

const test = require('node:test');
const assert = require('node:assert');

const vatScheme = require('../../src/services/vatScheme');
const { computeTotals } = require('../../src/services/invoicePdf');
const { splitVatCommande, regimeDeCommande } = require('../../src/services/accountingService');

/** Une vente à 1 200 € TTC : la TVA au taux normal y vaut 200 €. */
const vente = (extra) => ({ totalCents: 120000, ...(extra || {}) });

test('le défaut est 20 %, sans rien avoir à décider', async (t) => {
  await t.test('une commande sans champ vatScheme est au taux normal', () => {
    assert.equal(regimeDeCommande(vente()), 'normal');
    const t1 = computeTotals(vente());
    assert.equal(t1.margin, false);
    assert.equal(t1.vatCents, 20000);
    assert.equal(t1.htCents, 100000);
  });

  await t.test('et l’export comptable dit la même chose', () => {
    const s = splitVatCommande(vente());
    assert.equal(s.regime, 'normal');
    assert.equal(s.vatCents, 20000);
    assert.equal(s.htCents + s.vatCents, s.ttcCents, 'HT + TVA doit tomber sur le TTC');
  });
});

test('sous le régime de la marge, la TVA ne porte que sur la marge', async (t) => {
  /* Achetée 900 €, revendue 1 200 € : la marge fait 300 €, la TVA 50 €
     (300 × 20/120) au lieu de 200 €. C'est exactement l'écart qui partait
     du bénéfice. */
  const sousMarge = vente({ vatScheme: 'margin', purchase: { priceCents: 90000 } });

  await t.test('l’export comptable applique 20 % à la marge, pas au prix', () => {
    const s = splitVatCommande(sousMarge);
    assert.equal(s.regime, 'marge');
    assert.equal(s.vatCents, 5000);
    assert.equal(s.htCents + s.vatCents, s.ttcCents);
  });

  await t.test('l’économie vaut un sixième du prix d’achat', () => {
    const a = vatScheme.apercu(sousMarge, {});
    assert.equal(a.tvaNormaleCents, 20000);
    assert.equal(a.tvaMargeCents, 5000);
    assert.equal(a.economieCents, 15000);
    assert.equal(a.economieCents, Math.round(90000 / 6), '20/120 du prix d’achat');
  });

  await t.test('la facture ne fait apparaître AUCUNE TVA (art. 297 E)', () => {
    /* Interdiction, pas pudeur : afficher la taxe permettrait à l’acheteur de
       la déduire alors qu’elle ne l’est pas. */
    const t1 = computeTotals(sousMarge);
    assert.equal(t1.margin, true);
    assert.equal(t1.vatCents, 0);
    assert.equal(t1.htCents, 0, 'pas de décomposition HT non plus');
    assert.equal(t1.totalCents, 120000, 'le total reste ce que le client paie');
  });

  await t.test('sans prix d’achat, la marge vaudrait le prix entier — refusé en amont', () => {
    /* Le calcul, lui, reste défini (achat = 0) : c’est le contrôleur qui
       bloque. On vérifie les deux, sinon un oubli de garde-fou passerait
       inaperçu en produisant une TVA « normale » déguisée en marge. */
    const sansAchat = vente({ vatScheme: 'margin' });
    assert.equal(splitVatCommande(sansAchat).vatCents, 20000);
    const v = vatScheme.verifierMarge(sansAchat, { purchaseCents: null });
    assert.equal(v.ok, false);
    assert.match(v.raison, /prix d'achat/i);
  });
});

test('l’autoliquidation prime sur tout', async (t) => {
  const auto = vente({ vatScheme: 'margin', vat: { reverseCharge: true }, purchase: { priceCents: 90000 } });

  await t.test('aucune TVA collectée, quel que soit le vatScheme posé', () => {
    assert.equal(regimeDeCommande(auto), 'autoliquidation');
    assert.equal(splitVatCommande(auto).vatCents, 0);
    const t1 = computeTotals(auto);
    assert.equal(t1.reverseCharge, true);
    assert.equal(t1.margin, false, 'les deux régimes ne peuvent pas coexister');
    assert.equal(t1.vatCents, 0);
  });

  await t.test('et la marge est refusée explicitement', () => {
    const v = vatScheme.verifierMarge(auto, { purchaseCents: 90000 });
    assert.equal(v.ok, false);
    assert.match(v.raison, /autoliquid/i);
  });
});

test('la consigne reste hors de la base taxable, partout pareil', async (t) => {
  /* 1 200 € dont 200 € de caution remboursable → la TVA porte sur 1 000 €.
     La facture l’excluait déjà, l’export ne le faisait pas : les deux
     documents décrivaient la même vente avec deux TVA différentes. */
  const avecConsigne = vente({ consigne: { chargedTotalCents: 20000 } });

  await t.test('facture et export tombent sur le même montant', () => {
    assert.equal(computeTotals(avecConsigne).vatCents, splitVatCommande(avecConsigne).vatCents);
    assert.equal(splitVatCommande(avecConsigne).vatCents, Math.round(100000 / 6));
  });

  await t.test('et la marge se calcule sur la même base', () => {
    const m = vente({ consigne: { chargedTotalCents: 20000 }, vatScheme: 'margin', purchase: { priceCents: 60000 } });
    assert.equal(splitVatCommande(m).vatCents, Math.round(40000 / 6));
  });
});

test('un avoir reverse la TVA au prorata de ce qui avait été collecté', async (t) => {
  await t.test('sur une vente sous marge, la moitié remboursée annule la moitié de la TVA de marge', () => {
    /* Et non 20 % des 600 € remboursés : la TVA collectée n’a jamais porté
       sur le prix, seulement sur la marge. */
    const m = vente({ vatScheme: 'margin', purchase: { priceCents: 90000 } });
    const avoir = splitVatCommande(m, 60000);
    assert.equal(avoir.vatCents, 2500, 'la moitié des 50 € de TVA de marge');
    assert.notEqual(avoir.vatCents, 10000, 'surtout pas 20 % du remboursement');
    assert.equal(avoir.htCents + avoir.vatCents, avoir.ttcCents);
  });

  await t.test('sur une vente normale, le prorata retombe sur 20 %', () => {
    const avoir = splitVatCommande(vente(), 60000);
    assert.equal(avoir.vatCents, 10000);
  });

  await t.test('sur une vente autoliquidée, il n’y a rien à reverser', () => {
    assert.equal(splitVatCommande(vente({ vat: { reverseCharge: true } }), 60000).vatCents, 0);
  });
});

test('garde-fous : ce que le régime de la marge interdit', async (t) => {
  await t.test('un achat avec TVA déductible exclut la marge (art. 297 A II)', () => {
    const v = vatScheme.verifierMarge(vente(), { purchaseCents: 90000, supplierRegime: 'tva_deductible' });
    assert.equal(v.ok, false);
    assert.match(v.raison, /297 A/);
  });

  await t.test('un achat intracommunautaire autoliquidé aussi (art. 256 bis)', () => {
    const v = vatScheme.verifierMarge(vente(), { purchaseCents: 90000, supplierRegime: 'intracom_autoliquidation' });
    assert.equal(v.ok, false);
    assert.match(v.raison, /256 bis/);
  });

  await t.test('un prix d’achat supérieur au prix de vente est refusé', () => {
    /* La saisie d’un montant HT à la place d’un TTC, ou d’un zéro en trop,
       se voit ici plutôt que dans la déclaration du mois suivant. */
    const v = vatScheme.verifierMarge(vente(), { purchaseCents: 130000 });
    assert.equal(v.ok, false);
    assert.match(v.raison, /dépasse/i);
  });

  await t.test('un achat sous marge ou à un particulier passe', () => {
    assert.equal(vatScheme.verifierMarge(vente(), { purchaseCents: 90000, supplierRegime: 'marge' }).ok, true);
    assert.equal(vatScheme.verifierMarge(vente(), { purchaseCents: 90000, supplierRegime: 'non_assujetti' }).ok, true);
    assert.equal(vatScheme.verifierMarge(vente(), { purchaseCents: 90000, supplierRegime: '' }).ok, true);
  });
});

test('cas limites qui ne doivent pas produire de TVA fantôme', async (t) => {
  await t.test('une commande à 0 €', () => {
    const s = splitVatCommande({ totalCents: 0 });
    assert.equal(s.vatCents, 0);
    assert.equal(s.htCents, 0);
  });

  await t.test('un prix d’achat égal au prix de vente → marge nulle, TVA nulle', () => {
    const m = vente({ vatScheme: 'margin', purchase: { priceCents: 120000 } });
    assert.equal(splitVatCommande(m).vatCents, 0);
    assert.equal(computeTotals(m).totalCents, 120000);
  });

  await t.test('un prix d’achat aberrant ne rend pas la TVA négative', () => {
    const m = vente({ vatScheme: 'margin', purchase: { priceCents: 500000 } });
    assert.equal(splitVatCommande(m).vatCents, 0);
    assert.equal(vatScheme.tvaMargeCents(m, 500000), 0);
  });

  await t.test('une commande nulle ou vide ne fait rien planter', () => {
    assert.equal(regimeDeCommande(null), 'normal');
    assert.equal(splitVatCommande(null).vatCents, 0);
    assert.equal(vatScheme.baseTaxableCents(null), 0);
    assert.equal(vatScheme.tvaNormaleCents(undefined), 0);
    assert.equal(vatScheme.apercu(null, {}).tvaMargeCents, null);
  });
});
