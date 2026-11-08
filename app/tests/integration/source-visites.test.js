/**
 * Compteur des visites gratuites servi par la VRAIE application et lu par les
 * vraies agrégations Mongo (tableau marketing, outils MCP).
 *
 * Lancé par : npm test (mongodb-memory-server : aucune base externe, jamais la
 * production). Aucun envoi possible : clés vides, pas de MONGODB_URI (sessions
 * en mémoire), serveur sur un port éphémère.
 *
 * Diagnostic du 08/11/2026 : seules les URL avec gclid / utm_* étaient
 * enregistrées. Search Console : 6 450 clics gratuits sur 28 jours ; l'outil :
 * 1 visite organique sur 90 jours, et les commandes de ces visiteurs rangées
 * dans « Pré-tracking ». Les fonctions pures sont dans
 * tests/unit/source-visite.test.js ; ici, le chemin complet.
 */

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.BRAND = 'autoliva';
delete process.env.MONGODB_URI; // sessions en mémoire, jamais de base externe
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
let octet = 1;

async function visite(chemin, { referer = '', ua = UA_CHROME } = {}) {
  const headers = { 'User-Agent': ua, Accept: 'text/html,application/xhtml+xml', 'CF-Connecting-IP': `198.51.100.${(octet++ % 250) + 1}` };
  if (referer) headers.Referer = referer;
  const r = await fetch(base + chemin, { redirect: 'manual', headers });
  await r.text();
  return r.status;
}

// L'enregistrement est « fire & forget » : on attend qu'il soit en base.
async function attendreTouches(attendu) {
  const AttributionTouch = require('../../src/models/AttributionTouch');
  for (let i = 0; i < 50; i++) {
    const n = await AttributionTouch.countDocuments({});
    if (n >= attendu) return n;
    await new Promise((r) => setTimeout(r, 20));
  }
  return AttributionTouch.countDocuments({});
}

test('visites gratuites : enregistrées par le site, rangées par les tableaux', async (t) => {
  serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  const db = mongoose.connection.db;

  const app = require('../../src/app');
  http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${http.address().port}`;

  t.after(async () => {
    if (http) await new Promise((r) => http.close(r));
    await mongoose.disconnect();
    await serveur.stop();
  });

  const AttributionTouch = require('../../src/models/AttributionTouch');

  await t.test('le site enregistre Google gratuit et ChatGPT, pas le reste', async () => {
    await AttributionTouch.deleteMany({});

    const page = '/';
    assert.ok([200, 301, 302].includes(await visite(page, { referer: 'https://www.google.com/' })));
    await visite(page, { referer: 'https://chatgpt.com/' });
    await visite(page, { referer: 'https://forum.example.org/sujet/dq200' });
    // Rien de tout ça ne doit être enregistré :
    await visite(page, { referer: 'https://autoliva.com/produits' }); // navigation interne
    await visite(page, { referer: 'https://www.mollie.com/checkout/abc' }); // retour de paiement
    await visite(page); // sans référent
    await visite(page, { referer: 'https://www.google.com/', ua: UA_GOOGLEBOT }); // robot
    // Un clic pub reste enregistré comme avant :
    await visite(page + '?gclid=TEST-GCLID&utm_source=google&utm_medium=cpc&utm_campaign=pmax_feed', { referer: 'https://www.google.com/' });

    const n = await attendreTouches(4);
    await new Promise((r) => setTimeout(r, 100)); // laisse passer un éventuel enregistrement en trop
    const touches = await AttributionTouch.find({}).lean();
    assert.strictEqual(touches.length, 4, `4 arrivées attendues, ${n} trouvées : ${touches.map((x) => x.referrer + (x.gclid ? ' gclid' : '')).join(' | ')}`);
    const referents = touches.map((x) => x.referrer).sort();
    assert.deepStrictEqual(referents, [
      'https://chatgpt.com/',
      'https://forum.example.org/sujet/dq200',
      'https://www.google.com/',
      'https://www.google.com/',
    ]);
    assert.strictEqual(touches.filter((x) => x.gclid === 'TEST-GCLID').length, 1);
  });

  await t.test('tableau marketing et vue de pilotage : les vraies agrégations Mongo', async () => {
    const { getMarketingDashboardData } = require('../../src/services/marketingAggregations');
    const businessOverview = require('../../src/mcp/tools/businessOverview');

    const maintenant = new Date();
    const commande = (n, extra) => ({
      number: `TEST-${n}`, paymentStatus: 'paid', status: 'paid', deletedAt: null,
      createdAt: maintenant, updatedAt: maintenant, totalCents: 100000, ...extra,
    });
    const gratuit = { referrer: 'https://www.google.com/', gclid: '', utmSource: '', utmMedium: '', utmCampaign: '' };
    const pub = { referrer: 'https://www.google.com/', gclid: 'G-OLD', utmSource: '', utmMedium: '', utmCampaign: '' };
    await db.collection('orders').insertMany([
      // Ancien clic pub en cookie, retour par Google gratuit : « dernier clic » = pub, « dernière arrivée » = gratuit.
      commande(1, { source: { channel: 'website' }, attribution: { firstTouch: pub, lastTouch: pub, visitTouch: gratuit } }),
      // Venu de ChatGPT.
      commande(2, { source: { channel: 'website' }, attribution: { firstTouch: { referrer: 'https://chatgpt.com/' }, lastTouch: { referrer: 'https://chatgpt.com/' }, visitTouch: { referrer: 'https://chatgpt.com/' } } }),
      // Commande téléphone : jamais de visite.
      commande(3, { source: { channel: 'phone' }, isManual: true }),
      // Commande web sans aucune source (visite directe, ou d'avant le suivi).
      commande(4, { source: { channel: 'website' } }),
      // Ancienne commande sans canal renseigné : web par défaut.
      commande(5, {}),
    ]);

    const parBucket = (rows) => Object.fromEntries(rows.map((r) => [r.bucket || r.campaign, r]));

    const visite = await getMarketingDashboardData({ period: '30d', model: 'visit' });
    const v = parBucket(visite.rows);
    assert.strictEqual(v.__organic__.orders, 1, 'dernière arrivée : la vente revient au gratuit');
    assert.strictEqual(v.__organic__.visits, 1, 'la visite Google gratuite (celle du clic pub est rangée dans sa campagne)');
    assert.strictEqual(v.__ai__.orders, 1);
    assert.strictEqual(v.__ai__.visits, 1);
    assert.strictEqual(v.__referral__.visits, 1);
    assert.strictEqual(v.__offline__.orders, 1, 'la commande téléphone est à part');
    assert.strictEqual(v.__legacy__.orders, 2, 'commandes web sans source');
    assert.strictEqual(v.pmax_feed.visits, 1, 'le clic pub reste dans sa campagne');
    assert.strictEqual(visite.totals.orders, 2, 'les commandes sans source restent hors des totaux');

    const dernier = await getMarketingDashboardData({ period: '30d', model: 'last' });
    const d = parBucket(dernier.rows);
    assert.strictEqual(d.__gads__.orders, 1, 'dernier clic : le vieux gclid garde la vente (import Google Ads)');

    // Les étiquettes s'affichent dans la page admin (moteur de vues de l'application,
    // avec ses variables globales).
    const app = require('../../src/app');
    const html = await new Promise((resolve, reject) => app.render('admin/marketing', {
      title: 'Admin - Marketing',
      dbConnected: true,
      rows: visite.rows,
      totals: visite.totals,
      filters: { period: visite.period, model: visite.model, sort: visite.sortField, order: visite.sortDir, from: '', to: '' },
      formatEuro: (cents) => (Number(cents || 0) / 100).toFixed(2) + ' €',
      currentPath: '/admin/marketing',
      currentAdmin: { email: 'admin@example.com' },
      assetVersions: { mainCss: 1, adminCss: 1 },
      brand: require('../../src/config/brand'),
    }, (err, out) => (err ? reject(err) : resolve(out))));
    for (const etiquette of ['Trafic organique (SEO)', 'Assistants IA', 'Sites référents', 'Commandes hors site', 'Commandes web sans source', 'value="visit"', 'visitTouch']) {
      assert.ok(html.includes(etiquette), `la page admin affiche « ${etiquette} »`);
    }

    const res = await businessOverview.handler({ period: '30d' });
    const vue = JSON.parse(res.content[0].text);
    assert.strictEqual(vue.trafficMix.mix.organic.visits, 1);
    assert.strictEqual(vue.trafficMix.mix.ai.visits, 1);
    assert.strictEqual(vue.trafficMix.mix.referral.visits, 1);
    assert.strictEqual(vue.trafficMix.mix.paid_google.visits, 1);
    assert.ok(/Search Console/.test(vue.trafficMix.note));
  });
});
