/**
 * Commandes : la suppression DÉFINITIVE groupée (sans corbeille) est réservée
 * au propriétaire. Un employé reçoit 403 et la commande reste.
 *
 * Lancé par : npm test (mongodb-memory-server).
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.BRAND = 'autoliva';
delete process.env.MONGODB_URI;
delete process.env.SCALAPAY_ENABLED;
for (const cle of ['MAILERSEND_API_KEY', 'BREVO_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'MOLLIE_API_KEY',
  'MOLLIE_ORGANIZATION_TOKEN', 'SCALAPAY_API_KEY', 'PARCELWILL_API_KEY', 'TRACK17_API_KEY', 'MCP_BEARER_TOKEN',
  'BLOG_IMPORT_API_TOKEN', 'COMPTOIR_API_KEY', 'JUMINGO_API_KEY']) {
  process.env[cle] = '';
}
process.env.SAV_API_TOKEN = 'jeton-sav-de-test';
process.env.ADMIN_EMAIL = 'proprio-suppr@example.com';
process.env.ADMIN_PASSWORD = 'mot-de-passe-proprio-suppr';
process.env.DE_AUTO_TRANSLATE = 'false';

test('commandes : suppression définitive groupée interdite à un employé', async (t) => {
  const serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  let http;
  t.after(async () => {
    if (http) await new Promise((r) => http.close(r));
    await mongoose.disconnect();
    await serveur.stop();
  });

  const AdminUser = require('../../src/models/AdminUser');
  const Order = require('../../src/models/Order');
  const sel = 'sel-suppr';
  await AdminUser.create({
    firstName: 'Emma', lastName: 'Ployée', email: 'employe-suppr@example.com', role: 'employe', isActive: true,
    passwordSalt: sel, passwordHash: crypto.scryptSync('mot-de-passe-employe', sel, 64).toString('hex'),
  });
  await AdminUser.create({
    firstName: 'Paul', lastName: 'Proprio', email: process.env.ADMIN_EMAIL, role: 'owner', isActive: true,
    passwordSalt: sel, passwordHash: crypto.scryptSync(process.env.ADMIN_PASSWORD, sel, 64).toString('hex'),
  });
  const nouvelle = (n) => Order.create({
    userId: new mongoose.Types.ObjectId(), number: n, status: 'paid', accountType: 'particulier',
    items: [{ name: 'Pièce', unitPriceCents: 1000, quantity: 1, lineTotalCents: 1000 }],
    shippingAddress: { fullName: 'A', line1: '1 rue', postalCode: '13000', city: 'Marseille' },
    billingAddress: { fullName: 'A', line1: '1 rue', postalCode: '13000', city: 'Marseille' },
    subtotalCents: 1000, totalCents: 1000,
  });
  const c1 = await nouvelle('CPSUPPR-1');
  const c2 = await nouvelle('CPSUPPR-2');

  const app = require('../../src/app');
  http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${http.address().port}`;
  async function connexion(email, password) {
    const r = await fetch(`${base}/admin/connexion`, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email, password }).toString(), redirect: 'manual',
    });
    return (r.headers.get('set-cookie') || '').split(';')[0];
  }
  const supprimer = (cookie, id) => fetch(`${base}/admin/commandes/supprimer-multi`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ orderIds: String(id) }).toString(), redirect: 'manual',
  });

  await t.test('employé : 403, la commande reste', async () => {
    const cookie = await connexion('employe-suppr@example.com', 'mot-de-passe-employe');
    assert.ok(cookie, 'connexion employé');
    const r = await supprimer(cookie, c1._id);
    assert.equal(r.status, 403);
    assert.ok(await Order.exists({ _id: c1._id }));
  });

  await t.test('propriétaire : inchangé (suppression possible)', async () => {
    const cookie = await connexion(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);
    const r = await supprimer(cookie, c2._id);
    assert.equal(r.status, 200);
    assert.equal(await Order.exists({ _id: c2._id }), null);
  });
});
