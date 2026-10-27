/**
 * Scénario client (commande CP2026-000673) : après avoir payé, le client
 * continuait de recevoir des relances « votre panier vous attend », et le
 * lien « Se désinscrire » du pied de l'email pointait vers une route
 * inexistante.
 *
 * Ce test rejoue le parcours complet sur une vraie base MongoDB et la vraie
 * application Express (vues EJS rendues par HTTP), avec `fetch` intercepté :
 * aucun email ne part réellement.
 */

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MongoMemoryServer } = require('mongodb-memory-server');
const mongoose = require('mongoose');

test('désinscription réelle et relances bridées après paiement', async (t) => {
  const mongo = await MongoMemoryServer.create();
  const uri = mongo.getUri();

  process.env.MONGODB_URI = uri;
  process.env.SESSION_SECRET = 'test-secret';
  process.env.UNSUBSCRIBE_TOKEN_SECRET = 'test-unsubscribe-secret';
  process.env.MAILERSEND_API_KEY = 'test-key';
  process.env.MAIL_FROM_EMAIL = 'noreply@example.com';
  process.env.BREVO_API_KEY = '';
  process.env.SITE_URL = 'http://127.0.0.1';
  delete process.env.MAIL_FORCE_TO;
  delete process.env.MAIL_TEST_TO;

  const AbandonedCart = require('../../src/models/AbandonedCart');
  const MarketingOptOut = require('../../src/models/MarketingOptOut');
  const NewsletterSubscriber = require('../../src/models/NewsletterSubscriber');
  const Order = require('../../src/models/Order');
  const Product = require('../../src/models/Product');
  const User = require('../../src/models/User');
  const marketingOptOut = require('../../src/services/marketingOptOut');
  const { detectAbandonedCarts } = require('../../src/jobs/detectAbandonedCarts');
  const { sendAbandonedCartReminders } = require('../../src/jobs/sendAbandonedCartReminders');

  // Interception des appels sortants : rien ne doit partir chez MailerSend.
  const realFetch = globalThis.fetch;
  const outbox = [];
  globalThis.fetch = async (url, options) => {
    const target = String(url);
    if (target.startsWith('http://127.0.0.1')) return realFetch(url, options);
    assert.ok(/api\.mailersend\.com|api\.brevo\.com/.test(target), `appel réseau inattendu : ${target}`);
    outbox.push(JSON.parse((options && options.body) || '{}'));
    return new Response('', { status: 202 });
  };

  let server;
  try {
    await mongoose.connect(uri);

    // L'app est chargée SANS MONGODB_URI : sinon express-session ouvre un
    // store connect-mongo avec sa propre connexion, que rien ne ferme — le
    // process de test ne rendrait jamais la main et `npm test` resterait
    // bloqué. Les modèles passent par la connexion mongoose ci-dessus ; la
    // session de test tient en mémoire.
    process.env.MONGODB_URI = '';
    const app = require('../../src/app');
    process.env.MONGODB_URI = uri;
    await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    const SESSION_TTL = 30 * DAY;

    const boughtPart = { _id: new mongoose.Types.ObjectId(), name: 'Boîte de transfert Maserati', sku: 'WC-7842', priceCents: 139000 };
    const otherPart = { _id: new mongoose.Types.ObjectId(), name: 'Mécatronique DQ200', sku: 'MK-1', priceCents: 89000 };
    await Product.collection.insertMany([boughtPart, otherPart]);

    const buyer = { _id: new mongoose.Types.ObjectId(), email: 'acheteur@example.com', firstName: 'Paul' };
    const shopper = { _id: new mongoose.Types.ObjectId(), email: 'curieux@example.com', firstName: 'Léa' };
    await User.collection.insertMany([buyer, shopper]);

    // Commande payée et livrée, comme CP2026-000673
    await Order.collection.insertOne({
      _id: new mongoose.Types.ObjectId(),
      number: 'CP2026-000673',
      userId: buyer._id,
      status: 'delivered',
      paymentStatus: 'paid',
      createdAt: new Date(now - 10 * DAY),
      items: [{ productId: boughtPart._id, name: boughtPart.name, sku: boughtPart.sku, unitPriceCents: 139000, quantity: 1, lineTotalCents: 139000 }],
    });

    // Sessions encore porteuses d'un panier, dernier accès il y a 3 h
    const sessionPayload = (user, productId) => JSON.stringify({
      user: { _id: String(user._id), email: user.email, firstName: user.firstName },
      cart: { items: { [String(productId)]: { productId: String(productId), quantity: 1 } } },
    });
    await mongoose.connection.db.collection('sessions').insertMany([
      { _id: 'session-acheteur', expires: new Date(now + SESSION_TTL - 3 * 60 * 60 * 1000), session: sessionPayload(buyer, boughtPart._id) },
      { _id: 'session-curieux', expires: new Date(now + SESSION_TTL - 3 * 60 * 60 * 1000), session: sessionPayload(shopper, otherPart._id) },
    ]);

    await t.test('le panier résiduel d\'une pièce déjà payée ne devient pas un lead', async () => {
      const report = await detectAbandonedCarts();
      assert.equal(report.alreadyPaid, 1, JSON.stringify(report));
      assert.equal(report.detected, 1, JSON.stringify(report));
      assert.equal(await AbandonedCart.countDocuments({ email: buyer.email }), 0);
      assert.equal(await AbandonedCart.countDocuments({ email: shopper.email }), 1);
    });

    await t.test('un vrai panier abandonné est bien relancé', async () => {
      await AbandonedCart.updateOne({ email: shopper.email }, { $set: { abandonedAt: new Date(now - 5 * 60 * 60 * 1000) } });
      outbox.length = 0;

      const report = await sendAbandonedCartReminders();
      assert.equal(report.sent, 1, JSON.stringify(report));
      assert.equal(report.errors, 0, JSON.stringify(report));
      assert.equal(outbox.length, 1);

      const lead = await AbandonedCart.findOne({ email: shopper.email }).lean();
      assert.equal(lead.status, 'reminded_1');

      // Le lien de désinscription de l'email est signé et pointe sur la vraie page
      const expectedToken = marketingOptOut.buildUnsubscribeToken(shopper.email);
      const expectedLink = `/desinscription?e=${encodeURIComponent(shopper.email)}&amp;tk=${expectedToken}`;
      assert.ok(outbox[0].html.includes(expectedLink), `lien de désinscription attendu : ${expectedLink}`);
      assert.doesNotMatch(outbox[0].html, /newsletter\/desinscription/);
    });

    await t.test('le lien de l\'email désinscrit vraiment, page comprise', async () => {
      await NewsletterSubscriber.create({ email: shopper.email, status: 'active' });
      const unsubscribeUrl = marketingOptOut.buildUnsubscribeUrl(shopper.email, baseUrl);

      const response = await fetch(unsubscribeUrl);
      assert.equal(response.status, 200);
      const html = await response.text();
      assert.match(html, /vous ne recevrez plus de relance/i);
      assert.match(html, /noindex/);

      assert.equal(await MarketingOptOut.countDocuments({ email: shopper.email }), 1);
      const lead = await AbandonedCart.findOne({ email: shopper.email }).lean();
      assert.equal(lead.status, 'expired', 'le lead en cours doit être stoppé');
      const subscriber = await NewsletterSubscriber.findOne({ email: shopper.email }).lean();
      assert.equal(subscriber.status, 'unsubscribed');
    });

    await t.test('un lien signé invalide ne désinscrit personne', async () => {
      const response = await fetch(`${baseUrl}/desinscription?e=${encodeURIComponent(buyer.email)}&tk=${'0'.repeat(32)}`);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /n’est plus valide/);
      assert.equal(await MarketingOptOut.countDocuments({ email: buyer.email }), 0);
    });

    await t.test('l\'ancien lien newsletter redirige au lieu de renvoyer une 404', async () => {
      const response = await fetch(`${baseUrl}/newsletter/desinscription`, { redirect: 'manual' });
      assert.equal(response.status, 302);
      assert.match(response.headers.get('location') || '', /\/desinscription$/);
    });

    await t.test('une adresse désinscrite ne reçoit plus rien', async () => {
      // Nouvelle visite, nouveau panier : aucun lead ne doit repartir.
      // On vieillit le lead stoppé au-delà de la fenêtre anti-répétition de
      // 30 jours, sinon c'est elle (et non la désinscription) qui bloque.
      await AbandonedCart.updateOne(
        { email: shopper.email },
        { $set: { abandonedAt: new Date(now - 40 * DAY) } }
      );
      await mongoose.connection.db.collection('sessions').insertOne({
        _id: 'session-curieux-2',
        expires: new Date(now + SESSION_TTL - 3 * 60 * 60 * 1000),
        session: sessionPayload(shopper, otherPart._id),
      });
      const detectReport = await detectAbandonedCarts();
      assert.equal(detectReport.detected, 0, JSON.stringify(detectReport));
      // Les deux sessions du client désinscrit sont écartées pour ce motif.
      assert.equal(detectReport.optedOut, 2, JSON.stringify(detectReport));

      // Et un lead encore actif en base est stoppé, sans envoi
      await AbandonedCart.updateOne(
        { email: shopper.email },
        { $set: { status: 'abandoned', abandonedAt: new Date(now - 5 * 60 * 60 * 1000), lastRemindedAt: null } }
      );
      outbox.length = 0;
      const sendReport = await sendAbandonedCartReminders();
      assert.equal(sendReport.sent, 0, JSON.stringify(sendReport));
      assert.equal(sendReport.optedOut, 1, JSON.stringify(sendReport));
      assert.equal(outbox.length, 0, 'aucun email ne doit partir');
      const lead = await AbandonedCart.findOne({ email: shopper.email }).lean();
      assert.equal(lead.status, 'expired');
    });

    await t.test('le client peut se réinscrire depuis la page', async () => {
      const token = marketingOptOut.buildUnsubscribeToken(shopper.email);
      const response = await fetch(`${baseUrl}/desinscription/reinscription`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', Origin: baseUrl },
        body: new URLSearchParams({ email: shopper.email, token }).toString(),
        redirect: 'manual',
      });
      assert.equal(response.status, 200);
      assert.match(await response.text(), /réinscrit/i);
      assert.equal(await MarketingOptOut.countDocuments({ email: shopper.email }), 0);
    });

    await t.test('un lead déjà payé est marqué récupéré au lieu d\'être relancé', async () => {
      await AbandonedCart.create({
        sessionId: 'session-acheteur-legacy',
        userId: buyer._id,
        email: buyer.email,
        items: [{ productId: boughtPart._id, name: boughtPart.name, price: 139000, quantity: 1 }],
        totalAmountCents: 139000,
        status: 'abandoned',
        abandonedAt: new Date(now - 5 * 60 * 60 * 1000),
      });
      outbox.length = 0;

      const report = await sendAbandonedCartReminders();
      assert.equal(report.sent, 0, JSON.stringify(report));
      assert.equal(outbox.length, 0);
      const lead = await AbandonedCart.findOne({ email: buyer.email }).lean();
      assert.equal(lead.status, 'recovered');
    });
  } finally {
    globalThis.fetch = realFetch;
    if (server) await new Promise((resolve) => server.close(resolve));
    await mongoose.disconnect();
    await mongo.stop();
  }
});
