/**
 * Avoir SANS remboursement — servi par la VRAIE application, derrière la vraie
 * connexion admin.
 *
 * Killian rembourse parfois hors du site (virement, geste commercial) : l'avoir
 * est le document comptable, l'argent part ailleurs. Ce qui doit être garanti :
 * aucun remboursement n'est enregistré, rien ne part chez Mollie, le statut de
 * la commande ne bouge pas — et la comptabilité voit quand même l'avoir.
 *
 * Lancé par : npm test (mongodb-memory-server, clés d'envoi vides).
 */

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.BRAND = 'autoliva';
delete process.env.MONGODB_URI;
for (const cle of ['MAILERSEND_API_KEY', 'BREVO_API_KEY', 'MOLLIE_API_KEY', 'MOLLIE_ORGANIZATION_TOKEN',
  'SCALAPAY_API_KEY', 'COMPTOIR_API_KEY', 'SKEEPERS_API_KEY', 'JUMINGO_API_KEY']) {
  process.env[cle] = '';
}
process.env.ADMIN_EMAIL = 'admin-avoir@example.com';
process.env.ADMIN_PASSWORD = 'mot-de-passe-de-test-avoir';
process.env.DE_AUTO_TRANSLATE = 'false';

let serveur;
let http;
let base;
let cookie = '';

async function requete(chemin, { method = 'GET', form, sansSession = false } = {}) {
  const headers = {};
  if (!sansSession && cookie) headers.Cookie = cookie;
  let body;
  if (form) { headers['Content-Type'] = 'application/x-www-form-urlencoded'; body = new URLSearchParams(form).toString(); }
  const r = await fetch(base + chemin, { method, headers, body, redirect: 'manual' });
  const type = r.headers.get('content-type') || '';
  const corps = type.includes('application/pdf') ? Buffer.from(await r.arrayBuffer()) : await r.text();
  return { status: r.status, corps, entetes: r.headers };
}

test('avoir sans remboursement', async (t) => {
  serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  t.after(async () => {
    if (http) await new Promise((r) => http.close(r));
    await mongoose.disconnect();
    await serveur.stop();
  });

  const Order = require('../../src/models/Order');
  const User = require('../../src/models/User');
  const refundService = require('../../src/services/refundService');
  const mollie = require('../../src/services/mollie');

  /* Filet : si un chemin oublié appelait Mollie, le test le verrait. */
  let appelsMollie = 0;
  const vraiRefund = mollie.createRefund;
  mollie.createRefund = async (...a) => { appelsMollie += 1; return vraiRefund ? vraiRefund(...a) : {}; };
  t.after(() => { mollie.createRefund = vraiRefund; });

  const client = await User.create({
    email: 'client-avoir@example.com', passwordHash: 'x'.repeat(20), passwordSalt: 'y'.repeat(16),
    firstName: 'Paul', lastName: 'Renard', accountType: 'particulier',
  });

  const commande = await Order.create({
    userId: client._id,
    number: 'CPTEST-AV-001',
    status: 'delivered',
    paymentStatus: 'paid',
    accountType: 'particulier',
    totalCents: 120000,
    subtotalCents: 120000,
    items: [{ name: 'Pont avant BMW X5 E70', sku: '0BD525013C', unitPriceCents: 120000, quantity: 1, lineTotalCents: 120000 }],
    shippingAddress: { fullName: 'Paul Renard', line1: '2 rue du Test', postalCode: '69001', city: 'Lyon' },
    billingAddress: { fullName: 'Paul Renard', line1: '2 rue du Test', postalCode: '69001', city: 'Lyon' },
  });
  const id = String(commande._id);

  const app = require('../../src/app');
  http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${http.address().port}`;

  await t.test('sans session : refusé, et rien n’est créé', async () => {
    const r = await requete(`/admin/commandes/${id}/avoir`, { method: 'POST', form: { amount: '50' }, sansSession: true });
    assert.ok(r.status === 401 || r.status === 302, `attendu 401/302, reçu ${r.status}`);
    assert.equal((await Order.findById(id).lean()).creditNotes.length, 0);
  });

  await t.test('connexion admin', async () => {
    const r = await fetch(`${base}/admin/connexion`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ email: process.env.ADMIN_EMAIL, password: process.env.ADMIN_PASSWORD, returnTo: '/admin/commandes' }).toString(),
      redirect: 'manual',
    });
    assert.equal(r.status, 302);
    cookie = (r.headers.get('set-cookie') || '').split(';')[0];
    assert.ok(cookie);
  });

  await t.test('un avoir seul : aucun remboursement, aucun appel Mollie, statut inchangé', async () => {
    const r = await requete(`/admin/commandes/${id}/avoir`, {
      method: 'POST',
      form: { amount: '120,50', reason: 'Geste commercial', notes: 'remboursé par virement le 23/09' },
    });
    assert.equal(r.status, 302, r.corps.slice(0, 200));

    const o = await Order.findById(id).lean();
    assert.equal(o.creditNotes.length, 1);
    const cn = o.creditNotes[0];
    assert.match(cn.number, /^AV-\d{4}-\d{4}$/);
    assert.equal(cn.totalCents, 12050);
    assert.equal(cn.reason, 'Geste commercial');
    assert.equal(cn.notes, 'remboursé par virement le 23/09');
    assert.equal(cn.refundIndex, null, 'aucun remboursement rattaché');
    assert.ok(cn.pdfSizeBytes > 500, 'le PDF est stocké');

    assert.equal(o.refunds.length, 0, 'aucun remboursement enregistré');
    assert.equal(o.status, 'delivered', 'le statut de la commande ne bouge pas');
    assert.equal(appelsMollie, 0, 'aucun appel à Mollie');
    assert.ok(!(o.emailsSent || []).some((e) => e.type === 'refund_issued'), 'aucun e-mail client');
  });

  await t.test('la fiche commande l’affiche, et le PDF se télécharge', async () => {
    const page = await requete(`/admin/commandes/${id}`);
    assert.equal(page.status, 200);
    const numero = (await Order.findById(id).lean()).creditNotes[0].number;
    assert.match(page.corps, /Avoirs sans remboursement par le site/);
    assert.ok(page.corps.includes(numero), 'le numéro d’avoir est affiché');
    assert.match(page.corps, /Créer un avoir/, 'le bouton est proposé');

    const pdf = await requete(`/admin/commandes/${id}/avoir/${encodeURIComponent(numero)}/pdf`);
    assert.equal(pdf.status, 200);
    assert.match(pdf.entetes.get('content-type') || '', /application\/pdf/);
    assert.equal(pdf.corps.slice(0, 4).toString(), '%PDF');
  });

  await t.test('le plafond tient compte des avoirs déjà émis', async () => {
    const avant = (await Order.findById(id).lean()).creditNotes.length;
    const r = await requete(`/admin/commandes/${id}/avoir`, { method: 'POST', form: { amount: '1200' } });
    assert.equal(r.status, 302);
    const o = await Order.findById(id).lean();
    assert.equal(o.creditNotes.length, avant, 'rien n’est créé au-delà du total de la commande');
    const page = await requete(`/admin/commandes/${id}`);
    assert.match(page.corps, /dépasse ce qui reste à avoir/);
  });

  await t.test('montant invalide : refusé', async () => {
    for (const amount of ['', '0', '-10', 'abc']) {
      const avant = (await Order.findById(id).lean()).creditNotes.length;
      await requete(`/admin/commandes/${id}/avoir`, { method: 'POST', form: { amount } });
      assert.equal((await Order.findById(id).lean()).creditNotes.length, avant, `montant "${amount}" accepté à tort`);
    }
  });

  await t.test('la comptabilité compte cet avoir comme les autres', async () => {
    const accounting = require('../../src/services/accountingService');
    const from = new Date(Date.now() - 86400000);
    const to = new Date(Date.now() + 86400000);
    const liste = await accounting.listCreditNotes({ from, to, page: 1, limit: 50 });
    const numero = (await Order.findById(id).lean()).creditNotes[0].number;
    const ligne = (liste.items || liste.rows || []).find((x) => x && (x.number === numero || x.creditNoteNumber === numero));
    assert.ok(ligne, 'l’avoir apparaît dans la liste comptable');
  });

  await t.test('un remboursement normal continue de fonctionner (manuel, sans Mollie)', async () => {
    const r = await refundService.processOrderRefund({
      orderId: id, amountCents: 1000, method: 'bank_transfer', reason: 'Retour partiel',
      generateCreditNote: true, sendEmail: false, adminEmail: 'admin-test',
    });
    assert.equal(r.ok, true);
    const o = await Order.findById(id).lean();
    assert.equal(o.refunds.length, 1);
    assert.equal(o.status, 'partially_refunded');
    const lie = o.creditNotes.find((c) => Number.isInteger(c.refundIndex));
    assert.ok(lie, 'l’avoir du remboursement reste rattaché à celui-ci');
    assert.equal(appelsMollie, 0);
  });
});
