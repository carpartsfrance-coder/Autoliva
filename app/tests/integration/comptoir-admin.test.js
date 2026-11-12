/**
 * Tests d'intégration — une commande créée depuis l'ADMIN part bien chez Comptoir.
 *
 * Le tunnel de paiement est prouvé en vrai (CP2026-000684, poussée toute seule
 * en production). Restait le chemin manuel : la vente au téléphone, qui pèse
 * lourd chez Autoliva et passe par un tout autre code.
 *
 * On appelle ici les VRAIS contrôleurs — pas une imitation — contre un vrai
 * MongoDB, avec `fetch` remplacé : aucune fausse vente ne peut atterrir dans
 * le Comptoir de production.
 *
 * Lancé par : npm test
 */

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.COMPTOIR_API_KEY = 'cle-de-test';
/* Ceinture et bretelles : aucun envoi réel, même si un chemin oublié essayait. */
process.env.MAILERSEND_API_KEY = '';
process.env.BREVO_API_KEY = '';

const Order = require('../../src/models/Order');
const User = require('../../src/models/User');
const admin = require('../../src/controllers/adminController');

let serveur;

/** Remplace fetch et rend les requêtes observées. */
function avecFetch() {
  const vrai = global.fetch;
  const vues = [];
  global.fetch = async (url, options) => {
    vues.push({ url, body: JSON.parse(options.body), auth: options.headers.Authorization });
    return { status: 200, text: async () => JSON.stringify({ ok: true }) };
  };
  return { vues, restaurer: () => { global.fetch = vrai; } };
}

/** L'envoi est volontairement en arrière-plan : on attend qu'il ait eu lieu. */
async function attendreEnvoi(orderId, timeoutMs = 5000) {
  const fin = Date.now() + timeoutMs;
  while (Date.now() < fin) {
    const o = await Order.findById(orderId).select('comptoir').lean();
    if (o && o.comptoir && o.comptoir.sentAt) return o.comptoir;
    await new Promise((r) => setTimeout(r, 50));
  }
  return null;
}

function faussesReponses() {
  const res = { code: 200, payload: null };
  res.status = (c) => { res.code = c; return res; };
  res.json = (p) => { res.payload = p; return res; };
  return res;
}

const SESSION = { admin: { adminUserId: null, firstName: 'Killian', lastName: 'B' } };

test('commande créée depuis l’admin — envoi Comptoir', async (t) => {
  serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());

  t.after(async () => {
    await mongoose.disconnect();
    await serveur.stop();
    delete process.env.COMPTOIR_API_KEY;
  });

  const client = await User.create({
    email: 'garage@example.com',
    passwordHash: 'x'.repeat(20),
    passwordSalt: 'y'.repeat(16),
    firstName: 'Garage',
    lastName: 'Martin',
    accountType: 'pro',
  });

  const corps = (over = {}) => Object.assign({
    clientId: String(client._id),
    items: [{ name: 'Mécatronique DSG7 DQ200 reconditionnée', unitPriceCents: 145800, quantity: 1 }],
    shippingAddress: { fullName: 'Garage Martin', line1: '3 rue des Ateliers', postalCode: '69003', city: 'Lyon' },
    initialStatus: 'paid',
    source: { channel: 'phone' },
  }, over);

  await t.test('une vente au téléphone déjà payée part chez Comptoir', async () => {
    const f = avecFetch();
    let res;
    try {
      res = faussesReponses();
      await admin.postAdminCreateManualOrder({ body: corps(), session: SESSION }, res);
      assert.equal(res.payload.ok, true, JSON.stringify(res.payload));

      const marque = await attendreEnvoi(res.payload.orderId);
      assert.ok(marque && marque.sentAt, 'la commande doit être marquée envoyée');
      assert.equal(f.vues.length, 1, 'un seul appel');
      assert.equal(f.vues[0].url, 'https://getcomptoir.fr/api/ingest/orders');
      assert.equal(f.vues[0].auth, 'Bearer cle-de-test');
      assert.equal(f.vues[0].body.externalId, res.payload.orderNumber);
      assert.equal(f.vues[0].body.amount, 1749.6); // 1458 € + 20 % de TVA
      assert.equal(f.vues[0].body.status, 'preparation');
      assert.equal(f.vues[0].body.customerName, 'Garage Martin');
      assert.equal(f.vues[0].body.quantity, 1);
    } finally { f.restaurer(); }
  });

  await t.test('un brouillon n’est PAS compté tant qu’il n’est pas encaissé', async () => {
    const f = avecFetch();
    try {
      const res = faussesReponses();
      await admin.postAdminCreateManualOrder({ body: corps({ initialStatus: 'draft' }), session: SESSION }, res);
      assert.equal(res.payload.ok, true);
      await new Promise((r) => setTimeout(r, 400));
      assert.equal(f.vues.length, 0, 'un brouillon ne doit rien envoyer');

      /* …puis le même brouillon, validé en « payé », part bien. */
      const res2 = faussesReponses();
      await admin.postAdminValidateDraftOrder(
        { params: { orderId: res.payload.orderId }, body: { status: 'paid' }, session: SESSION },
        res2
      );
      assert.equal(res2.payload.ok, true, JSON.stringify(res2.payload));

      const marque = await attendreEnvoi(res.payload.orderId);
      assert.ok(marque && marque.sentAt, 'le brouillon validé doit partir');
      assert.equal(f.vues.length, 1);
      assert.equal(f.vues[0].body.externalId, res.payload.orderNumber);
    } finally { f.restaurer(); }
  });

  await t.test('un échec Comptoir ne fait PAS échouer la vente', async () => {
    /* La contrainte n° 1 : la commande doit se finaliser normalement même si
       leur API tombe. On simule le pire — un fetch qui explose. */
    const vrai = global.fetch;
    global.fetch = async () => { throw new Error('ECONNREFUSED'); };
    try {
      const res = faussesReponses();
      await admin.postAdminCreateManualOrder({ body: corps(), session: SESSION }, res);
      assert.equal(res.payload.ok, true, 'la vente doit aboutir malgré la panne');

      /* Et l'échec doit rester lisible, pas disparaître. */
      const fin = Date.now() + 3000;
      let etat = null;
      while (Date.now() < fin) {
        const o = await Order.findById(res.payload.orderId).select('comptoir').lean();
        if (o && o.comptoir && o.comptoir.lastError) { etat = o.comptoir; break; }
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.ok(etat, 'l’erreur doit être tracée sur la commande');
      assert.match(etat.lastError, /ECONNREFUSED/);
      assert.equal(etat.sentAt, null, 'pas marquée envoyée → le rattrapage la reprendra');
    } finally { global.fetch = vrai; }
  });
});
