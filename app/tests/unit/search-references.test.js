/**
 * La recherche doit retrouver une pièce à partir de sa référence OEM, quelle
 * que soit la façon dont le client la tape.
 *
 * Lancé par : npm test  (aucune base, aucun réseau)
 *
 * Mesuré le 18/09/2026 sur autoliva.com, à partir des termes facturés par
 * Google Ads. La fiche « Mécatronique DSG7 DQ200 » stocke ses références AVEC
 * espaces (« 0AM 325 025 D ») ; les clients, eux, les tapent collées :
 *   - « 0cw325025l » → aucune pièce trouvée, alors que « 0cw 325 025 l » sort
 *     la fiche (la référence est bien là, seulement dans l'autre graphie) ;
 *   - « oam927769d » (lettre O au lieu du zéro, 26,82 EUR de clics sur 30 j)
 *     → rien ;
 *   - « 0am 927 769 e » → un TCU multitronic 0AW en premier résultat, les
 *     fragments « 927 » et « 769 » matchant n'importe quelle fiche.
 * Et searchSynonyms, rempli par l'admin et par analyticsController, n'était
 * lu par personne.
 */

const test = require('node:test');
const assert = require('node:assert');

const { rankProducts } = require('../../src/services/search');

// Références telles qu'elles sont réellement stockées sur la fiche : espacées.
const MECATRONIQUE_DQ200 = {
  _id: 'meca-dq200',
  name: 'Mécatronique DSG7 DQ200 (0AM/0CW) reconditionnée (VAG) avec huile et levier - 0AM325065',
  sku: '0AM 325 025',
  category: 'Mécatroniques & calculateurs',
  compatibleReferences: [
    '0AM 325 025 D',
    '0AM 325 025 H',
    '0AM 325 025 X',
    '0CW 325 025 L',
    '0AM 927 769 E',
  ],
  searchSynonyms: ['0AM325025L'],
};

const TCU_DQ200 = {
  _id: 'tcu-dq200',
  name: 'TCU reconditionné DSG7 DQ200 0AM 0CW VAG',
  sku: 'ALV-TCU-DQ200',
  category: 'Calculateurs',
  compatibleReferences: ['0AM927769D'],
};

const TURBO_BMW = {
  _id: 'turbo-bmw',
  name: 'Turbo 4917706510 reconditionné BMW 325 TDS M51 échange standard',
  sku: 'ALV-TURBO-325',
  category: 'Turbos',
  compatibleReferences: ['11 65 2 244 065'],
};

const CATALOGUE = [TURBO_BMW, TCU_DQ200, MECATRONIQUE_DQ200];

const idsFor = (query) => rankProducts(CATALOGUE, query).map((entry) => entry.product._id);

test('une référence stockée avec espaces se trouve aussi collée', () => {
  assert.strictEqual(idsFor('0cw325025l')[0], 'meca-dq200');
  assert.strictEqual(idsFor('0am325025d')[0], 'meca-dq200');
  assert.strictEqual(idsFor('0am325025h')[0], 'meca-dq200');
});

test('une référence stockée collée se trouve aussi avec espaces', () => {
  assert.strictEqual(idsFor('0am 927 769 d')[0], 'tcu-dq200');
});

test('la lettre O à la place du zéro donne le même résultat que le zéro', () => {
  assert.deepStrictEqual(idsFor('oam927769d'), idsFor('0am927769d'));
  assert.strictEqual(idsFor('oam927769d')[0], 'tcu-dq200');
  assert.strictEqual(idsFor('oam325025d')[0], 'meca-dq200');
});

test('la référence tapée en fragments classe la bonne pièce en premier', () => {
  const classement = idsFor('0am 325 025 d');
  assert.strictEqual(classement[0], 'meca-dq200', `classement obtenu : ${classement.join(', ')}`);
  assert.strictEqual(idsFor('0am 927 769 d')[0], 'tcu-dq200');
});

test('les synonymes de recherche sont enfin lus', () => {
  assert.strictEqual(idsFor('0am325025l')[0], 'meca-dq200');
});

test('un fragment court ambigu ne réécrit pas le zéro', () => {
  // "o2" ne doit pas devenir "02" : sinon toute pièce citant 02E remonterait.
  assert.deepStrictEqual(idsFor('o2'), []);
});

test('une requête en mots garde son classement', () => {
  assert.strictEqual(idsFor('mécatronique dq200')[0], 'meca-dq200');
  assert.strictEqual(idsFor('turbo bmw 325 tds')[0], 'turbo-bmw');
  assert.strictEqual(idsFor('tcu dsg7')[0], 'tcu-dq200');
});
