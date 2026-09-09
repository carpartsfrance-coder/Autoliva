/**
 * Tests d'intégration — connecteur Comptoir contre un VRAI MongoDB.
 *
 * Lancé par : npm test (mongodb-memory-server, aucune base externe requise).
 *
 * Pourquoi une vraie base : le rattrapage repose sur une requête Mongo non
 * triviale (`$or` sur un champ absent, `$and` imbriqué, `$ne: true`). Un mock
 * de `Order.find` la validerait toujours — y compris fausse.
 *
 * ⚠ `global.fetch` est remplacé : AUCUN appel ne part vers Comptoir.
 */

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.COMPTOIR_API_KEY = 'cle-de-test';

const Order = require('../../src/models/Order');
const comptoir = require('../../src/services/comptoir');
const { syncComptoirOrders } = require('../../src/jobs/syncComptoirOrders');

let serveur;
let n = 0;

async function creerCommande(over = {}) {
  n += 1;
  return Order.create(Object.assign({
    userId: new mongoose.Types.ObjectId(),
    number: `CP2026-90${String(n).padStart(4, '0')}`,
    status: 'processing',
    paymentStatus: 'paid',
    accountType: 'particulier',
    totalCents: 45000,
    items: [{ name: 'Boîte de vitesses DQ250', unitPriceCents: 45000, quantity: 1, lineTotalCents: 45000 }],
    shippingAddress: { fullName: 'Jean Dupont', line1: '1 rue de Paris', postalCode: '75001', city: 'Paris' },
    billingAddress: { fullName: 'Jean Dupont', line1: '1 rue de Paris', postalCode: '75001', city: 'Paris' },
  }, over));
}

/** Remplace fetch le temps d'un appel, et rend les requêtes observées. */
function avecFetch(reponse) {
  const vrai = global.fetch;
  const vues = [];
  global.fetch = async (url, options) => {
    vues.push({ url, body: JSON.parse(options.body) });
    return typeof reponse === 'function' ? reponse() : reponse;
  };
  return { vues, restaurer: () => { global.fetch = vrai; } };
}

const OK = { status: 200, text: async () => JSON.stringify({ duplicate: false }) };
const PANNE = { status: 502, text: async () => 'Bad Gateway' };

test('connecteur Comptoir — envoi et rattrapage', async (t) => {
  serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());

  t.after(async () => {
    await mongoose.disconnect();
    await serveur.stop();
    delete process.env.COMPTOIR_API_KEY;
  });

  await t.test('une commande encaissée est envoyée puis marquée', async () => {
    const cmd = await creerCommande();
    const f = avecFetch(OK);
    try {
      const r = await comptoir.syncOrder(cmd._id);
      assert.equal(r.ok, true);
      assert.equal(f.vues.length, 1);
      assert.equal(f.vues[0].body.externalId, cmd.number);
      assert.equal(f.vues[0].body.amount, 450);
    } finally { f.restaurer(); }

    const relue = await Order.findById(cmd._id).lean();
    assert.ok(relue.comptoir.sentAt instanceof Date);
    assert.equal(relue.comptoir.externalId, cmd.number);
    assert.equal(relue.comptoir.attempts, 1);
    assert.equal(relue.comptoir.lastError, '');
  });

  await t.test('un second appel n’envoie rien : le marquage fait verrou', async () => {
    const cmd = await creerCommande();
    let f = avecFetch(OK);
    try { await comptoir.syncOrder(cmd._id); } finally { f.restaurer(); }

    f = avecFetch(OK);
    try {
      const r = await comptoir.syncOrder(cmd._id);
      assert.equal(r.skipped, true);
      assert.equal(f.vues.length, 0, 'aucun second appel réseau');
    } finally { f.restaurer(); }
  });

  await t.test('une commande non encaissée n’est jamais comptée', async () => {
    const cmd = await creerCommande({ status: 'pending_payment', paymentStatus: 'pending' });
    const f = avecFetch(OK);
    try {
      const r = await comptoir.syncOrder(cmd._id);
      assert.equal(r.ok, false);
      assert.equal(r.reason, 'non_encaissee');
      assert.equal(f.vues.length, 0);
    } finally { f.restaurer(); }
  });

  await t.test('un échec laisse l’erreur lisible et ne marque pas envoyé', async () => {
    const cmd = await creerCommande();
    const f = avecFetch(PANNE);
    try {
      const r = await comptoir.syncOrder(cmd._id);
      assert.equal(r.ok, false);
    } finally { f.restaurer(); }

    const relue = await Order.findById(cmd._id).lean();
    assert.equal(relue.comptoir.sentAt, null);
    assert.equal(relue.comptoir.attempts, 1);
    assert.match(relue.comptoir.lastError, /502|Bad Gateway/);
    assert.equal(relue.comptoir.permanentError, false);
  });

  await t.test('le rattrapage reprend l’échouée, ignore l’envoyée et la non payée', async () => {
    await Order.deleteMany({});
    const envoyee = await creerCommande();
    const echouee = await creerCommande();
    const impayee = await creerCommande({ status: 'pending_payment', paymentStatus: 'pending' });

    let f = avecFetch(OK);
    try { await comptoir.syncOrder(envoyee._id); } finally { f.restaurer(); }
    f = avecFetch(PANNE);
    try { await comptoir.syncOrder(echouee._id); } finally { f.restaurer(); }

    f = avecFetch(OK);
    let out;
    try { out = await syncComptoirOrders(); } finally { f.restaurer(); }

    assert.equal(out.candidates, 1, 'seule l’échouée est reprise');
    assert.equal(out.sent, 1);
    assert.equal(f.vues[0].body.externalId, echouee.number);

    assert.ok((await Order.findById(echouee._id).lean()).comptoir.sentAt);
    assert.equal((await Order.findById(impayee._id).lean()).comptoir.sentAt, null);
  });

  await t.test('une commande jamais tentée (champ absent) est bien candidate', async () => {
    await Order.deleteMany({});
    const cmd = await creerCommande();
    /* Reproduit une commande créée AVANT le connecteur : pas de sous-document
       `comptoir` du tout. C'est le cas que `{ $exists: false }` doit attraper. */
    await Order.collection.updateOne({ _id: cmd._id }, { $unset: { comptoir: '' } });
    const brute = await Order.collection.findOne({ _id: cmd._id });
    assert.equal(brute.comptoir, undefined);

    const f = avecFetch(OK);
    try {
      const out = await syncComptoirOrders();
      assert.equal(out.candidates, 1);
      assert.equal(out.sent, 1);
    } finally { f.restaurer(); }
  });

  await t.test('une erreur définitive (401) sort du rattrapage', async () => {
    await Order.deleteMany({});
    const cmd = await creerCommande();

    let f = avecFetch({ status: 401, text: async () => JSON.stringify({ error: 'Clé API invalide ou révoquée.' }) });
    try { await comptoir.syncOrder(cmd._id); } finally { f.restaurer(); }

    const relue = await Order.findById(cmd._id).lean();
    assert.equal(relue.comptoir.permanentError, true);

    f = avecFetch(OK);
    try {
      const out = await syncComptoirOrders();
      assert.equal(out.candidates, 0, 'on ne martèle pas une clé morte chaque heure');
    } finally { f.restaurer(); }
  });

  await t.test('une commande supprimée n’est pas comptée', async () => {
    await Order.deleteMany({});
    const cmd = await creerCommande({ deletedAt: new Date(), deleteReason: 'test' });
    const f = avecFetch(OK);
    try {
      const r = await comptoir.syncOrder(cmd._id);
      assert.equal(r.reason, 'supprimee');
      const out = await syncComptoirOrders();
      assert.equal(out.candidates, 0);
      assert.equal(f.vues.length, 0);
    } finally { f.restaurer(); }
  });
});
