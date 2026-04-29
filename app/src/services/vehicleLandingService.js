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

const VehicleMake = require('../models/VehicleMake');
const { slugify } = require('./productPublic');

/* Cache en mémoire — TTL 5 min. La liste des marques change rarement, on évite
 * de re-query à chaque hit de page. Reset automatiquement après TTL. */
const CACHE_TTL_MS = 5 * 60 * 1000;
let _cache = null;
let _cacheTimestamp = 0;

async function loadAllMakesCached() {
  const now = Date.now();
  if (_cache && (now - _cacheTimestamp) < CACHE_TTL_MS) {
    return _cache;
  }
  const docs = await VehicleMake.find({})
    .select('_id name nameLower models')
    .sort({ nameLower: 1 })
    .lean();
  _cache = (docs || []).map((doc) => ({
    name: doc.name,
    nameLower: doc.nameLower,
    slug: slugify(doc.name),
    models: (doc.models || []).map((m) => ({
      name: m.name,
      nameLower: m.nameLower,
      slug: slugify(m.name),
    })).sort((a, b) => a.name.localeCompare(b.name, 'fr', { sensitivity: 'base' })),
  }));
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
