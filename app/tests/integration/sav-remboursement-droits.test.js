/**
 * Le jeton de l'API SAV est remis à tout admin connecté qui ouvre le SAV. Un
 * EMPLOYÉ (sans le droit « orders.refund ») ne doit pas pouvoir rembourser par
 * l'API SAV ce que la fiche commande lui interdit.
 *
 * Lancé par : npm test (mongodb-memory-server, clés d'envoi et de paiement
 * vides : rien ne peut partir).
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
process.env.ADMIN_EMAIL = 'proprio-sav@example.com';
process.env.ADMIN_PASSWORD = 'mot-de-passe-proprio-sav';
process.env.DE_AUTO_TRANSLATE = 'false';

test('SAV : remboursement interdit à un employé', async (t) => {
  const serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  let http;
  t.after(async () => {
    if (http) await new Promise((r) => http.close(r));
    await mongoose.disconnect();
    await serveur.stop();
  });

  const AdminUser = require('../../src/models/AdminUser');
  const sel = 'sel-employe-test';
  await AdminUser.create({
    firstName: 'Emma', lastName: 'Ployée', email: 'employe-sav@example.com', role: 'employe', isActive: true,
    passwordSalt: sel, passwordHash: crypto.scryptSync('mot-de-passe-employe', sel, 64).toString('hex'),
  });

  await AdminUser.create({
    firstName: 'Paul', lastName: 'Proprio', email: process.env.ADMIN_EMAIL, role: 'owner', isActive: true,
    passwordSalt: sel, passwordHash: crypto.scryptSync(process.env.ADMIN_PASSWORD, sel, 64).toString('hex'),
  });

  const app = require('../../src/app');
  http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${http.address().port}`;

  async function connexion(email, password) {
    const r = await fetch(`${base}/admin/connexion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email, password }).toString(),
      redirect: 'manual',
    });
    return (r.headers.get('set-cookie') || '').split(';')[0];
  }
  const rembourser = (cookie) => fetch(`${base}/admin/api/sav/tickets/SAV-INEXISTANT/refund`, {
    method: 'POST',
    headers: { Authorization: 'Bearer jeton-sav-de-test', 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
    body: JSON.stringify({ amountCents: 1000 }),
  });

  await t.test('employé connecté : 403, même avec le jeton', async () => {
    const cookie = await connexion('employe-sav@example.com', 'mot-de-passe-employe');
    assert.ok(cookie, 'connexion employé');
    const r = await rembourser(cookie);
    assert.equal(r.status, 403);
  });

  await t.test('propriétaire connecté : la demande passe le contrôle (ticket inconnu → 404)', async () => {
    const cookie = await connexion(process.env.ADMIN_EMAIL, process.env.ADMIN_PASSWORD);
    assert.ok(cookie, 'connexion propriétaire');
    const r = await rembourser(cookie);
    assert.equal(r.status, 404);
  });

  await t.test('appel serveur avec le jeton seul : inchangé (404 ticket inconnu)', async () => {
    const r = await rembourser('');
    assert.equal(r.status, 404);
  });
});
