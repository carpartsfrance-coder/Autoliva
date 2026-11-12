'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { localizeProduct } = require('../../src/services/productI18n');

/* Les options portent le prix ET la sélection : on ne traduit QUE l'affichage.
   Un `key` traduit casserait le panier ; un prix perdu casserait la commande. */

const fiche = () => ({
  name: 'Boîte',
  slug: 'boite',
  localizations: { de: { name: 'Getriebe', translatedAt: new Date() } },
  options: [{
    key: 'clonage',
    label: 'Clonage',
    helpText: 'Aide à sécuriser la sélection de la pièce.',
    choices: [
      { key: 'avec', label: 'Avec programmation', priceDeltaCents: 10000, triggersCloning: true },
      { key: 'sans', label: 'Sans programmation', priceDeltaCents: 0 },
      { key: 'ref', label: '927769D', priceDeltaCents: 0 },
    ],
  }],
});

test('les libellés d’option passent en allemand', () => {
  const de = localizeProduct(fiche(), 'de');
  assert.strictEqual(de.options[0].label, 'Klonen');
  assert.strictEqual(de.options[0].choices[0].label, 'Mit Programmierung');
  assert.strictEqual(de.options[0].choices[1].label, 'Ohne Programmierung');
});

test('les clés, les prix et les drapeaux ne bougent pas', () => {
  const de = localizeProduct(fiche(), 'de');
  const o = de.options[0];
  assert.strictEqual(o.key, 'clonage');
  assert.strictEqual(o.choices[0].key, 'avec');
  assert.strictEqual(o.choices[0].priceDeltaCents, 10000);
  assert.strictEqual(o.choices[0].triggersCloning, true);
  assert.strictEqual(o.choices[1].priceDeltaCents, 0);
});

test('une référence n’est pas traduite', () => {
  const de = localizeProduct(fiche(), 'de');
  assert.strictEqual(de.options[0].choices[2].label, '927769D');
});

test('la fiche française est intacte après localisation', () => {
  const source = fiche();
  localizeProduct(source, 'de');
  assert.strictEqual(source.options[0].label, 'Clonage');
  assert.strictEqual(source.options[0].choices[0].label, 'Avec programmation');
});

test('un libellé absent de la table reste en français', () => {
  const f = fiche();
  f.options[0].label = 'Libellé que personne n’a traduit';
  const de = localizeProduct(f, 'de');
  assert.strictEqual(de.options[0].label, 'Libellé que personne n’a traduit');
});
