/**
 * Rappels de Mollie après un remboursement : la commande ne doit plus repartir
 * « En préparation ». Contre un VRAI MongoDB (mongodb-memory-server), avec le
 * vrai webhook du site ; seul l'appel à l'API Mollie est remplacé.
 *
 * Diagnostic du 08/11/2026 : CP2026-000755, 000785, 000713 et 000666 avaient
 * été remboursées, puis le rappel de Mollie (paiement toujours « paid » chez
 * Mollie) les avait remises en préparation, avec une nouvelle date de
 * paiement. Elles revenaient dans les commandes à préparer et dans les ventes.
 *
 * Aucun envoi possible : pas de clé e-mail / SMS / Comptoir, et les fonctions
 * d'envoi de la confirmation sont remplacées par des compteurs.
 */

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

for (const cle of ['MAILERSEND_API_KEY', 'BREVO_API_KEY', 'MOLLIE_API_KEY', 'MOLLIE_WEBHOOK_TOKEN', 'COMPTOIR_API_KEY', 'SCALAPAY_API_KEY']) {
  process.env[cle] = '';
}

const Order = require('../../src/models/Order');
const User = require('../../src/models/User');
const mollie = require('../../src/services/mollie');
const emailService = require('../../src/services/emailService');
const smsService = require('../../src/services/smsService');
const checkout = require('../../src/controllers/checkoutController');
const { repairRefundedOrdersReopened, statutAvantLeBug } = require('../../src/migrations/repairRefundedOrdersReopened');

let serveur;
let n = 0;
let userId;
const confirmations = { email: 0, sms: 0 };

const PAYE_LE = new Date('2026-10-08T15:06:20.000Z');

/* Insertion brute : pas de hook de sauvegarde, l'historique est exactement celui donné. */
async function commande(over = {}) {
  n += 1;
  const doc = Object.assign({
    userId,
    number: `CP2026-99${String(n).padStart(4, '0')}`,
    status: 'processing',
    paymentStatus: 'paid',
    paymentProvider: 'mollie',
    molliePaymentId: `tr_test_${n}`,
    molliePaidAt: PAYE_LE,
    accountType: 'particulier',
    orderType: 'standard',
    totalCents: 95990,
    items: [{ name: 'Pompe à injection 104669-2154', unitPriceCents: 93000, quantity: 1, lineTotalCents: 93000 }],
    shippingAddress: { fullName: 'Jean Test', line1: '1 rue de Paris', postalCode: '75001', city: 'Paris', country: 'France' },
    billingAddress: { fullName: 'Jean Test', line1: '1 rue de Paris', postalCode: '75001', city: 'Paris', country: 'France' },
    statusHistory: [],
    refunds: [],
    createdAt: new Date('2026-10-08T15:03:45.000Z'),
    updatedAt: new Date('2026-10-08T15:03:45.000Z'),
  }, over);
  await Order.collection.insertOne(doc);
  return doc;
}

function paiement(cmd, over = {}) {
  return Object.assign({
    id: cmd.molliePaymentId,
    status: 'paid',
    paidAt: PAYE_LE.toISOString(),
    amount: { currency: 'EUR', value: (cmd.totalCents / 100).toFixed(2) },
    amountRefunded: { currency: 'EUR', value: '0.00' },
  }, over);
}

/* Appelle le vrai webhook du site, comme Mollie le ferait. */
async function webhook(cmd, payment) {
  const vrai = mollie.getPayment;
  mollie.getPayment = async () => payment;
  try {
    const res = { code: 0, status(c) { this.code = c; return this; }, send() { return this; } };
    await checkout.postPaymentWebhook({ body: { id: cmd.molliePaymentId }, query: {} }, res, (err) => { throw err; });
    assert.strictEqual(res.code, 200);
  } finally {
    mollie.getPayment = vrai;
  }
  return Order.findById(cmd._id).lean();
}

const HISTO_REMBOURSEE = [
  { status: 'pending_payment', changedAt: new Date('2026-10-08T15:03:45Z'), changedBy: 'client', note: '' },
  { status: 'paid', changedAt: new Date('2026-10-08T15:06:20Z'), changedBy: 'mollie', note: '' },
  { status: 'processing', changedAt: new Date('2026-10-08T15:06:20Z'), changedBy: 'system', note: 'Passage automatique en préparation après paiement' },
  { status: 'refunded', changedAt: new Date('2026-10-19T08:00:01Z'), changedBy: 'contact@carpartsfrance.fr', note: 'Remboursement 959.90 € via mollie — Rupture de stock - annulation client' },
];

test('rappels de paiement Mollie : une commande traitée ne bouge plus', async (t) => {
  serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());

  const vraiEmail = emailService.sendOrderConfirmationEmail;
  const vraiSms = smsService.sendOrderConfirmationSms;
  emailService.sendOrderConfirmationEmail = async () => { confirmations.email += 1; return { ok: true }; };
  smsService.sendOrderConfirmationSms = async () => { confirmations.sms += 1; return { ok: true }; };

  t.after(async () => {
    emailService.sendOrderConfirmationEmail = vraiEmail;
    smsService.sendOrderConfirmationSms = vraiSms;
    await mongoose.disconnect();
    await serveur.stop();
  });

  const u = await User.collection.insertOne({
    firstName: 'Jean', lastName: 'Test', email: 'jean.test@example.com',
    passwordHash: 'x', passwordSalt: 'y', accountType: 'particulier', addresses: [],
    createdAt: new Date(), updatedAt: new Date(),
  });
  userId = u.insertedId;

  await t.test('remboursée puis rappel de Mollie : elle reste « Remboursée », même date de paiement', async () => {
    const cmd = await commande({
      status: 'refunded',
      statusHistory: HISTO_REMBOURSEE,
      refunds: [{ amountCents: 95990, method: 'mollie', kind: 'standard', providerRefundId: 're_connu', reason: 'Rupture de stock', createdAt: new Date('2026-10-19T08:00:01Z'), createdBy: 'contact@carpartsfrance.fr' }],
    });
    const apres = await webhook(cmd, paiement(cmd, {
      amountRefunded: { currency: 'EUR', value: '959.90' },
      _embedded: { refunds: [{ id: 're_connu', amount: { currency: 'EUR', value: '959.90' }, status: 'refunded' }] },
    }));
    assert.strictEqual(apres.status, 'refunded');
    assert.strictEqual(apres.paymentStatus, 'paid', 'convention du site : le paiement reste « paid », c’est le statut qui dit « remboursée »');
    assert.strictEqual(apres.statusHistory.length, HISTO_REMBOURSEE.length, 'aucune ligne « payée / en préparation » ajoutée');
    assert.strictEqual(new Date(apres.molliePaidAt).getTime(), PAYE_LE.getTime(), 'la date de paiement ne bouge pas');
    assert.strictEqual(apres.refunds.length, 1, 'pas de remboursement en double');
  });

  await t.test('remboursement fait depuis Mollie : enregistré, et la commande passe en « Remboursée »', async () => {
    const cmd = await commande({ status: 'processing', statusHistory: HISTO_REMBOURSEE.slice(0, 3) });
    const apres = await webhook(cmd, paiement(cmd, {
      amountRefunded: { currency: 'EUR', value: '959.90' },
      _embedded: { refunds: [{ id: 're_dashboard', amount: { currency: 'EUR', value: '959.90' }, status: 'refunded', description: 'Rupture' }] },
    }));
    assert.strictEqual(apres.status, 'refunded');
    assert.strictEqual(apres.refunds.length, 1);
    assert.strictEqual(apres.statusHistory.filter((h) => h.status === 'processing').length, 1, 'pas de nouveau passage en préparation');
  });

  await t.test('étiquette créée : un rappel de Mollie ne la renvoie pas en préparation', async () => {
    const cmd = await commande({
      status: 'label_created',
      statusHistory: [...HISTO_REMBOURSEE.slice(0, 3), { status: 'label_created', changedAt: new Date(), changedBy: 'faniri', note: 'Étiquette créée' }],
    });
    const apres = await webhook(cmd, paiement(cmd));
    assert.strictEqual(apres.status, 'label_created');
    assert.strictEqual(apres.statusHistory.length, 4);
  });

  await t.test('consigne remboursée sur une commande livrée : rien ne bouge', async () => {
    const cmd = await commande({ status: 'delivered', statusHistory: [{ status: 'delivered', changedAt: new Date(), changedBy: 'faniri', note: '' }] });
    const apres = await webhook(cmd, paiement(cmd, { amountRefunded: { currency: 'EUR', value: '99.00' } }));
    assert.strictEqual(apres.status, 'delivered');
    assert.strictEqual(apres.statusHistory.length, 1);
  });

  await t.test('paiement normal : en préparation, date de Mollie, une seule confirmation même si deux rappels arrivent ensemble', async () => {
    const avantEmail = confirmations.email;
    const avantSms = confirmations.sms;
    const cmd = await commande({
      status: 'pending_payment', paymentStatus: 'pending', molliePaidAt: null,
      statusHistory: [{ status: 'pending_payment', changedAt: new Date(), changedBy: 'client', note: '' }],
    });
    const p = paiement(cmd, { paidAt: '2026-11-08T10:00:00.000Z' });
    const vrai = mollie.getPayment;
    mollie.getPayment = async () => p;
    try {
      const res = () => ({ status() { return this; }, send() { return this; } });
      await Promise.all([
        checkout.postPaymentWebhook({ body: { id: cmd.molliePaymentId }, query: {} }, res(), (e) => { throw e; }),
        checkout.postPaymentWebhook({ body: { id: cmd.molliePaymentId }, query: {} }, res(), (e) => { throw e; }),
      ]);
    } finally {
      mollie.getPayment = vrai;
    }
    const apres = await Order.findById(cmd._id).lean();
    assert.strictEqual(apres.status, 'processing');
    assert.strictEqual(apres.paymentStatus, 'paid');
    assert.strictEqual(new Date(apres.molliePaidAt).toISOString(), '2026-11-08T10:00:00.000Z');
    assert.strictEqual(apres.statusHistory.filter((h) => h.status === 'paid').length, 1, 'une seule ligne « payée »');
    assert.strictEqual(apres.statusHistory.filter((h) => h.status === 'processing').length, 1, 'une seule ligne « en préparation »');
    assert.strictEqual(confirmations.email - avantEmail, 1, 'un seul e-mail de confirmation');
    assert.strictEqual(confirmations.sms - avantSms, 1, 'un seul SMS de confirmation');
    assert.ok(apres.invoice && apres.invoice.number, 'facture émise');
    const compteur = await mongoose.connection.db.collection('invoicecounters').findOne({});
    assert.strictEqual(compteur.seq, 1, 'un seul numéro de facture pris au compteur');
  });

  await t.test('paiement arrivé après une annulation (sans remboursement) : la commande repart, comme avant', async () => {
    const cmd = await commande({
      status: 'cancelled', paymentStatus: 'failed', molliePaidAt: null,
      statusHistory: [{ status: 'cancelled', changedAt: new Date(), changedBy: 'admin', note: '' }],
    });
    const apres = await webhook(cmd, paiement(cmd));
    assert.strictEqual(apres.status, 'processing');
    assert.strictEqual(apres.paymentStatus, 'paid');
  });

  await t.test('annulée et remboursée : un rappel de Mollie ne la rouvre pas', async () => {
    const cmd = await commande({
      status: 'cancelled',
      statusHistory: [...HISTO_REMBOURSEE.slice(0, 3), { status: 'cancelled', changedAt: new Date(), changedBy: 'admin', note: '' }],
      refunds: [{ amountCents: 95990, method: 'mollie', kind: 'standard', providerRefundId: 're_annule', reason: 'Annulation', createdAt: new Date(), createdBy: 'admin' }],
    });
    const apres = await webhook(cmd, paiement(cmd, {
      amountRefunded: { currency: 'EUR', value: '959.90' },
      _embedded: { refunds: [{ id: 're_annule', amount: { currency: 'EUR', value: '959.90' }, status: 'refunded' }] },
    }));
    assert.strictEqual(apres.status, 'cancelled');
  });

  await t.test('réparation des commandes déjà touchées par le bug', async () => {
    const bug = (avant, paye = 'mollie') => [
      ...HISTO_REMBOURSEE.slice(0, 3),
      avant,
      { status: 'paid', changedAt: new Date('2026-10-19T10:03:42Z'), changedBy: paye, note: '' },
      { status: 'processing', changedAt: new Date('2026-10-19T10:03:42Z'), changedBy: 'system', note: 'Passage automatique en préparation après paiement' },
    ];
    const remboursee = await commande({ statusHistory: bug(HISTO_REMBOURSEE[3]), molliePaidAt: new Date('2026-10-19T10:03:42Z') });
    const etiquette = await commande({ statusHistory: bug({ status: 'label_created', changedAt: new Date('2026-11-03T11:01:45Z'), changedBy: 'faniri', note: '' }) });
    // Remise à la main par l'équipe après le bug : on n'y touche pas.
    const deja = await commande({ status: 'refunded', statusHistory: [...bug(HISTO_REMBOURSEE[3]), { status: 'refunded', changedAt: new Date(), changedBy: 'admin', note: '' }] });
    // Avancée depuis par l'équipe (étiquette refaite) : pas touchée.
    const avancee = await commande({ status: 'label_created', statusHistory: [...bug(HISTO_REMBOURSEE[3]), { status: 'label_created', changedAt: new Date(), changedBy: 'faniri', note: '' }] });
    // Remboursement partiel : la pièce peut encore devoir partir → à la main.
    const partielle = await commande({ statusHistory: bug({ status: 'partially_refunded', changedAt: new Date(), changedBy: 'admin', note: '' }) });
    // Commande normale, payée puis en préparation : pas touchée.
    const normale = await commande({ statusHistory: HISTO_REMBOURSEE.slice(0, 3) });

    await repairRefundedOrdersReopened(mongoose.connection);

    const lire = async (c) => Order.findById(c._id).lean();
    const r1 = await lire(remboursee);
    assert.strictEqual(r1.status, 'refunded');
    assert.strictEqual(new Date(r1.molliePaidAt).getTime(), new Date('2026-10-08T15:06:20Z').getTime(), 'date du premier paiement rétablie');
    assert.match(r1.statusHistory[r1.statusHistory.length - 1].note, /rétabli/);
    assert.strictEqual((await lire(etiquette)).status, 'label_created');
    assert.strictEqual((await lire(deja)).status, 'refunded');
    assert.strictEqual((await lire(deja)).statusHistory.length, 7);
    assert.strictEqual((await lire(avancee)).statusHistory.length, 7);
    assert.strictEqual((await lire(partielle)).status, 'processing');
    assert.strictEqual((await lire(normale)).status, 'processing');

    // Une seule exécution : une nouvelle commande « buggée » n'est plus touchée.
    const apres = await commande({ statusHistory: bug(HISTO_REMBOURSEE[3]) });
    await repairRefundedOrdersReopened(mongoose.connection);
    assert.strictEqual((await lire(apres)).status, 'processing');
    const marqueur = await mongoose.connection.db.collection('migrationsapplied').findOne({ key: 'repair-orders-reopened-by-payment-webhook-v1' });
    assert.deepStrictEqual(marqueur.repaired.map((r) => r.status).sort(), ['label_created', 'refunded']);
  });

  await t.test('reconnaissance du motif, cas limites', () => {
    assert.strictEqual(statutAvantLeBug([]), null);
    assert.strictEqual(statutAvantLeBug(HISTO_REMBOURSEE), null);
    assert.strictEqual(statutAvantLeBug(null), null);
  });
});
