/**
 * Recherche dans /admin/activite-panier.
 *
 * Avant : chercher un client par son téléphone noté autrement, par le
 * numéro de sa commande, par la pièce qu'il voulait — ou simplement un
 * client plus vieux que 30 jours ou déjà traité — ne renvoyait rien,
 * parce que la recherche ne couvrait que 4 champs et restait enfermée
 * dans la période et la file « À traiter ».
 *
 * On appelle ici le vrai handler sur une vraie base MongoDB, en captant
 * les données qu'il envoie à la vue.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

test('la recherche de leads retrouve le client par tous ses identifiants', async (t) => {
  const mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();
  process.env.MONGODB_URI = uri;

  const AbandonedCart = require('../../src/models/AbandonedCart');
  const Order = require('../../src/models/Order');
  const User = require('../../src/models/User');
  const { getAdminLeadsPage } = require('../../src/controllers/abandonedCartAdminController');

  /** Appelle le handler et renvoie ce qu'il passe à la vue. */
  async function search(query) {
    return new Promise((resolve, reject) => {
      const res = { render: (view, options) => resolve({ view, options }) };
      getAdminLeadsPage({ query }, res, reject).catch(reject);
    });
  }
  const emailsOf = (result) => (result.options.leads || []).map((l) => l.email).sort();

  try {
    await mongoose.connect(uri);

    const DAY = 24 * 60 * 60 * 1000;
    const longAgo = new Date(Date.now() - 60 * DAY);

    const buyer = { _id: new mongoose.Types.ObjectId(), email: 'paul.durand@example.com', firstName: 'Paul', lastName: 'Durand' };
    const other = { _id: new mongoose.Types.ObjectId(), email: 'autre.client@example.com', firstName: 'Sophie', lastName: 'Martin' };
    await User.collection.insertMany([buyer, other]);

    const order = {
      _id: new mongoose.Types.ObjectId(),
      number: 'CP2026-000673',
      invoice: { number: 'F2026-000277' },
      userId: buyer._id,
      status: 'delivered',
      paymentStatus: 'paid',
      createdAt: longAgo,
      items: [{ productId: new mongoose.Types.ObjectId(), name: 'Boîte de transfert Maserati Ghibli', sku: 'WC-7842', unitPriceCents: 139000, quantity: 1, lineTotalCents: 139000 }],
    };
    await Order.collection.insertOne(order);

    // Le client cherché : vieux de 60 jours, déjà « récupéré » — donc hors
    // période ET hors file « À traiter ».
    await AbandonedCart.create({
      sessionId: 'sess-paul',
      userId: buyer._id,
      email: buyer.email,
      firstName: 'Paul',
      lastName: 'Durand',
      phone: '+33612345678',
      items: [{ productId: order.items[0].productId, name: 'Boîte de transfert Maserati Ghibli', sku: 'WC-7842', price: 139000, quantity: 1 }],
      totalAmountCents: 139000,
      status: 'recovered',
      abandonedAt: longAgo,
      lastActivityAt: longAgo,
      recoveredOrder: { orderId: order._id, number: 'CP2026-000673', totalCents: 139000, at: longAgo },
      requested: { plate: 'EL-337-MS', ref: '6700081380' },
    });

    // Un autre lead, récent et non traité : il ne doit jamais polluer une recherche ciblée.
    await AbandonedCart.create({
      sessionId: 'sess-sophie',
      userId: other._id,
      email: other.email,
      firstName: 'Sophie',
      lastName: 'Martin',
      phone: '0700000000',
      items: [{ productId: new mongoose.Types.ObjectId(), name: 'Mécatronique DQ200', sku: 'MK-1', price: 89000, quantity: 1 }],
      totalAmountCents: 89000,
      status: 'abandoned',
      abandonedAt: new Date(),
      lastActivityAt: new Date(),
    });

    await t.test('sans recherche, la période et la file « À traiter » s\'appliquent toujours', async () => {
      const result = await search({});
      assert.equal(result.options.view, 'todo');
      assert.deepEqual(emailsOf(result), [other.email]);
    });

    await t.test('par email, même hors période et hors file', async () => {
      const result = await search({ q: 'paul.durand@example.com' });
      assert.equal(result.options.view, 'all', 'la recherche doit porter sur tout l\'historique');
      assert.deepEqual(emailsOf(result), [buyer.email]);
    });

    await t.test('par téléphone noté dans une autre graphie', async () => {
      assert.deepEqual(emailsOf(await search({ q: '06 12 34 56 78' })), [buyer.email]);
      assert.deepEqual(emailsOf(await search({ q: '0612345678' })), [buyer.email]);
    });

    await t.test('par nom, prénom, ou les deux', async () => {
      assert.deepEqual(emailsOf(await search({ q: 'durand' })), [buyer.email]);
      assert.deepEqual(emailsOf(await search({ q: 'Paul Durand' })), [buyer.email]);
      assert.deepEqual(emailsOf(await search({ q: 'Durand Paul' })), [buyer.email]);
    });

    await t.test('par numéro de commande et par numéro de facture', async () => {
      assert.deepEqual(emailsOf(await search({ q: 'CP2026-000673' })), [buyer.email]);
      assert.deepEqual(emailsOf(await search({ q: 'cp2026-000673' })), [buyer.email]);
      assert.deepEqual(emailsOf(await search({ q: 'F2026-000277' })), [buyer.email]);
    });

    await t.test('par pièce, plaque ou référence', async () => {
      assert.deepEqual(emailsOf(await search({ q: 'maserati' })), [buyer.email]);
      assert.deepEqual(emailsOf(await search({ q: 'WC-7842' })), [buyer.email]);
      assert.deepEqual(emailsOf(await search({ q: 'EL-337-MS' })), [buyer.email]);
      assert.deepEqual(emailsOf(await search({ q: '6700081380' })), [buyer.email]);
    });

    await t.test('une saisie sans correspondance ne renvoie rien', async () => {
      const result = await search({ q: 'zzz-introuvable' });
      assert.deepEqual(emailsOf(result), []);
      assert.equal(result.options.pagination.totalItems, 0);
    });
  } finally {
    await mongoose.disconnect();
    await mongo.stop();
  }
});
