/**
 * Tableau de bord : de vrais chiffres.
 *  - le CA du mois n'inclut pas les cautions de consigne ;
 *  - plus de « +12 % » / « +5.2% » écrits en dur ni de faux bandeau « Maintenance » ;
 *  - « Stock bas » = fiches publiées à 1 ou 2 pièces (pas les ruptures).
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
process.env.ADMIN_EMAIL = 'admin-tdb@example.com';
process.env.ADMIN_PASSWORD = 'mot-de-passe-de-test-tdb';
process.env.DE_AUTO_TRANSLATE = 'false';

test('tableau de bord : chiffres réels', async (t) => {
  const serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  let http;
  t.after(async () => {
    if (http) await new Promise((r) => http.close(r));
    await mongoose.disconnect();
    await serveur.stop();
  });

  const Order = require('../../src/models/Order');
  const Product = require('../../src/models/Product');
  const client = new mongoose.Types.ObjectId();
  const base = {
    userId: client, accountType: 'particulier', status: 'paid',
    items: [{ name: 'Mécatronique DQ200', unitPriceCents: 100000, quantity: 1, lineTotalCents: 100000 }],
    shippingAddress: { fullName: 'A', line1: '1 rue', postalCode: '13000', city: 'Marseille' },
    billingAddress: { fullName: 'A', line1: '1 rue', postalCode: '13000', city: 'Marseille' },
    subtotalCents: 100000,
  };
  // 1 230,00 € payés dont 230,00 € de caution → 1 000,00 € de CA ; + 500,00 € sans caution.
  await Order.create({ ...base, number: 'CPTDB-1', totalCents: 123000, consigne: { chargedTotalCents: 23000 } });
  await Order.create({ ...base, number: 'CPTDB-2', totalCents: 50000 });
  await Product.collection.insertMany([
    { name: 'Rupture', slug: 'rupture-tdb', priceCents: 1000, stockQty: 0, isPublished: true },
    { name: 'Bas', slug: 'bas-tdb', priceCents: 1000, stockQty: 2, isPublished: true },
    { name: 'Brouillon bas', slug: 'brouillon-tdb', priceCents: 1000, stockQty: 1, isPublished: false },
  ]);

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
  const html = await (await fetch(`${url}/admin/`, { headers: { Cookie: cookie } })).text();
  const texte = html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');

  await t.test('CA du mois sans les cautions', () => {
    assert.match(texte, /C\.A\. \(mois en cours\) 1 500,00 €/); // les espaces insécables sont ramenés à des espaces ci-dessus
  });
  await t.test('plus de faux chiffres ni de faux bandeau', () => {
    assert.ok(!/\+12%|\+5\.2%|Maintenance Serveur/.test(html));
  });
  await t.test('stock bas : 1 fiche (publiée, 1 ou 2 pièces)', () => {
    assert.match(texte, /Stock bas \(1 ou 2 pièces\) 1 article/);
  });
});
