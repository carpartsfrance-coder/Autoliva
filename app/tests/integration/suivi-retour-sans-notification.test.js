/**
 * Ajout d'un suivi sur la fiche commande :
 *  - « Retour » (colis qui revient du client) : pas d'e-mail « votre commande est
 *    expédiée » ni de SMS, et la commande payée ne passe PAS en « étiquette créée » ;
 *  - « Envoi » : comportement inchangé (e-mail de suivi + « étiquette créée »).
 *
 * Lancé par : npm test (mongodb-memory-server, clés d'envoi vides).
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
process.env.ADMIN_EMAIL = 'admin-suivi@example.com';
process.env.ADMIN_PASSWORD = 'mot-de-passe-de-test-suivi';
process.env.DE_AUTO_TRANSLATE = 'false';

test('ajout de suivi : « Retour » ne notifie pas le client', async (t) => {
  const serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  let http;
  t.after(async () => {
    if (http) await new Promise((r) => http.close(r));
    await mongoose.disconnect();
    await serveur.stop();
  });

  const Order = require('../../src/models/Order');
  const User = require('../../src/models/User');
  const emailService = require('../../src/services/emailService');
  const smsService = require('../../src/services/smsService');
  const envois = [];
  const vraiEmail = emailService.sendShipmentTrackingEmail;
  const vraiSms = smsService.sendShipmentTrackingSms;
  emailService.sendShipmentTrackingEmail = async ({ shipment }) => { envois.push('email:' + shipment.label); return { ok: true }; };
  smsService.sendShipmentTrackingSms = async ({ shipment }) => { envois.push('sms:' + shipment.label); return { ok: true }; };
  t.after(() => { emailService.sendShipmentTrackingEmail = vraiEmail; smsService.sendShipmentTrackingSms = vraiSms; });

  const client = await User.create({
    email: 'client-suivi@example.com', passwordHash: 'x'.repeat(20), passwordSalt: 'y'.repeat(16),
    firstName: 'Marc', lastName: 'Suivi', accountType: 'particulier',
  });
  let n = 700;
  const commande = async () => String((await Order.create({
    userId: client._id, number: `CPSUIVI-${n++}`, status: 'paid', accountType: 'particulier',
    items: [{ name: 'Boîte DQ200', unitPriceCents: 50000, quantity: 1, lineTotalCents: 50000 }],
    shippingAddress: { fullName: 'Marc Suivi', line1: '1 rue', postalCode: '13000', city: 'Marseille' },
    billingAddress: { fullName: 'Marc Suivi', line1: '1 rue', postalCode: '13000', city: 'Marseille' },
    subtotalCents: 50000, totalCents: 50000,
  }))._id);

  const app = require('../../src/app');
  http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${http.address().port}`;
  const connexion = await fetch(`${base}/admin/connexion`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }).toString(),
    redirect: 'manual',
  });
  const cookie = (connexion.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie, 'connexion admin');
  const ajouterSuivi = (id, label, trackingNumber) => fetch(`${base}/admin/commandes/${id}/suivi`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
    body: new URLSearchParams({ label, carrier: 'UPS', trackingNumber }).toString(),
  }).then((r) => r.json());

  await t.test('« Retour » : aucun message client, statut inchangé', async () => {
    const id = await commande();
    const r = await ajouterSuivi(id, 'Retour', 'RET123');
    assert.equal(r.ok, true, JSON.stringify(r));
    await new Promise((res) => setTimeout(res, 50));
    assert.deepEqual(envois, []);
    const o = await Order.findById(id).lean();
    assert.equal(o.status, 'paid');
    assert.equal(o.shipments.length, 1);
  });

  await t.test('« Envoi » : e-mail de suivi et « étiquette créée » comme avant', async () => {
    const id = await commande();
    const r = await ajouterSuivi(id, 'Envoi', 'ENV456');
    assert.equal(r.ok, true, JSON.stringify(r));
    await new Promise((res) => setTimeout(res, 50));
    assert.ok(envois.includes('email:Envoi'));
    assert.equal((await Order.findById(id).lean()).status, 'label_created');
    assert.match(r.message, /reçu le numéro de suivi/);
  });
});
