/**
 * Leads : « Gagné » posé puis annulé laissait la date de conversion → relances
 * de réachat (J+90) chez quelqu'un qui n'a rien acheté. Une vraie commande
 * liée garde sa date.
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
process.env.ADMIN_EMAIL = 'proprio-leads@example.com';
process.env.ADMIN_PASSWORD = 'mot-de-passe-leads';
process.env.DE_AUTO_TRANSLATE = 'false';

test('lead : annuler « Gagné » retire la date de conversion manuelle', async (t) => {
  const serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  let http;
  t.after(async () => {
    if (http) await new Promise((r) => http.close(r));
    await mongoose.disconnect();
    await serveur.stop();
  });

  const AdminUser = require('../../src/models/AdminUser');
  const AbandonedCart = require('../../src/models/AbandonedCart');
  const sel = 'sel-leads';
  await AdminUser.create({
    firstName: 'Paul', lastName: 'Proprio', email: process.env.ADMIN_EMAIL, role: 'owner', isActive: true,
    passwordSalt: sel, passwordHash: crypto.scryptSync(process.env.ADMIN_PASSWORD, sel, 64).toString('hex'),
  });
  const simple = await AbandonedCart.create({ sessionId: 'sess-lead-simple', abandonedAt: new Date(), email: 'lead-simple@example.com', items: [] });
  const avecCommande = await AbandonedCart.create({
    sessionId: 'sess-lead-commande', abandonedAt: new Date(), email: 'lead-commande@example.com', items: [],
    recoveredOrder: { orderId: new mongoose.Types.ObjectId(), number: 'CP2026-000123', totalCents: 129000, at: new Date() },
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
  const statut = (id, status) => fetch(`${base}/admin/api/leads/${id}/status`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
  }).then((r) => r.json());

  await t.test('Gagné puis annulé : plus de date de conversion', async () => {
    assert.equal((await statut(simple._id, 'converted')).ok, true);
    assert.ok((await AbandonedCart.findById(simple._id).lean()).recoveredAt);
    assert.equal((await statut(simple._id, null)).ok, true);
    assert.equal((await AbandonedCart.findById(simple._id).lean()).recoveredAt, null);
  });

  await t.test('commande réellement liée : la date reste', async () => {
    await statut(avecCommande._id, 'converted');
    await statut(avecCommande._id, null);
    assert.ok((await AbandonedCart.findById(avecCommande._id).lean()).recoveredAt);
  });
});
