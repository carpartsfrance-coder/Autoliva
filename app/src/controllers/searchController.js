const mongoose = require('mongoose');

const Product = require('../models/Product');
const demoProducts = require('../demoProducts');
const { getPublicBaseUrlFromReq } = require('../services/productPublic');
const { buildSuggestPayload } = require('../services/search');
const { searchProductsViaAtlas } = require('../services/productListingService');
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

    // Voie normale : MÊME moteur que le catalogue — MongoDB Atlas Search — pour
    // que les suggestions (autocomplétion mobile + dropdown desktop) soient
    // classées par pertinence EXACTEMENT comme la page de résultats /produits.
    // On prend les ~10 premiers, en conservant l'ordre de pertinence Atlas.
    if (dbConnected) {
      const atlas = await searchProductsViaAtlas({
        baseFilter: { isPublished: { $ne: false } },
        searchQuery: q,
        page: 1,
        perPage: 10,
      });
      if (atlas && Array.isArray(atlas.products)) {
        const ranked = atlas.products.map((product) => ({ product }));
        const payload = buildSuggestPayload([], q, { ranked, productLimit: 6, categoryLimit: 2, brandLimit: 2 });
        if (Number.isFinite(atlas.totalCount)) payload.total = atlas.totalCount;
        return res.json(payload);
      }
      // atlas === null → Atlas indisponible : repli sur le moteur JS ci-dessous.
    }

    // Repli moteur JS (Atlas indisponible OU base déconnectée / démo).
    let products = [];
    if (dbConnected) {
      products = await Product.find({ isPublished: { $ne: false } })
        .select('_id name sku engineCode brand priceCents imageUrl galleryUrls slug category shortDescription description compatibleReferences compatibility specs keyPoints tags')
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
