const mongoose = require('mongoose');
const { getSiteUrlFromReq } = require('./siteUrl');

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/* Catégories actives pour le menu « Catalogue » du header, avec cache mémoire
   court (évite une requête par requête HTTP). Nom localisé DE si dispo. */
let _navCache = { at: 0, data: [] };
const NAV_TTL_MS = 5 * 60 * 1000;

async function getNavCategories() {
  if (mongoose.connection.readyState !== 1) return _navCache.data || [];
  const now = Date.now();
  if (_navCache.data.length && (now - _navCache.at) < NAV_TTL_MS) return _navCache.data;
  try {
    const Category = require('../models/Category');
    const docs = await Category.find({ isActive: true })
      .sort({ sortOrder: 1, name: 1 })
      .select('name slug localizations.de.name')
      .lean();
    const data = docs
      .filter((c) => c && c.slug && c.name)
      .map((c) => ({
        name: c.name,
        slug: c.slug,
        nameDe: (c.localizations && c.localizations.de && c.localizations.de.name)
          ? c.localizations.de.name
          : c.name,
      }));
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
