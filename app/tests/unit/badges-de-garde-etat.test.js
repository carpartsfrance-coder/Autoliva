/**
 * Le garde-fou d'état des pastilles.
 *
 * Une pastille fait deux mots et décide de ce que le client croit acheter.
 * « Occasion » rendu par « Generalüberholt », c'est une pièce d'occasion
 * vendue sous l'étiquette d'une pièce refaite à neuf — exactement l'écart qui
 * justifie le prix. Ces tests verrouillent la comparaison des deux côtés.
 */

const test = require('node:test');
const assert = require('node:assert');

const { etatFr, etatDe, etatCoherent } = require('../../scripts/fix-badges-de');

test('l’état français est reconnu sur le vocabulaire réel du catalogue', () => {
  assert.equal(etatFr('Occasion'), 'occasion');
  assert.equal(etatFr('Occasion contrôlée'), 'occasion');
  assert.equal(etatFr('Reconditionné et testé'), 'reconditionné');
  assert.equal(etatFr('Reconditionnée · Échange standard'), 'reconditionné');
  assert.equal(etatFr('Échange standard'), 'reconditionné');
  assert.equal(etatFr('Rénovation pièce client'), 'reconditionné');
  assert.equal(etatFr('Neuf'), 'neuf');
  assert.equal(etatFr('Garantie 12 mois'), null, 'une garantie ne dit rien de l’état');
});

test('l’état allemand est reconnu, y compris décliné', () => {
  assert.equal(etatDe('Gebraucht'), 'occasion');
  assert.equal(etatDe('Geprüftes Gebrauchteil'), 'occasion');
  assert.equal(etatDe('Generalüberholt'), 'reconditionné');
  assert.equal(etatDe('Generalüberholter Austauschmotor'), 'reconditionné');
  assert.equal(etatDe('Austauschgetriebe'), 'reconditionné');
  assert.equal(etatDe('Neu'), 'neuf');
  assert.equal(etatDe('Neuteil'), 'neuf');
  assert.equal(etatDe('12 Monate Garantie'), null);
});

test('le désaccord d’état est refusé', async (sub) => {
  await sub.test('occasion annoncée comme reconditionnée — le cas qui a fuité en production', () => {
    assert.equal(etatCoherent('Occasion', 'Generalüberholt'), false);
    assert.equal(etatCoherent('Occasion contrôlée', 'Generalüberholter Austauschmotor'), false);
  });

  await sub.test('reconditionné rabaissé en occasion', () => {
    /* Le sens inverse est faux aussi, et coûte une vente. */
    assert.equal(etatCoherent('Reconditionné et testé', 'Gebraucht'), false);
  });

  await sub.test('neuf confondu avec l’un ou l’autre', () => {
    assert.equal(etatCoherent('Neuf', 'Gebraucht'), false);
    assert.equal(etatCoherent('Neuf', 'Generalüberholt'), false);
  });
});

test('les traductions correctes passent', () => {
  assert.ok(etatCoherent('Occasion', 'Gebraucht'));
  assert.ok(etatCoherent('Occasion contrôlée', 'Geprüft gebraucht'));
  assert.ok(etatCoherent('Reconditionné et testé', 'Generalüberholt und geprüft'));
  assert.ok(etatCoherent('Échange standard', 'Austausch'));
  assert.ok(etatCoherent('Neuf', 'Neu'));
});

test('sans revendication d’état, on ne bloque rien', () => {
  /* Les garanties, délais et arguments commerciaux n'ont pas d'état à
     vérifier — les refuser priverait la fiche de sa traduction pour rien. */
  assert.ok(etatCoherent('Garantie 12 mois', '12 Monate Garantie'));
  assert.ok(etatCoherent('Livraison en Europe', 'Versand in ganz Europa'));
  assert.ok(etatCoherent('Testé sur banc', 'Auf dem Prüfstand getestet'));
});

test('le piège du chiffre neuf', () => {
  /* « neuf » en français et « neun » en allemand sont aussi des NOMBRES.
     Un « Garantie neun Monate » n'annonce pas une pièce neuve. */
  assert.equal(etatDe('Garantie neun Monate'), null);
  assert.equal(etatDe('neunzig Tage'), null);
  assert.equal(etatDe('Neutral'), null, '« neutral » n’a rien à voir avec le neuf');
  assert.equal(etatDe('Neuteil'), 'neuf');
  assert.equal(etatDe('neuwertig'), 'neuf');
});
