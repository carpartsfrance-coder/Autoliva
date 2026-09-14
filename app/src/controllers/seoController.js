const mongoose = require('mongoose');

const Product = require('../models/Product');
const Category = require('../models/Category');
const LegalPage = require('../models/LegalPage');
const BlogPost = require('../models/BlogPost');
const demoProducts = require('../demoProducts');
const { buildProductPublicUrl, getPublicBaseUrlFromReq } = require('../services/productPublic');
const { buildCategoryPublicUrl, compterFichesPubliees } = require('../services/categoryPublic');
const { DEFAULT_LEGAL_PAGES } = require('../services/legalPages');
const { buildSeoMediaUrl } = require('../services/mediaStorage');
/* Dates des sitemaps : jamais updatedAt (plan de reprise SEO du 14/09/2026,
   action A4.5) — voir services/datesSeo.js. */
const datesSeo = require('../services/datesSeo');
/* Politique d'indexation (plan de reprise SEO du 14/09/2026, action A5.6) :
   les sitemaps suivent les mêmes interrupteurs que la balise robots. Une
   famille ne quitte les sitemaps qu'une fois allumée dans SEO_PRUNE ; un
   sitemap de retrait temporaire la montre alors à Google. */
const seoIndexPolicy = require('../services/seoIndexPolicy');

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/* ─── Helpers de rendu XML ────────────────────────────────────────────── */

function renderUrlset(urls, { withImages = false } = {}) {
  const ns = withImages
    ? `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">`
    : `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;

  const body = urls.map((u) => {
    const lastmod = u.lastmod ? `\n    <lastmod>${escapeXml(u.lastmod)}</lastmod>` : '';
    const imageXml = withImages
      ? (u.images || [])
        .filter(Boolean)
        .map((imgUrl) => {
          const title = u.imageTitle ? `\n      <image:title>${escapeXml(u.imageTitle)}</image:title>` : '';
          return `\n    <image:image>\n      <image:loc>${escapeXml(imgUrl)}</image:loc>${title}\n    </image:image>`;
        })
        .join('')
      : '';
    return `  <url>\n    <loc>${escapeXml(u.loc)}</loc>${lastmod}${imageXml}\n  </url>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n${ns}\n${body}\n</urlset>\n`;
}

function renderSitemapIndex(sitemaps) {
  const body = sitemaps.map((s) => {
    const lastmod = s.lastmod ? `\n    <lastmod>${escapeXml(s.lastmod)}</lastmod>` : '';
    return `  <sitemap>\n    <loc>${escapeXml(s.loc)}</loc>${lastmod}\n  </sitemap>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    body + `\n</sitemapindex>\n`;
}

function sendXml(res, xml) {
  /* Le middleware express-session ajoute un Set-Cookie sur toutes les réponses
     (rolling: true). Sur un sitemap public, ce cookie casse le cache CDN et
     peut faire échouer le crawl Google ("Impossible de lire le sitemap"
     dans Search Console). On nettoie donc le header avant l'envoi. */
  res.removeHeader('Set-Cookie');
  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=600');
  return res.status(200).send(xml);
}

function absMediaUrl(baseUrl, mediaPath) {
  if (!mediaPath) return '';
  return baseUrl ? `${baseUrl}${mediaPath}` : mediaPath;
}

/* ─── Sous-sitemaps ──────────────────────────────────────────────────── */

async function buildPagesUrls(baseUrl, dbConnected) {
  const resolveUrl = (path) => baseUrl ? `${baseUrl}${path}` : path;
  const urls = [
    { loc: resolveUrl('/'), lastmod: '' },
    { loc: resolveUrl('/produits'), lastmod: '' },
    { loc: resolveUrl('/categorie'), lastmod: '' },
    { loc: resolveUrl('/pieces-auto'), lastmod: '' },
    { loc: resolveUrl('/blog'), lastmod: '' },
    { loc: resolveUrl('/contact'), lastmod: '' },
    { loc: resolveUrl('/devis'), lastmod: '' },
    { loc: resolveUrl('/faq'), lastmod: '' },
    { loc: resolveUrl('/notre-histoire'), lastmod: '' },
    { loc: resolveUrl('/legal'), lastmod: '' },
    // Landings devis (capture leads) — indexables, porteuses des requêtes money.
    { loc: resolveUrl('/moteurs'), lastmod: '' },
    { loc: resolveUrl('/moteurs-reconditionnes'), lastmod: '' },
    { loc: resolveUrl('/boites-vitesse'), lastmod: '' },
    { loc: resolveUrl('/boites-vitesse-reconditionnees'), lastmod: '' },
    { loc: resolveUrl('/ponts-differentiels'), lastmod: '' },
    { loc: resolveUrl('/boites-de-transfert'), lastmod: '' },
  ];

  let legalPages = [];
  if (dbConnected) {
    legalPages = await LegalPage.find({ isPublished: { $ne: false } })
      .select('_id slug')
      .sort({ sortOrder: 1, title: 1 })
      .lean();
  } else {
    legalPages = (DEFAULT_LEGAL_PAGES || []).map((p) => ({ slug: p.slug }));
  }

  /* Pas de lastmod : updatedAt des pages légales bouge aussi quand on écrit
     leur traduction allemande (scripts/translate-legal-de.js), sans que le
     texte français change. */
  for (const lp of legalPages) {
    if (!lp || !lp.slug) continue;
    urls.push({ loc: resolveUrl(`/legal/${encodeURIComponent(lp.slug)}`), lastmod: '' });
  }
  return urls;
}

async function buildCategoriesUrls(req, dbConnected) {
  if (!dbConnected) {
    /* Mode demo (sans DB) : construire les catégories depuis demoProducts. */
    const bySlug = new Map();
    for (const p of demoProducts || []) {
      const raw = p && typeof p.category === 'string' ? p.category.trim() : '';
      if (!raw) continue;
      const main = raw.includes('>') ? raw.split('>')[0].trim() : raw;
      const slug = main.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      if (!slug) continue;
      if (!bySlug.has(slug)) bySlug.set(slug, { slug });
    }
    const urls = [];
    for (const c of bySlug.values()) {
      const loc = buildCategoryPublicUrl(c, { req });
      if (loc) urls.push({ loc, lastmod: '' });
    }
    return urls;
  }

  const cats = await Category.find({ isActive: true })
    .select('_id slug name')
    .sort({ sortOrder: 1, name: 1 })
    .lean();

  /* Catégories VIDES hors du sitemap (plan de reprise SEO du 14/09/2026,
     action A4.6). La page d'une catégorie sans fiche publiée se sert en
     noindex (categoryController) : la lister ici demandait à Google d'explorer
     42 pages qu'on lui interdit d'indexer. Même règle que la page, calculée à
     chaque construction : une catégorie qui se remplit revient d'elle-même.
     Si le comptage échoue, on garde la liste entière — mieux vaut un sitemap
     trop long qu'un sitemap vide. */
  let comptes = null;
  try {
    comptes = await compterFichesPubliees(cats.map((c) => c && c.name).filter(Boolean));
  } catch (err) {
    console.error('[sitemap] catégories : comptage impossible, liste complète :', err && err.message ? err.message : err);
  }

  const urls = [];
  /* Pas de lastmod : une page catégorie est une liste de fiches, elle n'a pas
     de « dernière modification » propre — et updatedAt n'en est pas une. */
  for (const c of cats) {
    if (!c || !c.slug) continue;
    if (comptes && !(comptes.get(c.name) > 0)) continue;
    const loc = buildCategoryPublicUrl(c, { req });
    if (!loc) continue;
    urls.push({ loc, lastmod: '' });
  }
  return urls;
}

/* Cache + verrou pour le sitemap produits.
   Mesuré en production : 4,7 s et 11 Mo par appel, reconstruit à CHAQUE
   demande, et cette route est montée hors du limiteur de débit. Un crawler un
   peu insistant la reconstruisait en boucle. 30 min de cache : une fiche
   publiée apparaît dans le sitemap au plus une demi-heure plus tard, ce qui
   ne change rien à son indexation. */
const PRODUCTS_URLS_CACHE = { value: null, expiresAt: 0, baseUrl: null };
const PRODUCTS_URLS_TTL_MS = 30 * 60 * 1000;
let PRODUCTS_URLS_EN_COURS = null;

/* Fiches du sitemap, famille « products » appliquée : une fiche sortie de
   Google n'y figure plus. Le cache garde TOUTES les fiches ; le filtre passe
   à la lecture, l'état de l'interrupteur ne peut donc pas y rester collé. */
async function buildProductsUrls(req, baseUrl, dbConnected) {
  const toutes = await buildProductsUrlsToutes(req, baseUrl, dbConnected);
  if (!seoIndexPolicy.familleActive('products')) return toutes;
  return toutes.filter((u) => !seoIndexPolicy.produitNoindex(u.produit));
}

async function buildProductsUrlsToutes(req, baseUrl, dbConnected) {
  const now = Date.now();
  if (dbConnected && PRODUCTS_URLS_CACHE.value && PRODUCTS_URLS_CACHE.expiresAt > now
      && PRODUCTS_URLS_CACHE.baseUrl === baseUrl) {
    return PRODUCTS_URLS_CACHE.value;
  }
  if (dbConnected && PRODUCTS_URLS_EN_COURS) return PRODUCTS_URLS_EN_COURS;
  const construction = buildProductsUrlsSansCache(req, baseUrl, dbConnected).then((urls) => {
    if (dbConnected) {
      PRODUCTS_URLS_CACHE.value = urls;
      PRODUCTS_URLS_CACHE.expiresAt = Date.now() + PRODUCTS_URLS_TTL_MS;
      PRODUCTS_URLS_CACHE.baseUrl = baseUrl;
    }
    return urls;
  });
  if (dbConnected) PRODUCTS_URLS_EN_COURS = construction;
  try {
    return await construction;
  } finally {
    if (PRODUCTS_URLS_EN_COURS === construction) PRODUCTS_URLS_EN_COURS = null;
  }
}

async function buildProductsUrlsSansCache(req, baseUrl, dbConnected) {
  let products = [];
  if (dbConnected) {
    products = await Product.find({ isPublished: { $ne: false } })
      .select('_id slug sku name imageUrl galleryUrls seo.indexOverride')
      .sort({ updatedAt: -1 })
      .lean();
  } else {
    products = (demoProducts || []).slice();
  }

  const urls = [];
  for (const p of products) {
    if (!p || !p._id) continue;
    const loc = buildProductPublicUrl(p, { req });
    if (!loc) continue;
    const images = [];
    if (p.imageUrl) images.push(absMediaUrl(baseUrl, buildSeoMediaUrl(p.imageUrl, p.name)));
    if (Array.isArray(p.galleryUrls)) {
      for (const u of p.galleryUrls) {
        if (typeof u === 'string' && u.trim()) {
          images.push(absMediaUrl(baseUrl, buildSeoMediaUrl(u.trim(), p.name)));
        }
      }
    }
    /* lastmod = jour où la fiche a regagné sa description (A3), et seulement
       pour celles-là. Les autres n'ont pas changé : rien à annoncer. */
    urls.push({
      loc,
      lastmod: datesSeo.lastmodFicheFr(p),
      images,
      imageTitle: p.name || '',
      /* De quoi appliquer la famille « products » à la lecture du cache. */
      produit: { _id: p._id, sku: p.sku, seo: p.seo },
    });
  }
  return urls;
}

/* Cache mémoire pour buildVehiclesUrls.
 *
 * Pourquoi : la construction fait jusqu'à ~2 000 requêtes DB séquentielles
 * (countCompatibleProducts + listCategorySlugsForVehicle par modèle), ce
 * qui faisait timeout le /sitemap-vehicles.xml et le /sitemap.xml (qui
 * appelait aussi cette fonction pour vérifier que le sous-sitemap n'est
 * pas vide). Semrush flaggait alors "Sitemap not found" et "page couldn't
 * be crawled" — 4 errors. Cache 10 min suffit : la liste de véhicules
 * change rarement, et un sitemap pas tout à fait à jour à 10 min près
 * n'a aucun impact SEO. */
const VEHICLE_URLS_CACHE = { value: null, expiresAt: 0 };
const VEHICLE_URLS_TTL_MS = 10 * 60 * 1000; // 10 min

/* Verrou anti-ruée : plusieurs crawlers demandant le même sitemap pendant une
   reconstruction partagent UNE promesse au lieu de lancer N reconstructions. */
let VEHICLE_URLS_EN_COURS = null;

/**
 * Construit les URLs /pieces-auto/:marque[/:modele[/:categorie]] en UNE
 * agrégation.
 *
 * Pourquoi (diagnostic du 08/2026) : l'ancienne version bouclait sur chaque
 * marque puis chaque modèle et faisait un `countDocuments` par étape, soit
 * ~2 000 requêtes séquentielles, chacune un balayage complet des 14 464 fiches
 * (regex sur `compatibility`, non indexé). Mesuré en production : la route NE
 * FINISSAIT PAS (coupée à 120 s), et pendant qu'elle tournait, /produits
 * passait de 2 s à 8 s pour tout le monde. Google la redemande régulièrement ;
 * chaque fois, le site ralentissait.
 *
 * Une seule agrégation `$unwind compatibility` + `$group (marque, modèle)`
 * donne les mêmes informations (combien de fiches par couple, et quelles
 * catégories) en 683 ms mesurés sur la même base.
 *
 * Équivalence avec l'ancien calcul : il comparait marque et modèle en regex
 * exacte insensible à la casse (`^X$`, option i). On groupe donc sur les
 * valeurs passées en minuscules et on les rapproche de `nameLower` renvoyé
 * par listMakes().
 */
async function buildVehiclesUrlsToutes(req, baseUrl, dbConnected) {
  if (!dbConnected) return [];
  const now = Date.now();
  if (VEHICLE_URLS_CACHE.value && VEHICLE_URLS_CACHE.expiresAt > now
      && VEHICLE_URLS_CACHE.baseUrl === baseUrl) {
    return VEHICLE_URLS_CACHE.value;
  }
  if (VEHICLE_URLS_EN_COURS) return VEHICLE_URLS_EN_COURS;

  VEHICLE_URLS_EN_COURS = (async () => {
    const resolveUrl = (path) => baseUrl ? `${baseUrl}${path}` : path;
    const urls = [];
    /* Une URL, une entrée (plan de reprise SEO du 14/09/2026, action A4.6).
       Les marques et modèles sont groupés tels qu'écrits dans les fiches :
       « AUDI » et « Audi », « A4 » et « a4 » font deux groupes mais le même
       slug — 471 URL sortaient deux fois sur 8 281. */
    const dejaListees = new Set();
    const ajouter = (path) => {
      if (dejaListees.has(path)) return;
      dejaListees.add(path);
      urls.push({ loc: resolveUrl(path), lastmod: '' });
    };
    try {
      const vehicleService = require('../services/vehicleLandingService');
      const Category = require('../models/Category');
      const [makes, couples, categories] = await Promise.all([
        vehicleService.listMakes(),
        Product.aggregate([
          { $match: { isPublished: { $ne: false } } },
          { $unwind: '$compatibility' },
          {
            $project: {
              make: { $toLower: { $trim: { input: { $ifNull: ['$compatibility.make', ''] } } } },
              model: { $toLower: { $trim: { input: { $ifNull: ['$compatibility.model', ''] } } } },
              category: { $ifNull: ['$category', ''] },
            },
          },
          { $match: { make: { $ne: '' } } },
          {
            $group: {
              _id: { make: '$make', model: '$model' },
              n: { $sum: 1 },
              cats: { $addToSet: '$category' },
            },
          },
        ]),
        Category.find({ isActive: { $ne: false } }).select('name slug').lean(),
      ]);

      /* Index (marque : total) et (marque|modèle : catégories) depuis le résultat. */
      const parMarque = new Map();
      const parCouple = new Map();
      for (const row of couples) {
        const make = row._id.make;
        const model = row._id.model;
        parMarque.set(make, (parMarque.get(make) || 0) + row.n);
        if (model) parCouple.set(make + '|' + model, row.cats || []);
      }
      /* Nom exact de catégorie produit vers slug de Category, comme
         listCategorySlugsForVehicle le faisait via `name: { $in }`. */
      const slugParNomCategorie = new Map();
      for (const c of categories) {
        if (c.name && c.slug) slugParNomCategorie.set(c.name, { name: c.name, slug: c.slug });
      }

      for (const make of makes) {
        if (!(parMarque.get(make.nameLower) > 0)) continue;
        ajouter(`/pieces-auto/${make.slug}`);
        for (const model of (make.models || [])) {
          const cats = parCouple.get(make.nameLower + '|' + model.nameLower);
          if (!cats) continue;
          ajouter(`/pieces-auto/${make.slug}/${model.slug}`);
          const slugs = cats
            .map((nom) => slugParNomCategorie.get(nom))
            .filter(Boolean)
            .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
          for (const cat of slugs) {
            ajouter(`/pieces-auto/${make.slug}/${model.slug}/${cat.slug}`);
          }
        }
      }
    } catch (err) {
      console.error('[sitemap] vehicle landings : erreur ignorée :', err && err.message ? err.message : err);
      // Version cachée même expirée plutôt qu'un sitemap vide.
      if (VEHICLE_URLS_CACHE.value && VEHICLE_URLS_CACHE.baseUrl === baseUrl) {
        return VEHICLE_URLS_CACHE.value;
      }
      return [];
    }
    VEHICLE_URLS_CACHE.value = urls;
    VEHICLE_URLS_CACHE.expiresAt = Date.now() + VEHICLE_URLS_TTL_MS;
    VEHICLE_URLS_CACHE.baseUrl = baseUrl;
    return urls;
  })();

  try {
    return await VEHICLE_URLS_EN_COURS;
  } finally {
    VEHICLE_URLS_EN_COURS = null;
  }
}

/* Pages véhicule du sitemap, famille « pieces-auto » appliquée : seules les
   242 pages gardées y restent. Même principe que les fiches : le cache garde
   tout, le filtre passe à la lecture. */
async function buildVehiclesUrls(req, baseUrl, dbConnected) {
  const toutes = await buildVehiclesUrlsToutes(req, baseUrl, dbConnected);
  if (!seoIndexPolicy.familleActive('pieces-auto')) return toutes;
  return toutes.filter((u) => seoIndexPolicy.pieceAutoIndexable(cheminDe(u.loc)));
}

/* Chemin d'une <loc> absolue ou relative (https://autoliva.com/x → /x). */
function cheminDe(loc) {
  const s = String(loc || '');
  if (s.startsWith('/')) return s;
  try { return new URL(s).pathname; } catch (_) { return s; }
}

/* Références : sitemap-references.xml, famille « reference » appliquée — il
   ne garde alors que les 3 références qui ont rapporté (plan SEO A8). Le
   filtre porte sur la requête et non sur sa sortie : la limite de 5 000
   s'applique après le tri alphabétique, et C2D3506 aurait pu passer dessous.
   `pourRetrait` : toutes les AUTRES références, sans limite de 5 000, pour
   sitemap-retraits-reference.xml. */
async function buildReferencesUrls(baseUrl, dbConnected, { pourRetrait = false } = {}) {
  if (!dbConnected) return [];
  const resolveUrl = (path) => baseUrl ? `${baseUrl}${path}` : path;
  const urls = [];
  const filtree = seoIndexPolicy.familleActive('reference');
  const gardees = seoIndexPolicy.referencesGardees();
  let selection = [];
  if (pourRetrait) selection = [{ $match: { _id: { $nin: gardees } } }];
  else if (filtree) selection = [{ $match: { _id: { $in: gardees } } }];
  try {
    const refRows = await Product.aggregate([
      { $match: { isPublished: { $ne: false }, compatibleReferences: { $exists: true, $ne: [] } } },
      { $unwind: '$compatibleReferences' },
      { $project: { ref: { $trim: { input: '$compatibleReferences' } } } },
      { $match: { ref: { $regex: /^[A-Za-z0-9._\-/]{4,50}$/ } } },
      { $group: { _id: { $toUpper: '$ref' } } },
      ...selection,
      { $sort: { _id: 1 } },
      { $limit: pourRetrait ? 50000 : 5000 },
    ]);
    for (const row of refRows || []) {
      if (!row || !row._id) continue;
      urls.push({ loc: resolveUrl(`/reference/${encodeURIComponent(row._id)}`), lastmod: '' });
    }
  } catch (err) {
    console.error('[sitemap] OEM references : erreur ignorée :', err && err.message ? err.message : err);
  }
  return urls;
}

async function buildBlogUrls(baseUrl, dbConnected) {
  if (!dbConnected) return [];
  const resolveUrl = (path) => baseUrl ? `${baseUrl}${path}` : path;
  /* Famille « blog » : seuls les 295 articles gardés ; « gone » : pas les 410. */
  const posts = await BlogPost.find(seoIndexPolicy.publicBlogFilter({ isPublished: true }))
    .select('_id slug title publishedAt createdAt coverImageUrl')
    .sort({ publishedAt: -1, updatedAt: -1 })
    .lean();
  const urls = [];
  for (const bp of posts) {
    if (!bp || !bp.slug) continue;
    const loc = resolveUrl(`/blog/${encodeURIComponent(String(bp.slug))}`);
    /* La date de publication, pas updatedAt : l'écriture en masse du 08/09
       avait redaté 1 173 articles dont pas un mot n'avait changé. */
    const last = datesSeo.isoPasse(datesSeo.dateModificationArticle(bp));
    const images = [];
    if (bp.coverImageUrl) images.push(absMediaUrl(baseUrl, buildSeoMediaUrl(bp.coverImageUrl, bp.title)));
    urls.push({ loc, lastmod: last, images, imageTitle: bp.title || '' });
  }
  return urls;
}

/* Sitemap DE : ne liste QUE les articles avec une traduction allemande
 * effectivement publiée (localizations.de.translatedAt non null). Un article
 * en cours de traduction n'apparaît pas, ce qui évite à Google d'indexer une
 * 404 ou un fallback FR. */
async function buildBlogUrlsDe(baseUrl, dbConnected) {
  if (!dbConnected) return [];
  const resolveUrl = (path) => baseUrl ? `${baseUrl}${path}` : path;
  const posts = await BlogPost.find(seoIndexPolicy.publicBlogFilter({
    isPublished: true,
    'localizations.de.translatedAt': { $ne: null },
  }, { lang: 'de' }))
    .select('_id slug title publishedAt createdAt coverImageUrl localizations.de.translatedAt localizations.de.title')
    .sort({ publishedAt: -1, updatedAt: -1 })
    .lean();
  const urls = [];
  for (const bp of posts) {
    if (!bp || !bp.slug) continue;
    const deLoc = bp.localizations && bp.localizations.de;
    if (!deLoc || !deLoc.translatedAt) continue;
    const loc = resolveUrl(`/de/blog/${encodeURIComponent(String(bp.slug))}`);
    /* lastmod = date de la traduction, celle du texte allemand servi. Plus
       updatedAt, qui bouge quand on ÉCRIT la traduction… et le reste. */
    const last = datesSeo.isoPasse(datesSeo.dateModificationArticleDe(bp));
    const images = [];
    const imgTitle = deLoc.title || bp.title;
    if (bp.coverImageUrl) images.push(absMediaUrl(baseUrl, buildSeoMediaUrl(bp.coverImageUrl, imgTitle)));
    urls.push({ loc, lastmod: last, images, imageTitle: imgTitle || '' });
  }
  return urls;
}

/* Sitemap DE produits : ne liste QUE les fiches avec une traduction allemande
 * publiée (localizations.de.translatedAt non null) → Google n'indexe jamais une
 * fiche DE en cours de traduction (qui ferait un 301 vers le FR). URL alignée
 * sur la canonique servie par getProduct : /de/produits/<slug-de>-<id>. */
/* Catégories allemandes : elles existent (/de/categorie/<slug-de>) mais ne
   figuraient dans AUCUN sitemap — Google n'avait aucun moyen de les découvrir
   autrement qu'en suivant un lien depuis une page déjà connue. */
async function buildCategoryUrlsDe(req, baseUrl, dbConnected) {
  if (!dbConnected) return [];
  const cats = await Category.find({
    isActive: true,
    'localizations.de.translatedAt': { $ne: null },
  })
    .select('_id slug localizations.de.slug localizations.de.translatedAt')
    .sort({ sortOrder: 1, name: 1 })
    .lean();

  const urls = [];
  for (const c of cats) {
    const deLoc = c && c.localizations && c.localizations.de;
    if (!deLoc || !deLoc.translatedAt) continue;
    const deSlug = (deLoc.slug && String(deLoc.slug).trim()) || c.slug;
    if (!deSlug) continue;
    const path = `/de/categorie/${encodeURIComponent(deSlug)}`;
    urls.push({ loc: baseUrl ? `${baseUrl}${path}` : path, lastmod: datesSeo.isoPasse(datesSeo.dateTraductionDe(c)) });
  }
  return urls;
}

async function buildProductUrlsDe(req, baseUrl, dbConnected) {
  if (!dbConnected) return [];
  const products = await Product.find({
    isPublished: { $ne: false },
    'localizations.de.translatedAt': { $ne: null },
  })
    .select('_id slug name imageUrl galleryUrls localizations.de.translatedAt localizations.de.slug localizations.de.name')
    .sort({ updatedAt: -1 })
    .lean();

  const urls = [];
  for (const p of products) {
    if (!p || !p._id) continue;
    const deLoc = p.localizations && p.localizations.de;
    if (!deLoc || !deLoc.translatedAt) continue;
    const deSlug = (deLoc.slug && String(deLoc.slug).trim()) || p.slug || String(p._id);
    const path = `/de/produits/${encodeURIComponent(deSlug)}-${p._id}`;
    const loc = baseUrl ? `${baseUrl}${path}` : path;
    /* lastmod = date de la traduction : c'est elle qui a fait le texte
       allemand de la page. updatedAt bouge à chaque stock ou prix. */
    const last = datesSeo.isoPasse(datesSeo.dateTraductionDe(p));
    const imgTitle = deLoc.name || p.name;
    const images = [];
    if (p.imageUrl) images.push(absMediaUrl(baseUrl, buildSeoMediaUrl(p.imageUrl, imgTitle)));
    if (Array.isArray(p.galleryUrls)) {
      for (const u of p.galleryUrls) {
        if (typeof u === 'string' && u.trim()) images.push(absMediaUrl(baseUrl, buildSeoMediaUrl(u.trim(), imgTitle)));
      }
    }
    urls.push({ loc, lastmod: last, images, imageTitle: imgTitle || '' });
  }
  return urls;
}

/* ─── Routes ─────────────────────────────────────────────────────────── */

/* /sitemap.xml — sitemap index pointant vers les sous-sitemaps.
   Si l'index est désactivé (SITEMAP_LEGACY_FLAT=true) on retourne le format
   monolithique pour compat.

   IMPORTANT : on liste systématiquement tous les sous-sitemaps sans tester
   leur contenu. La version précédente lançait des requêtes DB pour chacun
   (buildVehiclesUrls fait un Vehicle.find() sur 2065 docs) afin de skipper
   les sitemaps vides — résultat : timeout du /sitemap.xml et du
   /sitemap-vehicles.xml en prod, flaggés par Semrush comme "sitemap not
   found" + "page couldn't be crawled" (2 errors chacun).

   Un sous-sitemap vide est valide pour Google (urlset vide accepté). On
   préfère sur-lister que sous-lister. */
/* Dernière modification RÉELLE de chaque sous-sitemap.
 *
 * L'index annonçait `lastmod` = l'heure de la requête, identique pour les neuf
 * enfants. Google documente qu'il IGNORE un lastmod jugé peu fiable, et « tous
 * modifiés à la seconde près, à chaque visite » en est l'exemple type. Il
 * n'avait donc aucun moyen de savoir que sitemap-products-de.xml avait
 * vraiment changé le 4 septembre, quand 9 242 fiches allemandes sont nées.
 *
 * Contrainte héritée d'une panne : la version qui testait le CONTENU de chaque
 * sous-sitemap faisait un Vehicle.find() sur 2 065 documents et mettait
 * /sitemap.xml en timeout. On ne lit donc qu'UNE ligne par collection, sur un
 * champ trié, et on garde le résultat en mémoire.
 *
 * Plan de reprise SEO du 14/09/2026 (action A4.5) : chaque enfant annonce la
 * plus récente des dates qu'il contient, et ces dates ne viennent plus
 * d'updatedAt (voir services/datesSeo.js). Un enfant sans date — pages,
 * catégories, pages véhicule, références — n'en annonce pas ; et en cas
 * d'échec, on n'en annonce pas non plus : « maintenant » était une fraîcheur
 * inventée, exactement ce que Google apprend à ignorer.
 */
const LASTMOD_TTL_MS = 10 * 60 * 1000;
let lastmodCache = { at: 0, valeurs: null };

async function datesDerniereModif() {
  const sig = seoIndexPolicy.signature();
  if (lastmodCache.valeurs && lastmodCache.sig === sig && Date.now() - lastmodCache.at < LASTMOD_TTL_MS) return lastmodCache.valeurs;
  if (mongoose.connection.readyState !== 1) return {};

  const dernier = async (modele, champ, filtre) => {
    try {
      const d = await modele.findOne(filtre || {}).sort({ [champ]: -1 }).select(champ).lean()
        .maxTimeMS(2000);
      const v = champ.split('.').reduce((o, k) => (o == null ? undefined : o[k]), d);
      return datesSeo.isoPasse(v) || null;
    } catch (e) { return null; }
  };

  const BlogPost = require('../models/BlogPost');
  const pasDansLeFutur = { $lte: new Date() };
  const [produitsDe, categoriesDe, blog, blogDe] = await Promise.all([
    dernier(Product, 'localizations.de.translatedAt', { isPublished: { $ne: false }, 'localizations.de.translatedAt': { $ne: null, ...pasDansLeFutur } }),
    dernier(Category, 'localizations.de.translatedAt', { isActive: true, 'localizations.de.translatedAt': { $ne: null, ...pasDansLeFutur } }),
    /* Les articles qui ont quitté le sitemap (410, noindex) ne lui donnent
       plus sa date : c'étaient justement les plus récents. */
    dernier(BlogPost, 'publishedAt', seoIndexPolicy.publicBlogFilter({ isPublished: true, publishedAt: pasDansLeFutur })),
    dernier(BlogPost, 'localizations.de.translatedAt', seoIndexPolicy.publicBlogFilter({ isPublished: true, 'localizations.de.translatedAt': { $ne: null, ...pasDansLeFutur } }, { lang: 'de' })),
  ]);

  const valeurs = {
    produits: datesSeo.lastmodIndexFichesFr() || null,
    produitsDe,
    categoriesDe,
    blog,
    blogDe,
  };
  lastmodCache = { at: Date.now(), valeurs, sig };
  return valeurs;
}

/* ─── Sitemaps et politique d'indexation ─────────────────────────────────── */

/* Les sous-sitemaps, dans l'ordre de l'index et de robots.txt. */
const ENFANTS = [
  'sitemap-pages.xml',
  'sitemap-categories.xml',
  'sitemap-categories-de.xml',
  'sitemap-products.xml',
  'sitemap-products-de.xml',
  'sitemap-vehicles.xml',
  'sitemap-references.xml',
  'sitemap-blog.xml',
  'sitemap-blog-de.xml',
];
const ENFANTS_DE = new Set(['sitemap-categories-de.xml', 'sitemap-products-de.xml', 'sitemap-blog-de.xml']);

/**
 * Sous-sitemaps annoncés (index et robots.txt), selon SEO_PRUNE :
 *   - « de » actif : les trois sitemaps allemands en sortent (ils restent
 *     servis huit semaines, voir servirSitemapDeRetire) ;
 *   - chaque famille allumée ajoute sitemap-retraits-<famille>.xml pendant
 *     ses huit semaines.
 * SEO_PRUNE absent : exactement la liste d'avant.
 */
function enfantsAnnonces() {
  const sansDe = seoIndexPolicy.familleActive('de');
  const enfants = ENFANTS.filter((e) => !(sansDe && ENFANTS_DE.has(e)));
  for (const famille of seoIndexPolicy.famillesEnRetrait()) enfants.push(`sitemap-retraits-${famille}.xml`);
  return enfants;
}

/**
 * Sitemap allemand retiré (famille « de ») : il sert encore sa liste pendant
 * huit semaines, chaque adresse datée du jour de la bascule — Google repasse
 * et lit le noindex —, puis répond 404. Rien ne change sans « de ».
 * Renvoie true si la réponse est partie (ou confiée au 404).
 */
function servirSitemapDeRetire(req, res, next, urls) {
  if (!seoIndexPolicy.familleActive('de')) return false;
  if (!seoIndexPolicy.retraitsEnCours('de')) { next(); return true; }
  const jour = seoIndexPolicy.dateBascule('de');
  sendXml(res, renderUrlset(urls.map((u) => ({ ...u, lastmod: jour })), { withImages: true }));
  return true;
}

/* Pages allemandes sans sitemap propre : l'accueil, les index, contact, devis
   et les pages légales traduites. Elles sortent aussi de Google avec « de ». */
async function buildPagesUrlsDe(baseUrl, dbConnected) {
  const resolveUrl = (path) => baseUrl ? `${baseUrl}${path}` : path;
  const chemins = ['/de', '/de/produits', '/de/categorie', '/de/blog', '/de/contact', '/de/devis', '/de/legal'];
  if (dbConnected) {
    const legales = await LegalPage.find({ isPublished: { $ne: false }, 'localizations.de.translatedAt': { $ne: null } })
      .select('slug')
      .sort({ sortOrder: 1, title: 1 })
      .lean();
    for (const lp of legales) if (lp && lp.slug) chemins.push(`/de/legal/${encodeURIComponent(lp.slug)}`);
  }
  return chemins.map((c) => ({ loc: resolveUrl(c), lastmod: '' }));
}

/* Adresses qui quittent Google avec chaque famille : le contenu des
   sitemap-retraits-<famille>.xml. */
const RETRAITS = {
  async gone(req, baseUrl) {
    return seoIndexPolicy.cheminsDisparus().map((c) => ({ loc: baseUrl ? `${baseUrl}${c}` : c }));
  },
  async blog(req, baseUrl, dbConnected) {
    if (!dbConnected) return [];
    /* Tout article publié hors des 295 gardés ; les 410 ont leur propre
       fichier quand « gone » est allumé. */
    const exclus = seoIndexPolicy.articlesGardes();
    if (seoIndexPolicy.familleActive('gone')) {
      for (const c of seoIndexPolicy.cheminsDisparus()) if (c.startsWith('/blog/')) exclus.push(c.slice('/blog/'.length));
    }
    const posts = await BlogPost.find({ isPublished: true, slug: { $nin: exclus } }).select('slug').sort({ slug: 1 }).lean();
    return posts.filter((p) => p && p.slug).map((p) => ({ loc: `${baseUrl}/blog/${encodeURIComponent(String(p.slug))}` }));
  },
  async reference(req, baseUrl, dbConnected) {
    return buildReferencesUrls(baseUrl, dbConnected, { pourRetrait: true });
  },
  async 'pieces-auto'(req, baseUrl, dbConnected) {
    const toutes = await buildVehiclesUrlsToutes(req, baseUrl, dbConnected);
    const garder = new Set(['pieces-auto']);
    return toutes.filter((u) => seoIndexPolicy.decisionChemin(cheminDe(u.loc), garder));
  },
  async de(req, baseUrl, dbConnected) {
    const [pages, categories, fiches, articles] = await Promise.all([
      buildPagesUrlsDe(baseUrl, dbConnected),
      buildCategoryUrlsDe(req, baseUrl, dbConnected),
      buildProductUrlsDe(req, baseUrl, dbConnected),
      buildBlogUrlsDe(baseUrl, dbConnected),
    ]);
    return [...pages, ...categories, ...fiches, ...articles];
  },
  async products(req, baseUrl, dbConnected) {
    const toutes = await buildProductsUrlsToutes(req, baseUrl, dbConnected);
    return toutes.filter((u) => seoIndexPolicy.produitNoindex(u.produit));
  },
};

/* GET /sitemap-retraits-<famille>.xml — n'existe que pendant les huit
   semaines qui suivent l'allumage de la famille ; chaque adresse porte la
   date de la bascule en <lastmod>. Sinon : la requête continue vers le 404. */
async function getSitemapRetraits(req, res, next) {
  try {
    const famille = String((req.params && req.params[0]) || '').toLowerCase();
    if (!Object.prototype.hasOwnProperty.call(RETRAITS, famille) || !seoIndexPolicy.retraitsEnCours(famille)) return next();
    const dbConnected = mongoose.connection.readyState === 1;
    const baseUrl = getPublicBaseUrlFromReq(req);
    const jour = seoIndexPolicy.dateBascule(famille);
    const urls = await RETRAITS[famille](req, baseUrl, dbConnected);
    return sendXml(res, renderUrlset(urls.map((u) => ({ loc: u.loc, lastmod: jour }))));
  } catch (err) {
    return next(err);
  }
}

async function getSitemapXml(req, res, next) {
  try {
    const baseUrl = getPublicBaseUrlFromReq(req);

    if (process.env.SITEMAP_LEGACY_FLAT === 'true') {
      return getLegacyFlatSitemap(req, res, next);
    }

    const resolveUrl = (path) => baseUrl ? `${baseUrl}${path}` : path;
    const d = await datesDerniereModif().catch(() => ({}));
    const dates = {
      'sitemap-categories-de.xml': d.categoriesDe || '',
      'sitemap-products.xml': d.produits || '',
      'sitemap-products-de.xml': d.produitsDe || '',
      'sitemap-blog.xml': d.blog || '',
      'sitemap-blog-de.xml': d.blogDe || '',
    };
    /* Les sitemaps de retrait annoncent la date de leur bascule. */
    for (const famille of seoIndexPolicy.famillesEnRetrait()) {
      dates[`sitemap-retraits-${famille}.xml`] = seoIndexPolicy.dateBascule(famille);
    }
    const sitemaps = enfantsAnnonces().map((e) => ({ loc: resolveUrl(`/${e}`), lastmod: dates[e] || '' }));

    return sendXml(res, renderSitemapIndex(sitemaps));
  } catch (err) {
    return next(err);
  }
}

/* Format flat : tout dans un seul sitemap.xml (anciennement la valeur par
   défaut). Conservé en flag pour rollback rapide si besoin. */
async function getLegacyFlatSitemap(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const baseUrl = getPublicBaseUrlFromReq(req);

    const all = []
      .concat(await buildPagesUrls(baseUrl, dbConnected))
      .concat(await buildCategoriesUrls(req, dbConnected))
      .concat(await buildVehiclesUrls(req, baseUrl, dbConnected))
      .concat(await buildReferencesUrls(baseUrl, dbConnected))
      .concat(await buildProductsUrls(req, baseUrl, dbConnected))
      .concat(await buildBlogUrls(baseUrl, dbConnected));

    return sendXml(res, renderUrlset(all, { withImages: true }));
  } catch (err) {
    return next(err);
  }
}

async function getSitemapPages(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const baseUrl = getPublicBaseUrlFromReq(req);
    const urls = await buildPagesUrls(baseUrl, dbConnected);
    return sendXml(res, renderUrlset(urls));
  } catch (err) {
    return next(err);
  }
}

async function getSitemapCategories(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const urls = await buildCategoriesUrls(req, dbConnected);
    return sendXml(res, renderUrlset(urls));
  } catch (err) {
    return next(err);
  }
}

async function getSitemapProducts(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const baseUrl = getPublicBaseUrlFromReq(req);
    const urls = await buildProductsUrls(req, baseUrl, dbConnected);
    return sendXml(res, renderUrlset(urls, { withImages: true }));
  } catch (err) {
    return next(err);
  }
}

async function getSitemapVehicles(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const baseUrl = getPublicBaseUrlFromReq(req);
    const urls = await buildVehiclesUrls(req, baseUrl, dbConnected);
    return sendXml(res, renderUrlset(urls));
  } catch (err) {
    return next(err);
  }
}

async function getSitemapReferences(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const baseUrl = getPublicBaseUrlFromReq(req);
    const urls = await buildReferencesUrls(baseUrl, dbConnected);
    return sendXml(res, renderUrlset(urls));
  } catch (err) {
    return next(err);
  }
}

async function getSitemapBlog(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const baseUrl = getPublicBaseUrlFromReq(req);
    const urls = await buildBlogUrls(baseUrl, dbConnected);
    return sendXml(res, renderUrlset(urls, { withImages: true }));
  } catch (err) {
    return next(err);
  }
}

async function getSitemapBlogDe(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const baseUrl = getPublicBaseUrlFromReq(req);
    const urls = await buildBlogUrlsDe(baseUrl, dbConnected);
    if (servirSitemapDeRetire(req, res, next, urls)) return undefined;
    return sendXml(res, renderUrlset(urls, { withImages: true }));
  } catch (err) {
    return next(err);
  }
}

async function getSitemapCategoriesDe(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const baseUrl = getPublicBaseUrlFromReq(req);
    const urls = await buildCategoryUrlsDe(req, baseUrl, dbConnected);
    if (servirSitemapDeRetire(req, res, next, urls)) return undefined;
    return sendXml(res, renderUrlset(urls));
  } catch (err) {
    return next(err);
  }
}

async function getSitemapProductsDe(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const baseUrl = getPublicBaseUrlFromReq(req);
    const urls = await buildProductUrlsDe(req, baseUrl, dbConnected);
    if (servirSitemapDeRetire(req, res, next, urls)) return undefined;
    return sendXml(res, renderUrlset(urls, { withImages: true }));
  } catch (err) {
    return next(err);
  }
}

function getRobotsTxt(req, res) {
  /* Même pollution Set-Cookie que sur sitemap : on nettoie. */
  res.removeHeader('Set-Cookie');

  if (process.env.FORCE_NOINDEX === 'true') {
    const body = [
      'User-agent: *',
      'Disallow: /',
      '',
    ].join('\n');

    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=600');
    return res.status(200).send(body);
  }

  const baseUrl = getPublicBaseUrlFromReq(req);
  const abs = (path) => (baseUrl ? `${baseUrl}${path}` : path);

  const lines = [
    '# =====================================================',
    '# robots.txt — autoliva.com',
    '# Optimisé suite migration carpartsfrance.fr',
    '# =====================================================',
    '',
    'User-agent: *',
    'Allow: /',
    '',
    '# --- Zones privées ---',
    'Disallow: /admin',
    'Disallow: /admin/',
    'Disallow: /panier',
    'Disallow: /panier/',
    'Disallow: /commande',
    'Disallow: /commande/',
    'Disallow: /compte',
    'Disallow: /compte/',
    'Disallow: /mon-compte',
    'Disallow: /mon-compte/',
    'Disallow: /checkout',
    'Disallow: /checkout/',
    'Disallow: /cart',
    'Disallow: /cart/',
    '',
    '# --- URLs paramétrées WooCommerce résiduelles (CRITIQUE) ---',
    'Disallow: /*?s=',
    'Disallow: /*?post_type=',
    'Disallow: /*?filter_cat=',
    'Disallow: /*?filter_tag=',
    'Disallow: /*?filter_*=',
    'Disallow: /*?add-to-cart=',
    'Disallow: /*?remove_item=',
    'Disallow: /*?undo_item=',
    'Disallow: /*?shop_view=',
    'Disallow: /*?orderby=',
    'Disallow: /*?per_page=',
    'Disallow: /*?min_price=',
    'Disallow: /*?max_price=',
    'Disallow: /*?wpf=',
    'Disallow: /*?paged=',
    'Disallow: /*?currency=',
    'Disallow: /*?utm_*=',
    'Disallow: /*?fbclid=',
    'Disallow: /*?gclid=',
    'Disallow: /*?msclkid=',
    'Disallow: /*?mc_cid=',
    'Disallow: /*?mc_eid=',
    '',
    '# --- Recherches internes ---',
    'Disallow: /search/',
    'Disallow: /?s=',
    '',
    '# --- Pages utilisateur ---',
    'Disallow: /wishlist',
    'Disallow: /wishlist/',
    'Disallow: /lost-password',
    'Disallow: /reset-password',
    'Disallow: /devis-en-cours/',
    'Disallow: /commande-recue/',
    'Disallow: /confirmation/',
    'Disallow: /thank-you/',
    '',
    '# --- Endpoints techniques ---',
    'Disallow: /api/',
    'Disallow: /_next/',
    'Disallow: /feed/',
    '',
    '# --- Bots indésirables ---',
    'User-agent: AhrefsBot',
    'Crawl-delay: 5',
    '',
    'User-agent: SemrushBot',
    'Crawl-delay: 5',
    '',
    'User-agent: MJ12bot',
    'Disallow: /',
    '',
    'User-agent: DotBot',
    'Disallow: /',
    '',
    '# --- Sitemaps ---',
    `Sitemap: ${abs('/sitemap.xml')}`,
    /* Mêmes sous-sitemaps que l'index, selon SEO_PRUNE (plan SEO A5.6).
       Aucune page n'est jamais bloquée ici : Google doit pouvoir lire le
       noindex d'une page pour la retirer. */
    ...enfantsAnnonces().map((e) => `Sitemap: ${abs(`/${e}`)}`),
    '',
  ];

  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=600');
  return res.status(200).send(lines.join('\n'));
}

module.exports = {
  getSitemapXml,
  getRobotsTxt,
  getSitemapPages,
  getSitemapCategories,
  getSitemapCategoriesDe,
  getSitemapProducts,
  getSitemapProductsDe,
  getSitemapVehicles,
  getSitemapReferences,
  getSitemapBlog,
  getSitemapBlogDe,
  getSitemapRetraits,
};

/* Exposé pour les tests d'équivalence et de cache (pas une API). */
module.exports.__test = {
  buildVehiclesUrls,
  buildProductsUrls,
  /* Les sitemaps sont en cache (10 à 30 min) : un test qui change une donnée
     ou un interrupteur entre deux lectures doit repartir de zéro. */
  viderCaches() {
    PRODUCTS_URLS_CACHE.value = null;
    PRODUCTS_URLS_CACHE.expiresAt = 0;
    VEHICLE_URLS_CACHE.value = null;
    VEHICLE_URLS_CACHE.expiresAt = 0;
    lastmodCache = { at: 0, valeurs: null };
  },
};

