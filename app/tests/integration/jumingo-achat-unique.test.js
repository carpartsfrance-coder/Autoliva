/**
 * Étiquette Jumingo : deux demandes d'achat simultanées (deux clics sur deux
 * tarifs, deux onglets) ne doivent acheter qu'UNE étiquette. L'API Jumingo est
 * remplacée par un faux (aucun appel réel, aucun achat).
 *
 * Lancé par : npm test (mongodb-memory-server).
 */

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.BRAND = 'autoliva';
delete process.env.MONGODB_URI;
delete process.env.SCALAPAY_ENABLED;
for (const cle of ['MAILERSEND_API_KEY', 'BREVO_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'MOLLIE_API_KEY',
  'MOLLIE_ORGANIZATION_TOKEN', 'SCALAPAY_API_KEY', 'PARCELWILL_API_KEY', 'TRACK17_API_KEY', 'MCP_BEARER_TOKEN',
  'BLOG_IMPORT_API_TOKEN', 'SAV_API_TOKEN', 'COMPTOIR_API_KEY', 'JUMINGO_API_KEY']) {
  process.env[cle] = '';
}
process.env.ADMIN_EMAIL = 'admin-jumingo@example.com';
process.env.ADMIN_PASSWORD = 'mot-de-passe-de-test-jumingo';
process.env.DE_AUTO_TRANSLATE = 'false';

test('Jumingo : un seul achat pour deux demandes simultanées', async (t) => {
  const serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  let http;
  t.after(async () => {
    if (http) await new Promise((r) => http.close(r));
    await mongoose.disconnect();
    await serveur.stop();
  });

  const jumingo = require('../../src/services/jumingo');
  const vrais = { labelsEnabled: jumingo.labelsEnabled, attachRate: jumingo.attachRate, purchaseLabel: jumingo.purchaseLabel };
  let achats = 0;
  jumingo.labelsEnabled = () => true;
  jumingo.attachRate = async () => { await new Promise((r) => setTimeout(r, 150)); return { ok: true }; };
  jumingo.purchaseLabel = async () => { achats += 1; await new Promise((r) => setTimeout(r, 150)); return { ok: true, orderNumber: 'JMG-' + achats, returnUrl: 'https://example.com/payer' }; };
  t.after(() => Object.assign(jumingo, vrais));

  const Order = require('../../src/models/Order');
  const commande = await Order.create({
    userId: new mongoose.Types.ObjectId(), number: 'CPJMG-1', status: 'paid', accountType: 'particulier',
    items: [{ name: 'Boîte DQ200', unitPriceCents: 50000, quantity: 1, lineTotalCents: 50000 }],
    shippingAddress: { fullName: 'A', line1: '1 rue', postalCode: '13000', city: 'Marseille' },
    billingAddress: { fullName: 'A', line1: '1 rue', postalCode: '13000', city: 'Marseille' },
    subtotalCents: 50000, totalCents: 50000,
  });

  const app = require('../../src/app');
  http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const url = `http://127.0.0.1:${http.address().port}`;
  const connexion = await fetch(`${url}/admin/connexion`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }).toString(),
    redirect: 'manual',
  });
  const cookie = (connexion.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie, 'connexion admin');
  const acheter = (tariffId) => fetch(`${url}/admin/commandes/${commande._id}/jumingo/acheter`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ shipmentId: 'SHIP-1', tariffId, carrier: 'UPS' }),
  }).then(async (r) => ({ status: r.status, corps: await r.json() }));

  const [a, b] = await Promise.all([acheter('T1'), acheter('T2')]);
  assert.equal(achats, 1, 'une seule étiquette achetée');
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  const o = await Order.findById(commande._id).lean();
  assert.ok(o.pendingJumingoLabel && o.pendingJumingoLabel.orderNumber === 'JMG-1');
  assert.ok(!o.jumingoAchatEnCoursAt, 'verrou relâché');
});
