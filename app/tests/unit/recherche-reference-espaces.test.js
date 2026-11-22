/**
 * Recherche d'une référence tapée avec des espaces ou des tirets (16/11/2026).
 *
 * Lancé par : npm test (aucune base : Product.aggregate est remplacé).
 *
 * Constaté en production : « 0AM325025 » trouvait 1 fiche, « 0AM 325 025 »
 * en trouvait 758 (moteurs BMW 325 en tête) ; « atc 450 » sortait un moteur
 * Renault R9M 450 avant les boîtes BMW ATC450. Une passe « référence » est
 * tentée d'abord ; si elle ne trouve rien ou échoue, la recherche d'avant
 * s'applique telle quelle.
 */

const test = require('node:test');
const assert = require('node:assert');

const svc = require('../../src/services/productListingService');
const Product = require('../../src/models/Product');

function remplacerAggregate(reponses) {
  const appels = [];
  const origine = Product.aggregate;
  Product.aggregate = (pipeline) => {
    appels.push(pipeline);
    const r = reponses[appels.length - 1];
    return {
      option: async () => {
        if (r instanceof Error) throw r;
        return [{ results: r.products, total: r.total ? [{ n: r.total }] : [] }];
      },
    };
  };
  return { appels, restaurer: () => { Product.aggregate = origine; } };
}

test('référence en plusieurs morceaux : détection étroite', () => {
  assert.equal(svc.referenceRecollee('0AM 325 025'), '0AM325025');
  assert.equal(svc.referenceRecollee('atc 450'), 'atc450');
  assert.equal(svc.referenceRecollee('02E-927-770-AJ'), '02E927770AJ');
  /* Déjà collée : la recherche habituelle la trouve, pas de seconde passe. */
  assert.equal(svc.referenceRecollee('0AM325025'), '');
  assert.equal(svc.referenceRecollee('P17BF'), '');
  /* Vraies phrases : jamais recollées. */
  assert.equal(svc.referenceRecollee('boîte de transfert bmw'), '');
  assert.equal(svc.referenceRecollee('pont arriere bmw x5'), '');
  assert.equal(svc.referenceRecollee('mecatronique dq200'), '');
  /* Sans chiffre : pas une référence. */
  assert.equal(svc.referenceRecollee('vw golf'), '');
  /* Recherches descriptives à petits chiffres : pas de passe stricte. */
  assert.equal(svc.referenceRecollee('golf 7 1.6'), '');
  assert.equal(svc.referenceRecollee('x3 2.0d'), '');
  assert.equal(svc.referenceRecollee('7G-Tronic'), '');
  assert.equal(svc.referenceRecollee('dq 200'), 'dq200');
});

test('passe « référence » : utilisée quand elle trouve, sinon recherche large', async (t) => {
  svc.reinitialiserDisjoncteur();

  await t.test('« 0AM 325 025 » : seules les fiches de la passe stricte', async () => {
    const stub = remplacerAggregate([{ products: [{ _id: 'dq200' }], total: 1 }]);
    try {
      const r = await svc.searchProductsViaAtlas({ baseFilter: {}, searchQuery: '0AM 325 025', sort: '', page: 1, perPage: 24 });
      assert.deepEqual(r, { products: [{ _id: 'dq200' }], totalCount: 1 });
      assert.equal(stub.appels.length, 1, 'pas de recherche large quand la passe stricte trouve');
      const should = stub.appels[0][0].$search.compound.should;
      assert.deepEqual(should[0], { phrase: { query: '0AM 325 025', path: ['name', 'sku', 'engineCode', 'compatibleReferences', 'searchSynonyms'] } });
      assert.equal(should[1].text.query, '0AM325025');
    } finally { stub.restaurer(); }
  });

  await t.test('rien en passe stricte → recherche large habituelle', async () => {
    const stub = remplacerAggregate([{ products: [], total: 0 }, { products: [{ _id: 'large' }], total: 7 }]);
    try {
      const r = await svc.searchProductsViaAtlas({ baseFilter: {}, searchQuery: 'xy 123 45', sort: '', page: 1, perPage: 24 });
      assert.deepEqual(r, { products: [{ _id: 'large' }], totalCount: 7 });
      assert.equal(stub.appels.length, 2);
      assert.ok(stub.appels[1][0].$search.compound.should.length >= 5, 'la seconde requête est la recherche large');
    } finally { stub.restaurer(); }
  });

  await t.test('erreur en passe stricte → recherche large, sans ouvrir le disjoncteur', async () => {
    const stub = remplacerAggregate([new Error('phrase non supportée'), { products: [{ _id: 'large' }], total: 3 },
      new Error('phrase non supportée'), { products: [{ _id: 'large' }], total: 3 },
      new Error('phrase non supportée'), { products: [{ _id: 'large' }], total: 3 }]);
    try {
      for (let i = 0; i < 3; i += 1) {
        const r = await svc.searchProductsViaAtlas({ baseFilter: {}, searchQuery: 'atc 450', sort: '', page: 1, perPage: 24 });
        assert.deepEqual(r, { products: [{ _id: 'large' }], totalCount: 3 }, `essai ${i + 1}`);
      }
    } finally { stub.restaurer(); }
  });

  await t.test('requête ordinaire : une seule recherche, comme avant', async () => {
    const stub = remplacerAggregate([{ products: [{ _id: 'x' }], total: 1 }]);
    try {
      await svc.searchProductsViaAtlas({ baseFilter: {}, searchQuery: 'boite de transfert bmw', sort: '', page: 1, perPage: 24 });
      assert.equal(stub.appels.length, 1);
      assert.ok(!stub.appels[0][0].$search.compound.should.some((c) => c.phrase), 'pas de passe référence');
    } finally { stub.restaurer(); }
  });
});

test('recherche par référence : le véhicule mémorisé ne s’applique pas', () => {
  for (const q of ['0AM325025', '0AM 325 025', 'ATC450', 'atc 450', '02E927770AJ', '722.9', 'P17BF', 'A0034460310']) {
    assert.equal(svc.rechercheParReference(q), true, q);
  }
  for (const q of ['', 'plaquettes', 'boite de transfert bmw', 'golf 7', 'BMW X5', 'clio']) {
    assert.equal(svc.rechercheParReference(q), false, q);
  }
});

/* Analytics du 22/11/2026 : « oam325065 », « 0am325025d », « 33107602984 »
   ne trouvaient rien alors que les pièces sont au catalogue. Quand Atlas
   répond 0, une passe regex tolérante (espaces, tirets, O pour 0) est tentée
   sur les champs courts. */
test('passe « référence tolérante » quand Atlas ne trouve rien', async (t) => {
  svc.reinitialiserDisjoncteur();

  await t.test('« oam325065 » (lettre O) : retrouve la fiche 0AM325065', async () => {
    const stub = remplacerAggregate([{ products: [], total: 0 }, { products: [{ _id: 'dq200' }], total: 1 }]);
    try {
      const r = await svc.searchProductsViaAtlas({ baseFilter: { isPublished: { $ne: false } }, searchQuery: 'oam325065', sort: '', page: 1, perPage: 24 });
      assert.deepEqual(r, { products: [{ _id: 'dq200' }], totalCount: 1 });
      assert.equal(stub.appels.length, 2);
      const match = stub.appels[1][0].$match;
      assert.ok(match && Array.isArray(match.$or), 'seconde requête = $match regex');
      const rx = new RegExp(match.$or[0].name.$regex, 'i');
      assert.ok(rx.test('Mécatronique DQ200 - 0AM325065'));
      assert.ok(rx.test('0AM 325 065'));
      assert.ok(!match.$or.some((c) => c.description), 'jamais sur la description');
      assert.deepEqual(stub.appels[1][1], { $match: { isPublished: { $ne: false } } }, 'le filtre de base reste appliqué');
    } finally { stub.restaurer(); }
  });

  await t.test('« 33107602984 » (tout chiffres, BMW) : motif accepté', async () => {
    const stub = remplacerAggregate([{ products: [], total: 0 }, { products: [{ _id: 'pont' }], total: 1 }]);
    try {
      const r = await svc.searchProductsViaAtlas({ baseFilter: {}, searchQuery: '33107602984', sort: '', page: 1, perPage: 24 });
      assert.equal(r.totalCount, 1);
      const rx = new RegExp(stub.appels[1][0].$match.$or[0].name.$regex, 'i');
      assert.ok(rx.test('33 10 7 602 984'));
      assert.ok(!rx.test('331075602984'), 'une faute de frappe sur la fiche reste introuvable');
    } finally { stub.restaurer(); }
  });

  await t.test('rien non plus en passe tolérante → 0 résultat, sans erreur', async () => {
    const stub = remplacerAggregate([{ products: [], total: 0 }, { products: [], total: 0 }]);
    try {
      const r = await svc.searchProductsViaAtlas({ baseFilter: {}, searchQuery: '0hk927156b', sort: '', page: 1, perPage: 24 });
      assert.deepEqual(r, { products: [], totalCount: 0 });
    } finally { stub.restaurer(); }
  });

  await t.test('erreur en passe tolérante → 0 résultat, disjoncteur intact', async () => {
    const stub = remplacerAggregate([{ products: [], total: 0 }, new Error('timeout')]);
    try {
      const r = await svc.searchProductsViaAtlas({ baseFilter: {}, searchQuery: '0gc325025e', sort: '', page: 1, perPage: 24 });
      assert.deepEqual(r, { products: [], totalCount: 0 });
    } finally { stub.restaurer(); }
  });

  await t.test('phrase ordinaire sans résultat : pas de passe tolérante', async () => {
    const stub = remplacerAggregate([{ products: [], total: 0 }]);
    try {
      await svc.searchProductsViaAtlas({ baseFilter: {}, searchQuery: 'retroviseur', sort: '', page: 1, perPage: 24 });
      assert.equal(stub.appels.length, 1);
    } finally { stub.restaurer(); }
  });

  await t.test('petit nombre (prix, km) : pas de passe tolérante', async () => {
    const stub = remplacerAggregate([{ products: [], total: 0 }]);
    try {
      await svc.searchProductsViaAtlas({ baseFilter: {}, searchQuery: '1500', sort: '', page: 1, perPage: 24 });
      assert.equal(stub.appels.length, 1);
    } finally { stub.restaurer(); }
  });
});
