/**
 * La chaîne de requête traverse la vraie pile de redirections (28/11/2026).
 *
 * Lancé par : npm test (mongodb-memory-server : aucune base externe, jamais la
 * production). Clés d'envoi vides, serveur sur un port éphémère.
 *
 * Les tests unitaires (tests/unit/redirection-requete.test.js) prouvent la
 * mécanique ; ici on vérifie qu'un vrai GET traverse la vraie chaîne de
 * middlewares sans que le ?gclid= tombe en route — c'est ce qu'on ne voyait
 * pas en lisant le code règle par règle.
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

const SLUG = 'mecatronique-dsg7-dq200-reconditionnee-0am927769d';
const ID = new mongoose.Types.ObjectId();

const FICHE = {
  _id: ID,
  name: 'Mécatronique DSG7 DQ200 reconditionnée',
  category: 'Mécatroniques',
  sku: '0AM927769D',
  slug: SLUG,
  slugHistory: [],
  priceCents: 89900,
  isPublished: true,
  inStock: true,
  imageUrl: '',
  galleryUrls: [],
  galleryTypes: [],
  shortDescription: 'Mécatronique testée au banc.',
  description: '<p>Mécatronique testée au banc.</p>',
  keyPoints: [],
  specs: [],
  faqs: [],
  compatibility: [],
  compatibleReferences: [],
  searchSynonyms: [],
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-11-28T00:00:00Z'),
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

test('le gclid traverse les redirections du site', async (t) => {
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

  await t.test('ancienne adresse WordPress : le gclid arrive sur la page légale', async () => {
    const r = await get('/cgv?gclid=TEST123');
    assert.strictEqual(r.status, 301);
    assert.strictEqual(r.location, '/legal/cgv?gclid=TEST123');
  });

  await t.test('ancien article WordPress : gclid et utm suivent ensemble', async () => {
    const r = await get('/mecatronique-dsg-6/?gclid=TEST123&utm_source=newsletter');
    assert.strictEqual(r.status, 301);
    assert.strictEqual(
      r.location,
      '/blog/mecatronique-dsg6-dq250-diagnostic-prix-remplacement?gclid=TEST123&utm_source=newsletter'
    );
  });

  await t.test('cible déjà paramétrée : la recherche garde son q ET le gclid', async () => {
    const r = await get('/tag-produit/mecatronique?gclid=TEST123');
    assert.strictEqual(r.status, 301);
    assert.strictEqual(r.location, '/produits?q=mecatronique&gclid=TEST123');
  });

  await t.test('fiche atteinte par son identifiant : le gclid va jusqu’au slug', async () => {
    /* Le cas d'un lien d'admin ou d'une vieille annonce : /product/<_id> part
       en 301 vers l'adresse canonique. Deux sauts (slash final, puis
       canonique), le gclid doit survivre aux deux. */
    const premier = await get(`/product/${ID}?gclid=TEST123`);
    assert.strictEqual(premier.status, 301);
    assert.strictEqual(premier.location, `/product/${ID}/?gclid=TEST123`);

    const second = await get(premier.location);
    assert.strictEqual(second.status, 301);
    assert.strictEqual(second.location, `/product/${SLUG}/?gclid=TEST123`);

    const arrivee = await get(second.location);
    assert.strictEqual(arrivee.status, 200);
  });

  await t.test('sans requête, les cibles restent nues', async () => {
    const r = await get('/cgv');
    assert.strictEqual(r.status, 301);
    assert.strictEqual(r.location, '/legal/cgv');
  });
});
