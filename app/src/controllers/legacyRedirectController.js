const mongoose = require('mongoose');

const Product = require('../models/Product');
const { buildProductPublicPath } = require('../services/productPublic');

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function slugifyLoose(value) {
  const input = getTrimmedString(value);
  if (!input) return '';
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 120);
}

async function redirectLegacyWooProduct(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const raw = getTrimmedString(req.params.slug);
    const legacySlug = slugifyLoose(raw);

    if (!dbConnected || !legacySlug) {
      return res.redirect(301, '/produits');
    }

    const product = await Product.findOne({ slug: legacySlug })
      .select('_id slug name')
      .lean();

    if (product && product._id) {
      return res.redirect(301, buildProductPublicPath(product));
    }

    return res.redirect(301, `/produits?q=${encodeURIComponent(raw)}`);
  } catch (err) {
    return next(err);
  }
}

function redirectLegacyShop(req, res) {
  return res.redirect(301, '/produits');
}

module.exports = {
  redirectLegacyWooProduct,
  redirectLegacyShop,
};
