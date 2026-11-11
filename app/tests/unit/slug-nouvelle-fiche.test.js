/**
 * Slug des nouvelles fiches — audit SEO du 11/11/2026, problème 13.
 *
 * Lancé par : npm test  (aucune base, aucun réseau)
 *
 * Les slugs cassés viennent des adresses relevées sur le site
 * (/product/diff-rentiel-avant-mercedes-cla-gla-classe-a-4matic-2462800200/…).
 */

const test = require('node:test');
const assert = require('node:assert');

const { slugNouvelleFiche } = require('../../src/services/slugNouvelleFiche');

test('slug fourni aux accents cassés : les mots du nom reprennent leur forme juste', () => {
  assert.equal(
    slugNouvelleFiche('diff-rentiel-avant-mercedes-cla-gla-classe-a-4matic-2462800200',
      'Différentiel avant Mercedes CLA, GLA, Classe A 4MATIC — 2462800200'),
    'differentiel-avant-mercedes-cla-gla-classe-a-4matic-2462800200');
  assert.equal(
    slugNouvelleFiche('pont-arri-re-reconditionn-bmw-x5-e70-33107572618',
      'Pont arrière reconditionné BMW X5 E70 — 33107572618'),
    'pont-arriere-reconditionne-bmw-x5-e70-33107572618');
  assert.equal(
    slugNouvelleFiche('bo-te-de-transfert-bmw-x3-f25-atc450', 'Boîte de transfert BMW X3 F25 ATC450'),
    'boite-de-transfert-bmw-x3-f25-atc450');
  assert.equal(
    slugNouvelleFiche('r-ducteur-arri-re-geely-emgrand-ev450', 'Réducteur arrière Geely Emgrand EV450'),
    'reducteur-arriere-geely-emgrand-ev450');
  assert.equal(
    slugNouvelleFiche('m-catronique-dsg7-dq200-reconditionn-e', 'Mécatronique DSG7 DQ200 reconditionnée'),
    'mecatronique-dsg7-dq200-reconditionnee');
});

test('sans slug fourni : le slug du nom, accents retirés', () => {
  assert.equal(slugNouvelleFiche('', 'Pont arrière BMW X5 E70'), 'pont-arriere-bmw-x5-e70');
  assert.equal(slugNouvelleFiche(undefined, 'Échange standard boîte DSG'), 'echange-standard-boite-dsg');
  assert.equal(slugNouvelleFiche('', ''), 'produit');
});

test('slug fourni déjà juste, ou avec de vrais accents : rien de cassé', () => {
  assert.equal(slugNouvelleFiche('pont-arriere-bmw-x5', 'Pont arrière BMW X5'), 'pont-arriere-bmw-x5');
  assert.equal(slugNouvelleFiche('Pont-Arrière-BMW', 'Pont arrière BMW'), 'pont-arriere-bmw');
  /* « échange » cassé donnerait « change » : un « echange » juste n'est pas touché. */
  assert.equal(slugNouvelleFiche('moteur-echange-standard', 'Moteur échange standard'), 'moteur-echange-standard');
  /* Un slug choisi qui ne reprend pas le nom reste tel quel. */
  assert.equal(slugNouvelleFiche('pont-x5-promo', 'Pont arrière BMW X5'), 'pont-x5-promo');
});
