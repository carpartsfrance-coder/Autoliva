/**
 * Leads : deux envois simultanés du même e-mail (deux onglets, deux collègues)
 * ne partent qu'une fois. L'envoi d'e-mail est remplacé par un faux (rien ne
 * part). Un envoi suivant, une fois le premier fini, reste possible.
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
process.env.ADMIN_EMAIL = 'proprio-envoi@example.com';
process.env.ADMIN_PASSWORD = 'mot-de-passe-envoi';
process.env.DE_AUTO_TRANSLATE = 'false';

test('lead : un seul e-mail pour deux envois simultanés', async (t) => {
  const serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  let http;
  t.after(async () => {
    if (http) await new Promise((r) => http.close(r));
    await mongoose.disconnect();
    await serveur.stop();
  });

  // Faux envoi, posé AVANT le chargement de l'application (le contrôleur le lit au démarrage).
  const emailService = require('../../src/services/emailService');
  let envois = 0;
  emailService.sendEmail = async () => { envois += 1; await new Promise((r) => setTimeout(r, 200)); return { ok: true }; };

  const AdminUser = require('../../src/models/AdminUser');
  const AbandonedCart = require('../../src/models/AbandonedCart');
  const sel = 'sel-envoi';
  await AdminUser.create({
    firstName: 'Paul', lastName: 'Proprio', email: process.env.ADMIN_EMAIL, role: 'owner', isActive: true,
    passwordSalt: sel, passwordHash: crypto.scryptSync(process.env.ADMIN_PASSWORD, sel, 64).toString('hex'),
  });
  const lead = await AbandonedCart.create({ sessionId: 'sess-envoi', abandonedAt: new Date(), email: 'lead-envoi@example.com', items: [] });

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
  const envoyer = () => fetch(`${base}/admin/api/leads/${lead._id}/email`, {
    method: 'POST', headers: { Cookie: cookie, 'Content-Type': 'application/json' },
    body: JSON.stringify({ subject: 'Votre devis', body: 'Bonjour {prenom}, voici votre devis.' }),
  }).then((r) => r.status);

  const statuts = await Promise.all([envoyer(), envoyer()]);
  assert.equal(envois, 1, 'un seul e-mail parti');
  assert.deepEqual(statuts.sort(), [200, 409]);
  // Le verrou est retiré juste APRÈS la réponse (bloc finally) : on lui laisse un instant.
  let verrou = true;
  for (let i = 0; i < 20 && verrou; i += 1) {
    verrou = !!(await AbandonedCart.findById(lead._id).lean()).envoiEnCoursAt;
    if (verrou) await new Promise((r) => setTimeout(r, 50));
  }
  assert.ok(!verrou, 'verrou retiré');

  assert.equal(await envoyer(), 200, 'un nouvel envoi reste possible ensuite');
  assert.equal(envois, 2);
  const apres = await AbandonedCart.findById(lead._id).lean();
  assert.equal(apres.manualEmailsSent, 2);

  // Même verrou pour l'envoi d'un devis moteur (formulaire classique → réponse texte).
  const { avecVerrouEnvoi } = require('../../src/services/verrouEnvoiLead');
  let devisEnvoyes = 0;
  const envoiDevis = avecVerrouEnvoi(async (req, res) => {
    devisEnvoyes += 1; await new Promise((r) => setTimeout(r, 150)); res.status(302).send('ok');
  }, { texte: true, dureeMs: 3 * 60 * 1000 });
  const faux = () => new Promise((resolve) => {
    const res = { code: 0, status(c) { this.code = c; return this; }, send(b) { resolve({ code: this.code, b }); return this; }, json(b) { resolve({ code: this.code, b, json: true }); return this; } };
    envoiDevis({ params: { id: String(lead._id) } }, res, (err) => resolve({ err }));
  });
  const [r1, r2] = await Promise.all([faux(), faux()]);
  assert.equal(devisEnvoyes, 1, 'un seul devis');
  const bloque = [r1, r2].find((r) => r.code === 409);
  assert.ok(bloque && typeof bloque.b === 'string' && !bloque.json, 'réponse texte 409');
});
