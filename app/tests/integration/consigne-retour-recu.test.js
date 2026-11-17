/**
 * « Marquer reçu » sur la consigne d'un échange standard : la commande doit
 * SORTIR de « Consignes en attente » (ce que promet la page), de la pastille
 * du menu et ne plus être « en retard ». Avant : seul consigne.lines était
 * coché, returnStatus restait pending/overdue pour toujours ; et les anciennes
 * commandes sans ligne de consigne n'avaient même pas de bouton.
 *
 * Lancé par : npm test (mongodb-memory-server, clés d'envoi vides : aucun
 * e-mail ni SMS ne peut partir).
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
process.env.ADMIN_EMAIL = 'admin-consigne@example.com';
process.env.ADMIN_PASSWORD = 'mot-de-passe-de-test-consigne';
process.env.DE_AUTO_TRANSLATE = 'false';

const JOUR = 24 * 3600 * 1000;

test('consigne reçue : la commande sort des retours en attente', async (t) => {
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
  const vraiEmail = emailService.sendConsigneReceivedEmail;
  const vraiSms = smsService.sendConsigneReceivedSms;
  emailService.sendConsigneReceivedEmail = async () => { envois.push('email'); return { ok: true }; };
  smsService.sendConsigneReceivedSms = async () => { envois.push('sms'); return { ok: true }; };
  t.after(() => { emailService.sendConsigneReceivedEmail = vraiEmail; smsService.sendConsigneReceivedSms = vraiSms; });

  const client = await User.create({
    email: 'client-consigne@example.com', passwordHash: 'x'.repeat(20), passwordSalt: 'y'.repeat(16),
    firstName: 'Paul', lastName: 'Retour', accountType: 'particulier',
  });

  let numero = 500;
  async function commande(over) {
    const doc = new Order({
      userId: client._id,
      number: `CPCONS-${numero++}`,
      items: [{ name: 'Mécatronique DQ200', sku: '0AM325065S', unitPriceCents: 89000, quantity: 1, lineTotalCents: 89000 }],
      accountType: 'particulier',
      shippingAddress: { fullName: 'Paul Retour', line1: '1 rue du Test', postalCode: '13000', city: 'Marseille' },
      billingAddress: { fullName: 'Paul Retour', line1: '1 rue du Test', postalCode: '13000', city: 'Marseille' },
      subtotalCents: 89000,
      totalCents: 89000,
      status: 'delivered',
      orderType: 'exchange',
      ...over,
    });
    await doc.validate();
    const brut = doc.toObject();
    brut.createdAt = new Date(Date.now() - 60 * JOUR);
    await Order.collection.insertOne(brut);
    return String(brut._id);
  }
  const ligne = (receivedAt = null) => ({
    productId: new mongoose.Types.ObjectId(), name: 'Mécatronique DQ200', quantity: 1, amountCents: 30000,
    delayDays: 30, startAt: new Date(Date.now() - 50 * JOUR), dueAt: new Date(Date.now() - 20 * JOUR), receivedAt,
  });
  const echeancePassee = { returnDueDate: new Date(Date.now() - 20 * JOUR) };

  const ids = {
    avecLigne: await commande({ returnStatus: 'overdue', returnDates: echeancePassee, consigne: { lines: [ligne()] } }),
    sansLigne: await commande({ returnStatus: 'overdue', returnDates: echeancePassee }),
    // Données passées : consigne cochée reçue AVANT le correctif, returnStatus resté « overdue ».
    dejaRecue: await commande({ returnStatus: 'overdue', returnDates: echeancePassee, consigne: { lines: [ligne(new Date(Date.now() - 5 * JOUR))] } }),
    toujoursAttendue: await commande({ returnStatus: 'overdue', returnDates: echeancePassee }),
    // 2 lignes dont UNE seule reçue : toujours attendue.
    moitieRecue: await commande({ returnStatus: 'overdue', returnDates: echeancePassee, consigne: { lines: [ligne(new Date()), ligne()] } }),
    // Échéance passée, encore « pending », consigne déjà reçue : le robot horaire ne doit pas la passer en retard.
    pendingAttendue: await commande({ returnStatus: 'pending', returnDates: echeancePassee }),
    pendingDejaRecue: await commande({ returnStatus: 'pending', returnDates: echeancePassee, consigne: { lines: [ligne(new Date(Date.now() - 2 * JOUR))] } }),
  };
  // Ligne enregistrée SANS champ receivedAt (anciennes données) = pas reçue.
  await Order.collection.updateOne({ _id: new mongoose.Types.ObjectId(ids.moitieRecue) }, { $unset: { 'consigne.lines.1.receivedAt': '' } });
  const numeros = {};
  for (const [cle, id] of Object.entries(ids)) numeros[cle] = (await Order.findById(id).select('number').lean()).number;

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

  const page = async (chemin) => (await fetch(base + chemin, { headers: { Cookie: cookie } })).text();
  const marquer = (id) => fetch(`${base}/admin/commandes/${id}/consigne/recu`, {
    method: 'POST', headers: { Cookie: cookie, Accept: 'application/json', 'X-Requested-With': 'XMLHttpRequest' },
  }).then((r) => r.json());

  await t.test('avant : la consigne déjà cochée reçue n’est plus listée (données passées)', async () => {
    const html = await page('/admin/consignes');
    assert.ok(!html.includes(numeros.dejaRecue), 'consigne déjà reçue : hors liste');
    assert.ok(html.includes(numeros.avecLigne) && html.includes(numeros.sansLigne) && html.includes(numeros.toujoursAttendue));
  });

  await t.test('lignes partiellement reçues (champ absent compris) : toujours listée', async () => {
    const html = await page('/admin/consignes');
    assert.ok(html.includes(numeros.moitieRecue));
  });

  await t.test('robot horaire : une consigne déjà reçue ne passe pas « en retard »', async () => {
    const checkOrderAlerts = require('../../src/jobs/checkOrderAlerts');
    await (checkOrderAlerts.checkOrderAlerts || checkOrderAlerts)();
    assert.equal((await Order.findById(ids.pendingDejaRecue).lean()).returnStatus, 'pending');
    assert.equal((await Order.findById(ids.pendingAttendue).lean()).returnStatus, 'overdue', 'témoin : le robot a bien tourné');
  });

  await t.test('la fiche d’un ancien échange sans ligne de consigne propose « Marquer reçue »', async () => {
    const html = await page(`/admin/commandes/${ids.sansLigne}`);
    assert.match(html, /Ancienne pièce \(échange\)/);
    assert.match(html, /consigne\/recu/);
  });

  await t.test('« Marquer reçu » avec ligne de consigne : statut de retour aligné + e-mail client', async () => {
    const j = await marquer(ids.avecLigne);
    assert.equal(j.ok, true);
    const o = await Order.findById(ids.avecLigne).lean();
    assert.equal(o.returnStatus, 'received');
    assert.ok(o.returnDates.returnReceivedAt);
    assert.ok(o.consigne.lines[0].receivedAt);
    assert.equal(o.statusHistory.at(-1).returnStatus, 'received');
    assert.deepEqual(envois.sort(), ['email', 'sms']);
  });

  await t.test('« Marquer reçue » sans ligne de consigne : statut aligné, aucun message client', async () => {
    envois.length = 0;
    const j = await marquer(ids.sansLigne);
    assert.equal(j.ok, true);
    const o = await Order.findById(ids.sansLigne).lean();
    assert.equal(o.returnStatus, 'received');
    assert.deepEqual(envois, []);
  });

  await t.test('après : seules les commandes vraiment attendues restent listées', async () => {
    const html = await page('/admin/consignes');
    assert.ok(!html.includes(numeros.avecLigne));
    assert.ok(!html.includes(numeros.sansLigne));
    assert.ok(html.includes(numeros.toujoursAttendue));
  });

  await t.test('une commande non échange n’est pas touchée', async () => {
    const id = await commande({ orderType: 'standard', returnStatus: 'not_applicable' });
    const j = await marquer(id);
    assert.equal(j.ok, false);
    assert.equal((await Order.findById(id).lean()).returnStatus, 'not_applicable');
  });
});
