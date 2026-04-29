const { getSiteUrlFromReq } = require('./siteUrl');

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
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
};
