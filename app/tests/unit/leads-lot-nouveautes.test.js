/**
 * Actions en lot et « ce qui est arrivé depuis » (controllers/leadWorkController.js).
 *
 * Ces deux routes touchent plusieurs dossiers d'un coup ou tournent en boucle
 * toutes les minutes : on vérifie ici les garde-fous, sans base de données —
 * les modèles sont remplacés par des espions.
 */
const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');

const AbandonedCart = require('../../src/models/AbandonedCart');

/** Express minimal : on capture le statut et le corps de la réponse. */
function faussRes() {
  const res = { code: 200, corps: null };
  res.status = (c) => { res.code = c; return res; };
  res.json = (j) => { res.corps = j; return res; };
  return res;
}

function avecBase(etat, fn) {
  const reel = Object.getOwnPropertyDescriptor(mongoose.connection, 'readyState');
  Object.defineProperty(mongoose.connection, 'readyState', { value: etat, configurable: true });
  return Promise.resolve(fn()).finally(() => {
    if (reel) Object.defineProperty(mongoose.connection, 'readyState', reel);
  });
}

/** Remplace les méthodes du modèle le temps d'un test. */
function espionner(methodes) {
  const anciens = {};
  Object.keys(methodes).forEach((k) => { anciens[k] = AbandonedCart[k]; AbandonedCart[k] = methodes[k]; });
  return () => Object.keys(anciens).forEach((k) => { AbandonedCart[k] = anciens[k]; });
}

const { postLot, getNouveautes, LOT_MAX } = require('../../src/controllers/leadWorkController');

const SESSION = { session: { admin: { firstName: 'Killian', lastName: 'B', adminUserId: new mongoose.Types.ObjectId().toString() } } };
function requete(extra) { return Object.assign({ body: {}, query: {}, params: {} }, SESSION, extra); }

test('clôture en lot : le motif est obligatoire, comme à l’unité', async () => {
  await avecBase(1, async () => {
    const res = faussRes();
    await postLot(requete({ body: { action: 'perdu', ids: [new mongoose.Types.ObjectId().toString()] } }), res, (e) => { throw e; });
    assert.equal(res.code, 400);
    assert.match(res.corps.error, /motif/i);
  });
});

test('clôture en lot : sans motif valide, rien n’est écrit', async () => {
  await avecBase(1, async () => {
    let ecrit = false;
    const rendre = espionner({ updateMany: async () => { ecrit = true; return { modifiedCount: 1 }; } });
    try {
      const res = faussRes();
      await postLot(requete({ body: { action: 'perdu', motif: 'motif_invente', ids: [new mongoose.Types.ObjectId().toString()] } }), res, (e) => { throw e; });
      assert.equal(res.code, 400);
      assert.equal(ecrit, false, 'aucune écriture sur un motif inconnu');
    } finally { rendre(); }
  });
});

test('clôture en lot : une vente déjà gagnée n’est jamais repassée en perdu', async () => {
  await avecBase(1, async () => {
    const filtres = [];
    const rendre = espionner({ updateMany: async (filtre) => { filtres.push(filtre); return { modifiedCount: 2 }; } });
    try {
      const res = faussRes();
      const ids = [new mongoose.Types.ObjectId().toString(), new mongoose.Types.ObjectId().toString()];
      await postLot(requete({ body: { action: 'perdu', motif: 'injoignable', ids } }), res, (e) => { throw e; });
      assert.equal(res.code, 200);
      assert.equal(res.corps.ok, true);
      assert.deepEqual(filtres[0].manualStatus, { $ne: 'converted' }, 'les dossiers gagnés sont exclus du filtre');
      assert.match(res.corps.message, /Impossible à joindre/);
    } finally { rendre(); }
  });
});

test('clôture en lot : le dossier devis suit, mais jamais un devis déjà gagné', async () => {
  await avecBase(1, async () => {
    const filtres = [];
    const rendre = espionner({ updateMany: async (filtre) => { filtres.push(filtre); return { modifiedCount: 1 }; } });
    try {
      await postLot(requete({ body: { action: 'perdu', motif: 'prix', ids: [new mongoose.Types.ObjectId().toString()] } }), faussRes(), (e) => { throw e; });
      const devis = filtres[1];
      assert.deepEqual(devis['engineQuote.status'], { $nin: ['won', 'acompte_recu', 'lost'] });
      assert.equal(devis.manualStatus, 'lost', 'seulement les dossiers qu’on vient de clôturer');
    } finally { rendre(); }
  });
});

test('prise en charge en lot : on ne prend pas le dossier d’un collègue', async () => {
  await avecBase(1, async () => {
    const filtres = [];
    const rendre = espionner({ updateMany: async (filtre) => { filtres.push(filtre); return { modifiedCount: 1 }; } });
    try {
      const res = faussRes();
      const ids = [new mongoose.Types.ObjectId().toString(), new mongoose.Types.ObjectId().toString()];
      await postLot(requete({ body: { action: 'prendre', ids } }), res, (e) => { throw e; });
      assert.ok(filtres[0].$or.some((c) => c.takenByName === '' || c.takenByName === null || (c.takenByName && c.takenByName.$exists === false)),
        'seuls les dossiers libres sont pris');
      assert.match(res.corps.message, /1 dossier pris en charge/);
      assert.match(res.corps.message, /1 déjà suivi/, 'on dit ce qui a été ignoré');
    } finally { rendre(); }
  });
});

test('actions en lot : identifiants invalides écartés, action inconnue refusée, plafond respecté', async () => {
  await avecBase(1, async () => {
    const res1 = faussRes();
    await postLot(requete({ body: { action: 'supprimer', ids: ['x'] } }), res1, (e) => { throw e; });
    assert.equal(res1.code, 400);

    const res2 = faussRes();
    await postLot(requete({ body: { action: 'prendre', ids: ['pas-un-id', ''] } }), res2, (e) => { throw e; });
    assert.equal(res2.code, 400);
    assert.match(res2.corps.error, /Aucun dossier/);

    const trop = Array.from({ length: LOT_MAX + 1 }, () => new mongoose.Types.ObjectId().toString());
    const res3 = faussRes();
    await postLot(requete({ body: { action: 'prendre', ids: trop } }), res3, (e) => { throw e; });
    assert.equal(res3.code, 400);
    assert.match(res3.corps.error, /maximum/);
  });
});

test('actions en lot : les doublons ne comptent qu’une fois', async () => {
  await avecBase(1, async () => {
    const filtres = [];
    const rendre = espionner({ updateMany: async (filtre) => { filtres.push(filtre); return { modifiedCount: 1 }; } });
    try {
      const id = new mongoose.Types.ObjectId().toString();
      const res = faussRes();
      await postLot(requete({ body: { action: 'prendre', ids: [id, id, id] } }), res, (e) => { throw e; });
      assert.equal(filtres[0]._id.$in.length, 1);
      assert.doesNotMatch(res.corps.message, /déjà suivi/, 'pas de « 2 ignorés » fabriqués par les doublons');
    } finally { rendre(); }
  });
});

test('nouveautés : une date de référence invalide est refusée', async () => {
  await avecBase(1, async () => {
    const res = faussRes();
    await getNouveautes(requete({ query: { depuis: 'avant-hier' } }), res, (e) => { throw e; });
    assert.equal(res.code, 400);
  });
});

test('nouveautés : une page ouverte depuis trois jours ne compte pas trois jours d’arrivées', async () => {
  await avecBase(1, async () => {
    const filtres = [];
    const rendre = espionner({ countDocuments: async (f) => { filtres.push(f); return 2; } });
    try {
      const res = faussRes();
      const vieux = new Date(Date.now() - 3 * 86400000).toISOString();
      await getNouveautes(requete({ query: { depuis: vieux } }), res, (e) => { throw e; });
      assert.equal(res.corps.ok, true);
      const borne = new Date(res.corps.depuis).getTime();
      assert.ok(borne > Date.now() - 37 * 3600 * 1000, 'la borne est ramenée à 36 h');
      assert.ok(filtres[0].createdAt.$gte.getTime() === borne);
      /* Les SMS reçus ne sont plus comptés (20/11/2026) : rattachés par le
         seul numéro, un message de SAV annonçait « 1 client a répondu ». */
      assert.equal(filtres.length, 1, 'un seul comptage : les nouvelles demandes');
      assert.equal(res.corps.reponses, undefined);
    } finally { rendre(); }
  });
});

test('nouveautés : on ne compte que les vraies demandes, hors dossiers rangés', async () => {
  await avecBase(1, async () => {
    const filtres = [];
    const rendre = espionner({ countDocuments: async (f) => { filtres.push(f); return 0; } });
    try {
      await getNouveautes(requete({ query: { depuis: new Date().toISOString() } }), faussRes(), (e) => { throw e; });
      assert.deepEqual(filtres[0].archived, { $ne: true });
      assert.ok(Array.isArray(filtres[0].captureSource.$in));
      assert.ok(filtres[0].captureSource.$in.includes('landing_moteurs'));
      assert.ok(!filtres[0].captureSource.$in.includes('cart_activity'), 'un panier abandonné n’est pas une demande');
    } finally { rendre(); }
  });
});

test('base indisponible : les deux routes le disent au lieu de planter', async () => {
  await avecBase(0, async () => {
    const r1 = faussRes();
    await postLot(requete({ body: { action: 'prendre', ids: [new mongoose.Types.ObjectId().toString()] } }), r1, (e) => { throw e; });
    assert.equal(r1.code, 503);
    const r2 = faussRes();
    await getNouveautes(requete({ query: { depuis: new Date().toISOString() } }), r2, (e) => { throw e; });
    assert.equal(r2.code, 503);
  });
});
