/*
 * productListingService.js
 *
 * Service partagé qui prépare TOUTES les données nécessaires à l'affichage
 * d'une liste de produits (catalogue + filtres + pagination + facettes).
 *
 * Utilisé par :
 *   - productController.listProducts  → URL /produits
 *   - categoryController.getCategory  → URL /categorie/:slug (avec preset catégorie)
 *
 * En extraire la logique du controller permet :
 *   - DRY : 1 seule source de vérité pour la logique métier
 *   - Cohérence UX : la page catégorie a les MÊMES filtres que /produits
 *   - SEO préservé : on garde l'URL /categorie/:slug, on n'ajoute pas un redirect
 *   - Testabilité : le service ne dépend pas de res, juste de req
 *
 * Le service NE rend PAS la vue. Il retourne un payload de données
 * que les controllers passent à res.render('products/index', payload).
 */

'use strict';

const mongoose = require('mongoose');
const Product = require('../models/Product');
const Category = require('../models/Category');
const demoProducts = require('../demoProducts');
const { rankProducts, sortRankedProducts } = require('./search');
const { buildProductPublicPath, getPublicBaseUrlFromReq } = require('./productPublic');
const { buildHreflangSet } = require('./i18n');
const { buildSeoMediaUrl } = require('./mediaStorage');
const brand = require('../config/brand');

/**
 * Lazy require pour éviter la dépendance circulaire avec productController.
 * Au moment où prepareProductListingData() est appelée (au runtime, sur une
 * requête HTTP), les deux modules sont entièrement chargés. En revanche, faire
 * un require synchrone en haut de fichier provoquerait un cycle qui retourne
 * un module partiellement initialisé.
 */
function getProductHelpers() {
  return require('../controllers/productController');
}

const PER_PAGE = 12;

/**
 * Prépare TOUT le payload nécessaire au render du template products/index.ejs.
 *
 * @param {Request} req — l'objet req Express (req.query, req.lang, req.path…)
 * @param {Object} options
 * @param {string} [options.presetCategoryName] — si fourni, force le filtre
 *   mainCategory à cette valeur (pour la page /categorie/:slug). L'utilisateur
 *   peut quand même switcher de catégorie via le filtre — on respectera son
 *   choix, c'est un override.
 * @returns {Promise<Object>} payload pour res.render
 */
async function prepareProductListingData(req, options = {}) {
  const { escapeRegex, toNumberOrNull, normalizeProduct } = getProductHelpers();
  const dbConnected = mongoose.connection.readyState === 1;

  // 1) Parsing des query params
  const searchQuery = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  let selectedVehicleMake = typeof req.query.vehicleMake === 'string' ? req.query.vehicleMake.trim() : '';
  let selectedVehicleModel = typeof req.query.vehicleModel === 'string' ? req.query.vehicleModel.trim() : '';
  const legacySelectedCategory = typeof req.query.category === 'string' ? req.query.category.trim() : '';
  let selectedMainCategory = typeof req.query.mainCategory === 'string' ? req.query.mainCategory.trim() : '';
  let selectedSubCategory = typeof req.query.subCategory === 'string' ? req.query.subCategory.trim() : '';

  // Preset depuis la page catégorie : si on est sur /categorie/X et qu'aucun
  // mainCategory n'est dans la query, on force le preset. L'utilisateur peut
  // toujours switcher via le filtre (qui mettra ?mainCategory=Y dans l'URL).
  if (!selectedMainCategory && options.presetCategoryName) {
    selectedMainCategory = String(options.presetCategoryName).trim();
  }

  if (!selectedMainCategory && legacySelectedCategory) {
    const parts = legacySelectedCategory
      .split('>')
      .map((p) => String(p || '').trim())
      .filter(Boolean);

    if (parts.length >= 1) {
      selectedMainCategory = parts[0];
      selectedSubCategory = parts.slice(1).join(' > ').trim();
    }
  }

  if (!selectedMainCategory) {
    selectedSubCategory = '';
  }

  let selectedCategoryLabel = selectedSubCategory
    ? `${selectedMainCategory} > ${selectedSubCategory}`
    : selectedMainCategory;
  const selectedStock = typeof req.query.stock === 'string' ? req.query.stock.trim() : '';
  const sort = typeof req.query.sort === 'string' ? req.query.sort.trim() : '';

  let page = 1;
  if (typeof req.query.page === 'string') {
    const parsedPage = Number(req.query.page);
    if (Number.isFinite(parsedPage) && parsedPage >= 1) {
      page = Math.floor(parsedPage);
    }
  }

  const perPage = PER_PAGE;
  const minPriceEuros = toNumberOrNull(req.query.minPrice);
  const maxPriceEuros = toNumberOrNull(req.query.maxPrice);

  // 2) Catégories disponibles (pour les filtres)
  let categories = [
    'Moteur',
    'Transmission',
    'Carrosserie / Éclairage',
    'Électricité / Électronique',
    'Freinage',
    'Suspension / Direction',
    'Habitacle',
    'Entretien',
    'Autre',
  ];

  let mainCategories = categories.slice();
  let subCategoriesByMain = {};

  if (dbConnected) {
    const dbCategories = await Category.find({ isActive: true })
      .sort({ sortOrder: 1, name: 1 })
      .select('_id name sortOrder')
      .lean();

    const productCategoryCounts = await Product.aggregate([
      { $match: { category: { $type: 'string', $ne: '' } } },
      { $group: { _id: '$category', count: { $sum: 1 } } },
    ]);

    const usedCountByCategory = new Map();
    const usedMainSet = new Set();
    for (const row of productCategoryCounts) {
      const key = typeof row._id === 'string' ? row._id.trim() : '';
      const count = Number.isFinite(row.count) ? row.count : 0;
      if (!key || count <= 0) continue;

      usedCountByCategory.set(key, count);

      const parts = key
        .split('>')
        .map((p) => String(p || '').trim())
        .filter(Boolean);
      const main = parts[0] || '';
      if (main) usedMainSet.add(main);
    }

    if (dbCategories.length > 0) {
      categories = dbCategories
        .map((c) => (typeof c.name === 'string' ? c.name.trim() : ''))
        .filter(Boolean);

      const mains = [];
      const mainSet = new Set();
      const subsMap = {};

      for (const c of dbCategories) {
        const name = typeof c.name === 'string' ? c.name.trim() : '';
        if (!name) continue;

        const parts = name
          .split('>')
          .map((p) => p.trim())
          .filter(Boolean);
        const main = parts[0] || '';
        const sub = parts.length > 1 ? parts.slice(1).join(' > ').trim() : '';
        if (!main) continue;

        const isUsedMain = usedMainSet.size ? usedMainSet.has(main) : true;
        if (!isUsedMain) continue;

        if (!mainSet.has(main)) {
          mainSet.add(main);
          mains.push(main);
        }

        if (sub) {
          const fullName = `${main} > ${sub}`;
          const isUsedSub = usedCountByCategory.size ? (usedCountByCategory.get(fullName) || 0) > 0 : true;
          if (!isUsedSub) continue;

          if (!subsMap[main]) subsMap[main] = [];
          if (!subsMap[main].includes(sub)) subsMap[main].push(sub);
        }
      }

      if (mains.length > 0) {
        mainCategories = mains;
      }
      subCategoriesByMain = subsMap;
    }
  }

  // 3) Validation : si la catégorie sélectionnée n'existe pas dans le set,
  //    on la wipe (sauf si c'est un preset venant de la page /categorie/:slug,
  //    car dans ce cas la catégorie existe forcément en DB)
  if (selectedMainCategory && Array.isArray(mainCategories) && !mainCategories.includes(selectedMainCategory)) {
    if (!options.presetCategoryName) {
      selectedMainCategory = '';
      selectedSubCategory = '';
    }
  }

  if (selectedMainCategory) {
    const subOptions = selectedMainCategory && subCategoriesByMain
      ? (subCategoriesByMain[selectedMainCategory] || [])
      : [];

    if (selectedSubCategory && Array.isArray(subOptions) && !subOptions.includes(selectedSubCategory)) {
      selectedSubCategory = '';
    }
  }

  selectedCategoryLabel = selectedSubCategory
    ? `${selectedMainCategory} > ${selectedSubCategory}`
    : selectedMainCategory;

  const minPriceCents = minPriceEuros !== null ? Math.round(minPriceEuros * 100) : null;
  const maxPriceCents = maxPriceEuros !== null ? Math.round(maxPriceEuros * 100) : null;

  // 4) Construction du filtre Mongo
  let products = [];
  let totalCount = 0;

  const filter = {};

  if (selectedVehicleMake || selectedVehicleModel) {
    const elem = {};
    if (selectedVehicleMake) {
      elem.make = { $regex: escapeRegex(selectedVehicleMake), $options: 'i' };
    }
    if (selectedVehicleModel) {
      elem.model = { $regex: escapeRegex(selectedVehicleModel), $options: 'i' };
    }
    filter.compatibility = { $elemMatch: elem };
  }

  if (selectedMainCategory) {
    if (selectedSubCategory) {
      filter.category = `${selectedMainCategory} > ${selectedSubCategory}`;
    } else {
      const rx = `^${escapeRegex(selectedMainCategory)}(\\s*>|$)`;
      filter.category = { $regex: new RegExp(rx) };
    }
  }

  if (selectedStock === 'in') {
    filter.$or = [{ stockQty: { $gt: 0 } }, { stockQty: null, inStock: true }];
  }

  const priceFilter = {};
  if (minPriceEuros !== null) {
    priceFilter.$gte = Math.round(minPriceEuros * 100);
  }
  if (maxPriceEuros !== null) {
    priceFilter.$lte = Math.round(maxPriceEuros * 100);
  }
  if (Object.keys(priceFilter).length > 0) {
    filter.priceCents = priceFilter;
  }

  // 5) Facettes : marques + modèles véhicules disponibles
  let vehicleMakes = [];
  let vehicleModelsByMake = {};
  if (dbConnected) {
    const rows = await Product.aggregate([
      { $unwind: '$compatibility' },
      {
        $match: {
          'compatibility.make': { $type: 'string', $ne: '' },
        },
      },
      {
        $project: {
          make: { $trim: { input: '$compatibility.make' } },
          model: { $trim: { input: '$compatibility.model' } },
        },
      },
      {
        $group: {
          _id: {
            make: '$make',
            model: '$model',
          },
        },
      },
    ]);

    const map = new Map();
    for (const r of rows) {
      const make = r && r._id && typeof r._id.make === 'string' ? r._id.make.trim() : '';
      const model = r && r._id && typeof r._id.model === 'string' ? r._id.model.trim() : '';
      if (!make) continue;
      if (!map.has(make)) map.set(make, new Set());
      if (model) map.get(make).add(model);
    }

    vehicleMakes = Array.from(map.keys()).sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
    vehicleModelsByMake = {};
    for (const mk of vehicleMakes) {
      const set = map.get(mk);
      vehicleModelsByMake[mk] = set ? Array.from(set).sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' })) : [];
    }
  } else {
    const map = new Map();
    for (const p of Array.isArray(demoProducts) ? demoProducts : []) {
      const compat = Array.isArray(p.compatibility) ? p.compatibility : [];
      for (const c of compat) {
        const make = c && typeof c.make === 'string' ? c.make.trim() : '';
        const model = c && typeof c.model === 'string' ? c.model.trim() : '';
        if (!make) continue;
        if (!map.has(make)) map.set(make, new Set());
        if (model) map.get(make).add(model);
      }
    }

    vehicleMakes = Array.from(map.keys()).sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
    vehicleModelsByMake = {};
    for (const mk of vehicleMakes) {
      const set = map.get(mk);
      vehicleModelsByMake[mk] = set ? Array.from(set).sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' })) : [];
    }
  }

  if (selectedVehicleMake && vehicleMakes.length) {
    const needle = selectedVehicleMake.toLowerCase();
    const match = vehicleMakes.find((mk) => String(mk).toLowerCase() === needle);
    if (match) selectedVehicleMake = match;
  }
  if (selectedVehicleModel && selectedVehicleMake && vehicleModelsByMake[selectedVehicleMake]) {
    const models = Array.isArray(vehicleModelsByMake[selectedVehicleMake]) ? vehicleModelsByMake[selectedVehicleMake] : [];
    const needle = selectedVehicleModel.toLowerCase();
    const match = models.find((md) => String(md).toLowerCase() === needle);
    if (match) selectedVehicleModel = match;
  }

  // 6) Tri
  let sortSpec = { createdAt: -1 };
  if (sort === 'price_asc') sortSpec = { priceCents: 1 };
  if (sort === 'price_desc') sortSpec = { priceCents: -1 };
  if (sort === 'newest') sortSpec = { createdAt: -1 };

  // 7) Récupération produits + pagination
  if (dbConnected) {
    if (searchQuery) {
      const matchedProducts = await Product.find(filter).lean();
      const rankedProducts = sortRankedProducts(rankProducts(matchedProducts, searchQuery), sort);

      totalCount = rankedProducts.length;
      const totalPagesRaw = Math.max(1, Math.ceil(totalCount / perPage));
      if (page > totalPagesRaw) page = totalPagesRaw;

      products = rankedProducts
        .slice((page - 1) * perPage, page * perPage)
        .map((entry) => entry.product)
        .map(normalizeProduct);
    } else {
      totalCount = await Product.countDocuments(filter);
      const totalPagesRaw = Math.max(1, Math.ceil(totalCount / perPage));
      if (page > totalPagesRaw) page = totalPagesRaw;

      products = await Product.find(filter)
        .sort(sortSpec)
        .skip((page - 1) * perPage)
        .limit(perPage)
        .lean();

      products = products.map(normalizeProduct);
    }

    const noFilters =
      !searchQuery &&
      !selectedMainCategory &&
      !selectedSubCategory &&
      !selectedStock &&
      minPriceEuros === null &&
      maxPriceEuros === null;

    if (totalCount === 0 && noFilters) {
      totalCount = demoProducts.length;
      const totalPagesRaw = Math.max(1, Math.ceil(totalCount / perPage));
      if (page > totalPagesRaw) page = totalPagesRaw;
      products = demoProducts
        .slice((page - 1) * perPage, page * perPage)
        .map(normalizeProduct);
    }
  } else {
    const filteredProducts = demoProducts
      .filter((p) => {
        if (selectedVehicleMake || selectedVehicleModel) {
          const compat = Array.isArray(p.compatibility) ? p.compatibility : [];
          const mk = String(selectedVehicleMake || '').toLowerCase();
          const md = String(selectedVehicleModel || '').toLowerCase();
          const ok = compat.some((c) => {
            if (!c) return false;
            const cMake = String(c.make || '').toLowerCase();
            const cModel = String(c.model || '').toLowerCase();
            if (mk && !cMake.includes(mk)) return false;
            if (md && !cModel.includes(md)) return false;
            return true;
          });
          if (!ok) return false;
        }

        if (selectedMainCategory) {
          if (selectedSubCategory) {
            const full = `${selectedMainCategory} > ${selectedSubCategory}`;
            if (p.category !== full) return false;
          } else {
            if (p.category !== selectedMainCategory && !String(p.category || '').startsWith(`${selectedMainCategory} >`)) {
              return false;
            }
          }
        }
        if (selectedStock === 'in' && !p.inStock) return false;

        if (minPriceCents !== null && p.priceCents < minPriceCents) return false;
        if (maxPriceCents !== null && p.priceCents > maxPriceCents) return false;

        return true;
      })
      .slice();

    if (searchQuery) {
      const rankedProducts = sortRankedProducts(rankProducts(filteredProducts, searchQuery), sort);
      totalCount = rankedProducts.length;

      const totalPagesRaw = Math.max(1, Math.ceil(totalCount / perPage));
      if (page > totalPagesRaw) page = totalPagesRaw;

      products = rankedProducts
        .slice((page - 1) * perPage, page * perPage)
        .map((entry) => normalizeProduct(entry.product));
    } else {
      products = filteredProducts.map(normalizeProduct);
      totalCount = products.length;

      const totalPagesRaw = Math.max(1, Math.ceil(totalCount / perPage));
      if (page > totalPagesRaw) page = totalPagesRaw;

      if (sort === 'price_asc') {
        products.sort((a, b) => a.priceCents - b.priceCents);
      }
      if (sort === 'price_desc') {
        products.sort((a, b) => b.priceCents - a.priceCents);
      }

      products = products.slice((page - 1) * perPage, page * perPage);
    }
  }

  const totalPages = Math.max(1, Math.ceil(totalCount / perPage));

  // 8) Enrichissement (URLs publiques + image SEO)
  const productsWithPublicPath = (products || []).map((p) => {
    const rawImage = p.imageUrl
      || (Array.isArray(p.galleryUrls) && p.galleryUrls.find((u) => typeof u === 'string' && u.trim()))
      || '';
    return {
      ...p,
      publicPath: buildProductPublicPath(p),
      imageUrl: buildSeoMediaUrl(rawImage, p.name),
    };
  });

  // 9) SEO meta (canonical, hreflang, robots, title, description)
  const baseUrl = getPublicBaseUrlFromReq(req);
  const langPrefix = req.lang === 'en' ? '/en' : '';
  const pathWithoutLang = (req.res && req.res.locals && req.res.locals.currentPathWithoutLang) || req.path;
  const hreflang = buildHreflangSet(baseUrl, pathWithoutLang);
  // Note: le canonical par défaut pointe vers /produits. Les controllers
  // peuvent l'override (la page catégorie veut son propre canonical).
  const canonicalUrl = baseUrl ? `${baseUrl}${langPrefix}/produits` : `${langPrefix}/produits`;

  const hasAnyFilter =
    !!searchQuery ||
    !!selectedVehicleMake ||
    !!selectedVehicleModel ||
    !!selectedMainCategory ||
    !!selectedSubCategory ||
    !!selectedStock ||
    minPriceEuros !== null ||
    maxPriceEuros !== null ||
    (!!sort && sort !== 'newest') ||
    (Number(page) || 1) > 1;

  const defaultMetaRobots = (req.res && req.res.locals && req.res.locals.metaRobots) || undefined;
  const metaRobots = hasAnyFilter ? 'noindex, follow' : defaultMetaRobots;

  const titleParts = [];
  if (selectedCategoryLabel) titleParts.push(String(selectedCategoryLabel));
  if (searchQuery) titleParts.push(`Recherche: ${searchQuery}`);
  const titleSuffix = titleParts.length ? ` (${titleParts.join(' • ')})` : '';
  const title = `Catalogue pièces auto${titleSuffix} - ${brand.NAME}`;

  const metaDescription = 'Catalogue de pièces auto : recherche par référence, marque et catégorie. Livraison rapide. Paiement sécurisé.';

  return {
    // SEO
    title,
    metaDescription,
    canonicalUrl,
    ...hreflang,
    ogTitle: title,
    ogDescription: metaDescription,
    ogUrl: canonicalUrl,
    metaRobots,
    // Layout / data
    dbConnected,
    searchQuery,
    selectedVehicleMake,
    selectedVehicleModel,
    vehicleMakes,
    vehicleModelsByMake,
    selectedMainCategory,
    selectedSubCategory,
    selectedCategoryLabel,
    selectedStock,
    minPriceEuros,
    maxPriceEuros,
    sort,
    categories,
    mainCategories,
    subCategoriesByMain,
    returnTo: req.originalUrl,
    products: productsWithPublicPath,
    page,
    perPage,
    totalCount,
    totalPages,
    activeFilterCount: countActiveFilters({
      searchQuery,
      selectedVehicleMake,
      selectedVehicleModel,
      selectedMainCategory,
      selectedSubCategory,
      selectedStock,
      minPriceEuros,
      maxPriceEuros,
    }),
  };
}

function countActiveFilters(s) {
  let count = 0;
  if (s.searchQuery) count++;
  if (s.selectedVehicleMake) count++;
  if (s.selectedVehicleModel) count++;
  if (s.selectedMainCategory) count++;
  if (s.selectedSubCategory) count++;
  if (s.selectedStock) count++;
  if (s.minPriceEuros !== null && s.minPriceEuros !== undefined) count++;
  if (s.maxPriceEuros !== null && s.maxPriceEuros !== undefined) count++;
  return count;
}

module.exports = {
  prepareProductListingData,
  PER_PAGE,
};
