/*
 * vehicleLandingService.js
 *
 * Service pour les landing pages véhicule (/pieces-auto/:make/:model/...).
 * Centralise la résolution de slug → entité (marque, modèle) avec un cache
 * léger en mémoire pour éviter les requêtes répétées sur des données peu
 * volatiles (le catalogue de marques/modèles change rarement).
 *
 * Usage typique :
 *   const v = require('./services/vehicleLandingService');
 *   const make = await v.resolveMakeSlug('audi');
 *   const model = await v.resolveModelSlug('audi', 'q5');
 *   const url = v.buildVehicleUrl(make, model);
 */

'use strict';

const { slugify } = require('./productPublic');

/* Cache en mémoire — TTL 5 min. La liste des marques change rarement, on évite
 * de re-query à chaque hit de page. Reset automatiquement après TTL.
 *
 * IMPORTANT — strategy de matching :
 *   Les noms de modèles dans VehicleMake (ex: "A4 S4 B8 8K") sont plus
 *   granulaires que ceux cités dans Product.compatibility[] (ex: "A4").
 *   Pour les landing pages SEO, on veut les modèles RÉELLEMENT cités dans
 *   les produits, pas la nomenclature complète. On construit donc la liste
 *   make/model à partir de Product.compatibility, pas de VehicleMake.
 *   VehicleMake reste utilisé par les filtres /produits (UI de drill-down). */
const CACHE_TTL_MS = 5 * 60 * 1000;
let _cache = null;
let _cacheTimestamp = 0;

async function loadAllMakesCached() {
  const now = Date.now();
  if (_cache && (now - _cacheTimestamp) < CACHE_TTL_MS) {
    return _cache;
  }
  const Product = require('../models/Product');
  /* Aggrégation : récupère tous les couples (make, model) distincts présents
   * dans Product.compatibility[], pour les produits publiés uniquement. */
  const rows = await Product.aggregate([
    { $match: { isPublished: { $ne: false } } },
    { $unwind: '$compatibility' },
    {
      $project: {
        make: { $trim: { input: { $ifNull: ['$compatibility.make', ''] } } },
        model: { $trim: { input: { $ifNull: ['$compatibility.model', ''] } } },
      },
    },
    { $match: { make: { $ne: '' } } },
    { $group: { _id: { make: '$make', model: '$model' } } },
  ]);

  /* Group by make */
  const byMake = new Map();
  for (const row of rows) {
    const make = row && row._id && row._id.make;
    const model = row && row._id && row._id.model;
    if (!make) continue;
    if (!byMake.has(make)) byMake.set(make, new Set());
    if (model) byMake.get(make).add(model);
  }

  _cache = Array.from(byMake.entries()).map(([makeName, modelsSet]) => ({
    name: makeName,
    nameLower: makeName.toLowerCase(),
    slug: slugify(makeName),
    models: Array.from(modelsSet)
      .map((modelName) => ({
        name: modelName,
        nameLower: modelName.toLowerCase(),
        slug: slugify(modelName),
      }))
      .sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' })),
  })).sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' }));

  _cacheTimestamp = now;
  return _cache;
}

/**
 * Force le refresh du cache (utile après un seed / import VehicleMake).
 */
function clearCache() {
  _cache = null;
  _cacheTimestamp = 0;
}

/**
 * Liste toutes les marques actives (avec ≥ 1 modèle pour pertinence SEO).
 */
async function listMakes() {
  const all = await loadAllMakesCached();
  return all.filter((m) => m.name && m.slug);
}

/**
 * Résout un slug de marque vers son nom canonique en base.
 * @returns {Promise<{name, slug, models[]}|null>}
 */
async function resolveMakeSlug(makeSlug) {
  if (!makeSlug || typeof makeSlug !== 'string') return null;
  const slug = String(makeSlug).trim().toLowerCase();
  if (!slug) return null;
  const all = await loadAllMakesCached();
  return all.find((m) => m.slug === slug) || null;
}

/**
 * Résout un couple slug-marque + slug-modèle vers les noms canoniques.
 * @returns {Promise<{make: {name, slug}, model: {name, slug}}|null>}
 */
async function resolveModelSlug(makeSlug, modelSlug) {
  const make = await resolveMakeSlug(makeSlug);
  if (!make) return null;
  if (!modelSlug || typeof modelSlug !== 'string') return null;
  const slug = String(modelSlug).trim().toLowerCase();
  if (!slug) return null;
  const model = (make.models || []).find((m) => m.slug === slug);
  if (!model) return null;
  return {
    make: { name: make.name, slug: make.slug },
    model: { name: model.name, slug: model.slug },
  };
}

/**
 * Construit l'URL publique pour une landing véhicule.
 * @param {Object} make - { name, slug } ou string
 * @param {Object|null} model - { name, slug } ou null
 * @param {string|null} categorySlug - slug catégorie (Phase 2)
 */
function buildVehicleUrl(make, model, categorySlug) {
  const makeSlug = typeof make === 'string' ? slugify(make) : (make && make.slug);
  if (!makeSlug) return '/pieces-auto';
  const modelSlug = model
    ? (typeof model === 'string' ? slugify(model) : model.slug)
    : null;
  const parts = ['/pieces-auto', makeSlug];
  if (modelSlug) parts.push(modelSlug);
  if (categorySlug) parts.push(String(categorySlug).trim().toLowerCase());
  return parts.join('/');
}

/**
 * Compte les produits compatibles avec une marque (ou marque + modèle).
 * Utile pour le nombre dans les meta-descriptions et pour exclure les couples
 * sans produits du sitemap.
 */
async function countCompatibleProducts({ make, model, categorySlug } = {}) {
  const Product = require('../models/Product');
  const filter = { isPublished: { $ne: false } };
  if (make || model) {
    const elem = {};
    if (make) {
      const escMake = String(make).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      elem.make = { $regex: `^${escMake}$`, $options: 'i' };
    }
    if (model) {
      const escModel = String(model).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      elem.model = { $regex: `^${escModel}$`, $options: 'i' };
    }
    filter.compatibility = { $elemMatch: elem };
  }
  if (categorySlug) {
    // categorySlug est le slug de Category; on a besoin du nom pour matcher product.category
    const Category = require('../models/Category');
    const cat = await Category.findOne({ slug: categorySlug, isActive: { $ne: false } }).select('name').lean();
    if (!cat) return 0;
    const escName = String(cat.name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    filter.category = { $regex: `^${escName}(\\s*>|$)`, $options: 'i' };
  }
  return Product.countDocuments(filter);
}

/**
 * Aggrégation : retourne, pour un (make, model) donné, la liste des catégories
 * (top-level Category.slug) qui ont au moins 1 produit compatible. Utilisé pour :
 *   - sitemap (URLs make/model/category)
 *   - internal linking depuis la page model (→ "Pièces par type")
 */
async function listCategorySlugsForVehicle({ make, model } = {}) {
  if (!make) return [];
  const Product = require('../models/Product');
  const Category = require('../models/Category');

  const elem = {};
  const escMake = String(make).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  elem.make = { $regex: `^${escMake}$`, $options: 'i' };
  if (model) {
    const escModel = String(model).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    elem.model = { $regex: `^${escModel}$`, $options: 'i' };
  }
  const filter = { isPublished: { $ne: false }, compatibility: { $elemMatch: elem } };

  /* Récupère les noms uniques de catégories de produits compatibles, puis
   * matche sur Category.name pour avoir le slug propre. */
  const productCats = await Product.distinct('category', filter);
  if (!productCats || !productCats.length) return [];

  /* Les categories produit peuvent être "Transmission > Mécatronique" — on
   * récupère tous les slugs Category.name pour matcher. */
  const cats = await Category.find({ name: { $in: productCats }, isActive: { $ne: false } })
    .select('name slug')
    .lean();
  return cats.map((c) => ({ name: c.name, slug: c.slug }));
}

module.exports = {
  listMakes,
  resolveMakeSlug,
  resolveModelSlug,
  buildVehicleUrl,
  countCompatibleProducts,
  listCategorySlugsForVehicle,
  clearCache,
};
