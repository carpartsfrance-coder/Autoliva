/**
 * Deux remboursements lancés en même temps sur la même commande (double clic,
 * deux onglets, deux personnes) : un seul doit passer. Avant, les deux
 * passaient le contrôle « reste remboursable » puis appelaient Mollie.
 *
 * Lancé par : npm test (mongodb-memory-server ; méthode « manual » : aucun
 * appel à Mollie ni à Scalapay, aucun e-mail).
 */
const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.BRAND = 'autoliva';
delete process.env.MONGODB_URI;
for (const cle of ['MAILERSEND_API_KEY', 'BREVO_API_KEY', 'MOLLIE_API_KEY', 'SCALAPAY_API_KEY']) process.env[cle] = '';

test('remboursements simultanés : un seul passe', async (t) => {
  const serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  t.after(async () => { await mongoose.disconnect(); await serveur.stop(); });

  const Order = require('../../src/models/Order');
  const refundService = require('../../src/services/refundService');
  const commande = await Order.create({
    userId: new mongoose.Types.ObjectId(),
    number: 'CPTEST-VERROU-1',
    status: 'delivered',
    accountType: 'particulier',
    items: [{ name: 'Mécatronique DQ200', unitPriceCents: 100000, quantity: 1, lineTotalCents: 100000 }],
    shippingAddress: { fullName: 'Test Verrou', line1: '1 rue', postalCode: '13000', city: 'Marseille' },
    billingAddress: { fullName: 'Test Verrou', line1: '1 rue', postalCode: '13000', city: 'Marseille' },
    subtotalCents: 100000,
    totalCents: 100000,
  });

  const demande = () => refundService.processOrderRefund({
    orderId: commande._id, amountCents: 100000, method: 'manual', reason: 'test', generateCreditNote: false, sendEmail: false,
  });
  const resultats = await Promise.all([demande(), demande(), demande()]);
  const reussis = resultats.filter((r) => r && r.ok);
  assert.equal(reussis.length, 1, JSON.stringify(resultats.map((r) => r.errorCode || 'ok')));
  const o = await Order.findById(commande._id).lean();
  assert.equal(o.refunds.length, 1);
  assert.equal(o.status, 'refunded');
  assert.ok(!o.refundLockAt, 'verrou relâché');

  // Après coup, une nouvelle demande est bien refusée pour dépassement (pas pour verrou).
  const apres = await demande();
  assert.equal(apres.errorCode, 'amount_exceeds_total');
});

test('Scalapay non remboursé par l’API : pas d’e-mail « remboursement émis »', async (t) => {
  const serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  t.after(async () => { await mongoose.disconnect(); await serveur.stop(); });

  const Order = require('../../src/models/Order');
  const User = require('../../src/models/User');
  const emailService = require('../../src/services/emailService');
  const refundService = require('../../src/services/refundService');
  const envois = [];
  const vrai = emailService.sendRefundIssuedEmail;
  emailService.sendRefundIssuedEmail = async () => { envois.push(1); return { ok: true }; };
  t.after(() => { emailService.sendRefundIssuedEmail = vrai; });

  const client = await User.create({
    email: 'client-scalapay@example.com', passwordHash: 'x'.repeat(20), passwordSalt: 'y'.repeat(16),
    firstName: 'Léa', lastName: 'Scalapay', accountType: 'particulier',
  });
  const commande = await Order.create({
    userId: client._id, number: 'CPTEST-SCALA-1', status: 'delivered', accountType: 'particulier',
    items: [{ name: 'Boîte DQ200', unitPriceCents: 50000, quantity: 1, lineTotalCents: 50000 }],
    shippingAddress: { fullName: 'Léa', line1: '1 rue', postalCode: '13000', city: 'Marseille' },
    billingAddress: { fullName: 'Léa', line1: '1 rue', postalCode: '13000', city: 'Marseille' },
    subtotalCents: 50000, totalCents: 50000,
  });

  const r = await refundService.processOrderRefund({
    orderId: commande._id, amountCents: 20000, method: 'scalapay', generateCreditNote: false, sendEmail: true,
  });
  assert.equal(r.ok, true);
  assert.equal(r.actionManuelle, true);
  assert.equal(r.refund.providerStatus, 'manual_required');
  assert.equal(envois.length, 0, 'aucun e-mail « remboursement émis »');
});
