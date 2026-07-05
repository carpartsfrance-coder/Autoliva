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

const PER_PAGE = 24;

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
/* Recherche full-text via MongoDB Atlas Search (index « product_search ») :
 * récupère DIRECTEMENT la page de résultats classés par pertinence Atlas
 * (fuzzy, pondération nom/codes, autocomplétion) en quelques dizaines de ms,
 * quel que soit le volume du catalogue. Filtres (stock/catégorie/véhicule/prix)
 * appliqués APRÈS le $search ; renvoie aussi le total.
 * Retourne null si Atlas Search est indisponible (env local / index absent) →
 * le caller bascule alors sur le moteur de classement JS (repli sûr). */
const ATLAS_SEARCH_INDEX = 'product_search';

async function searchProductsViaAtlas({ baseFilter, searchQuery, sort, page, perPage }) {
  const q = String(searchQuery || '').trim();
  if (!q) return null;

  const searchStage = {
    $search: {
      index: ATLAS_SEARCH_INDEX,
      compound: {
        should: [
          { text: { query: q, path: 'name', score: { boost: { value: 10 } }, fuzzy: { maxEdits: 1, prefixLength: 1 } } },
          { autocomplete: { query: q, path: 'name', score: { boost: { value: 6 } } } },
          { text: { query: q, path: ['sku', 'engineCode', 'reference', 'oemRef'], score: { boost: { value: 9 } } } },
          { text: { query: q, path: ['brand', 'category', 'compatibility.make', 'compatibility.model', 'compatibility.engine'], score: { boost: { value: 4 } }, fuzzy: { maxEdits: 1 } } },
          { text: { query: q, path: 'description', score: { boost: { value: 1 } }, fuzzy: { maxEdits: 1 } } },
        ],
        minimumShouldMatch: 1,
      },
    },
  };

  const pipeline = [searchStage];
  if (baseFilter && Object.keys(baseFilter).length) pipeline.push({ $match: baseFilter });

  // Tri explicite (prix / nouveauté) ; sinon on garde l'ordre de pertinence Atlas.
  if (sort === 'price_asc') pipeline.push({ $sort: { priceCents: 1 } });
  else if (sort === 'price_desc') pipeline.push({ $sort: { priceCents: -1 } });
  else if (sort === 'newest') pipeline.push({ $sort: { createdAt: -1 } });

  pipeline.push({
    $facet: {
      results: [{ $skip: Math.max(0, (page - 1) * perPage) }, { $limit: perPage }],
      total: [{ $count: 'n' }],
    },
  });

  try {
    const out = await Product.aggregate(pipeline);
    const facet = (out && out[0]) || {};
    const products = Array.isArray(facet.results) ? facet.results : [];
    const totalCount = (facet.total && facet.total[0] && facet.total[0].n) || 0;
    return { products, totalCount };
  } catch (err) {
    console.warn('[search] Atlas Search indisponible, repli moteur JS :', err && err.message);
    return null;
  }
}

/* États produits pour le filtre catalogue : chaque clé mappe vers une regex
 * sur le champ texte libre badges.condition. Permet de filtrer
 * occasion / reconditionné / neuf sans normaliser la donnée existante. */
const CONDITION_FILTERS = [
  { key: 'occasion', label: 'Occasion', rx: /occasion|used|utilis/i },
  { key: 'reconditionne', label: 'Reconditionné', rx: /recondition|refurb|[ée]change\s*standard/i },
  { key: 'neuf', label: 'Neuf', rx: /\bneuf\b|\bneuve\b|\bnew\b/i },
];
function parseConditionParam(raw) {
  const valid = new Set(CONDITION_FILTERS.map((c) => c.key));
  const list = Array.isArray(raw) ? raw : (typeof raw === 'string' ? raw.split(',') : []);
  const out = [];
  for (const v of list) {
    const k = String(v || '').trim().toLowerCase();
    if (valid.has(k) && !out.includes(k)) out.push(k);
  }
  return out;
}

async function prepareProductListingData(req, options = {}) {
  const { escapeRegex, toNumberOrNull, normalizeProduct } = getProductHelpers();
  const dbConnected = mongoose.connection.readyState === 1;

  // 1) Parsing des query params
  const searchQuery = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  let selectedVehicleMake = typeof req.query.vehicleMake === 'string' ? req.query.vehicleMake.trim() : '';
  let selectedVehicleModel = typeof req.query.vehicleModel === 'string' ? req.query.vehicleModel.trim() : '';
  let selectedVehicleEngine = typeof req.query.vehicleEngine === 'string' ? req.query.vehicleEngine.trim() : '';
  const legacySelectedCategory = typeof req.query.category === 'string' ? req.query.category.trim() : '';
  let selectedMainCategory = typeof req.query.mainCategory === 'string' ? req.query.mainCategory.trim() : '';
  let selectedSubCategory = typeof req.query.subCategory === 'string' ? req.query.subCategory.trim() : '';

  // Preset depuis la page catégorie : si on est sur /categorie/X et qu'aucun
  // mainCategory n'est dans la query, on force le preset. L'utilisateur peut
  // toujours switcher via le filtre (qui mettra ?mainCategory=Y dans l'URL).
  if (!selectedMainCategory && options.presetCategoryName) {
    selectedMainCategory = String(options.presetCategoryName).trim();
  }

  /* Preset depuis les pages /pieces-auto/:make et /pieces-auto/:make/:model :
   * si une marque (et éventuellement un modèle) est encodée dans le path, on
   * force le filtre. L'utilisateur peut switcher via le filtre vehicleMake. */
  if (!selectedVehicleMake && options.presetVehicleMake) {
    selectedVehicleMake = String(options.presetVehicleMake).trim();
  }
  if (!selectedVehicleModel && options.presetVehicleModel) {
    selectedVehicleModel = String(options.presetVehicleModel).trim();
  }
  if (!selectedVehicleEngine && options.presetVehicleEngine) {
    selectedVehicleEngine = String(options.presetVehicleEngine).trim();
  }
  // Véhicule mémorisé en session (sélecteur persistant) : s'applique en dernier
  // recours, quand rien n'est fourni par l'URL ni par un preset de page.
  const _sessionVehicle = (req.session && req.session.vehicle && typeof req.session.vehicle === 'object') ? req.session.vehicle : null;
  if (!selectedVehicleMake && _sessionVehicle && _sessionVehicle.make) {
    selectedVehicleMake = String(_sessionVehicle.make).trim();
    if (!selectedVehicleModel && _sessionVehicle.model) selectedVehicleModel = String(_sessionVehicle.model).trim();
    if (!selectedVehicleEngine && _sessionVehicle.engine) selectedVehicleEngine = String(_sessionVehicle.engine).trim();
  }
  // La motorisation seule n'a pas de sens sans modèle/marque.
  if (selectedVehicleEngine && !selectedVehicleModel) selectedVehicleEngine = '';

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
  const selectedConditions = parseConditionParam(req.query.condition);
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

  // Exclut les brouillons (isPublished === false), ex. produits importés non
  // encore publiés, du listing public. Les produits existants ont isPublished
  // à true par défaut → aucun impact sur le catalogue actuel.
  filter.isPublished = { $ne: false };

  if (selectedVehicleMake || selectedVehicleModel || selectedVehicleEngine) {
    const elem = {};
    if (selectedVehicleMake) {
      elem.make = { $regex: escapeRegex(selectedVehicleMake), $options: 'i' };
    }
    if (selectedVehicleModel) {
      elem.model = { $regex: escapeRegex(selectedVehicleModel), $options: 'i' };
    }
    if (selectedVehicleEngine) {
      elem.engine = { $regex: escapeRegex(selectedVehicleEngine), $options: 'i' };
    }
    filter.compatibility = { $elemMatch: elem };
  }

  if (selectedMainCategory) {
    if (selectedSubCategory) {
      // Sous-catégorie exacte, insensible à la casse (cohérent avec le comptage du menu).
      filter.category = { $regex: new RegExp(`^${escapeRegex(selectedMainCategory)}\\s*>\\s*${escapeRegex(selectedSubCategory)}$`, 'i') };
    } else {
      // Nom exact OU « Nom > … », insensible à la casse (imports = casse variable).
      const rx = `^${escapeRegex(selectedMainCategory)}(\\s*>|$)`;
      filter.category = { $regex: new RegExp(rx, 'i') };
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

  if (selectedConditions.length) {
    const rxs = CONDITION_FILTERS.filter((c) => selectedConditions.includes(c.key)).map((c) => c.rx);
    if (rxs.length) filter['badges.condition'] = { $in: rxs };
  }

  // 5) Facettes : marques + modèles véhicules disponibles
  let vehicleMakes = [];
  let vehicleModelsByMake = {};
  // Motorisations par "marque|||modèle" pour le 3e niveau du sélecteur.
  let vehicleEnginesByMakeModel = {};
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
          engine: { $trim: { input: { $ifNull: ['$compatibility.engine', ''] } } },
        },
      },
      {
        $group: {
          _id: {
            make: '$make',
            model: '$model',
            engine: '$engine',
          },
        },
      },
    ]);

    const map = new Map();
    const engMap = new Map();
    for (const r of rows) {
      const make = r && r._id && typeof r._id.make === 'string' ? r._id.make.trim() : '';
      const model = r && r._id && typeof r._id.model === 'string' ? r._id.model.trim() : '';
      const engine = r && r._id && typeof r._id.engine === 'string' ? r._id.engine.trim() : '';
      if (!make) continue;
      if (!map.has(make)) map.set(make, new Set());
      if (model) map.get(make).add(model);
      if (model && engine) {
        const k = make + '|||' + model;
        if (!engMap.has(k)) engMap.set(k, new Set());
        engMap.get(k).add(engine);
      }
    }

    vehicleMakes = Array.from(map.keys()).sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
    vehicleModelsByMake = {};
    for (const mk of vehicleMakes) {
      const set = map.get(mk);
      vehicleModelsByMake[mk] = set ? Array.from(set).sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' })) : [];
    }
    vehicleEnginesByMakeModel = {};
    for (const [k, set] of engMap.entries()) {
      vehicleEnginesByMakeModel[k] = Array.from(set).sort((a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' }));
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
      // 1) Atlas Search : page classée par pertinence, en ~dizaines de ms,
      //    quel que soit le volume du catalogue (voie normale).
      const atlas = await searchProductsViaAtlas({ baseFilter: filter, searchQuery, sort, page, perPage });
      if (atlas) {
        totalCount = atlas.totalCount;
        const totalPagesRaw = Math.max(1, Math.ceil(totalCount / perPage));
        if (totalCount > 0 && page > totalPagesRaw) {
          // Page hors limite → on relit la dernière page valide.
          page = totalPagesRaw;
          const reread = await searchProductsViaAtlas({ baseFilter: filter, searchQuery, sort, page, perPage });
          products = ((reread && reread.products) || []).map(normalizeProduct);
        } else {
          products = atlas.products.map(normalizeProduct);
        }
      } else {
        // 2) Repli (Atlas indisponible) : moteur de classement JS sur scan complet.
        const matchedProducts = await Product.find(filter).lean();
        const rankedProducts = sortRankedProducts(rankProducts(matchedProducts, searchQuery), sort);
        totalCount = rankedProducts.length;
        const totalPagesRaw = Math.max(1, Math.ceil(totalCount / perPage));
        if (page > totalPagesRaw) page = totalPagesRaw;
        products = rankedProducts
          .slice((page - 1) * perPage, page * perPage)
          .map((entry) => entry.product)
          .map(normalizeProduct);
      }
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
      selectedConditions.length === 0 &&
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

        if (selectedConditions.length) {
          const cond = String((p.badges && p.badges.condition) || '');
          const rxs = CONDITION_FILTERS.filter((c) => selectedConditions.includes(c.key)).map((c) => c.rx);
          if (!rxs.some((rx) => rx.test(cond))) return false;
        }

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
    selectedConditions.length > 0 ||
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

  // Compteurs de facettes CROISÉS : chaque facette est comptée en appliquant
  // tous les AUTRES filtres actifs (on clone `filter` en retirant la clé de la
  // facette concernée). Best-effort : si une agrégation échoue, le listing
  // reste fonctionnel (compteurs vides).
  const mainCategoryCounts = {};
  const categoryCounts = {};
  const conditionCounts = {};
  const makeCounts = {};
  if (dbConnected) {
    try {
      const catScope = { ...filter }; delete catScope.category;
      const makeScope = { ...filter }; delete makeScope.compatibility;
      const condScope = { ...filter }; delete condScope['badges.condition'];
      const [catRows, makeRows, condRows] = await Promise.all([
        Product.aggregate([
          { $match: { ...catScope, category: { $type: 'string', $ne: '' } } },
          { $group: { _id: '$category', n: { $sum: 1 } } },
        ]),
        Product.aggregate([
          { $match: makeScope },
          { $unwind: '$compatibility' },
          { $match: { 'compatibility.make': { $type: 'string', $ne: '' } } },
          { $group: { _id: { p: '$_id', m: { $trim: { input: '$compatibility.make' } } } } },
          { $group: { _id: '$_id.m', n: { $sum: 1 } } },
        ]),
        Promise.all(CONDITION_FILTERS.map(async (c) => ({
          key: c.key,
          n: await Product.countDocuments({ ...condScope, 'badges.condition': { $regex: c.rx } }),
        }))),
      ]);
      for (const r of catRows) {
        const full = String(r._id || '').trim();
        const n = Number(r.n) || 0;
        if (!full) continue;
        categoryCounts[full] = n;
        const main = full.split('>')[0].trim();
        if (main) mainCategoryCounts[main] = (mainCategoryCounts[main] || 0) + n;
      }
      for (const r of makeRows) {
        const k = String(r._id || '').trim();
        if (k) makeCounts[k] = Number(r.n) || 0;
      }
      for (const r of condRows) conditionCounts[r.key] = Number(r.n) || 0;
    } catch (_) { /* compteurs best-effort */ }
  }

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
    selectedVehicleEngine,
    vehicleMakes,
    vehicleModelsByMake,
    vehicleEnginesByMakeModel,
    selectedMainCategory,
    selectedSubCategory,
    selectedCategoryLabel,
    selectedStock,
    selectedConditions,
    conditionOptions: CONDITION_FILTERS.map((c) => ({ key: c.key, label: c.label })),
    mainCategoryCounts,
    categoryCounts,
    conditionCounts,
    makeCounts,
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
      selectedConditions,
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
  if (Array.isArray(s.selectedConditions)) count += s.selectedConditions.length;
  if (s.minPriceEuros !== null && s.minPriceEuros !== undefined) count++;
  if (s.maxPriceEuros !== null && s.maxPriceEuros !== undefined) count++;
  return count;
}

/**
 * Arbre véhicule (marques → modèles → motorisations) calculé depuis la
 * compatibilité des produits. Utilisé par l'endpoint /api/vehicules pour
 * alimenter le sélecteur de véhicule où qu'il soit (home, header, listing).
 */
async function getVehicleTree(dbConnected) {
  const makesSet = new Map(); // make -> Set(models)
  const engMap = new Map(); // "make|||model" -> Set(engines)

  const ingest = (make, model, engine) => {
    const mk = typeof make === 'string' ? make.trim() : '';
    const md = typeof model === 'string' ? model.trim() : '';
    const en = typeof engine === 'string' ? engine.trim() : '';
    if (!mk) return;
    if (!makesSet.has(mk)) makesSet.set(mk, new Set());
    if (md) makesSet.get(mk).add(md);
    if (md && en) {
      const k = mk + '|||' + md;
      if (!engMap.has(k)) engMap.set(k, new Set());
      engMap.get(k).add(en);
    }
  };

  if (dbConnected) {
    const rows = await Product.aggregate([
      { $unwind: '$compatibility' },
      { $match: { 'compatibility.make': { $type: 'string', $ne: '' }, isPublished: { $ne: false } } },
      {
        $group: {
          _id: {
            make: { $trim: { input: '$compatibility.make' } },
            model: { $trim: { input: { $ifNull: ['$compatibility.model', ''] } } },
            engine: { $trim: { input: { $ifNull: ['$compatibility.engine', ''] } } },
          },
        },
      },
    ]);
    for (const r of rows) {
      const id = r && r._id ? r._id : {};
      ingest(id.make, id.model, id.engine);
    }
  } else {
    for (const p of Array.isArray(demoProducts) ? demoProducts : []) {
      for (const c of (Array.isArray(p.compatibility) ? p.compatibility : [])) {
        ingest(c && c.make, c && c.model, c && c.engine);
      }
    }
  }

  const cmp = (a, b) => a.localeCompare(b, 'fr', { sensitivity: 'base' });
  const makes = Array.from(makesSet.keys()).sort(cmp);
  const modelsByMake = {};
  for (const mk of makes) modelsByMake[mk] = Array.from(makesSet.get(mk)).sort(cmp);
  const enginesByMakeModel = {};
  for (const [k, set] of engMap.entries()) enginesByMakeModel[k] = Array.from(set).sort(cmp);

  return { makes, modelsByMake, enginesByMakeModel };
}

module.exports = {
  prepareProductListingData,
  getVehicleTree,
  searchProductsViaAtlas,
  PER_PAGE,
};
