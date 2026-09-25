/**
 * Tests unitaires — une référence OEM doit ramener la fiche qui la porte.
 *
 * Lancé par : npm test  (aucune base de données, aucun appel réseau)
 *
 * Contexte, mesuré le 18/09/2026 en production. « 0am325025d » ne renvoyait
 * aucune pièce alors que la référence « 0AM 325 025 D » figure bien sur la
 * fiche Mécatronique DSG7 DQ200. Deux causes cumulées, toutes deux au moment
 * d'ALLER CHERCHER les fiches, pas au moment de les classer :
 *
 *   1. `compatibleReferences` n'était interrogé par AUCUN des deux chemins :
 *      ni les `path` de l'index Atlas, ni REPLI_CHAMPS. Une référence qui ne
 *      figure que là était donc invisible ;
 *   2. le catalogue écrit « 0AM 325 025 D » et le client tape « 0am325025d ».
 *      Un $regex sur l'une des deux graphies ne trouve jamais l'autre.
 *
 * Ces requêtes sont celles que Google Ads facture le plus cher (6 à 16 € le
 * clic, contre 1,01 € de moyenne sur le compte).
 */

const test = require('node:test');
const assert = require('node:assert');

const svc = require('../../src/services/productListingService');

/** Applique le filtre produit par le repli à une fiche pour de vrai. */
function fauxMatch(filtre, fiche) {
  const ou = filtre.$and ? filtre.$and[1].$or : filtre.$or;
  return (ou || []).some((clause) => {
    const [champ, cond] = Object.entries(clause)[0];
    const valeurs = [].concat(fiche[champ] || []);
    const rx = new RegExp(cond.$regex, cond.$options || '');
    return valeurs.some((v) => rx.test(String(v)));
  });
}

// Fiche réelle : la référence n'est QUE dans les références compatibles,
// et elle y est écrite avec des espaces.
const MECATRONIQUE = {
  name: 'Mécatronique DSG7 DQ200 (0AM/0CW) reconditionnée (VAG) avec huile et levier',
  sku: '0AM 325 025',
  description: 'Mécatronique reconditionnée et testée sur banc.',
  compatibleReferences: ['0AM 325 025 D', '0AM 325 026 E', '0CW 325 025 L'],
  searchSynonyms: [],
};

const TURBO = {
  name: 'Turbo 4917706510 reconditionné BMW 325 TDS M51 échange standard',
  sku: 'ALV-TURBO-325',
  description: 'Turbo reconditionné.',
  compatibleReferences: ['11 65 2 244 065'],
  searchSynonyms: [],
};

test('le repli va chercher dans les références compatibles', () => {
  const f = svc.filtreTexteRepli({ archived: false }, 'mecatronique');
  const champs = new Set(f.$and[1].$or.map((c) => Object.keys(c)[0]));
  assert.ok(champs.has('compatibleReferences'), 'compatibleReferences doit être interrogé');
  assert.ok(champs.has('searchSynonyms'), 'searchSynonyms doit être interrogé');
});

test('une référence tapée collée retrouve la fiche qui la stocke espacée', () => {
  for (const saisie of ['0am325025d', '0am325026e', '0cw325025l']) {
    const f = svc.filtreTexteRepli({ archived: false }, saisie);
    assert.ok(fauxMatch(f, MECATRONIQUE), `« ${saisie} » doit ramener la mécatronique`);
    assert.ok(!fauxMatch(f, TURBO), `« ${saisie} » ne doit pas ramener le turbo`);
  }
});

test('une référence tapée en fragments retrouve aussi la fiche', () => {
  const f = svc.filtreTexteRepli({ archived: false }, '0am 325 026 e');
  assert.ok(fauxMatch(f, MECATRONIQUE));
});

test('la lettre de variante isolée n’est pas perdue au recollage', () => {
  /* « 0am 325 025 d 000 » : le « d » fait un fragment d'un seul caractère.
     Recollé sans lui, on cherchait « 0am325025000 » — aucune pièce. Ce terme
     est facturé 19,28 € sur 30 jours dans Google Ads. */
  const f = svc.filtreTexteRepli({ archived: false }, '0am 325 025 d 000');
  assert.ok(fauxMatch(f, { compatibleReferences: ['0AM 325 025 D 000'] }));
  /* Le préfiltre reste large (les fragments « 325 » et « 025 » ramènent
     d'autres fiches) — c'est le classement qui tranche ensuite. Ici on
     vérifie seulement que la bonne fiche n'est plus écartée d'entrée. */
  assert.ok(new RegExp(svc.motifReference('0am325025d000'), 'i').test('0AM 325 025 D 000'));
  assert.ok(!new RegExp(svc.motifReference('0am325025d000'), 'i').test('0AM 325 025 H'));
});

test('la lettre O à la place du zéro initial retrouve la fiche', () => {
  const f = svc.filtreTexteRepli({ archived: false }, 'oam325025d');
  assert.ok(fauxMatch(f, MECATRONIQUE));
});

test('le motif de référence ne ramène pas une référence voisine', () => {
  const rx = new RegExp(svc.motifReference('0am325025d'), 'i');
  assert.ok(rx.test('0AM 325 025 D'));
  assert.ok(rx.test('0AM325025D'));
  assert.ok(!rx.test('0AM 325 025 H'), 'la variante H n’est pas la variante D');
  assert.ok(!rx.test('0AM 325 026 E'));
});

test('un mot ordinaire ne devient jamais un motif de référence', () => {
  // Pas de chiffre → pas de motif : « mecatronique » resterait sinon un motif
  // sans séparateurs, qui matcherait « méca-tronique » et bien pire.
  assert.strictEqual(svc.motifReference('mecatronique'), '');
  // Trop court : « o2 » deviendrait « [0o]2 » et ramènerait tout le 02E.
  assert.strictEqual(svc.motifReference('o2'), '');
});

test('un code moteur reste un code moteur', () => {
  // « dq200 » est code-like : il produit bien un motif, et c'est voulu — il
  // doit retrouver « DQ 200 ». Ce qu'il ne doit pas faire, c'est déborder.
  const rx = new RegExp(svc.motifReference('dq200'), 'i');
  assert.ok(rx.test('Mécatronique DQ200'));
  assert.ok(rx.test('boîte DQ 200'));
  assert.ok(!rx.test('Mécatronique DQ250'));
  // Le motif ne saute pas par-dessus des lettres : seuls les séparateurs.
  assert.ok(!rx.test('des quatre 200'));
});
