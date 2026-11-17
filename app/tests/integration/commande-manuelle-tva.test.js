/**
 * Commande manuelle (back-office) : « TVA 0 % (export) » donnait 20 % côté
 * serveur (0 || 20). Une valeur absente garde 20 %.
 *
 * Lancé par : npm test (mongodb-memory-server, clés d'envoi vides).
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
  'BLOG_IMPORT_API_TOKEN', 'SAV_API_TOKEN', 'COMPTOIR_API_KEY', 'JUMINGO_API_KEY']) {
  process.env[cle] = '';
}
process.env.ADMIN_EMAIL = 'proprio-manuelle@example.com';
process.env.ADMIN_PASSWORD = 'mot-de-passe-manuelle';
process.env.DE_AUTO_TRANSLATE = 'false';

test('commande manuelle : taux de TVA respecté', async (t) => {
  const serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  let http;
  t.after(async () => {
    if (http) await new Promise((r) => http.close(r));
    await mongoose.disconnect();
    await serveur.stop();
  });

  const AdminUser = require('../../src/models/AdminUser');
  const User = require('../../src/models/User');
  const Order = require('../../src/models/Order');
  const sel = 'sel-manuelle';
  await AdminUser.create({
    firstName: 'Paul', lastName: 'Proprio', email: process.env.ADMIN_EMAIL, role: 'owner', isActive: true,
    passwordSalt: sel, passwordHash: crypto.scryptSync(process.env.ADMIN_PASSWORD, sel, 64).toString('hex'),
  });
  const client = await User.create({
    email: 'client-export@example.com', passwordHash: 'x'.repeat(20), passwordSalt: 'y'.repeat(16),
    firstName: 'Hans', lastName: 'Export', accountType: 'pro', companyName: 'Export GmbH',
  });

  const app = require('../../src/app');
  http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${http.address().port}`;
  const connexion = await fetch(`${base}/admin/connexion`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD }).toString(),
    redirect: 'manual',
  });
  const cookie = (connexion.headers.get('set-cookie') || '').split(';')[0];
  assert.ok(cookie, 'connexion admin');

  const creer = (extra) => fetch(`${base}/admin/api/commandes/manuelle`, {
    method: 'POST',
    headers: { Cookie: cookie, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({
      clientId: String(client._id),
      initialStatus: 'draft',
      items: [{ name: 'Mécatronique DQ200', unitPriceCents: 100000, quantity: 1 }],
      shippingAddress: { fullName: 'Hans Export', line1: '1 Hauptstraße', postalCode: '10115', city: 'Berlin', country: 'Allemagne' },
      ...extra,
    }),
  }).then(async (r) => ({ status: r.status, corps: await r.json() }));

  await t.test('TVA 0 % (export) : total = HT', async () => {
    const r = await creer({ tvaRate: 0 });
    assert.equal(r.corps.ok, true, JSON.stringify(r.corps));
    const o = await Order.findOne({ userId: client._id }).sort({ createdAt: -1 }).lean();
    assert.equal(o.totalCents, 100000);
  });

  await t.test('taux absent : 20 % comme avant', async () => {
    await Order.deleteMany({ userId: client._id });
    const r = await creer({});
    assert.equal(r.corps.ok, true, JSON.stringify(r.corps));
    const o = await Order.findOne({ userId: client._id }).lean();
    assert.equal(o.totalCents, 120000);
  });
});
