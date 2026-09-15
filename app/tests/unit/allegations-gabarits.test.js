/**
 * Plus de promesse générale sur la garantie ni de 3x/4x fantôme.
 *
 * Lancé par : npm test  (aucune base, aucun réseau)
 *
 * Plan de reprise SEO du 14/09/2026, action A11. Les gabarits annonçaient
 * « garantie 2 ans » ou « 24 mois sur l'ensemble du catalogue » alors que la
 * garantie dépend de la pièce (6, 12 ou 24 mois, et 208 fiches sans garantie
 * saisie), et « paiement en 3x/4x sans frais » alors que Scalapay est coupé
 * depuis le 05/08 — sur 63 catégories, 7 782 pages véhicule et 6 547 pages
 * référence.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const racine = path.join(__dirname, '../..');
const lire = (f) => fs.readFileSync(path.join(racine, f), 'utf8');

function avecScalapay(etat, fn) {
  const avant = process.env.SCALAPAY_ENABLED;
  if (etat) process.env.SCALAPAY_ENABLED = 'on'; else delete process.env.SCALAPAY_ENABLED;
  try { return fn(); } finally {
    if (avant === undefined) delete process.env.SCALAPAY_ENABLED; else process.env.SCALAPAY_ENABLED = avant;
  }
}

const GARANTIE_GENERALE = /garanti(e|es|s)? (de )?2 ans|24 mois/i;
/* \b : « text-3xl » (classe de style) n'est pas une promesse de paiement. */
const FRACTIONNE = /\b[34]x\b/i;

test('descriptions de catégorie', async (sub) => {
  const { buildCategoryMetaDescription } = require('../../src/controllers/categoryController')._pourTests;

  await sub.test('Scalapay coupé : ni garantie générale ni 3x/4x', () => {
    avecScalapay(false, () => {
      for (const total of [0, 12, 3500]) {
        const d = buildCategoryMetaDescription('Boîtes de vitesses', total);
        assert.doesNotMatch(d, GARANTIE_GENERALE, d);
        assert.doesNotMatch(d, FRACTIONNE, d);
        assert.ok(d.length <= 160, 'description trop longue : ' + d.length);
      }
    });
  });

  await sub.test('Scalapay rallumé : le 3x/4x revient, la garantie générale non', () => {
    avecScalapay(true, () => {
      const d = buildCategoryMetaDescription('Turbos', 42);
      assert.match(d, FRACTIONNE);
      assert.doesNotMatch(d, GARANTIE_GENERALE);
    });
  });
});

test('textes et descriptions automatiques des pages véhicule', () => {
  const { buildAutoSeoText, buildAutoMetaDescription } = require('../../src/controllers/vehicleLandingController')._pourTests;
  const cas = [
    { makeName: 'Audi', modelName: 'A4', partTypeName: 'Boîtes de vitesses', totalCount: 7 },
    { makeName: 'Audi', modelName: 'A4', partTypeName: '', totalCount: 7 },
    { makeName: 'Audi', modelName: '', partTypeName: '', totalCount: 70 },
  ];
  avecScalapay(false, () => {
    for (const c of cas) {
      assert.doesNotMatch(buildAutoSeoText(c), FRACTIONNE, JSON.stringify(c));
      assert.doesNotMatch(buildAutoMetaDescription(c), FRACTIONNE, JSON.stringify(c));
    }
  });
  avecScalapay(true, () => {
    for (const c of cas) assert.match(buildAutoSeoText(c), FRACTIONNE, JSON.stringify(c));
  });
});

test('gabarits : plus de garantie générale ni d’atelier revendiqué', () => {
  const vehicule = lire('src/views/vehicle/index.ejs');
  const reference = lire('src/views/vehicle/reference.ejs');
  const maillage = lire('src/views/partials/internal-linking-blocks.ejs');
  const reglages = lire('src/services/siteSettings.js');
  for (const [nom, contenu] of Object.entries({ vehicule, reference, maillage, reglages })) {
    assert.doesNotMatch(contenu, /24 mois|garantie 2 ans|garanties 2 ans/i, nom);
  }
  assert.doesNotMatch(reference, /nos ateliers/i, 'la page référence revendique encore « nos ateliers »');
  /* Le 3x/4x des gabarits reste permis SOUS la condition scalapayActif. */
  for (const ligne of (vehicule + '\n' + reference).split('\n')) {
    if (FRACTIONNE.test(ligne)) assert.match(ligne, /scalapayActif/, 'ligne 3x/4x non conditionnée : ' + ligne.trim().slice(0, 90));
  }
});

test('fiche sans garantie saisie : « nous consulter », pas « 24 mois »', () => {
  const fiche = lire('src/views/products/show.ejs');
  assert.doesNotMatch(fiche, /product\.warranty24/, 'le repli « Garantie 24 Mois » est revenu');
  for (const langue of ['fr', 'de', 'en']) {
    const t = JSON.parse(lire('src/locales/' + langue + '.json'));
    assert.ok(t['product.warrantyAsk'], 'product.warrantyAsk manque en ' + langue);
    assert.doesNotMatch(String(t['product.warrantyAsk']), /\d/, 'le repli ne doit citer aucune durée');
  }
  const fr = JSON.parse(lire('src/locales/fr.json'));
  assert.doesNotMatch(fr['product.partsLabor'], /reconditionn/i,
    'la ligne de garantie ne doit pas dire « pièce reconditionnée » sur une occasion');
});
