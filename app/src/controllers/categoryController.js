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
const { buildHreflangSet, t } = require('../services/i18n');
const { formatCategoryDisplayName } = require('../services/brandSanitizer');
const internalLinking = require('../services/internalLinking');
const productI18n = require('../services/productI18n');

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

/* Garde-fou title SEO : 60 char max (limite SERP Google). */
const SEO_TITLE_MAX = 60;
function clampSeoTitle(t) {
  if (!t) return t;
  const s = String(t).trim();
  if (s.length <= SEO_TITLE_MAX) return s;
  const suffix = ` | ${brand.NAME}`;
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
        .select('_id name slug localizations.de.name localizations.de.slug localizations.de.translatedAt')
        .lean();

      categories = (categories || []).map((c) => {
        /* Sous /de : nom ET slug allemands. Le sommaire listait les 64
           catégories avec leurs URL françaises — 64 liens qui partaient tous
           en redirection depuis une page allemande. */
        const de = (req.lang === 'de' && c.localizations && c.localizations.de
          && c.localizations.de.translatedAt) ? c.localizations.de : null;
        return {
          id: String(c._id),
          name: (de && de.name) ? de.name : (c.name || ''),
          slug: c.slug || '',
          publicPath: de
            ? '/de/categorie/' + encodeURIComponent(de.slug || c.slug)
            : buildCategoryPublicPath(c),
        };
      });
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

    const title = clampSeoTitle(t(req.lang, 'categories.indexTitle'));
    const metaDescription = t(req.lang, 'categories.indexMeta');
    const baseUrl = getPublicBaseUrlFromReq(req);
    const langPrefix = req.lang === 'de' ? '/de' : (req.lang === 'en' ? '/en' : '');
    const pathWithoutLang = res.locals.currentPathWithoutLang || req.path;
    const hreflang = buildHreflangSet(baseUrl, pathWithoutLang);
    const canonicalUrl = baseUrl ? `${baseUrl}${langPrefix}/categorie` : `${langPrefix}/categorie`;
    const jsonLd = toSafeJsonLd({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'CollectionPage',
          name: t(req.lang, 'breadcrumb.categoriesLd'),
          url: canonicalUrl,
          description: metaDescription,
        },
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            {
              '@type': 'ListItem',
              position: 1,
              name: t(req.lang, 'breadcrumb.homeLd'),
              item: baseUrl ? `${baseUrl}${langPrefix}/` : '/',
            },
            {
              '@type': 'ListItem',
              position: 2,
              name: t(req.lang, 'breadcrumb.categoriesLd'),
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
      const CAT_FIELDS = '_id name slug updatedAt seoText localizations';
      /* Sous /de, on cherche D'ABORD par le slug allemand : le canonical et le
         hreflang de ces pages pointent depuis toujours vers /de/categorie/
         <slug-de>, une URL que la route ne savait pas résoudre — Google se
         voyait donc désigner une 404 comme page canonique. */
      if (req.lang === 'de') {
        category = await Category.findOne({ 'localizations.de.slug': slug, isActive: { $ne: false } })
          .select(CAT_FIELDS)
          .lean();
        /* Ancien slug (avant translittération des umlauts) : on le résout
           quand même, et la redirection plus bas envoie vers le nouveau. */
        if (!category) {
          category = await Category.findOne({ 'localizations.de.slugAliases': slug, isActive: { $ne: false } })
            .select(CAT_FIELDS)
            .lean();
        }
      }
      if (!category) {
        category = await Category.findOne({ slug, isActive: { $ne: false } })
          .select(CAT_FIELDS)
          .lean();
      }
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
    // ─── Localisation (DE) : la page catégorie est un calque sur le FR ───
    // Tant que la catégorie n'a pas de traduction publiée (translatedAt), on 301
    // vers le FR (jamais de page à moitié traduite). Le filtrage produits reste
    // basé sur le nom FR (presetCategoryName) ; seul l'AFFICHAGE est traduit.
    const isDe = req.lang === 'de' && productI18n.isSupportedLang('de');
    const deLoc = category.localizations && category.localizations.de;
    if (isDe && !(deLoc && deLoc.translatedAt)) {
      return res.redirect(301, '/categorie/' + encodeURIComponent(category.slug));
    }
    const deCatSlug = (isDe && deLoc && deLoc.slug && deLoc.slug.trim()) ? deLoc.slug.trim() : category.slug;
    /* Une catégorie allemande = UNE URL. Arrivé par le slug français sous /de,
       on renvoie vers le slug allemand, celui que déclare le canonical. */
    if (isDe && deCatSlug !== slug) {
      const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
      return res.redirect(301, '/de/categorie/' + encodeURIComponent(deCatSlug) + qs);
    }

    const { prepareProductListingData } = require('../services/productListingService');
    const data = await prepareProductListingData(req, { presetCategoryName: category.name });

    // Cartes en allemand + liens vers les fiches DE.
    if (isDe) {
      data.products = (data.products || []).map((p) => {
        const lp = productI18n.localizeProduct(p, 'de');
        lp.publicPath = '/de/produits/' + encodeURIComponent(productI18n.localizedSlug(p, 'de')) + '-' + p._id;
        return lp;
      });
    }

    /* Override SEO spécifique à la page catégorie (canonical /categorie/:slug,
     * title incluant le nom catégorie, JSON-LD CollectionPage + breadcrumb).
     *
     * Les noms en DB peuvent contenir " > " (hiérarchie parent > enfant) qui
     * polluerait le H1 et le <title>. On affiche le segment terminal seul
     * (« Bloc moteur » plutôt que « Moteur > Bloc moteur ») — le breadcrumb
     * au-dessus du H1 rappelle déjà la hiérarchie. */
    const rawName = getTrimmedString((isDe && deLoc && deLoc.name) ? deLoc.name : category.name);
    const name = formatCategoryDisplayName(rawName);
    /* Title clampé à 60 char + override DB éventuel.
     * Si DB a un metaTitle custom, on respecte mais on clamp toujours. */
    const dbMetaTitle = category.seo && typeof category.seo.metaTitle === 'string'
      ? category.seo.metaTitle.trim() : '';
    /* `seo.metaTitle` en DB est saisi en français : on ne l'applique qu'au FR. */
    const title = clampSeoTitle((!isDe && dbMetaTitle) || t(req.lang, 'category.metaTitle', { name }));
    const metaDescription = isDe
      ? buildCategoryMetaDescriptionDe(name, data.totalCount)
      : buildCategoryMetaDescription(name, data.totalCount);

    const baseUrl = getPublicBaseUrlFromReq(req);
    const canonicalBase = isDe
      ? `${baseUrl}/de/categorie/${encodeURIComponent(deCatSlug)}`
      : buildCategoryPublicUrl(category, { req });
    const canonicalUrl = data.page > 1
      ? `${canonicalBase}?page=${encodeURIComponent(String(data.page))}`
      : canonicalBase;

    const langPrefix = req.lang === 'de' ? '/de' : (req.lang === 'en' ? '/en' : '');
    const pathWithoutLang = res.locals.currentPathWithoutLang || req.path;
    const hreflang = buildHreflangSet(baseUrl, pathWithoutLang);
    // hreflang FR↔DE dès qu'une traduction DE de la catégorie existe.
    let hreflangTags;
    if (isDe || (deLoc && deLoc.translatedAt)) {
      const _frHref = `${baseUrl}/categorie/${encodeURIComponent(category.slug)}`;
      const _deHref = `${baseUrl}/de/categorie/${encodeURIComponent(deCatSlug)}`;
      hreflangTags = [
        { lang: 'fr', href: _frHref },
        { lang: 'de', href: _deHref },
        { lang: 'x-default', href: _frHref },
      ];
    }

    /* Robots : on indexe la page catégorie nue (pas de filtres au-delà de la
     * catégorie présélectionnée). Dès qu'un filtre additionnel est actif, qu'on
     * est en page 2+, ou que la catégorie est vide, on noindex pour éviter le
     * contenu dupliqué et le "thin content" signal sur les catégories vides. */
    const isEmpty = !data.totalCount || data.totalCount === 0;
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
    const metaRobots = (filtersBeyondCategory || isEmpty)
      ? 'noindex, follow'
      : (res.locals.metaRobots || undefined);

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

    /* Maillage interne (sibling categories, sous-cat, top makes, related blog). */
    let linkingData = {};
    try {
      linkingData = await internalLinking.getCategoryLinkingData(category, req.lang);
    } catch (err) {
      console.error('[category] internalLinking error :', err && err.message);
    }

    return res.render('products/index', {
      ...data,
      // Override SEO spécifique catégorie (écrase les valeurs par défaut du service)
      title,
      metaDescription,
      canonicalUrl,
      ...hreflang,
      hreflangTags,
      ogTitle: title,
      ogDescription: metaDescription,
      ogUrl: canonicalUrl,
      ogSiteName: brand.NAME,
      ogType: 'website',
      metaRobots,
      jsonLd,
      // Contexte page catégorie (pour breadcrumb, H1, bloc SEO en bas et basePath dynamique)
      basePath: isDe ? `/de/categorie/${encodeURIComponent(deCatSlug)}` : `/categorie/${category.slug}`,
      categoryContext: {
        name,
        slug: category.slug,
        publicPath: isDe ? `/de/categorie/${encodeURIComponent(deCatSlug)}` : buildCategoryPublicPath(category),
        seoText: isDe ? ((deLoc && deLoc.seoText) || '') : (typeof category.seoText === 'string' ? category.seoText : ''),
        linking: linkingData,
      },
    });
  } catch (err) {
    return next(err);
  }
}

/* Version allemande : le gabarit français produisait « Drehmomentwandler
   reconditionnées et testées sur banc… » — un nom allemand dans une phrase
   française, sur chacune des pages catégorie DE. */
function buildCategoryMetaDescriptionDe(name, totalCount) {
  const countText = totalCount > 0
    ? t('de', 'category.countRefs', { count: totalCount })
    : t('de', 'category.wideChoice');
  return truncateText(normalizeMetaText(t('de', 'category.metaDescription', { name, countText })), 160);
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
