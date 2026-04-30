const mongoose = require('mongoose');

const BlogPost = require('../models/BlogPost');
const Category = require('../models/Category');
const Product = require('../models/Product');
const VehicleMake = require('../models/VehicleMake');
const demoProducts = require('../demoProducts');
const { buildProductPublicPath, slugify, getPublicBaseUrlFromReq } = require('../services/productPublic');
const { buildCategoryPublicPath } = require('../services/categoryPublic');
const { buildHreflangSet } = require('../services/i18n');
const siteSettingsService = require('../services/siteSettings');
const brand = require('../config/brand');

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function stripHtml(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/<[^>]*>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function truncateText(value, max) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) return '';
  if (!Number.isFinite(max) || max <= 0) return input;
  if (input.length <= max) return input;
  return `${input.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function normalizeMetaText(value) {
  return getTrimmedString(value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function estimateReadingTimeMinutes(text) {
  const plain = stripHtml(text);
  if (!plain) return 0;
  const words = plain.split(/\s+/).filter(Boolean).length;
  const minutes = words / 190;
  const floored = Math.max(1, Math.round(minutes));
  return Math.min(120, floored);
}

function formatDateFR(value) {
  try {
    if (!value) return '';
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('fr-FR', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
    }).format(d);
  } catch (e) {
    return '';
  }
}

function sortAlpha(a, b) {
  return String(a || '').localeCompare(String(b || ''), 'fr', { sensitivity: 'base' });
}

function getInitials(value, max = 2) {
  const input = getTrimmedString(value);
  if (!input) return 'CP';

  const words = input
    .replace(/\s*>\s*/g, ' ')
    .split(/\s+/)
    .filter(Boolean);

  if (!words.length) return input.slice(0, max).toUpperCase();

  return words
    .slice(0, max)
    .map((word) => word[0])
    .join('')
    .toUpperCase();
}

function formatCategoryLabel(name) {
  return getTrimmedString(name).replace(/\s*>\s*/g, ' • ');
}

function buildHomeCategoriesFromDocs(rows) {
  return (Array.isArray(rows) ? rows : [])
    .filter(Boolean)
    .map((row) => {
      const name = getTrimmedString(row && row.name);
      const slug = getTrimmedString(row && row.slug);
      if (!name) return null;

      return {
        label: formatCategoryLabel(name),
        initials: getInitials(name),
        publicPath: buildCategoryPublicPath({ slug: slug || slugify(name) }),
      };
    })
    .filter(Boolean)
    .slice(0, 6);
}

function buildHomeCategoriesFromDemo(products) {
  const seen = new Set();
  const list = [];

  for (const product of Array.isArray(products) ? products : []) {
    const name = getTrimmedString(product && product.category);
    if (!name || seen.has(name)) continue;
    seen.add(name);
    list.push({ name, slug: slugify(name) });
  }

  list.sort((a, b) => sortAlpha(a.name, b.name));
  return buildHomeCategoriesFromDocs(list);
}

function buildHomeVehicleMakesFromNames(names) {
  return (Array.isArray(names) ? names : [])
    .map((value) => getTrimmedString(value))
    .filter(Boolean)
    .sort(sortAlpha)
    .slice(0, 12)
    .map((name) => ({
      name,
      initials: getInitials(name),
      queryValue: name,
    }));
}

function buildHomeVehicleMakesFromProducts(products) {
  const names = new Set();

  for (const product of Array.isArray(products) ? products : []) {
    const compatList = Array.isArray(product && product.compatibility) ? product.compatibility : [];
    for (const compat of compatList) {
      const make = getTrimmedString(compat && compat.make);
      if (make) names.add(make);
    }
  }

  return buildHomeVehicleMakesFromNames(Array.from(names));
}

async function getHome(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const baseUrl = getPublicBaseUrlFromReq(req);

    let featuredProducts = [];
    let homeCategories = [];
    let homeVehicleMakes = [];
    if (dbConnected) {
      const [products, featuredCategoryDocs, vehicleMakeDocs] = await Promise.all([
        Product.find({})
          .sort({ updatedAt: -1 })
          .limit(8)
          .lean(),
        Category.find({ isActive: true, isHomeFeatured: true })
          .sort({ sortOrder: 1, name: 1 })
          .select('_id name slug')
          .limit(6)
          .lean(),
        VehicleMake.find({})
          .sort({ name: 1 })
          .select('_id name')
          .limit(12)
          .lean(),
      ]);

      featuredProducts = products;
      homeCategories = buildHomeCategoriesFromDocs(featuredCategoryDocs);
      homeVehicleMakes = buildHomeVehicleMakesFromNames((vehicleMakeDocs || []).map((row) => row && row.name));

      if (!homeCategories.length) {
        const fallbackCategoryDocs = await Category.find({ isActive: true })
          .sort({ sortOrder: 1, name: 1 })
          .select('_id name slug')
          .limit(6)
          .lean();

        homeCategories = buildHomeCategoriesFromDocs(fallbackCategoryDocs);
      }

      if (!homeCategories.length) {
        homeCategories = buildHomeCategoriesFromDemo(featuredProducts);
      }

      if (!homeVehicleMakes.length) {
        const rows = await Product.aggregate([
          { $unwind: '$compatibility' },
          {
            $project: {
              make: {
                $trim: {
                  input: { $ifNull: ['$compatibility.make', ''] },
                },
              },
            },
          },
          { $match: { make: { $ne: '' } } },
          { $group: { _id: '$make', total: { $sum: 1 } } },
          { $sort: { total: -1, _id: 1 } },
          { $limit: 12 },
        ]);

        homeVehicleMakes = buildHomeVehicleMakesFromNames((rows || []).map((row) => row && row._id));
      }

      if (!homeVehicleMakes.length) {
        homeVehicleMakes = buildHomeVehicleMakesFromProducts(featuredProducts);
      }
    } else {
      featuredProducts = Array.isArray(demoProducts) ? demoProducts.slice(0, 8) : [];
      homeCategories = buildHomeCategoriesFromDemo(featuredProducts);
      homeVehicleMakes = buildHomeVehicleMakesFromProducts(featuredProducts);
    }

    const featuredProductsView = (featuredProducts || []).map((p) => ({
      ...p,
      publicPath: buildProductPublicPath(p),
    }));

    let homeBlogPosts = [];
    if (dbConnected) {
      const pinned = await BlogPost.find({ isPublished: true, isHomeFeatured: true })
        .sort({ publishedAt: -1, createdAt: -1 })
        .limit(3)
        .lean();

      const pinnedSlugs = new Set((pinned || []).map((p) => String(p && p.slug ? p.slug : '')).filter(Boolean));

      const fill = pinnedSlugs.size < 3
        ? await BlogPost.find({
            isPublished: true,
            ...(pinnedSlugs.size ? { slug: { $nin: Array.from(pinnedSlugs) } } : {}),
          })
            .sort({ publishedAt: -1, createdAt: -1 })
            .limit(Math.max(0, 3 - pinnedSlugs.size))
            .lean()
        : [];

      const combined = ([]
        .concat(pinned || [])
        .concat(fill || []))
        .slice(0, 3);

      homeBlogPosts = combined.map((d) => {
        const publishedAt = d && d.publishedAt ? d.publishedAt : d && d.createdAt ? d.createdAt : null;
        const minutes = Number.isFinite(d && d.readingTimeMinutes) && d.readingTimeMinutes > 0
          ? d.readingTimeMinutes
          : estimateReadingTimeMinutes(getTrimmedString(d && d.contentHtml));

        const excerpt = getTrimmedString(d && d.excerpt)
          || truncateText(stripHtml(getTrimmedString(d && d.contentHtml)), 140);

        const categoryLabel = d && d.category && d.category.label
          ? getTrimmedString(d.category.label)
          : (d && d.category && d.category.slug ? getTrimmedString(d.category.slug) : 'Blog');

        return {
          slug: getTrimmedString(d && d.slug),
          title: getTrimmedString(d && d.title),
          excerpt,
          imageUrl: getTrimmedString(d && d.coverImageUrl),
          categoryLabel,
          dateLabel: formatDateFR(publishedAt),
          readTimeLabel: `${minutes} min de lecture`,
          url: `/blog/${encodeURIComponent(getTrimmedString(d && d.slug))}`,
        };
      });
    }

    const siteSettings = res && res.locals && res.locals.siteSettings ? res.locals.siteSettings : null;
    const langPrefix = req.lang === 'en' ? '/en' : '';
    const pathWithoutLang = res.locals.currentPathWithoutLang || req.path;
    const hreflang = buildHreflangSet(baseUrl, pathWithoutLang);
    const canonicalUrl = baseUrl ? `${baseUrl}${langPrefix}/` : `${langPrefix}/`;
    const title = `Pièces auto reconditionnées, d’occasion et testées | ${brand.NAME}`;
    const { sanitizeBrandLeak } = require('../services/brandSanitizer');
    const aboutText = sanitizeBrandLeak(getTrimmedString(siteSettings && siteSettings.aboutText));
    const metaDescription = truncateText(
      normalizeMetaText(
        aboutText || `${brand.NAME} propose des pièces auto reconditionnées, d'occasion et testées, avec devis rapide, livraison express et accompagnement expert.`
      ),
      160
    );
    const ogTitle = title;
    const ogDescription = metaDescription;
    const ogUrl = canonicalUrl;
    const ogImage = baseUrl ? `${baseUrl}/images/hero-home.png` : '/images/hero-home.png';
    const sameAs = [
      getTrimmedString(siteSettings && siteSettings.facebookUrl),
      getTrimmedString(siteSettings && siteSettings.instagramUrl),
      getTrimmedString(siteSettings && siteSettings.youtubeUrl),
    ].filter(Boolean);

    const jsonLd = JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'Organization',
          name: brand.NAME,
          url: canonicalUrl,
          logo: baseUrl ? `${baseUrl}/images/favicon.png` : '/images/favicon.png',
          sameAs: sameAs.length ? sameAs : undefined,
        },
        {
          '@type': 'WebSite',
          name: brand.NAME,
          url: canonicalUrl,
          inLanguage: req.lang === 'en' ? 'en' : 'fr-FR',
          description: metaDescription,
          /* Sitelinks Search Box : permet à Google d'afficher un champ de recherche
             intégré dans les résultats organiques (rich result). Pointe vers le
             catalogue avec la query précise dans `q`. */
          potentialAction: {
            '@type': 'SearchAction',
            target: {
              '@type': 'EntryPoint',
              urlTemplate: `${baseUrl || ''}/produits?q={search_term_string}`,
            },
            'query-input': 'required name=search_term_string',
          },
        },
      ],
    })
      .replace(/</g, '\\u003c')
      .replace(/>/g, '\\u003e')
      .replace(/&/g, '\\u0026');

    // Hero slides : DB d'abord, fallback sur les defaults brand-aware
    const heroSlides = await siteSettingsService.getHeroSlidesForDisplay();

    return res.render('home', {
      title,
      metaDescription,
      canonicalUrl,
      ...hreflang,
      ogTitle,
      ogDescription,
      ogUrl,
      ogImage,
      ogSiteName: brand.NAME,
      ogType: 'website',
      jsonLd,
      dbConnected,
      featuredProducts: featuredProductsView,
      homeCategories,
      homeVehicleMakes,
      homeBlogPosts,
      heroSlides,
    });
  } catch (err) {
    return next(err);
  }
}

async function redirectLegacyBlogSlug(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    if (!dbConnected) return next();

    const slug = typeof req.params.slug === 'string' ? req.params.slug.trim() : '';
    if (!slug) return next();

    const reserved = new Set([
      'produits',
      'categorie',
      'blog',
      'rechercher',
      'panier',
      'commande',
      'compte',
      'admin',
      'legal',
      'sitemap.xml',
      'robots.txt',
      'favicon.ico',
    ]);
    if (reserved.has(slug)) return next();

    const exists = await BlogPost.findOne({ slug, isPublished: true })
      .select('_id slug')
      .lean();

    if (!exists) return next();

    return res.redirect(301, `/blog/${encodeURIComponent(slug)}`);
  } catch (err) {
    return next();
  }
}

module.exports = {
  getHome,
  redirectLegacyBlogSlug,
};
