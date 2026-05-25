'use strict';

/*
 * vehicleLandingController.js
 *
 * Routes :
 *   GET /pieces-auto                          → index marques
 *   GET /pieces-auto/:make                    → landing marque
 *   GET /pieces-auto/:make/:model             → landing modèle
 *   GET /pieces-auto/:make/:model/:category   → landing modèle + catégorie (Phase 2)
 *
 * Approche :
 *   - Résout les slugs en noms canoniques via vehicleLandingService
 *   - Délègue le filtrage produits à productListingService
 *   - Override les méta SEO (title/desc/canonical/JSON-LD) avec le contexte véhicule
 *   - Cherche un VehicleLanding admin-éditable pour le seoText custom
 */

const mongoose = require('mongoose');
const brand = require('../config/brand');
const vehicleService = require('../services/vehicleLandingService');
const VehicleLanding = require('../models/VehicleLanding');
const { buildHreflangSet } = require('../services/i18n');
const { getPublicBaseUrlFromReq } = require('../services/productPublic');
const internalLinking = require('../services/internalLinking');

function toJsonLdSafe(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/* Garde-fou title SEO : 60 char max pour éviter la troncature SERP Google.
 * Stratégie : si trop long, on retire d'abord la queue "| Brand" (l'auteur
 * peut l'écrire en pleine lettre), sinon on tronque le contenu en préservant
 * la queue " | Brand" pour garder la branding cohérence. */
const SEO_TITLE_MAX = 60;
function clampSeoTitle(t) {
  if (!t) return t;
  const s = String(t).trim();
  if (s.length <= SEO_TITLE_MAX) return s;
  const suffix = ` | ${brand.NAME}`;
  // Si le title contient le suffix, on tronque la partie head pour le préserver.
  if (s.endsWith(suffix)) {
    const head = s.slice(0, s.length - suffix.length).trim();
    const maxHead = Math.max(20, SEO_TITLE_MAX - suffix.length - 1);
    const cut = head.length > maxHead ? `${head.slice(0, maxHead).trim()}…` : head;
    const candidate = `${cut}${suffix}`;
    if (candidate.length <= SEO_TITLE_MAX) return candidate;
    return `${candidate.slice(0, SEO_TITLE_MAX - 1).trim()}…`;
  }
  return `${s.slice(0, SEO_TITLE_MAX - 1).trim()}…`;
}

/* Auto-templates de contenu SEO (utilisés quand pas de VehicleLanding admin) */
function buildAutoSeoText({ makeName, modelName, partTypeName, totalCount }) {
  if (modelName && partTypeName) {
    return `<p>Notre catalogue propose ${totalCount} ${partTypeName.toLowerCase()} compatible(s) avec ${makeName} ${modelName}, reconditionnées dans nos ateliers et garanties 24 mois. Chaque pièce est testée sur banc, expédiée sous 24-48h, et bénéficie d'un paiement en 3x ou 4x sans frais.</p>`;
  }
  if (modelName) {
    return `<p>Découvrez notre sélection de pièces auto reconditionnées compatibles avec ${makeName} ${modelName} : ${totalCount} référence(s) garanties 24 mois, expédiées sous 24-48h, paiement en 3x ou 4x sans frais.</p>`;
  }
  return `<p>Notre catalogue de pièces auto reconditionnées ${makeName} couvre l'ensemble des modèles de la marque : ${totalCount} référence(s) testées sur banc, garanties 24 mois et expédiées rapidement. Toutes nos pièces ${makeName} bénéficient d'un paiement en 3x ou 4x sans frais.</p>`;
}

function buildAutoTitle({ makeName, modelName, partTypeName }) {
  if (modelName && partTypeName) {
    return `${partTypeName} ${makeName} ${modelName} reconditionné | ${brand.NAME}`;
  }
  if (modelName) {
    return `Pièces auto ${makeName} ${modelName} reconditionnées | ${brand.NAME}`;
  }
  return `Pièces auto ${makeName} reconditionnées et garanties | ${brand.NAME}`;
}

function buildAutoMetaDescription({ makeName, modelName, partTypeName, totalCount }) {
  const count = totalCount > 0 ? `${totalCount} référence${totalCount > 1 ? 's' : ''}` : 'Large choix';
  if (modelName && partTypeName) {
    return `${partTypeName} ${makeName} ${modelName} reconditionné — ${count} testée(s) sur banc, garantie 2 ans, livraison 24-48h. Paiement 3x/4x.`;
  }
  if (modelName) {
    return `Pièces auto ${makeName} ${modelName} reconditionnées : ${count} testées et garanties 2 ans. Livraison express 24-48h. Paiement 3x/4x sans frais.`;
  }
  return `Pièces auto ${makeName} reconditionnées et garanties 2 ans. ${count} testées sur banc, expédition 24-48h. Paiement 3x/4x sans frais.`;
}

/* Lookup le VehicleLanding override pour un combo. Renvoie null si rien. */
async function findLanding({ make, model, partType }) {
  if (mongoose.connection.readyState !== 1) return null;
  const filter = {
    make: String(make || '').toLowerCase(),
    model: model ? String(model).toLowerCase() : null,
    partType: partType ? String(partType).toLowerCase() : null,
    isActive: { $ne: false },
  };
  return VehicleLanding.findOne(filter).lean();
}

/* GET /pieces-auto — index des marques */
async function listMakes(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const makes = dbConnected ? await vehicleService.listMakes() : [];

    const baseUrl = getPublicBaseUrlFromReq(req);
    const canonicalUrl = baseUrl ? `${baseUrl}/pieces-auto` : '/pieces-auto';
    const title = clampSeoTitle(`Pièces auto reconditionnées par marque | ${brand.NAME}`);
    const metaDescription = `Trouvez vos pièces auto reconditionnées et garanties 2 ans, classées par marque véhicule. Catalogue complet : Audi, BMW, Peugeot, Renault, Volkswagen et plus. Livraison 24-48h.`;

    const jsonLd = toJsonLdSafe({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'CollectionPage',
          name: 'Pièces auto par marque',
          url: canonicalUrl,
          description: metaDescription,
        },
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Accueil', item: baseUrl ? `${baseUrl}/` : '/' },
            { '@type': 'ListItem', position: 2, name: 'Pièces auto par marque', item: canonicalUrl },
          ],
        },
      ],
    });

    return res.render('vehicle/index', {
      title,
      metaDescription,
      canonicalUrl,
      ogTitle: title,
      ogDescription: metaDescription,
      ogUrl: canonicalUrl,
      ogType: 'website',
      ogSiteName: brand.NAME,
      jsonLd,
      makes,
      dbConnected,
    });
  } catch (err) {
    return next(err);
  }
}

/* Helper commun pour les pages /pieces-auto/:make et /pieces-auto/:make/:model */
async function renderLanding(req, res, { makeName, modelName, makeSlug, modelSlug, presetCategoryName, partTypeSlug, partTypeName }) {
  const { prepareProductListingData } = require('../services/productListingService');
  const data = await prepareProductListingData(req, {
    presetVehicleMake: makeName,
    presetVehicleModel: modelName || undefined,
    presetCategoryName: presetCategoryName || undefined,
  });

  /* Si la combinaison n'a aucun produit : au lieu de servir un 404 (qui crée
   * des "broken internal links" + "4XX pages" dans Semrush), on redirige en
   * 301 vers le parent le plus précis qui a du contenu :
   *   - /pieces-auto/:make/:model/:category  →  /pieces-auto/:make/:model
   *   - /pieces-auto/:make/:model            →  /pieces-auto/:make
   *   - /pieces-auto/:make                   →  /pieces-auto
   * Bénéfice : préserve le PageRank, supprime les 42 pages 4XX. */
  if (data.totalCount === 0) {
    if (partTypeSlug && modelSlug) {
      return res.redirect(301, `/pieces-auto/${makeSlug}/${modelSlug}`);
    }
    if (modelSlug) {
      return res.redirect(301, `/pieces-auto/${makeSlug}`);
    }
    return res.redirect(301, '/pieces-auto');
  }

  const baseUrl = getPublicBaseUrlFromReq(req);
  const slugParts = ['/pieces-auto', makeSlug];
  if (modelSlug) slugParts.push(modelSlug);
  if (partTypeSlug) slugParts.push(partTypeSlug);
  const path = slugParts.join('/');
  const canonicalBase = baseUrl ? `${baseUrl}${path}` : path;
  const canonicalUrl = data.page > 1
    ? `${canonicalBase}?page=${encodeURIComponent(String(data.page))}`
    : canonicalBase;

  /* Lookup override admin */
  const override = await findLanding({
    make: makeName,
    model: modelName,
    partType: partTypeSlug,
  });

  const title = clampSeoTitle((override && override.metaTitle)
    ? override.metaTitle
    : buildAutoTitle({ makeName, modelName, partTypeName }));
  const metaDescription = (override && override.metaDescription)
    ? override.metaDescription
    : buildAutoMetaDescription({ makeName, modelName, partTypeName, totalCount: data.totalCount });
  const seoText = (override && override.seoText)
    ? override.seoText
    : buildAutoSeoText({ makeName, modelName, partTypeName, totalCount: data.totalCount });

  /* Robots : indexable si page nue, noindex si filtres au-delà du preset */
  const filtersBeyond =
    data.searchQuery
    || data.selectedSubCategory
    || data.selectedStock
    || (data.minPriceEuros !== null && data.minPriceEuros !== undefined)
    || (data.maxPriceEuros !== null && data.maxPriceEuros !== undefined)
    || (data.sort && data.sort !== 'newest' && data.sort !== '')
    || data.page > 1;
  /* Si on est sur une page model+partType et que l'utilisateur change vehicleModel
   * via le filtre, le path ne matche plus → noindex pour éviter du dup content. */
  const filterMismatch = (modelName && data.selectedVehicleModel && data.selectedVehicleModel.toLowerCase() !== modelName.toLowerCase());
  const metaRobots = (filtersBeyond || filterMismatch)
    ? 'noindex, follow'
    : (res.locals.metaRobots || undefined);

  /* JSON-LD : CollectionPage + ItemList + BreadcrumbList. Pour les pages
   * marque on ajoute aussi un Brand schema. */
  const itemListElements = (data.products || []).map((p, idx) => {
    const productUrl = baseUrl
      ? `${baseUrl}${p.publicPath}`
      : p.publicPath;
    return {
      '@type': 'ListItem',
      position: idx + 1,
      name: typeof p.name === 'string' ? p.name.trim() : '',
      url: productUrl,
    };
  });

  const breadcrumb = [
    { '@type': 'ListItem', position: 1, name: 'Accueil', item: baseUrl ? `${baseUrl}/` : '/' },
    { '@type': 'ListItem', position: 2, name: 'Pièces auto par marque', item: baseUrl ? `${baseUrl}/pieces-auto` : '/pieces-auto' },
    { '@type': 'ListItem', position: 3, name: makeName, item: baseUrl ? `${baseUrl}/pieces-auto/${makeSlug}` : `/pieces-auto/${makeSlug}` },
  ];
  if (modelName) {
    breadcrumb.push({ '@type': 'ListItem', position: 4, name: `${makeName} ${modelName}`, item: baseUrl ? `${baseUrl}/pieces-auto/${makeSlug}/${modelSlug}` : `/pieces-auto/${makeSlug}/${modelSlug}` });
  }
  if (partTypeName) {
    breadcrumb.push({ '@type': 'ListItem', position: 5, name: partTypeName, item: canonicalUrl });
  }

  const graph = [
    {
      '@type': 'CollectionPage',
      name: title,
      url: canonicalUrl,
      description: metaDescription,
      mainEntity: {
        '@type': 'ItemList',
        numberOfItems: data.totalCount,
        itemListElement: itemListElements,
      },
    },
    { '@type': 'BreadcrumbList', itemListElement: breadcrumb },
  ];
  /* Brand schema sur les pages marque (pas modèle/partType — sinon on sur-attribue) */
  if (!modelName) {
    graph.push({
      '@type': 'Brand',
      name: makeName,
      url: baseUrl ? `${baseUrl}/pieces-auto/${makeSlug}` : `/pieces-auto/${makeSlug}`,
    });
  }

  const jsonLd = toJsonLdSafe({ '@context': 'https://schema.org', '@graph': graph });

  const langPrefix = req.lang === 'en' ? '/en' : '';
  const pathWithoutLang = res.locals.currentPathWithoutLang || req.path;
  const hreflang = buildHreflangSet(baseUrl, pathWithoutLang);

  /* Computed h1 + breadcrumb name pour le template.
   * IMPORTANT : H1 doit toujours différer du <title> pour éviter
   * les warnings Semrush "duplicate H1 and title tags" (14 pages).
   * Si l'admin a saisi un h1Override identique au metaTitle, on retombe
   * sur l'auto-template pour garantir la différenciation. */
  function buildAutoH1() {
    if (modelName && partTypeName) return `${partTypeName} ${makeName} ${modelName} reconditionné`;
    if (modelName) return `Pièces auto ${makeName} ${modelName}`;
    return `Pièces auto ${makeName}`;
  }
  function normalizeForCompare(s) {
    return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();
  }
  let h1 = (override && override.h1Override) ? override.h1Override : buildAutoH1();
  // Si l'override H1 est strictement identique au title (case-insensitive après
  // strip du suffixe " | Brand"), on bascule sur l'auto-template.
  const titleWithoutSuffix = title.replace(new RegExp(`\\s*[|\\-]\\s*${brand.NAME}\\s*$`, 'i'), '').trim();
  if (normalizeForCompare(h1) === normalizeForCompare(title)
   || normalizeForCompare(h1) === normalizeForCompare(titleWithoutSuffix)) {
    h1 = buildAutoH1();
  }
  // Fallback final si même l'auto-template matche : on ajoute un qualifier.
  if (normalizeForCompare(h1) === normalizeForCompare(titleWithoutSuffix)) {
    h1 = `${h1} : catalogue, garantie 2 ans`;
  }

  /* Maillage interne : matrice de liens contextuels (modèles enfants,
     catégories disponibles, articles blog liés, sibling pages…). Géré par
     le service internalLinking pour que la logique reste centralisée et
     cachée 5 min en mémoire. */
  let linkingData = {};
  try {
    if (partTypeSlug && modelName) {
      linkingData = await internalLinking.getMoneyPageLinkingData(makeName, modelName, partTypeSlug);
    } else if (modelName) {
      linkingData = await internalLinking.getModelLinkingData(makeName, modelName);
    } else {
      linkingData = await internalLinking.getMakeLinkingData(makeName);
    }
  } catch (err) {
    console.error('[vehicleLanding] internalLinking error :', err && err.message);
    linkingData = {};
  }

  return res.render('products/index', {
    ...data,
    /* Override SEO meta */
    title,
    metaDescription,
    canonicalUrl,
    ...hreflang,
    ogTitle: title,
    ogDescription: metaDescription,
    ogUrl: canonicalUrl,
    ogSiteName: brand.NAME,
    ogType: 'website',
    metaRobots,
    jsonLd,
    /* Contexte landing véhicule pour le template */
    basePath: path,
    vehicleContext: {
      makeName,
      makeSlug,
      modelName: modelName || null,
      modelSlug: modelSlug || null,
      partTypeName: partTypeName || null,
      partTypeSlug: partTypeSlug || null,
      h1,
      seoText,
      breadcrumb: {
        makeUrl: `/pieces-auto/${makeSlug}`,
        modelUrl: modelSlug ? `/pieces-auto/${makeSlug}/${modelSlug}` : null,
      },
      linking: linkingData,
    },
  });
}

/* GET /pieces-auto/:make
 *
 * Comportement quand le slug n'existe pas en DB : on redirige 301 vers le
 * listing /pieces-auto au lieu de renvoyer 404. Cela évite les "broken
 * internal links" Semrush sur les marques qui ont été retirées du catalogue
 * (ex: /pieces-auto/citroen, /pieces-auto/volvo) tout en consolidant le
 * PageRank vers la page parent. */
async function getMakeLanding(req, res, next) {
  try {
    const makeSlug = String(req.params.make || '').trim().toLowerCase();
    if (!makeSlug) {
      return res.redirect(301, '/pieces-auto');
    }
    const make = await vehicleService.resolveMakeSlug(makeSlug);
    if (!make) {
      return res.redirect(301, '/pieces-auto');
    }
    return renderLanding(req, res, {
      makeName: make.name,
      modelName: null,
      makeSlug: make.slug,
      modelSlug: null,
    });
  } catch (err) {
    return next(err);
  }
}

/* GET /pieces-auto/:make/:model
 *
 * Si le model n'existe pas mais la make oui : 301 vers la page make (préserve
 * PageRank). Si la make n'existe pas non plus : 301 vers le listing global.
 * Élimine les ~95 alertes "4XX pages" sur des slugs véhicule trop précis
 * (ex: bmw/x3-e83-2004-2010 → bmw/x3-e83 n'existe pas mais "bmw" oui). */
async function getModelLanding(req, res, next) {
  try {
    const makeSlug = String(req.params.make || '').trim().toLowerCase();
    const modelSlug = String(req.params.model || '').trim().toLowerCase();
    if (!makeSlug || !modelSlug) {
      return res.redirect(301, '/pieces-auto');
    }
    const resolved = await vehicleService.resolveModelSlug(makeSlug, modelSlug);
    if (!resolved) {
      // Fallback : si la make seule existe, on redirige vers sa landing.
      const fallbackMake = await vehicleService.resolveMakeSlug(makeSlug);
      if (fallbackMake) {
        return res.redirect(301, `/pieces-auto/${fallbackMake.slug}`);
      }
      return res.redirect(301, '/pieces-auto');
    }
    return renderLanding(req, res, {
      makeName: resolved.make.name,
      modelName: resolved.model.name,
      makeSlug: resolved.make.slug,
      modelSlug: resolved.model.slug,
    });
  } catch (err) {
    return next(err);
  }
}

/* GET /pieces-auto/:make/:model/:category — MONEY PAGES.
 * Capture les requêtes type "boîte de transfert audi q5" qui matchent à la fois
 * une catégorie de pièce et un véhicule précis. Highest-converting pages. */
async function getModelCategoryLanding(req, res, next) {
  try {
    const makeSlug = String(req.params.make || '').trim().toLowerCase();
    const modelSlug = String(req.params.model || '').trim().toLowerCase();
    const categorySlug = String(req.params.category || '').trim().toLowerCase();
    if (!makeSlug || !modelSlug || !categorySlug) {
      return res.redirect(301, '/pieces-auto');
    }
    const resolved = await vehicleService.resolveModelSlug(makeSlug, modelSlug);
    if (!resolved) {
      // 301 vers le niveau parent existant (make si possible, sinon listing).
      const fallbackMake = await vehicleService.resolveMakeSlug(makeSlug);
      if (fallbackMake) {
        return res.redirect(301, `/pieces-auto/${fallbackMake.slug}`);
      }
      return res.redirect(301, '/pieces-auto');
    }
    /* Résolution catégorie depuis le slug → name complet (ex: "Transmission > Mécatronique") */
    const Category = require('../models/Category');
    const catDoc = await Category.findOne({ slug: categorySlug, isActive: { $ne: false } })
      .select('name slug').lean();
    if (!catDoc) {
      // Catégorie absente : on retombe sur la landing model qui existe.
      return res.redirect(301, `/pieces-auto/${resolved.make.slug}/${resolved.model.slug}`);
    }
    /* Le partTypeName affiché à l'utilisateur est le dernier segment de la
     * catégorie (ex: "Transmission > Mécatronique" → "Mécatronique") pour un
     * H1 plus naturel. Mais pour SEO meta on garde le nom complet. */
    const fullCatName = catDoc.name;
    const partTypeShort = fullCatName.includes('>')
      ? fullCatName.split('>').pop().trim()
      : fullCatName;

    return renderLanding(req, res, {
      makeName: resolved.make.name,
      modelName: resolved.model.name,
      makeSlug: resolved.make.slug,
      modelSlug: resolved.model.slug,
      partTypeSlug: catDoc.slug,
      partTypeName: partTypeShort,
      presetCategoryName: fullCatName,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  listMakes,
  getMakeLanding,
  getModelLanding,
  getModelCategoryLanding,
  renderLanding,
};
