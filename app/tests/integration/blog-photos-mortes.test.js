/**
 * Une image dont le fichier a disparu ne doit plus sortir : ni en couverture,
 * ni en og:image, ni dans le JSON-LD, ni dans les sitemaps — en français comme
 * en allemand. À la place, la photo du premier produit lié.
 *
 * Lancé par : npm test
 *
 * Base : mongodb-memory-server, créée et détruite par ce fichier. MONGODB_URI
 * est volontairement IGNORÉE : dans ce dépôt elle désigne la PRODUCTION.
 *
 * ── Ce qu'on reproduit ───────────────────────────────────────────────────────
 *
 * Les images vivent dans GridFS ; les documents n'en gardent que l'adresse.
 * Quand le fichier manque, la route sert un carré gris en 200 : rien ne casse,
 * rien ne se voit. En octobre 2026, 196 articles affichaient ce carré, et
 * l'envoyaient à Google en og:image et dans sitemap-blog.xml.
 *
 * Un média « présent », ici, c'est une ligne dans media.files avec une taille
 * non nulle ; un média « mort », c'est une adresse sans ligne. C'est exactement
 * ce que teste le code de production.
 */

process.env.BRAND = 'autoliva';
delete process.env.SEO_PRUNE;

const test = require('node:test');
const assert = require('node:assert');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

const BlogPost = require('../../src/models/BlogPost');
const Product = require('../../src/models/Product');
const mediaStorage = require('../../src/services/mediaStorage');
const blogController = require('../../src/controllers/blogController');
const blogDeController = require('../../src/controllers/blogDeController');
const seoController = require('../../src/controllers/seoController');

let memoire;
const SLUG = 'test-photo-morte';
const ID_VIVANT = '000000000000000000000001';
const ID_MORT = '000000000000000000000002';
const URL_VIVANTE = `/media/${ID_VIVANT}`;
const URL_MORTE = `/media/${ID_MORT}`;

test.before(async () => {
  const uri = process.env.TEST_MONGODB_URI || (memoire = await MongoMemoryServer.create()).getUri();
  await mongoose.connect(uri);

  /* Un seul média stocké : le vivant. L'autre adresse ne correspond à rien,
     c'est tout ce qui fait qu'une image est « morte ». */
  await mongoose.connection.db.collection('media.files').insertOne({
    _id: new mongoose.Types.ObjectId(ID_VIVANT),
    filename: 'pont-haldex.webp',
    contentType: 'image/webp',
    length: 102400,
    uploadDate: new Date('2026-06-17T09:00:00Z'),
  });

  const produit = await Product.create({
    name: 'Pont arrière Haldex 0CQ525010 reconditionné',
    slug: 'pont-arriere-haldex-0cq525010',
    sku: 'TEST-HALDEX',
    priceCents: 89000,
    imageUrl: URL_VIVANTE,
    isPublished: true,
  });

  await BlogPost.create({
    title: 'Pont arrière Haldex : diagnostic et prix',
    slug: SLUG,
    isPublished: true,
    publishedAt: new Date('2026-05-10T10:00:00Z'),
    excerpt: 'Diagnostic du pont Haldex.',
    coverImageUrl: URL_MORTE,
    seo: { ogImageUrl: URL_MORTE },
    relatedProductIds: [produit._id],
    contentMarkdown: [
      'Le pont Haldex demande une vidange régulière.',
      '',
      `![Pont Haldex](${URL_MORTE})`,
      '',
      'Les roulements sont contrôlés un par un.',
    ].join('\n'),
    localizations: {
      de: {
        translatedAt: new Date('2026-09-08T10:00:00Z'),
        title: 'Haldex-Hinterachse: Diagnose und Preis',
        excerpt: 'Diagnose der Haldex-Kupplung.',
        contentHtml: '<p>Die Haldex-Kupplung braucht regelmäßigen Ölwechsel.</p>'
          + `<p><img src="${URL_MORTE}" alt="Haldex" loading="lazy"/></p>`
          + '<p>Die Lager werden einzeln geprüft.</p>',
      },
    },
  });
});

test.after(async () => {
  if (mongoose.connection.readyState === 1) {
    await BlogPost.deleteMany({ slug: SLUG });
    await Product.deleteMany({ sku: 'TEST-HALDEX' });
    await mongoose.disconnect();
  }
  if (memoire) await memoire.stop();
});

test.beforeEach(() => {
  /* Le cache des médias garde sa réponse dix minutes : chaque test repart
     d'une ardoise propre, sinon l'ordre des tests changerait le résultat. */
  mediaStorage.viderCacheMedias();
});

function fausseReq(lang) {
  const chemin = lang === 'de' ? `/de/blog/${SLUG}` : `/blog/${SLUG}`;
  return {
    params: { slug: SLUG }, query: {}, lang, path: chemin, originalUrl: chemin,
    protocol: 'https', hostname: 'autoliva.com', headers: { host: 'autoliva.com' },
    get: (h) => (String(h).toLowerCase() === 'host' ? 'autoliva.com' : undefined),
  };
}

function fausseRes() {
  const res = { code: 200, vue: null, rendu: null, locals: {}, entetes: {}, corps: null };
  res.status = (c) => { res.code = c; return res; };
  res.set = (k, v) => { res.entetes[k] = v; return res; };
  res.type = () => res;
  res.removeHeader = () => res;
  res.send = (c) => { res.corps = c; return res; };
  res.render = (vue, locals) => { res.vue = vue; res.rendu = locals; return res; };
  res.redirect = (a, b) => { res.redirection = b || a; return res; };
  return res;
}

test('article français : la couverture morte cède la place à la photo du produit lié', async () => {
  const res = fausseRes();
  await blogController.getBlogPost(fausseReq('fr'), res, (e) => { throw e; });
  assert.equal(res.vue, 'blog/show', `rendu inattendu (${res.code} ${res.vue})`);

  assert.ok(!String(res.rendu.post.coverImageUrl || '').includes(ID_MORT),
    'la couverture morte est encore affichée');
  assert.ok(String(res.rendu.post.coverImageUrl || '').includes(ID_VIVANT),
    'la photo du produit lié n’a pas pris le relais');

  assert.ok(!String(res.rendu.ogImage || '').includes(ID_MORT), 'og:image morte');
  assert.ok(String(res.rendu.ogImage || '').includes(ID_VIVANT), 'og:image sans repli');

  const brut = res.rendu.jsonLd;
  const ld = typeof brut === 'string' ? JSON.parse(brut) : brut;
  const article = (ld['@graph'] || [ld]).find((n) => n['@type'] === 'BlogPosting');
  assert.ok(!JSON.stringify(article.image || []).includes(ID_MORT), 'image morte dans le JSON-LD');
});

test('article allemand : même repli, qui lui manquait complètement', async () => {
  const res = fausseRes();
  await blogDeController.getBlogPostDe(fausseReq('de'), res, (e) => { throw e; });
  assert.equal(res.vue, 'blog/show', `rendu inattendu (${res.code} ${res.vue})`);

  assert.ok(!String(res.rendu.post.coverImageUrl || '').includes(ID_MORT),
    'la couverture morte est encore affichée côté allemand');
  assert.ok(String(res.rendu.ogImage || '').includes(ID_VIVANT),
    'l’allemand n’a pas repris la photo du produit lié');
});

test('sitemap-blog.xml : aucune image morte déclarée à Google', async () => {
  if (seoController.__test && seoController.__test.viderCaches) seoController.__test.viderCaches();
  const res = fausseRes();
  await seoController.getSitemapBlog(fausseReq('fr'), res, (e) => { throw e; });
  const xml = String(res.corps || '');
  assert.ok(xml.includes(`/blog/${SLUG}`), 'l’article devrait être dans le sitemap');
  assert.ok(!xml.includes(ID_MORT), 'une image morte est déclarée dans sitemap-blog.xml');
});

test('sitemap-blog-de.xml : même règle', async () => {
  if (seoController.__test && seoController.__test.viderCaches) seoController.__test.viderCaches();
  const res = fausseRes();
  await seoController.getSitemapBlogDe(fausseReq('de'), res, (e) => { throw e; });
  assert.ok(!String(res.corps || '').includes(ID_MORT),
    'une image morte est déclarée dans sitemap-blog-de.xml');
});

test('stockage vide : on ne déclare RIEN mort, pour ne pas vider le site', async () => {
  const fichiers = mongoose.connection.db.collection('media.files');
  const sauvegarde = await fichiers.find({}).toArray();
  await fichiers.deleteMany({});
  mediaStorage.viderCacheMedias();
  try {
    const absents = await mediaStorage.idsAbsentsEnCache([URL_MORTE, URL_VIVANTE]);
    assert.equal(absents.size, 0,
      'stockage vide : aucune image ne doit être déclarée morte (base non restaurée)');
  } finally {
    if (sauvegarde.length) await fichiers.insertMany(sauvegarde);
    mediaStorage.viderCacheMedias();
  }
});

test('le cache répond sans retourner en base, et se vide', async () => {
  const premier = await mediaStorage.idsAbsentsEnCache([URL_MORTE]);
  assert.equal(premier.size, 1, 'la première lecture doit voir l’image morte');
  const second = await mediaStorage.idsAbsentsEnCache([URL_MORTE]);
  assert.equal(second.size, 1, 'la réponse en cache doit être la même');
  mediaStorage.viderCacheMedias();
  const apres = await mediaStorage.idsAbsentsEnCache([URL_MORTE]);
  assert.equal(apres.size, 1, 'après vidage, la base redit la même chose');
});
