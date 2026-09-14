/**
 * Politique d'indexation servie par la VRAIE application — plan de reprise SEO
 * du 14/09/2026, action A5 (PR-1b), et la mécanique des actions A6 à A10 et
 * A14 (familles gone, blog, reference, pieces-auto, de, products).
 *
 * Lancé par : npm test (mongodb-memory-server : aucune base externe, jamais la
 * production). Aucun envoi possible : clés vides, pas de MONGODB_URI (sessions
 * en mémoire), serveur sur un port éphémère.
 *
 * Les requêtes se font en PRODUCTION du point de vue des robots (NODE_ENV posé
 * après le chargement de l'application) : hors production, tout le site sort
 * « noindex, nofollow » et l'on ne verrait rien. Elles se présentent comme
 * Googlebot — c'est lui qui lit la balise — et le limiteur du site l'épargne.
 *
 * Données : les 10 fiches copiées en lecture seule depuis la production
 * (tests/fixtures/fiches-produit-prod.json, champs publics) et des articles
 * construits ici sur de VRAIS slugs des listes du plan (gardés, à mailler,
 * en noindex, en 410), pour que la politique commitée s'y applique telle
 * qu'elle s'appliquera en ligne.
 *
 * 1er bloc — SEO_PRUNE absent, RIEN ne change : chaque page témoin, chaque
 * sitemap, robots.txt et les flux Merchant sont comparés à leur rendu par le
 * code d'AVANT la politique (tests/fixtures/seo/rendu-avant-politique.json.gz,
 * enregistré sur le commit 4ae285d avec ce même fichier). Ce qui est comparé :
 * statut, redirection, X-Robots-Tag, balise robots, canonique, hreflang,
 * titre, et CHAQUE lien de la page — les listes d'articles, les blocs liés,
 * l'accueil, les landings, les corps d'article en font partie ; pour les
 * sitemaps, chaque <url> avec son lastmod et ses images.
 * Pour réenregistrer (uniquement quand une modification étrangère à
 * l'indexation change les liens de ces pages, diff relu) : lancer, sur le code
 * d'AVANT la politique ou sur un code où SEO_PRUNE absent est prouvé neutre,
 *   SEO_REFERENCE_ECRIRE=1 node --test tests/integration/politique-indexation.test.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

/* Configuration AVANT tout require de l'application. */
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
process.env.PARCELWILL_ENABLED = 'false';
process.env.TRACK17_ENABLED = 'false';

const ECRIRE_REFERENCE = process.env.SEO_REFERENCE_ECRIRE === '1';
const REFERENCE = path.join(__dirname, '..', 'fixtures', 'seo', 'rendu-avant-politique.json.gz');

const FIXTURE = require('../fixtures/fiches-produit-prod.json');

const UA_GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

let serveur;
let http;
let base;

let prochainOctet = 1;
async function get(chemin, { entetes = {} } = {}) {
  const headers = { 'User-Agent': UA_GOOGLEBOT, Accept: 'text/html,application/xml', ...entetes };
  /* Chaque lecture vient d'un visiteur Cloudflare différent : le limiteur des
     sitemaps (30 / 10 min) ne doit pas se mêler des tests de contenu. */
  headers['CF-Connecting-IP'] = `198.51.100.${(prochainOctet++ % 250) + 1}`;
  const r = await fetch(base + chemin, { redirect: 'manual', headers });
  return {
    chemin,
    status: r.status,
    location: r.headers.get('location'),
    xRobotsTag: r.headers.get('x-robots-tag'),
    type: (r.headers.get('content-type') || '').split(';')[0],
    cacheControl: r.headers.get('cache-control'),
    setCookie: r.headers.get('set-cookie'),
    corps: await r.text(),
  };
}

function metaRobots(html) {
  const m = html.match(/<meta name="robots" content="([^"]*)"\/>/);
  return m ? m[1] : null;
}
function canonique(html) {
  const m = html.match(/<link rel="canonical" href="([^"]*)"\/>/);
  return m ? m[1] : null;
}
function alternates(html) {
  return [...html.matchAll(/<link rel="alternate" hreflang="([^"]*)" href="([^"]*)"\/>/g)].map((m) => [m[1], m[2]]);
}
function liens(html) {
  return [...html.matchAll(/\shref="([^"]*)"/g)].map((m) => m[1]);
}
/** <loc> → <lastmod> ('' si absent) d'un sitemap. */
function entrees(xml) {
  const out = new Map();
  for (const m of xml.matchAll(/<(?:url|sitemap)>\s*<loc>([^<]*)<\/loc>(?:\s*<lastmod>([^<]*)<\/lastmod>)?/g)) {
    out.set(m[1].replace(/&amp;/g, '&').replace(base, ''), m[2] || '');
  }
  return out;
}

/* ─── Articles : de vrais slugs des listes du plan ────────────────────────── */

const LISTES = path.join(__dirname, '..', '..', 'src', 'data', 'seo', 'listes');
function slugsDe(fichier, { gz = false } = {}) {
  const brut = gz ? zlib.gunzipSync(fs.readFileSync(fichier)).toString('utf8') : fs.readFileSync(fichier, 'utf8');
  return new Set(brut.split('\n').map((l) => l.trim()).filter(Boolean).map((u) => u.replace(/^https:\/\/autoliva\.com/, '')));
}
const GARDES = slugsDe(path.join(LISTES, 'keep-blog-fr.txt'));
const A_MAILLER = slugsDe(path.join(LISTES, 'kept-posts-need-inlinks.txt'));
const DISPARUS = slugsDe(path.join(LISTES, 'gone-410-blog.txt'));
const NOINDEX_BLOG = slugsDe(path.join(__dirname, '..', 'fixtures', 'seo', 'noindex-blog-fr.txt.gz'), { gz: true });

const ids = {};
function article(cle, { slug, titre, categorie, publie, epingle = false, une = false, de = null, corps = null, html = null, produits = [] }) {
  ids[cle] = new mongoose.Types.ObjectId();
  return {
    _id: ids[cle],
    title: titre,
    slug,
    excerpt: `${titre} — l'essentiel.`,
    /* Un corps en HTML brut (sans markdown) est servi tel quel : c'est là que
       survivent les adresses absolues, que markdownToHtml aurait raccourcies. */
    contentMarkdown: html ? '' : (corps || `## ${titre}\n\nTexte de l'article ${slug}.`),
    ...(html ? { contentHtml: html } : {}),
    isPublished: true,
    isFeatured: une,
    isHomeFeatured: epingle,
    publishedAt: new Date(publie),
    createdAt: new Date(publie),
    updatedAt: new Date('2026-09-08T18:16:30Z'),
    category: { slug: categorie, label: categorie },
    coverImageUrl: `/images/blog/${slug}.jpg`,
    relatedProductIds: produits,
    /* La valeur que portent 1 099 articles en base, et que blogController
       passe au rendu : la politique doit passer devant. */
    seo: { metaTitle: '', metaDescription: '', metaRobots: 'index, follow' },
    ...(de ? {
      localizations: {
        de: {
          title: de.titre,
          excerpt: `${de.titre} — das Wichtigste.`,
          contentHtml: de.corps || `<h2>${de.titre}</h2><p>Text.</p>`,
          seo: { metaTitle: '', metaDescription: '' },
          translatedAt: new Date(de.traduit || '2026-09-07T09:30:00Z'),
        },
      },
    } : {}),
  };
}

const DQ200 = FIXTURE.produits.find((p) => p.sku === '0AM 325 025');
const DM = FIXTURE.produits.find((p) => p.sku.startsWith('DM-'));
const ASY = FIXTURE.produits.find((p) => p.sku.startsWith('ASY-'));
const EDN = FIXTURE.produits.find((p) => p.sku.startsWith('EDN-'));
const ALV_BX = FIXTURE.produits.find((p) => p.sku.startsWith('ALV-BX-'));
const TRANSFERT = FIXTURE.produits.find((p) => p.sku === 'WC-7756');

const S = {
  K_DQ200: 'accumulateur-pression-dsg7-dq200-fissure-p17bf-symptomes',
  K_AUDI: 'boite-de-transfert-audi-q3-8u-quattro-panne-diagnostic',
  K_LR: 'boite-de-transfert-land-rover-lr125903-prix-comparatif',
  K_PONT: 'bruit-pont-avant-bmw-x1',
  N_RR: 'boite-de-transfert-range-rover',
  N_TDI: '1-4-tdi-entretien-distribution-fiabilite-3-cylindres',
  X_LR_PIN: 'boite-de-transfert-land-rover-discovery-5-range-rover-lr125903-guide-complet',
  X_ALFA_PIN: 'boite-de-transfert-alfa-romeo-giulia-stelvio-q4-guide-complet',
  X_D4FD: '17-crdi-d4fd-prix-budget-moteur-reconditionne',
  X_AUDI: 'audi-q5-fy-s-tronic-dl382-tcu-panne-diagnostic-prix',
  G_P0726: 'p0726-dl501-code-defaut-signal-regime-moteur',
  G_HILUX: 'identifier-differentiel-hilux-fortuner-code-moteur-reference-41110',
  G_CODES: 'codes-defaut-dsg-s-tronic-guide-complet-par-boite',
};

/* Corps de l'article gardé : un lien vers un article en 410 sous chacune de
   ses trois écritures, un vers un article en noindex (il reste : la page est
   en ligne), un vers un article gardé. */
const CORPS_DQ200 = `<h2>Symptômes</h2><p>Voir le <a href="/blog/${S.G_P0726}">code P0726</a>, le `
  + `<a href="https://autoliva.com/blog/${S.G_P0726}/" target="_blank">même guide</a> et l'<a class="lien" href='https://www.carpartsfrance.fr/blog/${S.G_HILUX}'>ancienne adresse</a>.</p>`
  + `<p>Budget d'un <a href="/blog/${S.X_D4FD}">moteur D4FD</a> et d'une <a href="/blog/${S.K_AUDI}">boîte de transfert Audi Q3</a>.</p>`;
const CORPS_DQ200_DE = `<h2>Symptome</h2><p>Siehe <a href="/de/blog/${S.G_P0726}">Code P0726</a>, <a href="/blog/${S.G_HILUX}">Hilux</a>, `
  + `<a href="https://autoliva.com/de/blog/${S.G_CODES}">DSG-Codes</a> und <a href="/blog/${S.K_AUDI}">Audi Q3</a>.</p>`;

const ARTICLES = [
  article('K_DQ200', { slug: S.K_DQ200, titre: 'Accumulateur de pression DSG7 DQ200 fissuré : symptômes', categorie: 'transmission-mecatronique', publie: '2026-05-02T09:00:00Z', une: true, html: CORPS_DQ200, produits: [new mongoose.Types.ObjectId(DQ200._id)], de: { titre: 'Druckspeicher DSG7 DQ200 gerissen', corps: CORPS_DQ200_DE } }),
  article('K_AUDI', { slug: S.K_AUDI, titre: 'Boîte de transfert Audi Q3 8U quattro : panne et diagnostic', categorie: 'transmission-boite-de-transfert', publie: '2026-05-20T09:00:00Z', de: { titre: 'Verteilergetriebe Audi Q3 8U quattro' } }),
  article('K_LR', { slug: S.K_LR, titre: 'Boîtes de transfert Land Rover LR125903 : prix comparatif', categorie: 'transmission-boite-de-transfert', publie: '2026-04-15T09:00:00Z', epingle: true }),
  article('K_PONT', { slug: S.K_PONT, titre: 'Bruit de pont avant BMW X1', categorie: 'transmission-pont-differentiel', publie: '2026-04-10T09:00:00Z' }),
  article('N_RR', { slug: S.N_RR, titre: 'Boîte de transfert Range Rover', categorie: 'transmission-boite-de-transfert', publie: '2026-03-01T09:00:00Z' }),
  article('N_TDI', { slug: S.N_TDI, titre: '1.4 TDI : entretien de la distribution', categorie: 'moteur-diesel', publie: '2026-03-02T09:00:00Z' }),
  article('X_LR_PIN', { slug: S.X_LR_PIN, titre: 'Boîtes de transfert Land Rover Discovery 5 : guide complet', categorie: 'transmission-boite-de-transfert', publie: '2026-07-01T09:00:00Z', epingle: true }),
  article('X_ALFA_PIN', { slug: S.X_ALFA_PIN, titre: 'Boîte de transfert Alfa Romeo Giulia Q4 : guide complet', categorie: 'transmission-boite-de-transfert', publie: '2026-07-02T09:00:00Z', epingle: true }),
  article('X_D4FD', { slug: S.X_D4FD, titre: 'Moteur 1.7 CRDi D4FD reconditionné : prix', categorie: 'moteur-diesel', publie: '2026-07-10T09:00:00Z', produits: [] }),
  article('X_AUDI', { slug: S.X_AUDI, titre: 'Audi Q5 FY S tronic DL382 : panne du calculateur', categorie: 'transmission-mecatronique', publie: '2026-08-01T09:00:00Z' }),
  article('G_P0726', { slug: S.G_P0726, titre: 'Code P0726 DL501 : signal de régime moteur', categorie: 'moteur-diesel', publie: '2026-09-05T09:00:00Z', de: { titre: 'Fehlercode P0726 DL501', traduit: '2026-09-08T08:00:00Z' } }),
  article('G_HILUX', { slug: S.G_HILUX, titre: 'Identifier le différentiel Hilux Fortuner', categorie: 'transmission-pont-differentiel', publie: '2026-09-06T09:00:00Z', de: { titre: 'Differential Hilux Fortuner erkennen', traduit: '2026-09-08T08:05:00Z' } }),
  article('G_CODES', { slug: S.G_CODES, titre: 'Codes défaut DSG S tronic Audi A4 : guide complet par boîte', categorie: 'transmission-mecatronique', publie: '2026-09-05T12:00:00Z', de: { titre: 'DSG-Fehlercodes', traduit: '2026-09-08T08:10:00Z' } }),
];

/* Fiche DQ200 : articles choisis dans l'admin — un en noindex, un en 410, un gardé. */
const LIES_DQ200 = ['X_D4FD', 'G_P0726', 'K_DQ200'];

/* ─── Fiches ──────────────────────────────────────────────────────────────── */

const REDATE = new Date('2026-09-08T18:16:30Z');
function versMongo(p) {
  const doc = { ...p };
  delete doc._role;
  doc._id = new mongoose.Types.ObjectId(p._id);
  if (doc.localizations && doc.localizations.de) {
    doc.localizations = { de: { ...doc.localizations.de } };
    if (doc.localizations.de.translatedAt) doc.localizations.de.translatedAt = new Date(doc.localizations.de.translatedAt);
  }
  if (p.sku === DQ200.sku) doc.relatedBlogPostIds = LIES_DQ200.map((c) => ids[c]);
  /* EDN est gardée par le plan : Killian la sort à la main. */
  if (p.sku === EDN.sku) doc.seo = { ...(doc.seo || {}), indexOverride: 'noindex' };
  doc.createdAt = new Date('2026-05-20T10:00:00Z');
  doc.updatedAt = REDATE;
  return doc;
}

/* Une copie distrimotor que Killian a remise dans Google depuis l'admin. */
const DM_REMISE = {
  _id: new mongoose.Types.ObjectId(),
  name: 'Turbo reconditionné Garrett échange standard (remis à l’index)',
  slug: 'turbo-reconditionne-garrett-echange-standard-remis',
  sku: 'DM-99001',
  category: 'Turbos',
  priceCents: 42000,
  isPublished: true,
  seo: { metaTitle: '', metaDescription: '', indexOverride: 'index' },
  createdAt: new Date('2026-06-01T00:00:00Z'),
  updatedAt: REDATE,
};
/* Pages /reference : deux des trois gardées, une qui ne l'est pas. */
const REFERENCES = {
  _id: new mongoose.Types.ObjectId(),
  name: 'Mécatronique DQ200 0AM927769G reconditionnée',
  slug: 'mecatronique-dq200-0am927769g-test',
  sku: 'WC-990010',
  category: 'Mécatroniques & calculateurs',
  priceCents: 99000,
  isPublished: true,
  compatibleReferences: ['0AM927769G', 'C2D3506', 'XYZ-99887'],
  createdAt: new Date('2026-06-01T00:00:00Z'),
  updatedAt: REDATE,
};
/* Pages véhicule : /pieces-auto/audi et /audi/a4 sont gardées, /audi/a4/turbos non. */
const TURBO_AUDI = {
  _id: new mongoose.Types.ObjectId(),
  name: 'Turbo Audi A4 2.0 TDI',
  slug: 'turbo-audi-a4-2-0-tdi-test',
  sku: 'WC-990011',
  category: 'Turbos',
  priceCents: 45000,
  isPublished: true,
  compatibility: [{ make: 'Audi', model: 'A4' }],
  createdAt: new Date('2026-06-01T00:00:00Z'),
  updatedAt: REDATE,
};

function slugifier(s) {
  return String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
const SLUGS_PROD = { 'Mécatroniques & calculateurs': 'mecatroniques' };
const slugCategorie = (nom) => SLUGS_PROD[nom] || slugifier(nom);

const urlFr = (p) => `/product/${p.slug}/`;
const urlDe = (p) => `/de/produits/${encodeURIComponent(p.localizations.de.slug)}-${p._id}`;

/* ─── Pages témoins du 1er bloc ───────────────────────────────────────────── */

const PAGES_TEMOINS = [
  '/', '/de', '/blog', '/de/blog',
  `/blog/${S.K_DQ200}`, `/blog/${S.K_AUDI}`, `/blog/${S.N_TDI}`, `/blog/${S.X_D4FD}`, `/blog/${S.G_P0726}`,
  `/de/blog/${S.K_DQ200}`, `/de/blog/${S.G_P0726}`, `/${S.G_P0726}`,
  urlFr(DQ200), urlFr(DM), urlFr(ASY), urlFr(EDN), urlFr(DM_REMISE), urlDe(DQ200), urlDe(DM),
  '/produits', '/categorie/boites-de-transfert', '/de/categorie/motoren',
  '/pieces-auto', '/pieces-auto/audi', '/pieces-auto/audi/a4', '/pieces-auto/audi/a4/turbos',
  '/reference/0AM927769G', '/reference/0am927769g', '/reference/XYZ-99887',
  '/moteurs', '/boites-vitesse', '/ponts-differentiels', '/boites-de-transfert',
  '/de/contact', '/de/devis', '/de/legal/cgv', '/legal/cgv',
  '/sitemap.xml', '/sitemap-pages.xml', '/sitemap-categories.xml', '/sitemap-categories-de.xml',
  '/sitemap-products.xml', '/sitemap-products-de.xml', '/sitemap-vehicles.xml', '/sitemap-references.xml',
  '/sitemap-blog.xml', '/sitemap-blog-de.xml', '/robots.txt',
  '/sitemap-retraits-gone.xml', '/sitemap-retraits-blog.xml', '/sitemap-retraits-de.xml',
  '/google-merchant-feed.xml', '/google-merchant-feed-de.xml',
];

/**
 * Ce qui compte pour l'indexation, rendu comparable d'une exécution à l'autre.
 * Les ensembles sont triés : plusieurs listes du site trient sur un champ à
 * égalité (updatedAt, marques « Seat » et « SEAT »), leur ordre varie d'un
 * lancement à l'autre sans que rien ne change pour Google. Ce qui ne doit pas
 * bouger — un lien de plus ou de moins, une adresse de sitemap, un statut, la
 * balise robots, la canonique, le hreflang — reste comparé à l'identique.
 */
function signature(r) {
  const net = (v) => (typeof v === 'string'
    ? v.split(base).join('').replace(/\?v=\d+/g, '?v=')
    : v);
  const sig = { status: r.status, location: net(r.location), xRobotsTag: r.xRobotsTag, type: r.type };
  if (r.type === 'text/html') {
    sig.meta = metaRobots(r.corps);
    sig.canonique = net(canonique(r.corps));
    sig.alternates = alternates(r.corps).map(([l, h]) => `${l} ${net(h)}`);
    sig.titre = (r.corps.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || null;
    sig.liens = liens(r.corps).map(net).sort();
  } else if (/google-merchant-feed/.test(r.chemin)) {
    /* Le flux porte sa date de génération : on compare ses fiches. */
    sig.liens = [...r.corps.matchAll(/<(?:g:)?link>([^<]*)<\/(?:g:)?link>/g)].map((m) => net(m[1])).sort();
    sig.ids = [...r.corps.matchAll(/<g:id>([^<]*)<\/g:id>/g)].map((m) => m[1]).sort();
  } else if (/<urlset/.test(r.corps)) {
    sig.urls = [...r.corps.matchAll(/<url>[\s\S]*?<\/url>/g)].map((m) => net(m[0])).sort();
  } else {
    sig.corps = net(r.corps);
  }
  return sig;
}

test('politique d’indexation servie par l’application (plan SEO A5)', async (t) => {
  serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  const db = mongoose.connection.db;

  await db.collection('blogposts').insertMany(ARTICLES);
  await db.collection('products').insertMany([...FIXTURE.produits.map(versMongo), DM_REMISE, REFERENCES, TURBO_AUDI]);
  const categories = [...new Set([...FIXTURE.produits.map((p) => p.category)])];
  await db.collection('categories').insertMany(categories.map((name, i) => ({
    name,
    slug: slugCategorie(name),
    isActive: true,
    sortOrder: i,
    updatedAt: REDATE,
    ...(name === 'Moteurs'
      ? { localizations: { de: { name: 'Motoren', slug: 'motoren', translatedAt: new Date('2026-09-05T12:00:00Z') } } }
      : {}),
  })));
  await db.collection('legalpages').insertOne({
    slug: 'cgv', title: 'Conditions générales de vente', content: 'Article 1 — Objet.', isPublished: true,
    sortOrder: 0, createdAt: new Date('2026-05-01T00:00:00Z'), updatedAt: REDATE,
    localizations: { de: { title: 'Allgemeine Geschäftsbedingungen', content: 'Artikel 1 — Gegenstand.', translatedAt: new Date('2026-09-06T10:00:00Z') } },
  });

  const app = require('../../src/app');
  http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  base = `http://127.0.0.1:${http.address().port}`;

  /* Production du point de vue des robots, pour les requêtes seulement. */
  const nodeEnvOrigine = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';

  t.after(async () => {
    process.env.NODE_ENV = nodeEnvOrigine;
    delete process.env.SEO_PRUNE;
    for (const cle of Object.keys(process.env)) if (cle.startsWith('SEO_PRUNE_SINCE_')) delete process.env[cle];
    if (http) await new Promise((r) => http.close(r));
    await mongoose.disconnect();
    await serveur.stop();
  });

  /* ── SEO_PRUNE absent : rien ne change ──────────────────────────────────── */

  await t.test('SEO_PRUNE absent : chaque page témoin est servie exactement comme avant la politique', async () => {
    const signatures = {};
    for (const chemin of PAGES_TEMOINS) signatures[chemin] = signature(await get(chemin));

    if (ECRIRE_REFERENCE) {
      fs.writeFileSync(REFERENCE, zlib.gzipSync(JSON.stringify(signatures, null, 1) + '\n', { level: 9 }));
      return;
    }
    const avant = JSON.parse(zlib.gunzipSync(fs.readFileSync(REFERENCE)).toString('utf8'));
    assert.deepEqual(Object.keys(signatures), Object.keys(avant), 'la liste des pages témoins a changé : réenregistrer');
    for (const chemin of PAGES_TEMOINS) {
      assert.deepStrictEqual(signatures[chemin], avant[chemin], `${chemin} : rendu différent de celui d'avant la politique`);
    }
  });

  /* Le code d'avant la politique s'arrête ici : il n'a pas le reste. */
  if (ECRIRE_REFERENCE) return;

  const seoIndexPolicy = require('../../src/services/seoIndexPolicy');
  const seo = require('../../src/controllers/seoController');
  const admin = require('../../src/controllers/adminController');
  const Product = require('../../src/models/Product');
  const BlogPost = require('../../src/models/BlogPost');

  /* Vérification préalable : les articles du jeu d'essai sont bien là où le
     plan les range — sinon les tests suivants ne prouveraient rien. */
  for (const cle of ['K_DQ200', 'K_AUDI', 'K_LR', 'K_PONT', 'N_RR', 'N_TDI']) {
    assert.ok(GARDES.has(`/blog/${S[cle]}`), `${cle} doit être dans keep-blog-fr.txt`);
  }
  for (const cle of ['N_RR', 'N_TDI']) assert.ok(A_MAILLER.has(`/blog/${S[cle]}`), `${cle} doit être à mailler`);
  for (const cle of ['K_DQ200', 'K_AUDI', 'K_LR', 'K_PONT']) assert.ok(!A_MAILLER.has(`/blog/${S[cle]}`), `${cle} ne doit pas être à mailler`);
  for (const cle of ['X_LR_PIN', 'X_ALFA_PIN', 'X_D4FD', 'X_AUDI']) assert.ok(NOINDEX_BLOG.has(`/blog/${S[cle]}`), `${cle} doit être dans noindex-blog-fr.txt`);
  for (const cle of ['G_P0726', 'G_HILUX', 'G_CODES']) {
    assert.ok(DISPARUS.has(`/blog/${S[cle]}`) && DISPARUS.has(`/de/blog/${S[cle]}`), `${cle} doit être dans gone-410-blog.txt (FR et DE)`);
  }

  /** Allume les familles (et leurs dates de bascule), vide les caches des sitemaps. */
  function activer(familles, dates = {}) {
    if (familles) process.env.SEO_PRUNE = familles; else delete process.env.SEO_PRUNE;
    for (const cle of Object.keys(process.env)) if (cle.startsWith('SEO_PRUNE_SINCE_')) delete process.env[cle];
    for (const [f, jour] of Object.entries(dates)) process.env[`SEO_PRUNE_SINCE_${f.toUpperCase().replace(/-/g, '_')}`] = jour;
    seo.__test.viderCaches();
  }
  const jour = (decalage) => new Date(Date.now() + decalage * 24 * 3600 * 1000).toISOString().slice(0, 10);
  const TOUTES = 'gone,blog,reference,pieces-auto,de,products';

  function estIndexable(r, quoi) {
    assert.equal(r.status, 200, `${quoi} : statut ${r.status}`);
    assert.ok(!r.xRobotsTag || !/noindex/i.test(r.xRobotsTag), `${quoi} : en-tête X-Robots-Tag « ${r.xRobotsTag} »`);
    const m = metaRobots(r.corps);
    assert.ok(m && /^index/.test(m), `${quoi} : balise robots « ${m} »`);
  }
  function estNoindex(r, quoi) {
    assert.equal(r.status, 200, `${quoi} : statut ${r.status} — la page doit rester en ligne`);
    assert.equal(r.xRobotsTag, 'noindex, follow', `${quoi} : en-tête X-Robots-Tag`);
    assert.equal(metaRobots(r.corps), 'noindex, follow', `${quoi} : la balise robots doit dire la même chose que l'en-tête`);
  }
  const articlesLies = (html) => [...new Set(liens(html).map((h) => h.replace(base, ''))
    .filter((h) => /^(?:\/de)?\/blog\/[^/?#]+$/.test(h)).map((h) => h.replace(/^\/de/, '').slice('/blog/'.length)))];
  const nomsDe = (slugs) => slugs.map((s) => Object.keys(S).find((k) => S[k] === s) || s).sort();

  /* ── gone ─────────────────────────────────────────────────────────────── */

  await t.test('gone : les 268 adresses répondent 410 — page courte vers le blog, balise et en-tête d’accord', async () => {
    activer('gone');
    for (const url of DISPARUS) {
      const r = await get(url);
      assert.equal(r.status, 410, `${url} : ${r.status}`);
      assert.equal(r.location, null, `${url} : un 410, jamais une redirection`);
      assert.equal(r.xRobotsTag, 'noindex, follow', `${url} : en-tête`);
      assert.equal(metaRobots(r.corps), 'noindex, follow', `${url} : balise`);
      const vers = url.startsWith('/de/') ? '/de/blog' : '/blog';
      assert.ok(liens(r.corps).includes(vers), `${url} : la page renvoie vers ${vers}`);
    }
    /* Toutes les écritures de l'adresse. */
    for (const variante of [`/blog/${S.G_P0726}/`, `/BLOG/${S.G_P0726.toUpperCase()}`]) {
      assert.equal((await get(variante)).status, 410, variante);
    }
    /* Un visiteur qui a une session reçoit son cookie à chaque réponse
       (rolling) : la page 410 qui le porte ne doit jamais se déclarer
       « public » — un cache partagé la resservirait, cookie compris, à
       d'autres visiteurs. */
    const UA_HUMAIN = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
    const entree = await get('/de/blog', { entetes: { 'User-Agent': UA_HUMAIN } });
    assert.ok(entree.setCookie, 'jeu d’essai : une page allemande ouvre une session au visiteur');
    const cookie = entree.setCookie.split(';')[0];
    for (const url of [`/blog/${S.G_P0726}`, `/de/blog/${S.G_P0726}`]) {
      const r = await get(url, { entetes: { 'User-Agent': UA_HUMAIN, Cookie: cookie } });
      assert.equal(r.status, 410, url);
      assert.ok(!(r.setCookie && /public/i.test(r.cacheControl || '')),
        `${url} : « ${r.cacheControl} » avec un cookie de session — un cache partagé le distribuerait`);
    }
    /* L'ancienne adresse à la racine ne redirige plus vers un 410. */
    assert.notEqual((await get(`/${S.G_P0726}`)).status, 301);
    /* Le contenu reste en base : couper la famille le rend aussitôt. */
    assert.ok(await BlogPost.exists({ slug: S.G_P0726, isPublished: true }), 'l’article reste en base');
    estIndexable(await get(`/blog/${S.K_DQ200}`), 'un article gardé');
    activer('');
    estIndexable(await get(`/blog/${S.G_P0726}`), 'gone coupé : l’article revient');
  });

  /* ── blog ─────────────────────────────────────────────────────────────── */

  await t.test('blog : hors des 295 gardés, un article sort de Google — même si la base dit « index, follow »', async () => {
    activer('blog');
    for (const cle of ['X_D4FD', 'X_LR_PIN', 'X_AUDI', 'G_P0726']) estNoindex(await get(`/blog/${S[cle]}`), cle);
    for (const cle of ['K_DQ200', 'K_AUDI', 'N_TDI', 'N_RR']) estIndexable(await get(`/blog/${S[cle]}`), cle);
    estIndexable(await get('/blog'), 'la liste /blog');
    /* La couche allemande n'est pas concernée par « blog ». */
    estIndexable(await get(`/de/blog/${S.G_P0726}`), 'article allemand, famille « de » coupée');
    activer('');
    estIndexable(await get(`/blog/${S.X_D4FD}`), 'blog coupé : l’article revient');
  });

  await t.test('blog et gone : listes, barre latérale, accueil, landings, fiches et blocs liés ne citent que des articles gardés', async () => {
    const RETIRES = ['X_LR_PIN', 'X_ALFA_PIN', 'X_D4FD', 'X_AUDI', 'G_P0726', 'G_HILUX', 'G_CODES'].map((c) => S[c]);
    const pages = {
      '/blog': null,
      '/': ['K_AUDI', 'K_DQ200', 'K_LR'],
      '/moteurs': null,
      '/boites-de-transfert': null,
      '/ponts-differentiels': null,
      [urlFr(DQ200)]: ['K_DQ200'],
      '/pieces-auto/audi': ['K_AUDI'],
      '/pieces-auto/audi/a4': null,
      '/pieces-auto/audi/a4/turbos': null,
      '/categorie/boites-de-transfert': ['K_LR'],
      [`/blog/${S.K_AUDI}`]: null,
    };

    /* Avant : chacune de ces pages cite au moins un article retiré. */
    activer('');
    for (const chemin of Object.keys(pages)) {
      const cites = articlesLies((await get(chemin)).corps);
      assert.ok(cites.some((s) => RETIRES.includes(s)), `${chemin} : le jeu d'essai doit citer un article retiré (${nomsDe(cites)})`);
    }

    activer('gone,blog');
    for (const [chemin, attendus] of Object.entries(pages)) {
      const r = await get(chemin);
      assert.equal(r.status, 200, chemin);
      const cites = articlesLies(r.corps);
      const retires = cites.filter((s) => RETIRES.includes(s));
      assert.deepEqual(nomsDe(retires), [], `${chemin} cite encore un article retiré`);
      assert.ok(cites.every((s) => GARDES.has(`/blog/${s}`)), `${chemin} : ${nomsDe(cites)}`);
      if (attendus) {
        for (const cle of attendus) assert.ok(cites.includes(S[cle]), `${chemin} doit citer ${cle} (${nomsDe(cites)})`);
      }
    }
    /* Les blocs que le maillage calcule sans les afficher suivent la même règle. */
    const internalLinking = require('../../src/services/internalLinking');
    const fiche = await Product.findById(DQ200._id).lean();
    const lies = await internalLinking.getProductLinkingData({ ...fiche, compatibility: [{ make: 'Audi', model: 'Q5' }] });
    assert.ok(lies.relatedBlogPosts.every((a) => GARDES.has(`/blog/${a.slug}`)), `fiche : ${nomsDe(lies.relatedBlogPosts.map((a) => a.slug))}`);
    const voisin = await internalLinking.getBlogPostLinkingData(await BlogPost.findById(ids.K_DQ200).lean());
    assert.ok(voisin.siblingBlogPosts.every((a) => GARDES.has(`/blog/${a.slug}`)), `article : ${nomsDe(voisin.siblingBlogPosts.map((a) => a.slug))}`);

    /* Accueil : les deux épinglés retirés sont remplacés — trois cartes. */
    const accueil = articlesLies((await get('/')).corps);
    assert.deepEqual(nomsDe(accueil), ['K_AUDI', 'K_DQ200', 'K_LR']);

    /* « gone » seul : les 410 disparaissent, les articles en noindex restent listés. */
    activer('gone');
    const liste = articlesLies((await get('/blog')).corps);
    assert.ok(liste.includes(S.X_D4FD), 'gone seul : un article en noindex… qui n’est pas encore en noindex reste listé');
    assert.ok(!liste.includes(S.G_P0726) && !liste.includes(S.G_CODES), 'gone : pas de 410 dans /blog');
    const listeDe = articlesLies((await get('/de/blog')).corps);
    assert.ok(!listeDe.includes(S.G_P0726) && listeDe.includes(S.K_DQ200), '/de/blog : pas de 410 allemand');
  });

  await t.test('maillage : chaque article gardé privé de liens en reçoit un depuis un article gardé', async () => {
    const gardes = ['K_DQ200', 'K_AUDI', 'K_LR', 'K_PONT', 'N_RR', 'N_TDI'];
    async function hotesDe(cible) {
      const hotes = [];
      for (const cle of gardes) {
        if (S[cle] === cible) continue;
        if (articlesLies((await get(`/blog/${S[cle]}`)).corps).includes(cible)) hotes.push(cle);
      }
      return hotes;
    }
    activer('');
    assert.deepEqual(await hotesDe(S.N_TDI), [], 'jeu d’essai : aujourd’hui, aucun article gardé ne cite N_TDI');
    for (const familles of ['blog', 'gone', 'gone,blog']) {
      activer(familles);
      for (const cle of ['N_RR', 'N_TDI']) {
        assert.ok((await hotesDe(S[cle])).length >= 1, `${familles} : ${cle} n’est cité par aucun article gardé`);
      }
    }
  });

  await t.test('corps d’article : un lien vers un 410 perd sa balise, sous ses trois écritures (et /de/blog)', async () => {
    const retires = (html) => [...html.matchAll(/<a\b[^>]*>/g)].map((m) => m[0])
      .filter((a) => a.includes(S.G_P0726) || a.includes(S.G_HILUX) || a.includes(S.G_CODES));
    activer('');
    const avant = (await get(`/blog/${S.K_DQ200}`)).corps;
    for (const forme of [`href="/blog/${S.G_P0726}"`, `href="https://autoliva.com/blog/${S.G_P0726}/"`, `href='https://www.carpartsfrance.fr/blog/${S.G_HILUX}'`]) {
      assert.ok(avant.includes(forme), `jeu d’essai : le corps pointe vers ${forme}`);
    }
    const avantDe = liens((await get(`/de/blog/${S.K_DQ200}`)).corps);
    for (const forme of [`/de/blog/${S.G_P0726}`, `/de/blog/${S.G_HILUX}`, `https://autoliva.com/de/blog/${S.G_CODES}`]) {
      assert.ok(avantDe.includes(forme), `jeu d’essai : le corps allemand pointe vers ${forme}`);
    }
    activer('gone');
    const fr = (await get(`/blog/${S.K_DQ200}`)).corps;
    assert.deepEqual(retires(fr), [], 'plus aucun lien vers un 410');
    for (const texte of ['code P0726', 'même guide', 'ancienne adresse']) assert.ok(fr.includes(texte), `le texte « ${texte} » reste`);
    assert.ok(liens(fr).includes(`/blog/${S.X_D4FD}`), 'un lien vers un article en noindex reste : la page est en ligne');
    assert.ok(liens(fr).includes(`/blog/${S.K_AUDI}`), 'un lien vers un article gardé reste');
    const de = (await get(`/de/blog/${S.K_DQ200}`)).corps;
    assert.deepEqual(retires(de), [], 'article allemand : plus aucun lien vers un 410');
    assert.ok(de.includes('Code P0726') && de.includes('DSG-Codes'), 'le texte reste');
    assert.ok(liens(de).includes(`/de/blog/${S.K_AUDI}`), 'le lien vers un article gardé reste');
  });

  /* ── reference ────────────────────────────────────────────────────────── */

  await t.test('reference : toute /reference sort, sauf les 3 gardées, dans toutes les casses ; canonique en majuscules', async () => {
    activer('reference');
    for (const ref of ['0AM927769G', '0am927769g', 'C2D3506']) {
      const r = await get(`/reference/${ref}`);
      estIndexable(r, ref);
      assert.equal(canonique(r.corps), `${base}/reference/${ref.toUpperCase()}`, `${ref} : canonique`);
    }
    for (const ref of ['XYZ-99887', 'xyz-99887']) {
      const r = await get(`/reference/${ref}`);
      estNoindex(r, ref);
      assert.equal(canonique(r.corps), `${base}/reference/XYZ-99887`, `${ref} : canonique en majuscules`);
    }
    activer('');
    assert.equal(canonique((await get('/reference/xyz-99887')).corps), `${base}/reference/xyz-99887`, 'famille coupée : canonique d’avant');
  });

  /* ── pieces-auto ──────────────────────────────────────────────────────── */

  await t.test('pieces-auto : les pages gardées restent, les autres sortent ; la racine n’est pas concernée', async () => {
    activer('pieces-auto');
    for (const chemin of ['/pieces-auto', '/pieces-auto/audi', '/pieces-auto/audi/a4', '/pieces-auto/audi/a4/', '/pieces-auto/opel/zafira', '/pieces-auto/volkswagen']) {
      estIndexable(await get(chemin), chemin);
    }
    for (const chemin of ['/pieces-auto/audi/a4/turbos', '/pieces-auto/opel/zafira/moteurs', '/pieces-auto/volkswagen/golf-caddy-touran']) {
      estNoindex(await get(chemin), chemin);
    }
  });

  /* ── de ───────────────────────────────────────────────────────────────── */

  await t.test('de : toute la couche allemande sort de Google et reste en ligne ; plus de hreflang de, le sélecteur reste', async () => {
    activer('de');
    for (const chemin of ['/de', '/de/blog', `/de/blog/${S.K_DQ200}`, urlDe(DQ200), '/de/categorie/motoren', '/de/contact', '/de/devis', '/de/legal/cgv', '/de/produits']) {
      estNoindex(await get(chemin), chemin);
    }
    /* Fiche française : fr et x-default (français), plus de de ; le sélecteur
       FR/DE de l'en-tête et la suggestion de langue gardent le lien allemand. */
    const fr = await get(urlFr(DQ200), { entetes: { 'Accept-Language': 'de-DE,de;q=0.9' } });
    estIndexable(fr, 'fiche DQ200 française');
    assert.deepEqual(alternates(fr.corps), [['fr', `${base}${urlFr(DQ200)}`], ['x-default', `${base}${urlFr(DQ200)}`]]);
    const versDe = `${base}${urlDe(DQ200)}`;
    assert.ok(new RegExp(`href="${versDe.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}" hreflang="de"`).test(fr.corps), 'le sélecteur FR/DE mène toujours à la page allemande');
    assert.ok(/id="lang-suggest-go" href="[^"]*\/de\/produits\//.test(fr.corps), 'la suggestion de langue propose toujours l’allemand');
    const article = await get(`/blog/${S.K_DQ200}`);
    assert.deepEqual(alternates(article.corps).map(([l]) => l), ['fr', 'x-default']);
    assert.ok(liens(article.corps).includes(`${base}/de/blog/${S.K_DQ200}`), 'le sélecteur de l’article mène à sa version allemande');
    const accueil = await get('/');
    assert.ok(!alternates(accueil.corps).some(([l]) => l === 'de'), 'accueil : plus de hreflang de');
    activer('');
    assert.ok(alternates((await get(urlFr(DQ200))).corps).some(([l]) => l === 'de'), 'famille coupée : le hreflang de revient');
  });

  /* ── products ─────────────────────────────────────────────────────────── */

  await t.test('products : liste du plan et copies distrimotor (DM-) sortent ; le choix de l’admin passe devant ; la fiche reste en vente', async () => {
    activer('products');
    for (const [p, quoi] of [[ASY, 'ASY de la liste'], [DM, 'copie distrimotor gardée par le plan'], [EDN, 'gardée, sortie à la main dans l’admin']]) {
      const r = await get(urlFr(p));
      estNoindex(r, `${p.sku} (${quoi})`);
      assert.ok(r.corps.includes('/panier'), `${p.sku} : toujours en vente`);
    }
    for (const [p, quoi] of [[DQ200, 'fiche faite main'], [ALV_BX, 'gardée par le plan'], [DM_REMISE, 'DM- remise dans Google par l’admin']]) {
      estIndexable(await get(urlFr(p)), `${p.sku} (${quoi})`);
    }
    /* La page allemande d'une fiche retirée sort aussi, même « de » coupée. */
    estNoindex(await get(urlDe(DM)), `${DM.sku} en allemand`);
    estIndexable(await get(urlDe(DQ200)), 'DQ200 en allemand');
    /* Hors « products », le choix de l'admin n'agit pas : couper la famille remet tout. */
    activer('blog');
    for (const p of [ASY, DM, EDN]) estIndexable(await get(urlFr(p)), `${p.sku}, products coupée`);
  });

  /* ── Pages à garder, toutes familles allumées ───────────────────────────── */

  await t.test('toutes les familles allumées : pages statiques, landings Ads, fiches, articles, pages véhicule et références gardés restent indexables', async () => {
    activer(TOUTES);
    const gardees = [
      '/', '/blog', '/produits', '/categorie', '/contact', '/devis', '/faq', '/notre-histoire', '/legal', '/legal/cgv',
      '/moteurs', '/moteurs-reconditionnes', '/boites-vitesse', '/boites-vitesse-reconditionnees', '/ponts-differentiels', '/boites-de-transfert', '/pieces-auto',
      urlFr(DQ200), urlFr(ALV_BX), urlFr(TRANSFERT), urlFr(DM_REMISE),
      ...['K_DQ200', 'K_AUDI', 'K_LR', 'K_PONT', 'N_RR', 'N_TDI'].map((c) => `/blog/${S[c]}`),
      '/pieces-auto/audi', '/pieces-auto/audi/a4', '/pieces-auto/opel/zafira', '/pieces-auto/volkswagen',
      '/reference/0AM927769G', '/reference/C2D3506',
      '/categorie/boites-de-transfert', '/categorie/moteurs', '/categorie/mecatroniques',
    ];
    for (const chemin of gardees) estIndexable(await get(chemin), chemin);
    /* Aucune fiche n'est retirée de la vente : toutes répondent 200. */
    for (const p of FIXTURE.produits) assert.equal((await get(urlFr(p))).status, 200, p.sku);
  });

  /* ── Sitemaps et robots.txt ───────────────────────────────────────────── */

  await t.test('sitemaps : gone et blog — sitemap-blog ne garde que les gardés, deux sitemaps de retrait datés de la bascule', async () => {
    const bascule = jour(-3);
    activer('gone,blog', { gone: bascule, blog: bascule });
    const blog = entrees((await get('/sitemap-blog.xml')).corps);
    assert.deepEqual(nomsDe([...blog.keys()].map((u) => u.slice('/blog/'.length))), ['K_AUDI', 'K_DQ200', 'K_LR', 'K_PONT', 'N_RR', 'N_TDI']);

    const gone = entrees((await get('/sitemap-retraits-gone.xml')).corps);
    assert.deepEqual([...gone.keys()].sort(), [...DISPARUS].sort(), 'les 268 adresses en 410');
    assert.ok([...gone.values()].every((v) => v === bascule), 'lastmod = jour de la bascule');

    const retraitsBlog = entrees((await get('/sitemap-retraits-blog.xml')).corps);
    assert.deepEqual(nomsDe([...retraitsBlog.keys()].map((u) => u.slice('/blog/'.length))), ['X_ALFA_PIN', 'X_AUDI', 'X_D4FD', 'X_LR_PIN']);
    assert.ok([...retraitsBlog.values()].every((v) => v === bascule));

    const blogDe = entrees((await get('/sitemap-blog-de.xml')).corps);
    assert.ok(!blogDe.has(`/de/blog/${S.G_P0726}`) && blogDe.has(`/de/blog/${S.K_DQ200}`), 'sitemap-blog-de : plus de 410');

    const index = entrees((await get('/sitemap.xml')).corps);
    assert.equal(index.get('/sitemap-retraits-gone.xml'), bascule);
    assert.equal(index.get('/sitemap-retraits-blog.xml'), bascule);
    assert.equal(index.get('/sitemap-blog.xml'), '2026-05-20T09:00:00.000Z', 'la date du plus récent article GARDÉ');
    const robots = (await get('/robots.txt')).corps;
    assert.ok(robots.includes(`Sitemap: ${base}/sitemap-retraits-gone.xml`) && robots.includes(`Sitemap: ${base}/sitemap-retraits-blog.xml`));
    assert.ok(!/Disallow: \/blog/.test(robots), 'aucun article n’est bloqué : Google doit lire le noindex');

    /* Sans date de bascule : servi, mais sans lastmod ; une date à venir n'est pas annoncée. */
    activer('blog');
    assert.ok([...entrees((await get('/sitemap-retraits-blog.xml')).corps).values()].every((v) => v === ''));
    activer('blog', { blog: jour(3) });
    assert.ok([...entrees((await get('/sitemap-retraits-blog.xml')).corps).values()].every((v) => v === ''));
    /* Huit semaines après la bascule : 404, hors de l'index et de robots.txt. */
    activer('gone,blog', { gone: jour(-57), blog: jour(-56) });
    assert.equal((await get('/sitemap-retraits-gone.xml')).status, 404);
    assert.equal((await get('/sitemap-retraits-blog.xml')).status, 404);
    assert.ok(!(await get('/robots.txt')).corps.includes('retraits'));
    assert.ok(!(await get('/sitemap.xml')).corps.includes('retraits'));
    /* La famille reste active : sitemap-blog ne garde que les gardés. */
    assert.equal(entrees((await get('/sitemap-blog.xml')).corps).size, 6);
  });

  await t.test('sitemaps : reference garde les 3, pieces-auto les pages gardées, products retire ses fiches — chacun avec son retrait', async () => {
    const bascule = jour(-2);
    activer('reference', { reference: bascule });
    assert.deepEqual([...entrees((await get('/sitemap-references.xml')).corps).keys()], ['/reference/0AM927769G', '/reference/C2D3506']);
    const refsRetirees = entrees((await get('/sitemap-retraits-reference.xml')).corps);
    assert.ok(refsRetirees.has('/reference/XYZ-99887') && refsRetirees.has('/reference/80536744'));
    assert.ok(!refsRetirees.has('/reference/0AM927769G') && !refsRetirees.has('/reference/C2D3506'));
    assert.ok((await get('/sitemap.xml')).corps.includes('/sitemap-references.xml'), 'sitemap-references reste dans l’index');

    activer('pieces-auto', { 'pieces-auto': bascule });
    const vehicules = [...entrees((await get('/sitemap-vehicles.xml')).corps).keys()];
    assert.ok(vehicules.length > 0);
    const garder = new Set(fs.readFileSync(path.join(LISTES, 'keep-pieces-auto.txt'), 'utf8').split('\n').filter(Boolean).map((u) => u.replace('https://autoliva.com', '')));
    assert.deepEqual(vehicules.filter((u) => !garder.has(u)), [], 'sitemap-vehicles : seulement des pages gardées');
    for (const u of ['/pieces-auto/audi', '/pieces-auto/audi/a4', '/pieces-auto/opel/zafira']) assert.ok(vehicules.includes(u), u);
    const vehiculesRetires = entrees((await get('/sitemap-retraits-pieces-auto.xml')).corps);
    assert.ok(vehiculesRetires.has('/pieces-auto/audi/a4/turbos'));
    assert.ok([...vehiculesRetires.keys()].every((u) => !garder.has(u)));

    activer('products', { products: bascule });
    const fiches = entrees((await get('/sitemap-products.xml')).corps);
    for (const p of [DQ200, ALV_BX, DM_REMISE]) assert.ok(fiches.has(urlFr(p)), `${p.sku} reste dans sitemap-products`);
    for (const p of [ASY, DM, EDN]) assert.ok(!fiches.has(urlFr(p)), `${p.sku} sort de sitemap-products`);
    const fichesRetirees = entrees((await get('/sitemap-retraits-products.xml')).corps);
    for (const p of [ASY, DM, EDN]) assert.equal(fichesRetirees.get(urlFr(p)), bascule, `${p.sku} dans le retrait`);
    assert.ok(!fichesRetirees.has(urlFr(DQ200)));
    /* Leur page allemande est servie en noindex elle aussi (getProduct décide
       sur l'_id, dans les deux langues) : un sitemap ne doit pas la proposer.
       Elle quitte sitemap-products-de et rejoint le retrait des fiches. */
    const fichesDe = entrees((await get('/sitemap-products-de.xml')).corps);
    assert.ok(fichesDe.has(urlDe(DQ200)) && fichesDe.has(urlDe(ALV_BX)), 'les fiches gardées restent dans sitemap-products-de');
    for (const p of [ASY, DM, EDN]) {
      assert.ok(!fichesDe.has(urlDe(p)), `${p.sku} : page allemande en noindex encore proposée par sitemap-products-de`);
      assert.equal(fichesRetirees.get(urlDe(p)), bascule, `${p.sku} : page allemande dans le retrait`);
    }
    assert.ok(!fichesRetirees.has(urlDe(DQ200)) && !fichesRetirees.has(urlDe(ALV_BX)));
    /* « de » déjà allumée : la page allemande était sortie avant, avec son
       propre retrait — la redater au jour de « products » serait faux. */
    activer('de,products', { de: jour(-9), products: bascule });
    const avecDe = entrees((await get('/sitemap-retraits-products.xml')).corps);
    assert.ok(avecDe.has(urlFr(DM)) && !avecDe.has(urlDe(DM)), 'retraits-products, « de » allumée : sans les pages allemandes');
    activer('');
    const toutesDe = entrees((await get('/sitemap-products-de.xml')).corps);
    for (const p of [ASY, DM, EDN, DQ200]) assert.ok(toutesDe.has(urlDe(p)), `products coupée : ${p.sku} revient dans sitemap-products-de`);

    /* Pas de sitemap de retrait des fiches tant que « products » est coupée. */
    activer('gone,blog,reference,pieces-auto,de');
    assert.equal((await get('/sitemap-retraits-products.xml')).status, 404);
    assert.ok(!(await get('/robots.txt')).corps.includes('retraits-products'));
  });

  await t.test('sitemaps : de — les sitemaps allemands quittent l’index et robots.txt, servis huit semaines datés de la bascule, puis 404', async () => {
    const bascule = jour(-4);
    activer('de', { de: bascule });
    const index = (await get('/sitemap.xml')).corps;
    const robots = (await get('/robots.txt')).corps;
    for (const e of ['sitemap-categories-de.xml', 'sitemap-products-de.xml', 'sitemap-blog-de.xml']) {
      assert.ok(!index.includes(e), `index : ${e} doit sortir`);
      assert.ok(!robots.includes(e), `robots.txt : ${e} doit sortir`);
      const r = await get(`/${e}`);
      assert.equal(r.status, 200, `${e} reste servi`);
      const dates = [...entrees(r.corps).values()];
      assert.ok(dates.length > 0 && dates.every((v) => v === bascule), `${e} : chaque adresse datée de la bascule`);
    }
    assert.ok(index.includes('sitemap-retraits-de.xml') && robots.includes('sitemap-retraits-de.xml'));
    const retraits = entrees((await get('/sitemap-retraits-de.xml')).corps);
    for (const u of ['/de', '/de/blog', '/de/legal/cgv', '/de/categorie/motoren', urlDe(DQ200), `/de/blog/${S.K_DQ200}`]) {
      assert.equal(retraits.get(u), bascule, `retraits-de : ${u}`);
    }
    activer('de', { de: jour(-60) });
    for (const e of ['sitemap-categories-de.xml', 'sitemap-products-de.xml', 'sitemap-blog-de.xml', 'sitemap-retraits-de.xml']) {
      assert.equal((await get(`/${e}`)).status, 404, `${e} : 404 après huit semaines`);
    }
  });

  await t.test('flux Merchant : toutes les familles allumées, chaque fiche publiée y reste (français et allemand)', async () => {
    activer('');
    const avant = await get('/google-merchant-feed.xml');
    const avantDe = await get('/google-merchant-feed-de.xml');
    activer(TOUTES, { products: jour(-1), de: jour(-1) });
    const apres = await get('/google-merchant-feed.xml');
    const apresDe = await get('/google-merchant-feed-de.xml');
    const idsDe = (xml) => [...xml.matchAll(/<g:id>([^<]*)<\/g:id>/g)].map((m) => m[1]).sort();
    assert.equal(apres.status, 200);
    assert.deepEqual(idsDe(apres.corps), idsDe(avant.corps));
    assert.deepEqual(idsDe(apresDe.corps), idsDe(avantDe.corps));
    for (const p of [ASY, DM, EDN]) assert.ok(apres.corps.includes(p.slug), `${p.sku} reste dans le flux`);
  });

  /* ── Admin ────────────────────────────────────────────────────────────── */

  function fausseReponse() {
    const res = { code: 200, payload: null, vue: null, options: null, redirection: null, locals: {} };
    res.status = (c) => { res.code = c; return res; };
    res.json = (p) => { res.payload = p; return res; };
    res.render = (vue, options) => { res.vue = vue; res.options = options; return res; };
    res.redirect = (a, b) => { res.redirection = b || a; return res; };
    return res;
  }
  const lot = (prefixe, n) => Array.from({ length: n }, (_, i) => ({
    nom: `Pièce d'import ${prefixe} ${i + 1}`, sku: `IMP-${prefixe}-${i + 1}`, prix_ttc: 199, categorie: 'Autre', statut: 'brouillon',
  }));
  async function importer(items) {
    const res = fausseReponse();
    await admin.postAdminImportProducts({ body: items, session: { admin: { adminUserId: null } } }, res);
    assert.equal(res.payload && res.payload.ok, true, JSON.stringify(res.payload));
    return res.payload;
  }
  const choix = async (sku) => ((await Product.findOne({ sku }).lean()) || {}).seo || {};

  await t.test('admin : un lot de plus de 3 fiches importé avec « products » active naît hors de Google', async () => {
    activer('products');
    const r = await importer(lot('A', 4));
    assert.equal(r.summary.created, 4);
    for (const res of r.results) assert.equal(res.indexation, 'noindex', res.sku);
    for (let i = 1; i <= 4; i++) assert.equal((await choix(`IMP-A-${i}`)).indexOverride, 'noindex');

    const trois = await importer(lot('B', 3));
    assert.equal(trois.summary.created, 3);
    for (let i = 1; i <= 3; i++) assert.equal((await choix(`IMP-B-${i}`)).indexOverride, undefined, '3 fiches : pas un lot');

    activer('blog');
    await importer(lot('C', 4));
    for (let i = 1; i <= 4; i++) assert.equal((await choix(`IMP-C-${i}`)).indexOverride, undefined, '« products » coupée : rien');

    /* Une mise à jour par SKU ne touche pas à l'indexation. */
    activer('products');
    await importer([...lot('B', 3), ...lot('D', 1)].map((it) => ({ ...it, prix_ttc: 249 })));
    for (let i = 1; i <= 3; i++) assert.equal((await choix(`IMP-B-${i}`)).indexOverride, undefined, `IMP-B-${i} mise à jour`);
    assert.equal((await choix('IMP-D-1')).indexOverride, 'noindex', 'la fiche créée par ce lot de 4');
  });

  await t.test('admin : le choix d’indexation se lit, s’enregistre et passe devant la liste du plan', async () => {
    activer('products');
    const edition = fausseReponse();
    await admin.getAdminEditProductPage({ params: { productId: String(ASY._id) }, session: { admin: { adminUserId: null } }, query: {} }, edition, (e) => { throw e; });
    assert.equal(edition.vue, 'admin/product');
    assert.equal(edition.options.form.seoIndexOverride, '');
    assert.equal(edition.options.seoIndexState.code, 'noindex-liste');

    /* Le formulaire rend le sélecteur, sur l'état de la fiche. */
    const ejs = require('ejs');
    const vues = path.join(__dirname, '..', '..', 'src', 'views');
    const source = fs.readFileSync(path.join(vues, 'admin', 'product.ejs'), 'utf8');
    const debut = source.indexOf('<%# Indexation fiche par fiche');
    const fin = source.indexOf('</section>', debut);
    const fragment = ejs.render(source.slice(debut, fin), { form: { seoIndexOverride: 'index' }, seoIndexState: edition.options.seoIndexState });
    assert.match(fragment, /<select[^>]*name="seoIndexOverride"/);
    assert.match(fragment, /<option value="index" selected>/);
    assert.match(fragment, /data-seo-index-etat="noindex-liste"/);

    const corps = {
      name: ASY.name, slug: ASY.slug, sku: ASY.sku, category: ASY.category, price: '4990', isPublished: 'true',
      imageUrl: '/images/test.jpg', specType: 'Moteur', badgeTopLeft: 'Garantie 12 mois', badgeCondition: 'Reconditionné',
      shortDescription: 'Moteur reconditionné.', description: 'Moteur reconditionné, testé.', seoIndexOverride: 'index',
    };
    const enregistrer = async (body) => {
      const res = fausseReponse();
      await admin.postAdminUpdateProduct({ params: { productId: String(ASY._id) }, body, session: { admin: { adminUserId: null } } }, res, (e) => { throw e; });
      assert.ok(res.redirection, `enregistrement refusé : ${res.options && res.options.errorMessage}`);
    };
    await enregistrer(corps);
    assert.equal((await choix(ASY.sku)).indexOverride, 'index');
    estIndexable(await get(urlFr(ASY)), 'ASY remise dans Google depuis l’admin');

    /* Un enregistrement qui n'envoie pas le champ ne l'efface pas. */
    const sansChamp = { ...corps };
    delete sansChamp.seoIndexOverride;
    await enregistrer(sansChamp);
    assert.equal((await choix(ASY.sku)).indexOverride, 'index');

    /* « Automatique » : la liste du plan reprend la main. */
    await enregistrer({ ...corps, seoIndexOverride: '' });
    assert.equal((await choix(ASY.sku)).indexOverride, undefined);
    estNoindex(await get(urlFr(ASY)), 'ASY revenue à la politique');
    activer('');
  });
});
