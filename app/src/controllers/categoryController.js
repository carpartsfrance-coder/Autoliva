const mongoose = require('mongoose');

const Category = require('../models/Category');
const demoProducts = require('../demoProducts');
const brand = require('../config/brand');
const { buildProductPublicPath, slugify: slugifyGeneric } = require('../services/productPublic');
const {
  buildCategoryPublicPath,
  buildCategoryPublicUrl,
  getPublicBaseUrlFromReq,
} = require('../services/categoryPublic');
const { buildHreflangSet } = require('../services/i18n');

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function truncateText(value, max) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) return '';
  if (!Number.isFinite(max) || max <= 0) return input;
  if (input.length <= max) return input;
  return `${input.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function normalizeMetaText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function toSafeJsonLd(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}


async function listCategories(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;

    let categories = [];

    if (dbConnected) {
      categories = await Category.find({ isActive: true })
        .sort({ sortOrder: 1, name: 1 })
        .select('_id name slug')
        .lean();

      categories = (categories || []).map((c) => ({
        id: String(c._id),
        name: c.name || '',
        slug: c.slug || '',
        publicPath: buildCategoryPublicPath(c),
      }));
    } else {
      const used = new Set();
      const derived = [];
      for (const p of demoProducts || []) {
        const cat = getTrimmedString(p && p.category ? p.category : '');
        if (!cat) continue;
        if (used.has(cat)) continue;
        used.add(cat);
        derived.push({
          id: cat,
          name: cat,
          slug: slugifyGeneric(cat) || 'categorie',
        });
      }

      categories = derived
        .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
        .map((c) => ({
          ...c,
          publicPath: buildCategoryPublicPath(c),
        }));
    }

    const title = `Catégories - ${brand.NAME}`;
    const metaDescription = 'Découvre toutes nos catégories de pièces auto : moteur, freinage, carrosserie, électricité, entretien et plus.';
    const baseUrl = getPublicBaseUrlFromReq(req);
    const langPrefix = req.lang === 'en' ? '/en' : '';
    const pathWithoutLang = res.locals.currentPathWithoutLang || req.path;
    const hreflang = buildHreflangSet(baseUrl, pathWithoutLang);
    const canonicalUrl = baseUrl ? `${baseUrl}${langPrefix}/categorie` : `${langPrefix}/categorie`;
    const jsonLd = toSafeJsonLd({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'CollectionPage',
          name: 'Catégories',
          url: canonicalUrl,
          description: metaDescription,
        },
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            {
              '@type': 'ListItem',
              position: 1,
              name: 'Accueil',
              item: baseUrl ? `${baseUrl}/` : '/',
            },
            {
              '@type': 'ListItem',
              position: 2,
              name: 'Catégories',
              item: canonicalUrl,
            },
          ],
        },
      ],
    });

    return res.render('categories/index', {
      title,
      metaDescription,
      canonicalUrl,
      ...hreflang,
      ogTitle: title,
      ogDescription: metaDescription,
      ogUrl: canonicalUrl,
      ogSiteName: brand.NAME,
      ogType: 'website',
      jsonLd,
      dbConnected,
      categories,
    });
  } catch (err) {
    return next(err);
  }
}

async function getCategory(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const slug = getTrimmedString(req.params.slug);
    if (!slug) {
      return res.status(404).render('errors/404', { title: `Page introuvable - ${brand.NAME}` });
    }

    let category = null;
    if (dbConnected) {
      category = await Category.findOne({ slug, isActive: { $ne: false } })
        .select('_id name slug updatedAt seoText')
        .lean();
    } else {
      const all = new Map();
      for (const p of demoProducts || []) {
        const cat = getTrimmedString(p && p.category ? p.category : '');
        if (!cat) continue;
        const s = slugifyGeneric(cat) || '';
        if (!s) continue;
        if (!all.has(s)) all.set(s, { id: s, slug: s, name: cat, updatedAt: null });
      }
      category = all.get(slug) || null;
    }

    if (!category) {
      return res.status(404).render('errors/404', { title: `Page introuvable - ${brand.NAME}` });
    }

    /* Délègue toute la logique de listing/filtrage/pagination au service partagé,
     * en pré-filtrant la catégorie. L'utilisateur reste libre d'appliquer d'autres
     * filtres (marque véhicule, prix, stock, tri…) qui se cumuleront avec la
     * catégorie pré-sélectionnée. */
    const { prepareProductListingData } = require('../services/productListingService');
    const data = await prepareProductListingData(req, { presetCategoryName: category.name });

    /* Override SEO spécifique à la page catégorie (canonical /categorie/:slug,
     * title incluant le nom catégorie, JSON-LD CollectionPage + breadcrumb). */
    const name = getTrimmedString(category.name);
    const title = `${name} - Pièces auto | ${brand.NAME}`;
    const metaDescription = buildCategoryMetaDescription(name, data.totalCount);

    const canonicalBase = buildCategoryPublicUrl(category, { req });
    const canonicalUrl = data.page > 1
      ? `${canonicalBase}?page=${encodeURIComponent(String(data.page))}`
      : canonicalBase;

    const baseUrl = getPublicBaseUrlFromReq(req);
    const langPrefix = req.lang === 'en' ? '/en' : '';
    const pathWithoutLang = res.locals.currentPathWithoutLang || req.path;
    const hreflang = buildHreflangSet(baseUrl, pathWithoutLang);

    /* Robots : on indexe la page catégorie nue (pas de filtres au-delà de la
     * catégorie présélectionnée). Dès qu'un filtre additionnel est actif ou
     * qu'on est en page 2+, on noindex pour éviter le contenu dupliqué. */
    const filtersBeyondCategory =
      data.searchQuery
      || data.selectedVehicleMake
      || data.selectedVehicleModel
      || data.selectedSubCategory
      || data.selectedStock
      || (data.minPriceEuros !== null && data.minPriceEuros !== undefined)
      || (data.maxPriceEuros !== null && data.maxPriceEuros !== undefined)
      || (data.sort && data.sort !== 'newest' && data.sort !== '')
      || data.page > 1;
    const metaRobots = filtersBeyondCategory ? 'noindex, follow' : (res.locals.metaRobots || undefined);

    const itemListElements = (data.products || []).map((p, idx) => {
      const productUrl = baseUrl
        ? `${baseUrl}${p.publicPath || buildProductPublicPath(p)}`
        : (p.publicPath || buildProductPublicPath(p));
      return {
        '@type': 'ListItem',
        position: idx + 1,
        name: getTrimmedString(p.name),
        url: productUrl,
      };
    });

    const jsonLd = toSafeJsonLd({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'CollectionPage',
          name,
          url: canonicalUrl,
          description: metaDescription,
          mainEntity: {
            '@type': 'ItemList',
            numberOfItems: data.totalCount,
            itemListElement: itemListElements,
          },
        },
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Accueil', item: baseUrl ? `${baseUrl}/` : '/' },
            { '@type': 'ListItem', position: 2, name: 'Catégories', item: baseUrl ? `${baseUrl}/categorie` : '/categorie' },
            { '@type': 'ListItem', position: 3, name, item: canonicalUrl },
          ],
        },
      ],
    });

    return res.render('products/index', {
      ...data,
      // Override SEO spécifique catégorie (écrase les valeurs par défaut du service)
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
      // Contexte page catégorie (pour breadcrumb, H1, bloc SEO en bas et basePath dynamique)
      basePath: `/categorie/${category.slug}`,
      categoryContext: {
        name,
        slug: category.slug,
        publicPath: buildCategoryPublicPath(category),
        seoText: typeof category.seoText === 'string' ? category.seoText : '',
      },
    });
  } catch (err) {
    return next(err);
  }
}

function buildCategoryMetaDescription(name, totalCount) {
  const n = name.toLowerCase();
  const count = totalCount > 0 ? totalCount : '';
  const countText = count ? `${count} références` : 'Large choix';

  const templates = [
    `${name} reconditionnées et testées sur banc. Garantie 2 ans, expédition 24/48h. ${countText} à prix compétitifs. Paiement en 3x/4x sans frais.`,
    `${countText} de ${n} reconditionnées avec garantie 2 ans. Testées sur banc, expédiées sous 24/48h. Commandez en 3x/4x sans frais.`,
    `${name} d'occasion et reconditionnées. ${countText} testées et garanties 2 ans. Livraison express 24/48h. Paiement en 3x/4x disponible.`,
  ];

  for (const t of templates) {
    const clean = normalizeMetaText(t);
    if (clean.length >= 140 && clean.length <= 160) return clean;
  }

  const fallback = `${name} reconditionnées, testées sur banc et garanties 2 ans. ${countText} disponibles, expédition 24/48h. Paiement en 3x/4x.`;
  return truncateText(normalizeMetaText(fallback), 160);
}

module.exports = {
  listCategories,
  getCategory,
};
