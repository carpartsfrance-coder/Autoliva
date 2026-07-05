const mongoose = require('mongoose');
const { getSiteUrlFromReq } = require('./siteUrl');

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/* Catégories du menu « Catalogue » du header : uniquement les catégories PRINCIPALES
   (≥ NAV_MIN_PRODUCTS produits publiés), triées par nombre de produits décroissant.
   Cache mémoire court (évite une requête par requête HTTP). Nom localisé DE si dispo. */
let _navCache = { at: 0, data: [] };
const NAV_TTL_MS = 5 * 60 * 1000;
const NAV_MIN_PRODUCTS = 3; // on n'affiche pas une catégorie avec 2 produits ou moins

function _escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function getNavCategories() {
  if (mongoose.connection.readyState !== 1) return _navCache.data || [];
  const now = Date.now();
  if (_navCache.data.length && (now - _navCache.at) < NAV_TTL_MS) return _navCache.data;
  try {
    const Category = require('../models/Category');
    const Product = require('../models/Product');

    const [docs, counts] = await Promise.all([
      Category.find({ isActive: true }).sort({ sortOrder: 1, name: 1 }).select('name slug localizations.de.name').lean(),
      // Nombre de produits publiés par valeur de category (texte libre, parfois « Parent > Enfant »)
      Product.aggregate([
        { $match: { isPublished: true, category: { $type: 'string', $ne: '' } } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
      ]),
    ]);

    // Pour chaque catégorie, on somme les produits dont le champ category vaut le nom
    // exact OU commence par « Nom > … » (même logique de rattachement que l'admin).
    const countFor = (name) => {
      const rx = new RegExp('^' + _escapeRegExp(name) + '(\\s*>|$)', 'i');
      let total = 0;
      for (const c of counts) { if (c && typeof c._id === 'string' && rx.test(c._id)) total += c.count; }
      return total;
    };

    const data = docs
      .filter((c) => c && c.slug && c.name)
      .map((c) => ({
        name: c.name,
        slug: c.slug,
        nameDe: (c.localizations && c.localizations.de && c.localizations.de.name) ? c.localizations.de.name : c.name,
        count: countFor(c.name),
      }))
      .filter((c) => c.count >= NAV_MIN_PRODUCTS)
      .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

    _navCache = { at: now, data };
    return data;
  } catch (e) {
    return _navCache.data || [];
  }
}

function getPublicBaseUrlFromReq(req) {
  return getSiteUrlFromReq(req);
}

function buildCategoryPublicPath(category) {
  const slug = getTrimmedString(category && category.slug ? category.slug : '');
  if (!slug) return '/categorie';
  return `/categorie/${encodeURIComponent(slug)}`;
}

function buildCategoryPublicUrl(category, { req } = {}) {
  const base = getPublicBaseUrlFromReq(req);
  const path = buildCategoryPublicPath(category);
  if (!base) return path;
  return `${base}${path}`;
}

module.exports = {
  buildCategoryPublicPath,
  buildCategoryPublicUrl,
  getPublicBaseUrlFromReq,
  getNavCategories,
};
