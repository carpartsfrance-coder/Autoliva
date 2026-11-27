/**
 * Renommage d'adresse de fiche — retrait des noms de fournisseurs des URLs
 * (27/11/2026).
 *
 * Lancé par : npm test (mongodb-memory-server : aucune base externe, jamais la
 * production). Clés d'envoi vides, serveur sur un port éphémère.
 *
 * Ce qui est vérifié :
 *   1. slugHistory sert l'ancienne adresse en 301 vers la nouvelle. Sans ça un
 *      renommage envoie la page vers /produits?q=… (noindex) : Google perd la
 *      page, le client voit une liste au lieu de sa pièce.
 *   2. La chaîne de requête SURVIT à la redirection, y compris au passage par
 *      /product/<slug> → /product/<slug>/ : un clic Google Ads doit arriver sur
 *      la fiche avec son gclid, sinon la conversion n'est plus rattachée à
 *      l'annonce (Ads = premier canal de leads).
 *   3. Un slug réellement inconnu garde le repli d'avant.
 */

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

/* Configuration AVANT tout require de l'application. */
process.env.BRAND = 'autoliva';
delete process.env.MONGODB_URI;
delete process.env.SITE_URL;
for (const cle of ['MAILERSEND_API_KEY', 'BREVO_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
  'MOLLIE_API_KEY', 'MOLLIE_ORGANIZATION_TOKEN', 'TRACK17_API_KEY']) {
  process.env[cle] = '';
}
process.env.DE_AUTO_TRANSLATE = 'false';
process.env.TRACK17_ENABLED = 'false';

const NOUVEAU = 'moteur-bkd-2-0-tdi-140ch-reconditionne-0100205699';
const ANCIEN = 'moteur-bkd-2-0-tdi-140ch-reconditionne-distrimotor-0100205699';

const FICHE = {
  _id: new mongoose.Types.ObjectId(),
  name: 'Moteur BKD 2.0 TDI 140 ch reconditionné',
  category: 'Moteurs',
  sku: 'BKD',
  slug: NOUVEAU,
  slugHistory: [ANCIEN],
  priceCents: 199900,
  isPublished: true,
  inStock: true,
  imageUrl: '',
  galleryUrls: [],
  galleryTypes: [],
  shortDescription: 'Bloc reconditionné, rodé au banc.',
  description: '<p>Bloc reconditionné, rodé au banc.</p>',
  keyPoints: [],
  specs: [],
  faqs: [],
  compatibility: [],
  compatibleReferences: [],
  searchSynonyms: [],
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-11-27T00:00:00Z'),
};

let mongo;
let http;
let base;
let prochainOctet = 1;

/** Une requête, sans suivre les redirections, depuis une IP toujours nouvelle
 *  (le limiteur du site ne doit pas se mêler de ces tests). */
async function get(chemin) {
  const r = await fetch(base + chemin, {
    redirect: 'manual',
    headers: { Accept: 'text/html', 'CF-Connecting-IP': `198.51.100.${(prochainOctet++ % 250) + 1}` },
  });
  return { status: r.status, location: r.headers.get('location') };
}

test('adresse de fiche renommée : l’ancienne reste servie en 301', async (t) => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
  await mongoose.connection.db.collection('products').insertOne(FICHE);

  const app = require('../../src/app');
  http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${http.address().port}`;

  t.after(async () => {
    if (http) await new Promise((r) => http.close(r));
    await mongoose.disconnect();
    await mongo.stop();
  });

  await t.test('l’ancienne adresse part en 301 vers la nouvelle', async () => {
    const r = await get(`/product/${ANCIEN}/`);
    assert.strictEqual(r.status, 301);
    assert.strictEqual(r.location, `/product/${NOUVEAU}/`);
  });

  await t.test('la nouvelle adresse est servie (200)', async () => {
    const r = await get(`/product/${NOUVEAU}/`);
    assert.strictEqual(r.status, 200);
  });

  await t.test('le gclid survit au renommage', async () => {
    const r = await get(`/product/${ANCIEN}/?gclid=TEST123`);
    assert.strictEqual(r.status, 301);
    assert.strictEqual(r.location, `/product/${NOUVEAU}/?gclid=TEST123`);
  });

  await t.test('le gclid survit AUSSI à l’ajout du slash final', async () => {
    /* Le cas réel d'un clic Ads : l'annonce pointe souvent /product/<slug>
       sans slash. La normalisation du slash ne doit pas manger la requête. */
    const r = await get(`/product/${NOUVEAU}?gclid=TEST123`);
    assert.strictEqual(r.status, 301);
    assert.strictEqual(r.location, `/product/${NOUVEAU}/?gclid=TEST123`);
  });

  await t.test('l’ancienne adresse sans slash : les deux sauts gardent le gclid', async () => {
    const premier = await get(`/product/${ANCIEN}?gclid=TEST123`);
    assert.strictEqual(premier.status, 301);
    assert.strictEqual(premier.location, `/product/${ANCIEN}/?gclid=TEST123`);
    const second = await get(premier.location);
    assert.strictEqual(second.status, 301);
    assert.strictEqual(second.location, `/product/${NOUVEAU}/?gclid=TEST123`);
  });

  await t.test('sans requête, l’adresse de redirection reste nue', async () => {
    const r = await get(`/product/${NOUVEAU}`);
    assert.strictEqual(r.status, 301);
    assert.strictEqual(r.location, `/product/${NOUVEAU}/`);
  });

  await t.test('un slug vraiment inconnu garde le repli vers la recherche', async () => {
    const r = await get('/product/slug-qui-na-jamais-existe-xyz/');
    assert.strictEqual(r.status, 301);
    assert.match(r.location, /^\/produits\?q=/);
  });
});
