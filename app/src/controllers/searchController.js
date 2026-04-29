const mongoose = require('mongoose');

const Product = require('../models/Product');
const demoProducts = require('../demoProducts');
const { getPublicBaseUrlFromReq } = require('../services/productPublic');
const { buildSuggestPayload } = require('../services/search');
const { buildHreflangSet } = require('../services/i18n');
const brand = require('../config/brand');

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function getSearchPage(req, res, next) {
  try {
    const title = `Rechercher - ${brand.NAME}`;
    const metaDescription = 'Recherche rapide de pièces auto par nom, référence (SKU) ou marque.';
    const baseUrl = getPublicBaseUrlFromReq(req);
    const langPrefix = req.lang === 'en' ? '/en' : '';
    const pathWithoutLang = res.locals.currentPathWithoutLang || req.path;
    const hreflang = buildHreflangSet(baseUrl, pathWithoutLang);
    const canonicalUrl = baseUrl ? `${baseUrl}${langPrefix}/rechercher` : `${langPrefix}/rechercher`;

    return res.render('search/index', {
      title,
      metaDescription,
      canonicalUrl,
      ...hreflang,
      ogTitle: title,
      ogDescription: metaDescription,
      ogUrl: canonicalUrl,
      ogSiteName: brand.NAME,
      ogType: 'website',
      metaRobots: 'noindex, follow',
    });
  } catch (err) {
    return next(err);
  }
}

async function getSuggest(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const q = getTrimmedString(req.query.q);

    if (!q || q.length < 2) {
      return res.json({ results: [], sections: [], total: 0 });
    }

    let products = [];

    if (dbConnected) {
      products = await Product.find({})
        .select('_id name sku brand priceCents imageUrl galleryUrls slug category shortDescription description compatibleReferences compatibility specs keyPoints tags')
        .lean();
    } else {
      products = Array.isArray(demoProducts)
        ? demoProducts.map((product) => ({
            ...product,
            _id: product && product._id ? product._id : (product && product.id ? product.id : product && product.sku ? product.sku : product && product.name ? product.name : ''),
          }))
        : [];
    }

    const payload = buildSuggestPayload(products, q, {
      productLimit: 4,
      categoryLimit: 2,
      brandLimit: 2,
    });

    return res.json(payload);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getSearchPage,
  getSuggest,
};
