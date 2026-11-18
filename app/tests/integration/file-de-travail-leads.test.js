/**
 * File de travail commerciale (/admin/activite-panier) et page Devis
 * (/admin/devis-moteurs) — de bout en bout, par les vraies routes.
 *
 * Problèmes constatés le 18/11/2026 et couverts ici :
 *  - les demandes des landings ponts/boîtes/moteurs n'apparaissaient JAMAIS
 *    dans « À traiter » (197 dossiers « Nouveau » sur 200) ;
 *  - la page Devis plafonnait à 200 dossiers (limit sans pagination) ;
 *  - « Contacté » sortait le client de la file sans prochaine action ;
 *  - 209 robots du formulaire de blog noyaient la file.
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
process.env.ADMIN_EMAIL = 'faniry-file@example.com';
process.env.ADMIN_PASSWORD = 'mot-de-passe-file';
process.env.DE_AUTO_TRANSLATE = 'false';

test('file de travail : toutes les vraies demandes, une suite pour chacune', async (t) => {
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
  const sel = 'sel-file';
  await AdminUser.create({
    firstName: 'Faniry', lastName: 'R', email: process.env.ADMIN_EMAIL, role: 'owner', isActive: true,
    passwordSalt: sel, passwordHash: crypto.scryptSync(process.env.ADMIN_PASSWORD, sel, 64).toString('hex'),
  });

  const maintenant = Date.now();
  const pont = await AbandonedCart.create({
    sessionId: 's-pont', captureSource: 'landing_ponts', email: 'pont-ads@example.com', phone: '+33608610148',
    abandonedAt: new Date(maintenant - 30 * 60000), lastActivityAt: new Date(maintenant - 30 * 60000),
    attribution: { gclid: 'Cj0KCQ-test', medium: 'cpc', source: 'google' },
    requested: { plate: 'BE251FQ', vehicle: 'Boîte de transfert reconditionné(e)', ref: 'AUT-2026-11-TEST01' },
  });
  const devis = await AbandonedCart.create({
    sessionId: 's-devis', captureSource: 'devis', email: 'devis-fiche@example.com', phone: '0753093140',
    abandonedAt: new Date(maintenant - 3600000), lastActivityAt: new Date(maintenant - 3600000),
    requested: { ref: '02E 325 025', vin: 'VSSZZZ5FZGR076791' },
  });
  /* Demande de juillet jamais traitée : perdue de fait, hors file (mise en
     ligne du 18/11 : 2 901 dossiers de ce genre faussaient les compteurs). */
  await AbandonedCart.create({
    sessionId: 's-vieux', captureSource: 'devis', email: 'vieille-demande@example.com', phone: '0611111111',
    abandonedAt: new Date(maintenant - 60 * 86400000), createdAt: new Date(maintenant - 60 * 86400000),
    lastActivityAt: new Date(maintenant - 60 * 86400000),
  });
  /* Vieille demande mais suivie : une prochaine action est posée → dans la file. */
  await AbandonedCart.create({
    sessionId: 's-vieux-suivi', captureSource: 'devis', email: 'vieille-suivie@example.com', phone: '0622222222',
    abandonedAt: new Date(maintenant - 60 * 86400000), createdAt: new Date(maintenant - 60 * 86400000),
    lastActivityAt: new Date(maintenant - 60 * 86400000),
    nextAction: { type: 'callback', dueAt: new Date(maintenant + 86400000) },
  });
  await AbandonedCart.create({
    sessionId: 's-news', captureSource: 'newsletter', email: 'newsletter-seule@example.com',
    abandonedAt: new Date(maintenant - 3600000), lastActivityAt: new Date(maintenant - 3600000),
  });
  await AbandonedCart.create({
    sessionId: 's-robot', captureSource: 'blog_cta', email: 'robot-archive@example.jp', phone: '+12732963132',
    archived: true, archivedReason: 'spam automatique',
    abandonedAt: new Date(maintenant - 3600000), lastActivityAt: new Date(maintenant - 3600000),
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
  const page = async (url) => (await fetch(base + url, { headers: { cookie } })).text();
  const post = async (url, body) => {
    const r = await fetch(base + url, { method: 'POST', headers: { cookie, 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body || {}) });
    return { status: r.status, data: await r.json() };
  };

  await t.test('la demande de landing pont est dans « À traiter », pas la newsletter ni le robot', async () => {
    const html = await page('/admin/activite-panier');
    assert.ok(html.includes('pont-ads@example.com'), 'lead landing pont visible');
    assert.ok(html.includes('devis-fiche@example.com'), 'demande de devis visible');
    assert.ok(!html.includes('newsletter-seule@example.com'), 'newsletter hors file');
    assert.ok(!html.includes('robot-archive@example.jp'), 'robot archivé hors file');
    assert.ok(html.includes('Nouvelles demandes'));
    assert.ok(!html.includes('vieille-demande@example.com'), 'demande de plus de 45 jours jamais traitée : hors file');
    assert.ok(html.includes('vieille-suivie@example.com'), 'vieille demande suivie (prochaine action) : dans la file');
    const tous = await page('/admin/activite-panier?q=vieille-demande@example.com');
    assert.ok(tous.includes('vieille-demande@example.com'), 'toujours retrouvable par la recherche');
  });

  await t.test('vue boîte mail : une ligne et une fiche par client, avec la pièce et la prochaine action', async () => {
    const html = await page('/admin/activite-panier');
    const lignes = (html.match(/class="lead-ligne /g) || []).length;
    const fiches = (html.match(/class="lead-fiche /g) || []).length;
    assert.ok(lignes >= 3 && lignes === fiches, `autant de fiches que de lignes (${lignes}/${fiches})`);
    assert.ok(html.includes(`id="fiche-${pont._id}"`), 'fiche du lead pont');
    assert.ok(html.includes('La prochaine action'));
    assert.ok(html.includes('Boîte de transfert'), 'pièce lue dans la demande de la landing');
  });

  await t.test('lien direct vers un lead ouvert dans le navigateur : la fiche, pas le JSON', async () => {
    const r = await fetch(`${base}/admin/activite-panier/${devis._id}`, { headers: { cookie, Accept: 'text/html,application/xhtml+xml' }, redirect: 'manual' });
    assert.equal(r.status, 302);
    assert.match(r.headers.get('location'), new RegExp('lead=' + devis._id));
    const j = await fetch(`${base}/admin/activite-panier/${devis._id}`, { headers: { cookie, Accept: 'application/json' } });
    assert.equal((await j.json()).ok, true, 'le script de la page reçoit toujours le JSON');
  });

  await t.test('appel « client joint » puis perdu : le dossier devis passe aussi en perdu', async () => {
    const l0 = await AbandonedCart.create({ sessionId: 's-appel-perdu', captureSource: 'landing_boites', email: 'appel-perdu@example.com',
      phone: '+33612345678', abandonedAt: new Date(), lastActivityAt: new Date(), engineQuote: { status: 'analyzing' } });
    const r = await post(`/admin/api/leads/${l0._id}/appel`, { resultat: 'joint', suite: 'perdu', motif: 'deja_achete' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const l = await AbandonedCart.findById(l0._id).lean();
    assert.equal(l.manualStatus, 'lost');
    assert.equal(l.engineQuote.status, 'lost');
    await AbandonedCart.deleteOne({ _id: l0._id });
  });

  await t.test('« J’ai appelé » exige un résultat et une suite', async () => {
    const r1 = await post(`/admin/api/leads/${devis._id}/appel`, {});
    assert.equal(r1.status, 400);
    const r2 = await post(`/admin/api/leads/${devis._id}/appel`, { resultat: 'joint' });
    assert.equal(r2.status, 400, 'joint sans suite refusé');
  });

  await t.test('pas de réponse : rappel posé tout seul, le client reste dans la file', async () => {
    const r = await post(`/admin/api/leads/${pont._id}/appel`, { resultat: 'pas_reponse' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const l = await AbandonedCart.findById(pont._id).lean();
    assert.equal(l.manualStatus, 'contacted', 'compatibilité : coupe toujours les relances panier');
    assert.equal(l.lastCallOutcome.outcome, 'pas_reponse');
    assert.equal(l.nextAction.type, 'callback');
    assert.ok(new Date(l.nextAction.dueAt).getTime() > Date.now(), 'rappel dans le futur');
    assert.equal(l.takenByName, 'Faniry', 'pris en charge par celle qui appelle');
    const html = await page('/admin/activite-panier');
    assert.ok(html.includes('pont-ads@example.com'), 'toujours dans la file après « Contacté »');
  });

  await t.test('prendre un dossier déjà pris demande confirmation', async () => {
    await AbandonedCart.updateOne({ _id: devis._id }, { $set: { takenByName: 'Andy' } });
    const r = await post(`/admin/api/leads/${devis._id}/prendre`, {});
    assert.equal(r.status, 409);
    assert.match(r.data.error, /Andy/);
    const r2 = await post(`/admin/api/leads/${devis._id}/prendre`, { force: true });
    assert.equal(r2.status, 200);
    assert.equal((await AbandonedCart.findById(devis._id).lean()).takenByName, 'Faniry');
  });

  await t.test('planifier une prochaine action', async () => {
    const r = await post(`/admin/api/leads/${devis._id}/prochaine-action`, { type: 'quote', quand: '2j', note: 'Photo étiquette' });
    assert.equal(r.status, 200, JSON.stringify(r.data));
    const l = await AbandonedCart.findById(devis._id).lean();
    assert.equal(l.nextAction.type, 'quote');
    assert.equal(l.nextAction.note, 'Photo étiquette');
    const passe = await post(`/admin/api/leads/${devis._id}/prochaine-action`, { type: 'quote', quand: '2020-01-01T10:00:00Z' });
    assert.equal(passe.status, 400, 'date passée refusée');
  });

  await t.test('perdu exige un motif ; le dossier devis passe aussi en perdu', async () => {
    await AbandonedCart.updateOne({ _id: pont._id }, { $set: { engineQuote: { status: 'new' } } });
    const r1 = await post(`/admin/api/leads/${pont._id}/cloturer`, { issue: 'perdu' });
    assert.equal(r1.status, 400);
    const r2 = await post(`/admin/api/leads/${pont._id}/cloturer`, { issue: 'perdu', motif: 'prix' });
    assert.equal(r2.status, 200);
    const l = await AbandonedCart.findById(pont._id).lean();
    assert.equal(l.manualStatus, 'lost');
    assert.equal(l.lostReason, 'prix');
    assert.equal(l.engineQuote.status, 'lost');
    const html = await page('/admin/activite-panier');
    assert.ok(!html.includes('pont-ads@example.com'), 'perdu = hors de la file');
  });

  await t.test('gagné exige la confirmation du paiement', async () => {
    const r1 = await post(`/admin/api/leads/${devis._id}/cloturer`, { issue: 'gagne' });
    assert.equal(r1.status, 400);
    const r2 = await post(`/admin/api/leads/${devis._id}/cloturer`, { issue: 'gagne', confirme: true, moyen: 'Virement' });
    assert.equal(r2.status, 200);
    assert.equal((await AbandonedCart.findById(devis._id).lean()).manualStatus, 'converted');
  });

  await t.test('page Devis : plus de plafond à 200, pagination et compteurs sur toute la base', async () => {
    const lot = [];
    for (let i = 0; i < 230; i += 1) {
      const d = new Date(maintenant - (i + 2) * 3600000);
      lot.push({ sessionId: 's-lot-' + i, captureSource: 'landing_ponts', email: `lot${i}@example.com`, phone: '+3361234' + String(1000 + i),
        abandonedAt: d, lastActivityAt: d, requested: { ref: 'AUT-LOT-' + i } });
    }
    await AbandonedCart.insertMany(lot);
    const html = await page('/admin/devis-moteurs');
    /* 230 du lot + le dossier pont (perdu, mais pas archivé). */
    assert.match(html, /1–50 sur 231 dossiers/);
    const html5 = await page('/admin/devis-moteurs?page=5');
    assert.match(html5, /201–231 sur 231 dossiers/);
  });

  await t.test('formulaire de blog : le robot ne crée rien, le vrai client oui', async () => {
    const avant = await AbandonedCart.countDocuments({ captureSource: 'blog_cta' });
    const robot = await fetch(`${base}/api/lead/blog-cta`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'tina@yahoo.co.jp', phone: '+19353224406', firstName: 'Tina', message: 'this product is tasty.' }) });
    assert.equal((await robot.json()).ok, true, 'le robot croit avoir réussi');
    assert.equal(await AbandonedCart.countDocuments({ captureSource: 'blog_cta' }), avant, 'aucun lead créé');
    const vrai = await fetch(`${base}/api/lead/blog-cta`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'claude.client@example.fr', phone: '0678900639', vehicle: 'Audi SQ8', message: 'Bloquée en 3e après vidange' }) });
    assert.equal((await vrai.json()).ok, true);
    assert.equal(await AbandonedCart.countDocuments({ captureSource: 'blog_cta' }), avant + 1, 'vrai lead créé');
    const piege = await fetch(`${base}/api/lead/blog-cta`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'bot2@example.com', vehicle: 'Golf', website: 'http://spam' }) });
    assert.equal((await piege.json()).ok, true);
    assert.equal(await AbandonedCart.countDocuments({ captureSource: 'blog_cta' }), avant + 1, 'champ-piège : rien créé');
  });
});
