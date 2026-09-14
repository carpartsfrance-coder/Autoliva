/**
 * Garde-fous d'exploration servis par la VRAIE application — plan de reprise
 * SEO du 14/09/2026, action A4 (PR-1a : aucune modification d'indexation).
 *
 * Lancé par : npm test (mongodb-memory-server : aucune base externe, jamais la
 * production). Aucun envoi possible : clés vides, pas de MONGODB_URI (sessions
 * en mémoire), serveur sur un port éphémère, DNS remplacé par une doublure.
 *
 * Chaque bloc correspond à un point de l'action A4 ; tous passent par
 * app.js, ses middlewares et ses routes, comme une requête de Google.
 */

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

/* Configuration AVANT tout require de l'application : brand.js et app.js lisent
   l'environnement au chargement. La production tourne sous BRAND=autoliva. */
process.env.BRAND = 'autoliva';
delete process.env.MONGODB_URI; // sessions en mémoire, jamais de base externe
delete process.env.SCALAPAY_ENABLED;
delete process.env.SHOW_PRODUCT_DESCRIPTION;
delete process.env.SITE_URL;
for (const cle of ['MAILERSEND_API_KEY', 'BREVO_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'MOLLIE_API_KEY',
  'MOLLIE_ORGANIZATION_TOKEN', 'SCALAPAY_API_KEY', 'PARCELWILL_API_KEY', 'TRACK17_API_KEY', 'MCP_BEARER_TOKEN',
  'BLOG_IMPORT_API_TOKEN', 'SAV_API_TOKEN', 'COMPTOIR_API_KEY']) {
  process.env[cle] = '';
}
process.env.DE_AUTO_TRANSLATE = 'false';

const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const UA_GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

let serveur;
let http;
let base;

async function get(chemin, { ua = UA_CHROME, ip, entetes = {} } = {}) {
  const headers = { 'User-Agent': ua, Accept: 'text/html,application/xml', ...entetes };
  if (ip) headers['CF-Connecting-IP'] = ip;
  const r = await fetch(base + chemin, { redirect: 'manual', headers });
  return { status: r.status, location: r.headers.get('location'), headers: r.headers, corps: await r.text() };
}

/* DNS de test : un seul « vrai » Googlebot, 66.249.66.1. */
const erreurDns = (code) => Object.assign(new Error(code), { code });
const DNS_TEST = {
  reverse: async (ip) => {
    if (ip === '66.249.66.1') return ['crawl-66-249-66-1.googlebot.com'];
    throw erreurDns('ENOTFOUND');
  },
  resolve4: async (nom) => {
    if (nom === 'crawl-66-249-66-1.googlebot.com') return ['66.249.66.1'];
    throw erreurDns('ENODATA');
  },
  resolve6: async () => { throw erreurDns('ENODATA'); },
};

test('garde-fous d’exploration servis par l’application (plan SEO A4)', async (t) => {
  serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());

  const app = require('../../src/app');
  const robotsVerifies = require('../../src/services/robotsVerifies');
  robotsVerifies.verificateur.definirResolveurs(DNS_TEST);
  robotsVerifies.verificateur.viderCache();

  http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${http.address().port}`;

  t.after(async () => {
    if (http) await new Promise((r) => http.close(r));
    await mongoose.disconnect();
    await serveur.stop();
  });

  /* ── A4.3 — limiteur des sitemaps et des flux ─────────────────────────── */

  await t.test('A4.3 limiteur : un compteur par visiteur Cloudflare, jamais un 429 pour un Googlebot vérifié', async () => {
    /* Toutes ces requêtes arrivent par la même socket (127.0.0.1), comme
       derrière un même nœud Cloudflare. Seul CF-Connecting-IP les distingue. */
    const scraper = '203.0.113.50';
    for (let i = 1; i <= 30; i++) {
      assert.equal((await get('/sitemap-pages.xml', { ip: scraper })).status, 200, `requête ${i} du scraper`);
    }
    assert.equal((await get('/sitemap-pages.xml', { ip: scraper })).status, 429, 'la 31e est freinée');

    assert.equal((await get('/sitemap-pages.xml', { ip: '203.0.113.51' })).status, 200,
      'un autre visiteur derrière le même nœud n’hérite pas du quota du scraper');

    for (let i = 1; i <= 40; i++) {
      const r = await get('/sitemap-pages.xml', { ip: '66.249.66.1', ua: UA_GOOGLEBOT });
      assert.equal(r.status, 200, `Googlebot vérifié, requête ${i}`);
    }

    const fauxGooglebot = '203.0.113.52';
    for (let i = 1; i <= 30; i++) await get('/sitemap-pages.xml', { ip: fauxGooglebot, ua: UA_GOOGLEBOT });
    assert.equal((await get('/sitemap-pages.xml', { ip: fauxGooglebot, ua: UA_GOOGLEBOT })).status, 429,
      'se dire Googlebot ne suffit pas');
  });
});
