const { getSiteUrlFromReq } = require('./siteUrl');

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function slugify(value) {
  if (typeof value !== 'string') return '';
  const input = value.trim();
  if (!input) return '';

  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

function getPublicBaseUrlFromReq(req) {
  return getSiteUrlFromReq(req);
}

function buildProductPublicPath(product) {
  const preferredSlug = getTrimmedString(product && product.slug ? product.slug : '');
  const nameSlug = slugify(getTrimmedString(product && product.name ? product.name : ''));
  const finalSlug = preferredSlug || nameSlug || 'produit';

  if (!finalSlug) return '/produits';
  return `/product/${encodeURIComponent(finalSlug)}/`;
}

function buildProductPublicUrl(product, { req } = {}) {
  const base = getPublicBaseUrlFromReq(req);
  const path = buildProductPublicPath(product);
  if (!base) return path;
  return `${base}${path}`;
}

module.exports = {
  slugify,
  buildProductPublicPath,
  buildProductPublicUrl,
  getPublicBaseUrlFromReq,
};
