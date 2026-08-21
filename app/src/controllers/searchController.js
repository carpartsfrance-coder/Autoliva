const mongoose = require('mongoose');

const Product = require('../models/Product');
const demoProducts = require('../demoProducts');
const { getPublicBaseUrlFromReq } = require('../services/productPublic');
const { buildSuggestPayload } = require('../services/search');
const { searchProductsViaAtlas, filtreTexteRepli } = require('../services/productListingService');
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

/* Le menu déroulant montre 4 produits, 2 catégories, 2 marques. Classer 400
   fiches est déjà large ; en classer 14 464 bloquait la boucle d'événements
   plusieurs secondes par frappe — d'où les « [NODE-CRON] missed execution ». */
const SUGGEST_MAX_PRODUITS = 400;

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

    /* Repli moteur JS (Atlas indisponible OU base déconnectée / démo).
     *
     * ⚠ CE CHEMIN A ÉTÉ LA MOITIÉ OUBLIÉE DE LA PANNE DU 21/08/2026.
     *
     * Le correctif de /produits (productListingService) avait borné son propre
     * repli, mais celui-ci — le plus sollicité du site — chargeait toujours
     * les 14 464 fiches publiées, projection lourde comprise (description,
     * compatibility, specs, keyPoints…), À CHAQUE FRAPPE : l'autocomplétion
     * part toutes les 300 ms (public/js/search-autocomplete.js:224).
     *
     * Pire, le disjoncteur posé pour éteindre l'incendie ALIMENTAIT celui-ci :
     * disjoncteur ouvert → `searchProductsViaAtlas` renvoie null immédiatement
     * → on tombe ici sans même tenter Atlas. Le garde-fou d'un chemin était
     * l'accélérateur de l'autre.
     *
     * Deux bornes, les mêmes qu'ailleurs :
     *   — le préfiltre regex côté MongoDB (on ne rapatrie que les fiches
     *     contenant un mot cherché) ;
     *   — un plafond serré : le menu n'affiche que 4 produits, 2 catégories
     *     et 2 marques. En classer 400 est déjà généreux ; en classer 14 464
     *     bloquait la boucle d'événements plusieurs secondes.
     */
    let products = [];
    if (dbConnected) {
      const filtreRepli = filtreTexteRepli({ isPublished: { $ne: false } }, q);
      products = await Product.find(filtreRepli)
        .select('_id name sku engineCode brand priceCents imageUrl galleryUrls slug category shortDescription description compatibleReferences compatibility specs keyPoints tags')
        .limit(SUGGEST_MAX_PRODUITS)
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
