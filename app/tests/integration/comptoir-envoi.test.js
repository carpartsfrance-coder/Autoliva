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
const { syncComptoirOrders, syncComptoirStatuses } = require('../../src/jobs/syncComptoirOrders');

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

  await t.test('un envoi réussi efface le verdict « définitif » d’un échec passé', async () => {
    /* Vécu le 09/09/2026 : le backfill a d'abord tourné avec un placeholder de
       clé → 251 commandes en 401 donc `permanentError`. Relancé avec la vraie
       clé, l'envoi passait mais le drapeau restait posé : les commandes étaient
       sorties du rattrapage pour de bon, sans que rien ne le signale. */
    await Order.deleteMany({});
    const cmd = await creerCommande();

    let f = avecFetch({ status: 401, text: async () => JSON.stringify({ error: 'Clé API invalide ou révoquée.' }) });
    try { await comptoir.syncOrder(cmd._id); } finally { f.restaurer(); }
    assert.equal((await Order.findById(cmd._id).lean()).comptoir.permanentError, true);

    f = avecFetch(OK);
    try { await comptoir.syncOrder(cmd._id); } finally { f.restaurer(); }

    const relue = await Order.findById(cmd._id).lean();
    assert.ok(relue.comptoir.sentAt);
    assert.equal(relue.comptoir.permanentError, false, 'le drapeau doit retomber');
    assert.equal(relue.comptoir.lastError, '');
  });

  await t.test('--force renvoie une commande déjà envoyée', async () => {
    /* Comptoir peut faire évoluer son ingestion et redemander les commandes
       (le renvoi du même externalId les complète, réponse `backfilled: true`). */
    await Order.deleteMany({});
    const cmd = await creerCommande();

    let f = avecFetch(OK);
    try { await comptoir.syncOrder(cmd._id); } finally { f.restaurer(); }

    f = avecFetch(OK);
    try {
      const r = await comptoir.syncOrder(cmd._id, { force: true });
      assert.equal(r.ok, true);
      assert.equal(r.skipped, undefined, 'force passe outre le verrou sentAt');
      assert.equal(f.vues.length, 1, 'l’appel réseau a bien lieu');
    } finally { f.restaurer(); }

    assert.equal((await Order.findById(cmd._id).lean()).comptoir.attempts, 2);
  });

  /* ── Mise à jour des statuts (envoi groupé, guide du 18/09/2026) ───────── */

  const BULK_OK = { status: 200, text: async () => JSON.stringify({ created: 0, updated: 1, unchanged: 0, failed: 0 }) };

  async function envoyee(over = {}) {
    const cmd = await creerCommande(over);
    const f = avecFetch(OK);
    try { await comptoir.syncOrder(cmd._id); } finally { f.restaurer(); }
    return cmd;
  }

  await t.test('une vente livrée après l’envoi est repoussée en « livree », une seule fois', async () => {
    await Order.deleteMany({});
    const cmd = await envoyee();
    assert.equal((await Order.findById(cmd._id).lean()).comptoir.statusSentFor, 'preparation');

    await Order.updateOne({ _id: cmd._id }, { $set: { status: 'delivered' } });
    let f = avecFetch(BULK_OK);
    try {
      const out = await syncComptoirStatuses();
      assert.equal(out.updated, 1);
      assert.equal(f.vues.length, 1, 'un seul appel, groupé');
      assert.match(f.vues[0].url, /\/orders\/bulk$/);
      assert.equal(f.vues[0].body.orders.length, 1);
      assert.equal(f.vues[0].body.orders[0].status, 'livree');
      assert.equal(f.vues[0].body.orders[0].externalId, cmd.number);
    } finally { f.restaurer(); }
    const apres = await Order.findById(cmd._id).lean();
    assert.equal(apres.comptoir.statusSentFor, 'livree');
    assert.ok(apres.comptoir.statusSyncedAt);

    /* Rien n'a bougé depuis : plus aucun appel. */
    f = avecFetch(BULK_OK);
    try {
      const out = await syncComptoirStatuses();
      assert.equal(out.changed, 0);
      assert.equal(f.vues.length, 0);
    } finally { f.restaurer(); }
  });

  await t.test('un remboursement repart en « retour », une commande figée est ignorée', async () => {
    await Order.deleteMany({});
    const rembourse = await envoyee();
    await Order.updateOne({ _id: rembourse._id }, { $set: { status: 'refunded' } });
    await envoyee();                       // toujours en préparation : rien à dire à Comptoir

    const f = avecFetch(BULK_OK);
    try {
      const out = await syncComptoirStatuses();
      assert.equal(out.changed, 1);
      assert.equal(f.vues[0].body.orders.length, 1);
      assert.equal(f.vues[0].body.orders[0].status, 'retour');
    } finally { f.restaurer(); }
  });

  await t.test('un lot refusé est réessayé à l’heure suivante, pas marqué à jour', async () => {
    await Order.deleteMany({});
    const cmd = await envoyee();
    await Order.updateOne({ _id: cmd._id }, { $set: { status: 'delivered' } });

    let f = avecFetch(PANNE);
    try {
      const out = await syncComptoirStatuses();
      assert.equal(out.updated, 0);
      assert.equal(out.errors, 1);
    } finally { f.restaurer(); }
    let apres = await Order.findById(cmd._id).lean();
    assert.equal(apres.comptoir.statusSentFor, 'preparation', 'rien n’est marqué à jour');
    assert.equal(apres.comptoir.statusAttempts, 1);
    assert.match(apres.comptoir.statusError, /502|Bad Gateway/);

    f = avecFetch(BULK_OK);
    try { assert.equal((await syncComptoirStatuses()).updated, 1); } finally { f.restaurer(); }
    apres = await Order.findById(cmd._id).lean();
    assert.equal(apres.comptoir.statusSentFor, 'livree');
    assert.equal(apres.comptoir.statusAttempts, 0, 'un succès efface le compteur d’échecs');
    assert.equal(apres.comptoir.statusError, '');
  });

  await t.test('échec détaillé : seule la vente refusée est réessayée', async () => {
    await Order.deleteMany({});
    const a = await envoyee();
    const b = await envoyee();
    await Order.updateMany({}, { $set: { status: 'delivered' } });

    const refus = { status: 200, text: async () => JSON.stringify({ updated: 1, failed: [{ externalId: b.number, error: 'montant invalide' }] }) };
    let f = avecFetch(refus);
    try {
      const out = await syncComptoirStatuses();
      assert.equal(out.updated, 1);
      assert.equal(out.errors, 1);
    } finally { f.restaurer(); }
    assert.equal((await Order.findById(a._id).lean()).comptoir.statusSentFor, 'livree');
    const refusee = await Order.findById(b._id).lean();
    assert.equal(refusee.comptoir.statusSentFor, 'preparation');
    assert.equal(refusee.comptoir.statusAttempts, 1);

    f = avecFetch(BULK_OK);
    try {
      const out = await syncComptoirStatuses();
      assert.equal(out.changed, 1, 'seule la refusée repart');
      assert.equal(f.vues[0].body.orders[0].externalId, b.number);
    } finally { f.restaurer(); }
  });

  await t.test('échec annoncé sans détail : tout le lot est réessayé', async () => {
    await Order.deleteMany({});
    const cmd = await envoyee();
    await Order.updateOne({ _id: cmd._id }, { $set: { status: 'delivered' } });

    const flou = { status: 200, text: async () => JSON.stringify({ updated: 0, failed: 1 }) };
    const f = avecFetch(flou);
    try {
      const out = await syncComptoirStatuses();
      assert.equal(out.updated, 0);
      assert.equal(out.errors, 1);
    } finally { f.restaurer(); }
    const apres = await Order.findById(cmd._id).lean();
    assert.equal(apres.comptoir.statusSentFor, 'preparation');
    assert.equal(apres.comptoir.statusAttempts, 1);
  });

  await t.test('une vente jamais envoyée n’est pas concernée par les statuts', async () => {
    await Order.deleteMany({});
    await creerCommande({ status: 'delivered' });
    const f = avecFetch(BULK_OK);
    try {
      const out = await syncComptoirStatuses();
      assert.equal(out.candidates, 0);
      assert.equal(f.vues.length, 0);
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
