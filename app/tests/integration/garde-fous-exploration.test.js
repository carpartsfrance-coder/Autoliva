/**
 * Garde-fous d'exploration servis par la VRAIE application — plan de reprise
 * SEO du 14/09/2026, action A4 (PR-1a : aucune modification d'indexation).
 *
 * Lancé par : npm test (mongodb-memory-server : aucune base externe, jamais la
 * production). Aucun envoi possible : clés vides, pas de MONGODB_URI (sessions
 * en mémoire), serveur sur un port éphémère, DNS remplacé par une doublure.
 *
 * Données : les 10 fiches copiées en lecture seule depuis la production
 * (tests/fixtures/fiches-produit-prod.json, champs publics), plus quelques
 * documents construits ici. Toutes portent updatedAt = 08/09/2026 18:16 — la
 * date de l'écriture en masse qui avait redaté 13 345 fiches et 1 173
 * articles : elle ne doit ressortir NULLE PART.
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

const FIXTURE = require('../fixtures/fiches-produit-prod.json');
/* Même objet que celui que lit services/datesSeo.js (cache de require) : on
   peut y régler la date de mise en ligne A3 pour le test. */
const FICHES_A3 = require('../../src/data/seo/fiches-description-a3.json');

const UA_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const UA_GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

/* L'écriture en masse du 08/09/2026 : la date qui ne doit plus mentir. On
   cherche l'HEURE exacte et pas le jour : des traductions allemandes datent
   réellement du 08/09 au matin (fiche AUTO du jeu d'essai), et celles-là sont
   vraies. */
const REDATE = new Date('2026-09-08T18:16:30Z');
const MARQUE_REDATE = '2026-09-08T18:16';

let serveur;
let http;
let base;

/* Chaque lecture de sitemap vient d'une adresse différente : le limiteur
   (30 / 10 min par visiteur) ne doit pas se mêler des tests de contenu. */
let prochainOctet = 1;
async function get(chemin, { ua = UA_CHROME, ip, entetes = {} } = {}) {
  const headers = { 'User-Agent': ua, Accept: 'text/html,application/xml', ...entetes };
  headers['CF-Connecting-IP'] = ip || `198.51.100.${(prochainOctet++ % 250) + 1}`;
  const r = await fetch(base + chemin, { redirect: 'manual', headers });
  return { status: r.status, location: r.headers.get('location'), headers: r.headers, corps: await r.text() };
}

/** <loc> → <lastmod> ('' si absent) d'un sitemap. */
function entrees(xml) {
  const out = new Map();
  for (const m of xml.matchAll(/<(?:url|sitemap)>\s*<loc>([^<]*)<\/loc>(?:\s*<lastmod>([^<]*)<\/lastmod>)?/g)) {
    out.set(m[1].replace(/&amp;/g, '&'), m[2] || '');
  }
  return out;
}

function jsonLd(html) {
  const blocs = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
  const graphe = [];
  for (const b of blocs) {
    const d = JSON.parse(b[1]);
    if (Array.isArray(d['@graph'])) graphe.push(...d['@graph']); else graphe.push(d);
  }
  return graphe;
}

function metaPropriete(html, nom) {
  const m = html.match(new RegExp(`<meta property="${nom}" content="([^"]*)"`));
  return m ? m[1] : null;
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

/* ─── Données ──────────────────────────────────────────────────────────────── */

function slugifier(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function versMongo(p) {
  const doc = { ...p };
  delete doc._role;
  doc._id = new mongoose.Types.ObjectId(p._id);
  if (doc.localizations && doc.localizations.de) {
    doc.localizations = { de: { ...doc.localizations.de } };
    if (doc.localizations.de.translatedAt) doc.localizations.de.translatedAt = new Date(doc.localizations.de.translatedAt);
  }
  doc.createdAt = new Date('2026-05-20T10:00:00Z');
  doc.updatedAt = REDATE;
  return doc;
}

const DQ200 = FIXTURE.produits.find((p) => p.sku === '0AM 325 025');
const DM = FIXTURE.produits.find((p) => p.sku.startsWith('DM-'));
const ALIBABA = FIXTURE.produits.find((p) => p.sku.startsWith('ALV-PT-'));

/* Une fiche publiée qui n'a PAS regagné de description avec A3. */
const HORS_LISTE = {
  _id: new mongoose.Types.ObjectId(),
  name: 'Moteur de test hors liste A3',
  slug: 'moteur-test-hors-liste-a3',
  sku: 'ASY-0000000001',
  category: 'Moteurs',
  priceCents: 150000,
  isPublished: true,
  description: 'Un moteur de test.',
  createdAt: new Date('2026-09-11T08:00:00Z'),
  updatedAt: REDATE,
};

/* Sitemap des catégories et des pages véhicule (A4.6).
   - « Freinage » n'a pas de fiche à son nom exact, mais une en
     « Freinage > Disques » : elle n'est PAS vide (règle « Nom > … » de la page) ;
   - « Disques frein » n'a aucune fiche, « Brouillons seulement » n'a qu'un
     brouillon : vides, donc servies en noindex, donc hors du sitemap ;
   - « AUDI / A4 » et « Audi / a4 » : deux écritures, un seul slug. */
const FREIN = {
  _id: new mongoose.Types.ObjectId(),
  name: 'Disques de frein avant Audi A4',
  slug: 'disques-frein-avant-audi-a4-test',
  sku: 'WC-900001',
  category: 'Freinage > Disques',
  priceCents: 12000,
  isPublished: true,
  compatibility: [{ make: 'AUDI', model: 'A4' }],
  createdAt: new Date('2026-06-01T00:00:00Z'),
  updatedAt: REDATE,
};
const TURBO_AUDI = {
  _id: new mongoose.Types.ObjectId(),
  name: 'Turbo Audi A4 2.0 TDI',
  slug: 'turbo-audi-a4-2-0-tdi-test',
  sku: 'WC-900002',
  category: 'Turbos',
  priceCents: 45000,
  isPublished: true,
  compatibility: [{ make: 'Audi', model: 'a4' }, { make: 'Audi', model: 'A4 ' }],
  createdAt: new Date('2026-06-01T00:00:00Z'),
  updatedAt: REDATE,
};
const BROUILLON = {
  _id: new mongoose.Types.ObjectId(),
  name: 'Pièce en brouillon',
  slug: 'piece-en-brouillon-test',
  sku: 'WC-900003',
  category: 'Brouillons seulement',
  priceCents: 1000,
  isPublished: false,
  createdAt: new Date('2026-06-01T00:00:00Z'),
  updatedAt: REDATE,
};
const CATEGORIES_EN_PLUS = [
  { name: 'Freinage', slug: 'freinage', isActive: true },
  { name: 'Disques frein', slug: 'disques-frein', isActive: true },
  { name: 'Brouillons seulement', slug: 'brouillons-seulement', isActive: true },
  { name: 'Filtres huile', slug: 'filtres-huile', isActive: false },
];

const ARTICLE_FR = {
  title: 'Panne de mécatronique DQ200 : le guide',
  slug: 'panne-mecatronique-dq200-guide',
  excerpt: 'Symptômes, causes et solutions.',
  contentMarkdown: '## Symptômes\n\nÀ-coups au passage des rapports.\n\n## Causes\n\nL’accumulateur de pression.',
  contentHtml: '<h2>Symptômes</h2><p>À-coups au passage des rapports.</p><h2>Causes</h2><p>L’accumulateur de pression.</p>',
  isPublished: true,
  publishedAt: new Date('2026-04-02T09:00:00Z'),
  createdAt: new Date('2026-04-02T08:55:00Z'),
  updatedAt: REDATE,
  seo: { metaTitle: '', metaDescription: '', metaRobots: 'index, follow' },
};

const ARTICLE_TRADUIT = {
  title: 'Boîte de transfert 4MATIC : le guide',
  slug: 'boite-transfert-4matic-guide',
  excerpt: 'Tout sur la boîte de transfert 4MATIC.',
  contentMarkdown: '## Rôle\n\nRépartir le couple entre les essieux.',
  contentHtml: '<h2>Rôle</h2><p>Répartir le couple entre les essieux.</p>',
  isPublished: true,
  publishedAt: new Date('2026-05-10T08:00:00Z'),
  createdAt: new Date('2026-05-10T07:58:00Z'),
  updatedAt: REDATE,
  localizations: {
    de: {
      title: 'Verteilergetriebe 4MATIC: der Ratgeber',
      excerpt: 'Alles über das Verteilergetriebe 4MATIC.',
      contentHtml: '<h2>Aufgabe</h2><p>Das Drehmoment auf die Achsen verteilen.</p>',
      seo: { metaTitle: '', metaDescription: '' },
      translatedAt: new Date('2026-09-07T09:30:00Z'),
    },
  },
};

test('garde-fous d’exploration servis par l’application (plan SEO A4)', async (t) => {
  serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  const db = mongoose.connection.db;

  await db.collection('products').insertMany([...FIXTURE.produits.map(versMongo), HORS_LISTE, FREIN, TURBO_AUDI, BROUILLON]);
  const categories = [...new Set(FIXTURE.produits.map((p) => p.category))];
  await db.collection('categories').insertMany(categories.map((name, i) => ({
    name,
    slug: slugifier(name),
    isActive: true,
    sortOrder: i,
    createdAt: new Date('2026-05-01T00:00:00Z'),
    updatedAt: REDATE,
    ...(name === 'Moteurs'
      ? { localizations: { de: { name: 'Motoren', slug: 'motoren', translatedAt: new Date('2026-09-05T12:00:00Z') } } }
      : {}),
  })));
  await db.collection('categories').insertMany(CATEGORIES_EN_PLUS.map((c, i) => ({ ...c, sortOrder: 100 + i, updatedAt: REDATE })));
  await db.collection('blogposts').insertMany([ARTICLE_FR, ARTICLE_TRADUIT]);
  await db.collection('legalpages').insertOne({
    slug: 'cgv', title: 'Conditions générales de vente', content: 'Article 1 — Objet.', isPublished: true,
    sortOrder: 0, createdAt: new Date('2026-05-01T00:00:00Z'), updatedAt: REDATE,
  });

  const app = require('../../src/app');
  const seo = require('../../src/controllers/seoController');
  const robotsVerifies = require('../../src/services/robotsVerifies');
  robotsVerifies.verificateur.definirResolveurs(DNS_TEST);
  robotsVerifies.verificateur.viderCache();

  http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${http.address().port}`;

  const dateA3Origine = FICHES_A3.dateMiseEnLigne;
  t.after(async () => {
    FICHES_A3.dateMiseEnLigne = dateA3Origine;
    delete process.env.SHOW_PRODUCT_DESCRIPTION;
    if (http) await new Promise((r) => http.close(r));
    await mongoose.disconnect();
    await serveur.stop();
  });

  const urlFiche = (p) => `${base}/product/${p.slug}/`;

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

  /* ── A4.5 — dates : jamais updatedAt ─────────────────────────────────── */

  await t.test('A4.5 sitemap des fiches : la date A3 pour les fiches qui ont regagné leur description, rien pour les autres', async () => {
    FICHES_A3.dateMiseEnLigne = '2026-09-10';
    seo.__test.viderCaches();
    const r = await get('/sitemap-products.xml');
    assert.equal(r.status, 200);
    assert.ok(!r.corps.includes(MARQUE_REDATE), 'la date de l’écriture en masse ressort');
    const e = entrees(r.corps);
    const listees = FIXTURE.produits.filter((p) => FICHES_A3.ids.includes(p._id));
    assert.equal(listees.length, 8, 'les 8 fiches du jeu d’essai qui ont regagné leur description');
    for (const p of listees) assert.equal(e.get(urlFiche(p)), '2026-09-10', `${p.sku} : lastmod A3 attendu`);
    for (const p of [DM, ALIBABA, HORS_LISTE]) {
      assert.ok(e.has(urlFiche(p)), `${p.sku} reste dans le sitemap`);
      assert.equal(e.get(urlFiche(p)), '', `${p.sku} : aucun lastmod — son contenu n’a pas changé`);
    }
  });

  await t.test('A4.5 sitemap des fiches : description coupée ou date A3 à venir → aucun lastmod', async () => {
    process.env.SHOW_PRODUCT_DESCRIPTION = 'off';
    seo.__test.viderCaches();
    let r = await get('/sitemap-products.xml');
    assert.ok(![...entrees(r.corps).values()].some(Boolean), 'interrupteur coupé : la description n’est plus servie');
    delete process.env.SHOW_PRODUCT_DESCRIPTION;

    FICHES_A3.dateMiseEnLigne = '2099-01-01';
    seo.__test.viderCaches();
    r = await get('/sitemap-products.xml');
    assert.ok(![...entrees(r.corps).values()].some(Boolean), 'on n’annonce pas un changement à venir');
    FICHES_A3.dateMiseEnLigne = '2026-09-10';
    seo.__test.viderCaches();
  });

  await t.test('A4.5 sitemaps allemands, blog, catégories, pages : aucune date tirée d’updatedAt', async () => {
    const de = entrees((await get('/sitemap-products-de.xml')).corps);
    const urlDe = `${base}/de/produits/${DQ200.localizations.de.slug}-${DQ200._id}`;
    assert.equal(de.get(urlDe), DQ200.localizations.de.translatedAt, 'fiche allemande : date de sa traduction');

    const blog = entrees((await get('/sitemap-blog.xml')).corps);
    assert.equal(blog.get(`${base}/blog/${ARTICLE_FR.slug}`), '2026-04-02T09:00:00.000Z', 'article : sa publication');
    assert.equal(blog.get(`${base}/blog/${ARTICLE_TRADUIT.slug}`), '2026-05-10T08:00:00.000Z');

    const blogDe = entrees((await get('/sitemap-blog-de.xml')).corps);
    assert.equal(blogDe.get(`${base}/de/blog/${ARTICLE_TRADUIT.slug}`), '2026-09-07T09:30:00.000Z', 'article allemand : sa traduction');

    const cats = (await get('/sitemap-categories.xml')).corps;
    assert.ok(cats.includes('<loc>'), 'le sitemap des catégories n’est pas vide');
    assert.ok(!cats.includes('<lastmod>'), 'catégories : pas de lastmod');
    const catsDe = entrees((await get('/sitemap-categories-de.xml')).corps);
    assert.equal(catsDe.get(`${base}/de/categorie/motoren`), '2026-09-05T12:00:00.000Z');

    const pages = (await get('/sitemap-pages.xml')).corps;
    assert.ok(pages.includes('/legal/cgv'));
    assert.ok(!pages.includes('<lastmod>'), 'pages et pages légales : pas de lastmod');

    for (const chemin of ['/sitemap-products-de.xml', '/sitemap-blog.xml', '/sitemap-blog-de.xml', '/sitemap-categories.xml', '/sitemap-categories-de.xml', '/sitemap-pages.xml']) {
      assert.ok(!(await get(chemin)).corps.includes(MARQUE_REDATE), `${chemin} : la date de l’écriture en masse ressort`);
    }
  });

  await t.test('A4.5 index des sitemaps : chaque enfant annonce sa vraie dernière date, ou rien', async () => {
    const idx = entrees((await get('/sitemap.xml')).corps);
    assert.equal(idx.get(`${base}/sitemap-products.xml`), '2026-09-10');
    assert.equal(idx.get(`${base}/sitemap-blog.xml`), '2026-05-10T08:00:00.000Z', 'la publication la plus récente');
    assert.equal(idx.get(`${base}/sitemap-blog-de.xml`), '2026-09-07T09:30:00.000Z');
    for (const enfant of ['sitemap-pages.xml', 'sitemap-categories.xml', 'sitemap-vehicles.xml', 'sitemap-references.xml']) {
      assert.equal(idx.get(`${base}/${enfant}`), '', `${enfant} : pas de date inventée`);
    }
    assert.ok(![...idx.values()].some((v) => v.startsWith(MARQUE_REDATE)));
    assert.equal(idx.get(`${base}/sitemap-products-de.xml`), '2026-09-08T07:39:42.953Z', 'la traduction allemande la plus récente');
  });

  await t.test('A4.5 article : dateModified et article:modified_time = publication (FR), traduction (DE)', async () => {
    const fr = await get(`/blog/${ARTICLE_FR.slug}`);
    assert.equal(fr.status, 200);
    const posting = jsonLd(fr.corps).find((n) => n['@type'] === 'BlogPosting');
    assert.equal(posting.datePublished, '2026-04-02T09:00:00.000Z');
    assert.equal(posting.dateModified, '2026-04-02T09:00:00.000Z');
    assert.equal(metaPropriete(fr.corps, 'article:modified_time'), '2026-04-02T09:00:00.000Z');
    assert.ok(!fr.corps.includes(MARQUE_REDATE), 'la date de l’écriture en masse ressort dans la page');

    const de = await get(`/de/blog/${ARTICLE_TRADUIT.slug}`);
    assert.equal(de.status, 200);
    const postingDe = jsonLd(de.corps).find((n) => n['@type'] === 'BlogPosting');
    assert.equal(postingDe.dateModified, '2026-09-07T09:30:00.000Z');
    assert.equal(metaPropriete(de.corps, 'article:modified_time'), '2026-09-07T09:30:00.000Z');
    assert.ok(!de.corps.includes(MARQUE_REDATE));
  });

  /* ── A4.6 — sitemaps : catégories vides, doublons des pages véhicule ──── */

  await t.test('A4.6 sitemap des catégories : les catégories vides (servies en noindex) en sortent', async () => {
    seo.__test.viderCaches();
    const r = await get('/sitemap-categories.xml');
    assert.equal(r.status, 200);
    const locs = [...entrees(r.corps).keys()].map((u) => u.replace(`${base}/categorie/`, ''));
    for (const nom of categories) {
      assert.ok(locs.includes(slugifier(nom)), `« ${nom} » a des fiches : elle reste`);
    }
    assert.ok(locs.includes('freinage'), '« Freinage » compte ses fiches « Freinage > Disques »');
    for (const vide of ['disques-frein', 'brouillons-seulement', 'filtres-huile']) {
      assert.ok(!locs.includes(vide), `« ${vide} » est vide (ou inactive) : hors du sitemap`);
    }
    /* Le sitemap dit la même chose que la page : la catégorie vide reste en
       ligne (200), c'est la page qui se déclare non indexable. */
    assert.equal((await get('/categorie/disques-frein')).status, 200);
  });

  await t.test('A4.6 sitemap des pages véhicule : chaque URL une seule fois', async () => {
    seo.__test.viderCaches();
    const r = await get('/sitemap-vehicles.xml');
    assert.equal(r.status, 200);
    const locs = [...r.corps.matchAll(/<loc>([^<]*)<\/loc>/g)].map((m) => m[1]);
    const doublons = locs.filter((u, i) => locs.indexOf(u) !== i);
    assert.deepEqual(doublons, [], 'une URL listée deux fois');
    for (const attendu of ['/pieces-auto/audi', '/pieces-auto/audi/a4', '/pieces-auto/audi/a4/turbos', '/pieces-auto/volkswagen', '/pieces-auto/opel/zafira']) {
      assert.ok(locs.includes(base + attendu), `${attendu} manque`);
    }
  });

  await t.test('A4.5 page légale : plus de dateModified tiré d’updatedAt', async () => {
    const r = await get('/legal/cgv');
    assert.equal(r.status, 200);
    const page = jsonLd(r.corps).find((n) => n['@type'] === 'WebPage');
    assert.ok(page, 'le JSON-LD WebPage reste');
    assert.equal(page.dateModified, undefined);
  });
});
