/**
 * Corrections de l'audit SEO du 11/11/2026, servies par la VRAIE application.
 *
 * Lancé par : npm test (mongodb-memory-server : aucune base externe, jamais la
 * production). Aucun envoi possible : clés vides, pas de MONGODB_URI (sessions
 * en mémoire), serveur sur un port éphémère. Requêtes en PRODUCTION du point
 * de vue des robots (hors production, tout le site sort « noindex, nofollow »).
 *
 *   problème 2 : les anciennes adresses de catégories répondent 301 vers la
 *                catégorie qui les remplace (table, renommage dans l'admin,
 *                queue parasite), jamais vers une autre 404 ;
 *   problème 5 : les titres de fiche n'ont plus de « … » et gardent la
 *                référence ;
 *   problème 6 : les pages 2+ d'une catégorie sont indexables, avec leur
 *                propre canonique, title et hreflang ;
 *   consigne 8 : la page 404 dit « noindex », robots.txt ne cite plus /_next/.
 */

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.BRAND = 'autoliva';
delete process.env.MONGODB_URI;
delete process.env.SCALAPAY_ENABLED;
delete process.env.SHOW_PRODUCT_DESCRIPTION;
delete process.env.SITE_URL;
delete process.env.FORCE_NOINDEX;
delete process.env.SEO_PRUNE;
for (const cle of Object.keys(process.env)) if (cle.startsWith('SEO_PRUNE_SINCE_')) delete process.env[cle];
for (const cle of ['MAILERSEND_API_KEY', 'BREVO_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'MOLLIE_API_KEY',
  'MOLLIE_ORGANIZATION_TOKEN', 'SCALAPAY_API_KEY', 'PARCELWILL_API_KEY', 'TRACK17_API_KEY', 'MCP_BEARER_TOKEN',
  'BLOG_IMPORT_API_TOKEN', 'SAV_API_TOKEN', 'COMPTOIR_API_KEY']) {
  process.env[cle] = '';
}
process.env.DE_AUTO_TRANSLATE = 'false';

const UA_GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

let serveur;
let http;
let base;
let prochainOctet = 1;

async function get(chemin) {
  const headers = { 'User-Agent': UA_GOOGLEBOT, Accept: 'text/html,application/xml' };
  headers['CF-Connecting-IP'] = `198.51.100.${(prochainOctet++ % 250) + 1}`;
  const r = await fetch(base + chemin, { redirect: 'manual', headers });
  return { status: r.status, location: r.headers.get('location'), corps: await r.text() };
}

const attr = (html, re) => { const m = html.match(re); return m ? m[1].replace(/&amp;/g, '&') : null; };
const robots = (html) => attr(html, /<meta name="robots" content="([^"]*)"/);
const canonique = (html) => attr(html, /<link rel="canonical" href="([^"]*)"/);
const titre = (html) => attr(html, /<title>([^<]*)<\/title>/);
const hreflangs = (html) => [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)"/g)].map((m) => `${m[1]} ${m[2].replace(/&amp;/g, '&')}`);

test('audit SEO du 11/11/2026 : redirections, pages 2+, titres, 404', async (t) => {
  serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  const db = mongoose.connection.db;

  await db.collection('categories').insertMany([
    { name: 'Ponts & différentiels', slug: 'ponts-differentiels', isActive: true, sortOrder: 4 },
    { name: 'Mécatroniques & calculateurs', slug: 'mecatroniques', isActive: true, sortOrder: 7, slugAliases: ['mecatroniques-calculateurs'] },
    /* Ancienne catégorie gardée en base mais désactivée (scripts/migrate-ponts.js). */
    { name: 'Transmission > Pont / Différentiel', slug: 'transmission-pont-differentiel', isActive: false, sortOrder: 30 },
  ]);

  /* 30 ponts : 24 par page, la page 2 en porte 6. */
  const ponts = [];
  for (let i = 0; i < 30; i += 1) {
    ponts.push({
      _id: new mongoose.Types.ObjectId(),
      name: `Pont arrière reconditionné BMW X5 E70 xDrive35d rapport 3,64 test ${i} - 3310757${String(1000 + i)}`,
      slug: `pont-arriere-test-${i}`,
      sku: `ALV-PT-TEST${i}`,
      category: 'Ponts & différentiels',
      priceCents: 150000 + i,
      isPublished: true,
      badges: { condition: 'Reconditionné' },
    });
  }
  await db.collection('products').insertMany(ponts);
  await db.collection('products').insertOne({
    _id: new mongoose.Types.ObjectId(),
    name: 'Mécatronique DSG7 DQ200 (0AM/0CW) reconditionnée (VAG) avec huile et levier - 0AM325065',
    slug: 'meca-test-dq200',
    sku: 'ALV-MC-TEST',
    category: 'Mécatroniques & calculateurs',
    priceCents: 99000,
    isPublished: true,
  });

  const app = require('../../src/app');
  http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${http.address().port}`;

  const nodeEnvOrigine = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  t.after(async () => {
    process.env.NODE_ENV = nodeEnvOrigine;
    if (http) await new Promise((r) => http.close(r));
    await mongoose.disconnect();
    await serveur.stop();
  });

  await t.test('problème 2 : anciennes adresses de catégories → 301 vers la remplaçante', async () => {
    const attendus = [
      ['/categorie/transmission-pont-differentiel', '/categorie/ponts-differentiels'],
      ['/categorie/ponts-neufs', '/categorie/ponts-differentiels'],
      ['/categorie/transmission-mecatronique', '/categorie/mecatroniques'],
      ['/categorie/electricite-electronique-calculateurs', '/categorie/mecatroniques'],
      /* Renommage fait dans l'admin : l'ancien slug est gardé en base. */
      ['/categorie/mecatroniques-calculateurs', '/categorie/mecatroniques'],
      /* Queue parasite vue dans la Search Console (caractères privés + page). */
      ['/categorie/transmission-pont-differentiel%EE%85%8D%EE%A2%9E%EE%A2%B622', '/categorie/ponts-differentiels'],
      ['/categorie/ponts-differentiels%EE%85%8D%EE%A2%9E%EE%A2%B62', '/categorie/ponts-differentiels'],
      /* Ancienne catégorie mère : le sommaire. */
      ['/categorie/transmission', '/categorie'],
    ];
    for (const [ancienne, nouvelle] of attendus) {
      const r = await get(ancienne);
      assert.equal(r.status, 301, `${ancienne} : statut ${r.status}`);
      assert.equal(r.location, nouvelle, `${ancienne} → ${r.location}`);
    }
  });

  await t.test('problème 2 : jamais de redirection vers une catégorie absente, l’inconnu reste en 404 (noindex)', async () => {
    /* moteur-vilebrequin → moteurs, absente de cette base : 404, pas 301. */
    const r = await get('/categorie/moteur-vilebrequin');
    assert.equal(r.status, 404);
    const inconnue = await get('/categorie/nexiste-pas-du-tout');
    assert.equal(inconnue.status, 404);
    assert.equal(robots(inconnue.corps), 'noindex, follow', 'la page 404 dit noindex');
  });

  await t.test('problème 6 : page 2 indexable, canonique, title et hreflang propres', async () => {
    const p1 = await get('/categorie/ponts-differentiels');
    assert.equal(p1.status, 200);
    assert.match(robots(p1.corps) || '', /^index/);

    const p2 = await get('/categorie/ponts-differentiels?page=2');
    assert.equal(p2.status, 200);
    assert.match(robots(p2.corps) || '', /^index/, `page 2 : ${robots(p2.corps)}`);
    assert.equal(canonique(p2.corps), `${base}/categorie/ponts-differentiels?page=2`);
    assert.match(titre(p2.corps), /– page 2/);
    assert.notEqual(titre(p2.corps), titre(p1.corps));
    for (const h of hreflangs(p2.corps)) assert.ok(h.endsWith('?page=2'), `hreflang de la page 2 : ${h}`);

    /* Un filtre au-delà de la catégorie : toujours hors de Google. */
    const filtree = await get('/categorie/ponts-differentiels?page=2&sort=price_asc');
    assert.equal(robots(filtree.corps), 'noindex, follow');
  });

  await t.test('problème 5 : titre de fiche sans « … », référence gardée', async () => {
    const r = await get('/product/meca-test-dq200/');
    assert.equal(r.status, 200);
    const tt = titre(r.corps);
    assert.ok(tt.length <= 60, tt);
    assert.ok(!tt.includes('…'), tt);
    assert.ok(tt.includes('0AM325065'), tt);
  });

  await t.test('consigne 8 : robots.txt ne cite plus /_next/', async () => {
    const r = await get('/robots.txt');
    assert.equal(r.status, 200);
    assert.ok(!r.corps.includes('/_next/'), 'Disallow: /_next/ encore présent');
    assert.match(r.corps, /Sitemap: .*\/sitemap\.xml/);
  });
});
