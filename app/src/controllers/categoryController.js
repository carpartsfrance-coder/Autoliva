const mongoose = require('mongoose');

const Category = require('../models/Category');
const Product = require('../models/Product');
const demoProducts = require('../demoProducts');
const brand = require('../config/brand');
const { buildProductPublicPath, slugify: slugifyGeneric } = require('../services/productPublic');
const {
  buildCategoryPublicPath,
  buildCategoryPublicUrl,
  getPublicBaseUrlFromReq,
} = require('../services/categoryPublic');
const { buildHreflangSet } = require('../services/i18n');
const { buildSeoMediaUrl } = require('../services/mediaStorage');

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

function parsePage(value) {
  if (typeof value !== 'string') return 1;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 1) return 1;
  return Math.floor(n);
}

function normalizeProductForList(product) {
  if (!product) return product;
  const p = { ...product };

  const stockQty = Number.isFinite(p.stockQty) ? p.stockQty : null;
  const inStock = stockQty !== null ? stockQty > 0 : p.inStock !== false;

  const rawImage = p.imageUrl
    || (Array.isArray(p.galleryUrls) && p.galleryUrls.find((u) => typeof u === 'string' && u.trim()))
    || '';

  return {
    ...p,
    inStock,
    publicPath: buildProductPublicPath(p),
    imageUrl: buildSeoMediaUrl(rawImage, p.name),
  };
}

function buildProductFilterFromCategoryName(categoryName) {
  const name = getTrimmedString(categoryName);
  if (!name) return {};

  if (name.includes('>')) {
    return { category: name };
  }

  const rx = `^${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(\\s*>|$)`;
  return { category: { $regex: new RegExp(rx) } };
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

    const perPage = 24;
    const page = parsePage(req.query.page);

    const filter = buildProductFilterFromCategoryName(category.name);

    let products = [];
    let totalCount = 0;

    if (dbConnected) {
      totalCount = await Product.countDocuments(filter);
      const totalPagesRaw = Math.max(1, Math.ceil(totalCount / perPage));
      const safePage = Math.min(page, totalPagesRaw);

      products = await Product.find(filter)
        .sort({ updatedAt: -1 })
        .skip((safePage - 1) * perPage)
        .limit(perPage)
        .lean();

      products = (products || []).map(normalizeProductForList);

      return renderCategoryPage({ req, res, category, products, totalCount, page: safePage, perPage, totalPages: totalPagesRaw, dbConnected });
    }

    products = (demoProducts || [])
      .filter((p) => {
        if (!p) return false;
        if (!filter.category) return true;
        const cat = getTrimmedString(p.category);
        if (!cat) return false;
        if (typeof filter.category === 'string') return cat === filter.category;
        if (filter.category && filter.category.$regex) {
          return filter.category.$regex.test(cat);
        }
        return false;
      })
      .map(normalizeProductForList);

    totalCount = products.length;
    const totalPages = Math.max(1, Math.ceil(totalCount / perPage));
    const safePage = Math.min(page, totalPages);
    products = products.slice((safePage - 1) * perPage, safePage * perPage);

    return renderCategoryPage({ req, res, category, products, totalCount, page: safePage, perPage, totalPages, dbConnected });
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

function renderCategoryPage({ req, res, category, products, totalCount, page, perPage, totalPages, dbConnected }) {
  const name = getTrimmedString(category && category.name ? category.name : 'Catégorie');
  const title = `${name} - Pièces auto | ${brand.NAME}`;
  const metaDescription = buildCategoryMetaDescription(name, totalCount);

  const canonicalBase = buildCategoryPublicUrl(category, { req });
  const canonicalUrl = page > 1 ? `${canonicalBase}?page=${encodeURIComponent(String(page))}` : canonicalBase;
  const baseUrl = getPublicBaseUrlFromReq(req);
  const langPrefix = req.lang === 'en' ? '/en' : '';
  const pathWithoutLang = res.locals.currentPathWithoutLang || req.path;
  const hreflang = buildHreflangSet(baseUrl, pathWithoutLang);
  const metaRobots = page > 1 ? 'noindex, follow' : res.locals.metaRobots;

  const itemListElements = (products || []).map((p, idx) => {
    const productUrl = baseUrl ? `${baseUrl}${p.publicPath || buildProductPublicPath(p)}` : (p.publicPath || buildProductPublicPath(p));
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
          numberOfItems: totalCount,
          itemListElement: itemListElements,
        },
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
            item: baseUrl ? `${baseUrl}/categorie` : '/categorie',
          },
          {
            '@type': 'ListItem',
            position: 3,
            name,
            item: canonicalUrl,
          },
        ],
      },
    ],
  });

  return res.render('categories/show', {
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
    dbConnected,
    category: {
      name,
      slug: category.slug,
      publicPath: buildCategoryPublicPath(category),
      seoText: typeof category.seoText === 'string' ? category.seoText : '',
    },
    products,
    page,
    perPage,
    totalCount,
    totalPages,
  });
}

module.exports = {
  listCategories,
  getCategory,
};
