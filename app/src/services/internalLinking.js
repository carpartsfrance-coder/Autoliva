'use strict';

/**
 * internalLinking.js
 *
 * Service central pour le maillage interne SEO.
 *
 * Pourquoi ce service existe :
 *   Avant ce service, les pages marque/modèle/money/catégorie/blog/produit
 *   ne se liaient quasiment pas entre elles (audit SEO v2 de 2026-04-30 :
 *   page marque BMW = 0 lien vers ses 67 modèles, page modèle = 0 lien vers
 *   ses sous-catégories). Conséquence : Google ne consolidait pas la
 *   thématique transmission/marque, et les concurrents (GTH, Itemauto)
 *   gagnaient les SERP commerciales malgré un contenu moins riche.
 *
 * Stratégie :
 *   On expose une fonction par page-type qui retourne la matrice des liens
 *   à insérer dans la page (modèles enfants, catégories sœurs, articles
 *   blog liés, produits similaires…). Les controllers injectent ce résultat
 *   dans les locals EJS, et les vues affichent les blocs via un partial
 *   commun internal-linking-blocks.ejs.
 *
 * Cache léger (5 min) sur les requêtes qui agrègent beaucoup de docs
 * (similarité produits, blog matching), pour éviter de surcharger Mongo.
 */

const mongoose = require('mongoose');
const { slugify } = require('./productPublic');

const CACHE_TTL_MS = 5 * 60 * 1000;
const _cache = new Map();

function getCached(key) {
  const entry = _cache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.at > CACHE_TTL_MS) {
    _cache.delete(key);
    return null;
  }
  return entry.value;
}

function setCached(key, value) {
  _cache.set(key, { value, at: Date.now() });
}

function clearCache() {
  _cache.clear();
}

function safeRegexEscape(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function dbReady() {
  return mongoose.connection.readyState === 1;
}

/* ─── 1. Page MARQUE — /pieces-auto/:make ─────────────────────────────── */

/**
 * Retourne le maillage pour une page marque (ex. /pieces-auto/bmw) :
 *   - childModels[]   : tous les modèles de la marque qui ont ≥1 produit publié
 *   - availableCategories[] : catégories qui ont ≥1 produit pour cette marque
 *   - relatedBlogPosts[]    : 6 articles blog dont le titre contient la marque
 *   - siblingMakes[]        : 5 autres marques (rotation alphabétique)
 */
async function getMakeLinkingData(makeName) {
  if (!makeName || !dbReady()) {
    return { childModels: [], availableCategories: [], relatedBlogPosts: [], siblingMakes: [] };
  }
  const cacheKey = `make:${makeName.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const Product = require('../models/Product');
  const Category = require('../models/Category');
  const BlogPost = require('../models/BlogPost');
  const vehicleService = require('./vehicleLandingService');

  /* Modèles enfants : tous les modèles de cette marque qui ont ≥1 produit. */
  const escMake = safeRegexEscape(makeName);
  const modelRows = await Product.aggregate([
    { $match: { isPublished: { $ne: false } } },
    { $unwind: '$compatibility' },
    { $match: { 'compatibility.make': { $regex: `^${escMake}$`, $options: 'i' } } },
    {
      $group: {
        _id: '$compatibility.model',
        productCount: { $sum: 1 },
      },
    },
    { $match: { _id: { $ne: '' } } },
    { $sort: { _id: 1 } },
    { $limit: 200 },
  ]);
  const makeSlug = slugify(makeName);
  const childModels = modelRows
    .filter((r) => r._id)
    .map((r) => ({
      name: r._id,
      slug: slugify(r._id),
      url: `/pieces-auto/${makeSlug}/${slugify(r._id)}`,
      productCount: r.productCount,
    }));

  /* Catégories disponibles : on récupère les noms catégorie distincts des
     produits de cette marque, puis on matche contre Category pour les slugs. */
  const productCategoryNames = await Product.distinct('category', {
    isPublished: { $ne: false },
    compatibility: { $elemMatch: { make: { $regex: `^${escMake}$`, $options: 'i' } } },
  });
  /* On ne garde que les catégories top-level pour le maillage (sinon explosion
     combinatoire et jus dilué). On split sur " > " et on ne garde que la racine. */
  const topLevelNames = new Set();
  for (const cat of productCategoryNames || []) {
    if (typeof cat !== 'string' || !cat.trim()) continue;
    const top = cat.includes('>') ? cat.split('>')[0].trim() : cat.trim();
    if (top) topLevelNames.add(top);
  }
  const cats = topLevelNames.size > 0
    ? await Category.find({
        name: { $in: Array.from(topLevelNames) },
        isActive: { $ne: false },
      }).select('name slug').lean()
    : [];
  const availableCategories = cats.map((c) => ({
    name: c.name,
    slug: c.slug,
    url: `/categorie/${c.slug}`,
  })).sort((a, b) => a.name.localeCompare(b.name, 'fr'));

  /* Articles blog liés : titre OU slug OU primaryKeyword contient la marque. */
  const relatedBlogPosts = await BlogPost.find({
    isPublished: true,
    $or: [
      { title: { $regex: escMake, $options: 'i' } },
      { slug: { $regex: makeSlug, $options: 'i' } },
      { 'seo.primaryKeyword': { $regex: escMake, $options: 'i' } },
    ],
  })
    .select('slug title coverImageUrl publishedAt readingTimeMinutes')
    .sort({ publishedAt: -1 })
    .limit(6)
    .lean();

  /* Sibling makes : 5 marques alphabétiquement adjacentes (navigation). */
  const allMakes = await vehicleService.listMakes();
  const idx = allMakes.findIndex((m) => m.name.toLowerCase() === makeName.toLowerCase());
  const siblingMakes = idx >= 0
    ? [
        ...allMakes.slice(Math.max(0, idx - 2), idx),
        ...allMakes.slice(idx + 1, idx + 4),
      ].slice(0, 5).map((m) => ({ name: m.name, slug: m.slug, url: `/pieces-auto/${m.slug}` }))
    : allMakes.slice(0, 5).map((m) => ({ name: m.name, slug: m.slug, url: `/pieces-auto/${m.slug}` }));

  const result = { childModels, availableCategories, relatedBlogPosts, siblingMakes };
  setCached(cacheKey, result);
  return result;
}

/* ─── 2. Page MODÈLE — /pieces-auto/:make/:model ──────────────────────── */

/**
 * Retourne le maillage pour une page modèle :
 *   - parentMake            : marque parente
 *   - availableCategories[] : catégories disponibles pour ce modèle (avec slugs money page)
 *   - siblingModels[]       : 6 autres modèles de la même marque
 *   - relatedBlogPosts[]    : 6 articles blog matchant make+model
 */
async function getModelLinkingData(makeName, modelName) {
  if (!makeName || !modelName || !dbReady()) {
    return { parentMake: null, availableCategories: [], siblingModels: [], relatedBlogPosts: [] };
  }
  const cacheKey = `model:${makeName.toLowerCase()}:${modelName.toLowerCase()}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const BlogPost = require('../models/BlogPost');
  const vehicleService = require('./vehicleLandingService');

  const makeSlug = slugify(makeName);
  const modelSlug = slugify(modelName);

  const parentMake = {
    name: makeName,
    slug: makeSlug,
    url: `/pieces-auto/${makeSlug}`,
  };

  /* Catégories disponibles pour ce modèle (money pages). */
  const cats = await vehicleService.listCategorySlugsForVehicle({ make: makeName, model: modelName });
  const availableCategories = (cats || []).map((c) => ({
    name: c.name,
    slug: c.slug,
    /* La money page = /pieces-auto/{make}/{model}/{categorySlug} */
    url: `/pieces-auto/${makeSlug}/${modelSlug}/${c.slug}`,
  }));

  /* Sibling models : 6 autres modèles de la même marque. */
  const make = await vehicleService.resolveMakeSlug(makeSlug);
  const siblingModels = make && Array.isArray(make.models)
    ? make.models
        .filter((m) => m.slug !== modelSlug)
        .slice(0, 6)
        .map((m) => ({
          name: m.name,
          slug: m.slug,
          url: `/pieces-auto/${makeSlug}/${m.slug}`,
        }))
    : [];

  /* Articles blog liés : title/slug/keyword contient make ET (model OU model token). */
  const escMake = safeRegexEscape(makeName);
  const escModel = safeRegexEscape(modelName);
  /* Pour matcher des titres comme "BMW X5 G05" quand modelName = "X5 G05 xDrive50i",
     on prend le premier token significatif. */
  const modelToken = modelName.split(/\s+/)[0];
  const escModelToken = safeRegexEscape(modelToken);
  const relatedBlogPosts = await BlogPost.find({
    isPublished: true,
    $and: [
      { $or: [
        { title: { $regex: escMake, $options: 'i' } },
        { slug: { $regex: makeSlug, $options: 'i' } },
        { 'seo.primaryKeyword': { $regex: escMake, $options: 'i' } },
      ] },
      { $or: [
        { title: { $regex: escModel, $options: 'i' } },
        { title: { $regex: escModelToken, $options: 'i' } },
        { slug: { $regex: modelSlug, $options: 'i' } },
        { 'seo.primaryKeyword': { $regex: escModel, $options: 'i' } },
      ] },
    ],
  })
    .select('slug title coverImageUrl publishedAt readingTimeMinutes')
    .sort({ publishedAt: -1 })
    .limit(6)
    .lean();

  const result = { parentMake, availableCategories, siblingModels, relatedBlogPosts };
  setCached(cacheKey, result);
  return result;
}

/* ─── 3. Page MONEY — /pieces-auto/:make/:model/:category ──────────────── */

/**
 * Retourne le maillage pour une money page :
 *   - parentMake           : /pieces-auto/{make}
 *   - parentModel          : /pieces-auto/{make}/{model}
 *   - parentCategory       : /categorie/{category} (catégorie globale)
 *   - siblingCategories[]  : autres catégories disponibles pour ce modèle
 *   - sameCategoryOtherModels[] : top 6 autres modèles de la même marque qui ont
 *                                  cette catégorie (Boîte de transfert BMW X3, X4...)
 *   - relatedBlogPosts[]   : 4 articles blog matchant make + model + category
 */
async function getMoneyPageLinkingData(makeName, modelName, categorySlug) {
  if (!makeName || !modelName || !categorySlug || !dbReady()) {
    return {
      parentMake: null,
      parentModel: null,
      parentCategory: null,
      siblingCategories: [],
      sameCategoryOtherModels: [],
      relatedBlogPosts: [],
    };
  }
  const cacheKey = `money:${makeName.toLowerCase()}:${modelName.toLowerCase()}:${categorySlug}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const Product = require('../models/Product');
  const Category = require('../models/Category');
  const BlogPost = require('../models/BlogPost');
  const vehicleService = require('./vehicleLandingService');

  const makeSlug = slugify(makeName);
  const modelSlug = slugify(modelName);

  const parentMake = { name: makeName, slug: makeSlug, url: `/pieces-auto/${makeSlug}` };
  const parentModel = {
    name: `${makeName} ${modelName}`,
    slug: modelSlug,
    url: `/pieces-auto/${makeSlug}/${modelSlug}`,
  };

  /* Catégorie globale (lien vers /categorie/{slug}). */
  const catDoc = await Category.findOne({ slug: categorySlug, isActive: { $ne: false } })
    .select('name slug').lean();
  const parentCategory = catDoc
    ? { name: catDoc.name, slug: catDoc.slug, url: `/categorie/${catDoc.slug}` }
    : null;

  /* Sibling categories : autres catégories disponibles pour ce modèle. */
  const allCats = await vehicleService.listCategorySlugsForVehicle({ make: makeName, model: modelName });
  const siblingCategories = (allCats || [])
    .filter((c) => c.slug !== categorySlug)
    .slice(0, 8)
    .map((c) => ({
      name: c.name.includes('>') ? c.name.split('>').pop().trim() : c.name,
      fullName: c.name,
      slug: c.slug,
      url: `/pieces-auto/${makeSlug}/${modelSlug}/${c.slug}`,
    }));

  /* Other models with same category (top 6) : trouve les modèles de la même
     marque qui ont aussi cette catégorie disponible. */
  let sameCategoryOtherModels = [];
  if (catDoc) {
    const escMake = safeRegexEscape(makeName);
    const escCatName = safeRegexEscape(catDoc.name);
    const otherModels = await Product.aggregate([
      {
        $match: {
          isPublished: { $ne: false },
          category: { $regex: `^${escCatName}(\\s*>|$)`, $options: 'i' },
          compatibility: { $elemMatch: { make: { $regex: `^${escMake}$`, $options: 'i' } } },
        },
      },
      { $unwind: '$compatibility' },
      { $match: { 'compatibility.make': { $regex: `^${escMake}$`, $options: 'i' } } },
      {
        $group: {
          _id: '$compatibility.model',
          productCount: { $sum: 1 },
        },
      },
      { $match: { _id: { $ne: '' } } },
      { $sort: { productCount: -1, _id: 1 } },
      { $limit: 12 },
    ]);
    sameCategoryOtherModels = otherModels
      .filter((r) => r._id && slugify(r._id) !== modelSlug)
      .slice(0, 6)
      .map((r) => ({
        name: r._id,
        slug: slugify(r._id),
        url: `/pieces-auto/${makeSlug}/${slugify(r._id)}/${categorySlug}`,
        productCount: r.productCount,
      }));
  }

  /* Articles blog matchant make + model OU make + category. */
  const escMake2 = safeRegexEscape(makeName);
  const modelToken = modelName.split(/\s+/)[0];
  const escModelToken = safeRegexEscape(modelToken);
  const escCatName = catDoc ? safeRegexEscape(catDoc.name.split('>').pop().trim()) : null;
  const blogQuery = {
    isPublished: true,
    $or: [
      {
        $and: [
          { title: { $regex: escMake2, $options: 'i' } },
          { title: { $regex: escModelToken, $options: 'i' } },
        ],
      },
    ],
  };
  if (escCatName) {
    blogQuery.$or.push({
      $and: [
        { title: { $regex: escMake2, $options: 'i' } },
        { title: { $regex: escCatName, $options: 'i' } },
      ],
    });
  }
  const relatedBlogPosts = await BlogPost.find(blogQuery)
    .select('slug title coverImageUrl publishedAt readingTimeMinutes')
    .sort({ publishedAt: -1 })
    .limit(4)
    .lean();

  const result = {
    parentMake,
    parentModel,
    parentCategory,
    siblingCategories,
    sameCategoryOtherModels,
    relatedBlogPosts,
  };
  setCached(cacheKey, result);
  return result;
}

/* ─── 4. Page CATÉGORIE — /categorie/:slug ─────────────────────────────── */

/**
 * Retourne le maillage pour une page catégorie :
 *   - siblingCategories[]   : autres catégories top-level
 *   - subCategories[]       : sous-catégories (si la category name contient ">")
 *   - topMakesForCategory[] : top 8 marques avec produits dans cette catégorie
 *   - relatedBlogPosts[]    : 6 articles blog dont category.slug match
 */
async function getCategoryLinkingData(category) {
  if (!category || !dbReady()) {
    return { siblingCategories: [], subCategories: [], topMakesForCategory: [], relatedBlogPosts: [] };
  }
  const cacheKey = `cat:${category.slug}`;
  const cached = getCached(cacheKey);
  if (cached) return cached;

  const Product = require('../models/Product');
  const Category = require('../models/Category');
  const BlogPost = require('../models/BlogPost');

  /* Sibling categories : autres catégories actives, sauf celle-ci. */
  const allCats = await Category.find({ isActive: { $ne: false } })
    .select('name slug sortOrder')
    .sort({ sortOrder: 1, name: 1 })
    .lean();
  const siblingCategories = allCats
    .filter((c) => c.slug !== category.slug && !c.name.includes('>'))
    .slice(0, 10)
    .map((c) => ({ name: c.name, slug: c.slug, url: `/categorie/${c.slug}` }));

  /* Sub-categories : catégories dont le name commence par "{category.name} >". */
  const escName = safeRegexEscape(category.name);
  const subCategories = allCats
    .filter((c) => new RegExp(`^${escName}\\s*>`, 'i').test(c.name))
    .map((c) => ({
      name: c.name.split('>').pop().trim(),
      fullName: c.name,
      slug: c.slug,
      url: `/categorie/${c.slug}`,
    }));

  /* Top makes : 8 marques avec le plus de produits dans cette catégorie. */
  const escCatName = safeRegexEscape(category.name);
  const makeRows = await Product.aggregate([
    {
      $match: {
        isPublished: { $ne: false },
        category: { $regex: `^${escCatName}(\\s*>|$)`, $options: 'i' },
      },
    },
    { $unwind: '$compatibility' },
    { $match: { 'compatibility.make': { $ne: '' } } },
    {
      $group: {
        _id: '$compatibility.make',
        productCount: { $sum: 1 },
      },
    },
    { $sort: { productCount: -1 } },
    { $limit: 8 },
  ]);
  const topMakesForCategory = makeRows.map((r) => ({
    name: r._id,
    slug: slugify(r._id),
    url: `/pieces-auto/${slugify(r._id)}`,
    productCount: r.productCount,
  }));

  /* Articles blog liés : category.slug match OU title match category name. */
  const catNameTop = category.name.includes('>')
    ? category.name.split('>').pop().trim()
    : category.name;
  const escCatNameTop = safeRegexEscape(catNameTop);
  const relatedBlogPosts = await BlogPost.find({
    isPublished: true,
    $or: [
      { 'category.slug': category.slug },
      { title: { $regex: escCatNameTop, $options: 'i' } },
    ],
  })
    .select('slug title coverImageUrl publishedAt readingTimeMinutes')
    .sort({ publishedAt: -1 })
    .limit(6)
    .lean();

  const result = { siblingCategories, subCategories, topMakesForCategory, relatedBlogPosts };
  setCached(cacheKey, result);
  return result;
}

/* ─── 5. Fiche PRODUIT — /product/:slug/ ───────────────────────────────── */

/**
 * Retourne le maillage pour une fiche produit :
 *   - parentVehicleLandings[] : breadcrumb /pieces-auto et /pieces-auto/{make}/{model}
 *   - parentCategory         : /categorie/{slug} (top-level)
 *   - similarProducts[]      : 6 produits compatibles avec le même véhicule + catégorie
 *   - relatedBlogPosts[]     : 4 articles blog matchant make/model/category
 */
async function getProductLinkingData(product) {
  if (!product || !dbReady()) {
    return { parentVehicleLandings: [], parentCategory: null, similarProducts: [], relatedBlogPosts: [] };
  }
  const Product = require('../models/Product');
  const Category = require('../models/Category');
  const BlogPost = require('../models/BlogPost');
  const { buildProductPublicPath } = require('./productPublic');

  /* Catégorie parente. */
  let parentCategory = null;
  if (product.category) {
    const topLevelName = product.category.includes('>')
      ? product.category.split('>')[0].trim()
      : product.category.trim();
    const cat = await Category.findOne({
      name: topLevelName,
      isActive: { $ne: false },
    }).select('name slug').lean();
    if (cat) {
      parentCategory = { name: cat.name, slug: cat.slug, url: `/categorie/${cat.slug}` };
    }
  }

  /* Vehicle landings (les 3 premiers couples make/model présents dans
     compatibility[] — typiquement 1 produit a 5-25 véhicules compatibles). */
  const parentVehicleLandings = [];
  const seenMakeModel = new Set();
  for (const c of (product.compatibility || []).slice(0, 8)) {
    if (!c || !c.make) continue;
    const makeSlug = slugify(c.make);
    const modelSlug = c.model ? slugify(c.model) : null;
    const key = `${makeSlug}/${modelSlug || ''}`;
    if (seenMakeModel.has(key)) continue;
    seenMakeModel.add(key);
    parentVehicleLandings.push({
      makeName: c.make,
      modelName: c.model || null,
      url: modelSlug
        ? `/pieces-auto/${makeSlug}/${modelSlug}`
        : `/pieces-auto/${makeSlug}`,
    });
    if (parentVehicleLandings.length >= 3) break;
  }

  /* Similar products : autres produits avec même catégorie top-level + au
     moins 1 véhicule compatibilité commun. Limité à 6. */
  const similarProducts = [];
  if (product.category && Array.isArray(product.compatibility) && product.compatibility.length > 0) {
    const topLevel = product.category.includes('>')
      ? product.category.split('>')[0].trim()
      : product.category.trim();
    const escTopLevel = safeRegexEscape(topLevel);
    const compatMakes = product.compatibility
      .map((c) => c && c.make ? c.make : null)
      .filter(Boolean)
      .slice(0, 5);
    if (compatMakes.length > 0) {
      const escMakes = compatMakes.map((m) => new RegExp(`^${safeRegexEscape(m)}$`, 'i'));
      const sims = await Product.find({
        _id: { $ne: product._id },
        isPublished: { $ne: false },
        category: { $regex: `^${escTopLevel}(\\s*>|$)`, $options: 'i' },
        'compatibility.make': { $in: escMakes },
      })
        .select('_id slug name imageUrl priceCents compareAtPriceCents')
        .limit(6)
        .lean();
      for (const s of sims) {
        similarProducts.push({
          name: s.name,
          imageUrl: s.imageUrl,
          priceCents: s.priceCents,
          compareAtPriceCents: s.compareAtPriceCents,
          url: buildProductPublicPath(s),
        });
      }
    }
  }

  /* Articles blog liés : tagsbasés sur la 1re compatibilité + categoryName + name. */
  const relatedBlogPosts = [];
  const orClauses = [];
  if (Array.isArray(product.compatibility)) {
    for (const c of product.compatibility.slice(0, 3)) {
      if (!c || !c.make) continue;
      const escM = safeRegexEscape(c.make);
      if (c.model) {
        const tok = safeRegexEscape(c.model.split(/\s+/)[0]);
        orClauses.push({ $and: [
          { title: { $regex: escM, $options: 'i' } },
          { title: { $regex: tok, $options: 'i' } },
        ] });
      } else {
        orClauses.push({ title: { $regex: escM, $options: 'i' } });
      }
    }
  }
  /* Aussi : explicit relatedBlogPostIds depuis le produit. */
  if (Array.isArray(product.relatedBlogPostIds) && product.relatedBlogPostIds.length > 0) {
    orClauses.push({ _id: { $in: product.relatedBlogPostIds } });
  }
  if (orClauses.length > 0) {
    const posts = await BlogPost.find({ isPublished: true, $or: orClauses })
      .select('slug title coverImageUrl publishedAt readingTimeMinutes')
      .sort({ publishedAt: -1 })
      .limit(4)
      .lean();
    relatedBlogPosts.push(...posts);
  }

  return { parentVehicleLandings, parentCategory, similarProducts, relatedBlogPosts };
}

/* ─── 6. Article BLOG — /blog/:slug ────────────────────────────────────── */

/**
 * Retourne le maillage pour un article blog :
 *   - parentCategory        : la catégorie blog
 *   - relatedProducts[]     : produits liés (relatedProductIds + auto-detect)
 *   - detectedVehicleLandings[] : si l'article mentionne marque/modèle, lien vers
 *                                  /pieces-auto/{make}/{model}
 *   - siblingBlogPosts[]    : 4 autres articles du même thème
 */
async function getBlogPostLinkingData(post) {
  if (!post || !dbReady()) {
    return { parentCategory: null, relatedProducts: [], detectedVehicleLandings: [], siblingBlogPosts: [] };
  }
  const Product = require('../models/Product');
  const BlogPost = require('../models/BlogPost');
  const { buildProductPublicPath } = require('./productPublic');
  const vehicleService = require('./vehicleLandingService');

  /* Catégorie parente. */
  let parentCategory = null;
  if (post.category && post.category.slug) {
    parentCategory = {
      slug: post.category.slug,
      label: post.category.label || post.category.slug,
      url: `/blog?category=${encodeURIComponent(post.category.slug)}`,
    };
  }

  /* Related products : explicit IDs en priorité, sinon auto-detect via title. */
  const relatedProducts = [];
  if (Array.isArray(post.relatedProductIds) && post.relatedProductIds.length > 0) {
    const explicit = await Product.find({
      _id: { $in: post.relatedProductIds },
      isPublished: { $ne: false },
    })
      .select('_id slug name imageUrl priceCents compareAtPriceCents')
      .limit(6)
      .lean();
    for (const p of explicit) {
      relatedProducts.push({
        name: p.name,
        imageUrl: p.imageUrl,
        priceCents: p.priceCents,
        compareAtPriceCents: p.compareAtPriceCents,
        url: buildProductPublicPath(p),
      });
    }
  }
  /* Si peu de produits explicites, on complète via auto-detect : extrait les
     mots-clés du titre (BMW, X5, DSG7…) et on cherche les produits matchant. */
  if (relatedProducts.length < 6) {
    const titleTokens = String(post.title || '')
      .replace(/[,;:!?()«»]/g, ' ')
      .split(/\s+/)
      .filter((t) => t.length >= 3 && /^[A-Za-z0-9À-ÿ]/.test(t))
      .slice(0, 8);
    if (titleTokens.length > 0) {
      const tokenRegexes = titleTokens.map((t) => new RegExp(safeRegexEscape(t), 'i'));
      /* On cherche les produits dont au moins 2 tokens matchent dans le name. */
      const candidates = await Product.find({
        isPublished: { $ne: false },
        $or: [
          { name: { $in: tokenRegexes } },
          { 'compatibility.make': { $in: tokenRegexes } },
          { 'compatibility.model': { $in: tokenRegexes } },
        ],
      })
        .select('_id slug name imageUrl priceCents compareAtPriceCents compatibility')
        .limit(20)
        .lean();
      /* Score chaque candidat par nombre de tokens matchant dans name. */
      const scored = candidates.map((p) => {
        const text = `${p.name || ''} ${(p.compatibility || []).map((c) => `${c.make} ${c.model}`).join(' ')}`.toLowerCase();
        const score = titleTokens.reduce((sum, t) => sum + (text.includes(t.toLowerCase()) ? 1 : 0), 0);
        return { p, score };
      })
        .filter((s) => s.score >= 2)
        .sort((a, b) => b.score - a.score)
        .slice(0, 6 - relatedProducts.length);
      const seen = new Set(relatedProducts.map((r) => r.url));
      for (const { p } of scored) {
        const url = buildProductPublicPath(p);
        if (seen.has(url)) continue;
        relatedProducts.push({
          name: p.name,
          imageUrl: p.imageUrl,
          priceCents: p.priceCents,
          compareAtPriceCents: p.compareAtPriceCents,
          url,
        });
        seen.add(url);
      }
    }
  }

  /* Detected vehicle landings : si l'article mentionne explicitement une
     marque/modèle, on propose le lien vers la landing dédiée. */
  const detectedVehicleLandings = [];
  const allMakes = await vehicleService.listMakes();
  const lowerTitle = String(post.title || '').toLowerCase();
  const lowerSlug = String(post.slug || '').toLowerCase();
  for (const m of allMakes) {
    if (lowerTitle.includes(m.nameLower) || lowerSlug.includes(m.slug)) {
      /* Marque détectée — on cherche aussi un modèle matchant dans le titre. */
      let matchedModel = null;
      for (const mod of m.models || []) {
        if (lowerTitle.includes(mod.nameLower) || lowerSlug.includes(mod.slug)) {
          matchedModel = mod;
          break;
        }
      }
      detectedVehicleLandings.push({
        makeName: m.name,
        modelName: matchedModel ? matchedModel.name : null,
        url: matchedModel
          ? `/pieces-auto/${m.slug}/${matchedModel.slug}`
          : `/pieces-auto/${m.slug}`,
      });
      if (detectedVehicleLandings.length >= 3) break;
    }
  }

  /* Sibling blog posts : 4 autres articles de la même catégorie (ou keyword). */
  const siblingFilter = { isPublished: true, _id: { $ne: post._id } };
  if (post.category && post.category.slug) {
    siblingFilter['category.slug'] = post.category.slug;
  }
  const siblingBlogPosts = await BlogPost.find(siblingFilter)
    .select('slug title coverImageUrl publishedAt readingTimeMinutes')
    .sort({ publishedAt: -1 })
    .limit(4)
    .lean();

  return { parentCategory, relatedProducts, detectedVehicleLandings, siblingBlogPosts };
}

module.exports = {
  getMakeLinkingData,
  getModelLinkingData,
  getMoneyPageLinkingData,
  getCategoryLinkingData,
  getProductLinkingData,
  getBlogPostLinkingData,
  clearCache,
};
