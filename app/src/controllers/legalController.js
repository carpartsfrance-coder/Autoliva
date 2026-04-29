const mongoose = require('mongoose');
  
const { getPublicBaseUrlFromReq } = require('../services/categoryPublic');
const { listLegalPages, getLegalPageBySlug } = require('../services/legalPages');
const { buildHreflangSet } = require('../services/i18n');
const brand = require('../config/brand');

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function stripHtml(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/<[^>]*>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function normalizeMetaText(value) {
  return getTrimmedString(value)
    .replace(/[\r\n\t]+/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function truncateText(value, max) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) return '';
  if (!Number.isFinite(max) || max <= 0) return input;
  if (input.length <= max) return input;
  return `${input.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function toSafeJsonLd(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

async function getLegalIndex(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const baseUrl = getPublicBaseUrlFromReq(req);
    const langPrefix = req.lang === 'en' ? '/en' : '';
    const pathWithoutLang = res.locals.currentPathWithoutLang || req.path;
    const hreflang = buildHreflangSet(baseUrl, pathWithoutLang);
    const pages = await listLegalPages({ dbConnected });
    const title = `Informations légales, CGV, CGU et confidentialité | ${brand.NAME}`;
    const metaDescription = `Consulte les informations légales de ${brand.NAME} : CGV, CGU, mentions légales, confidentialité et cookies.`;
    const canonicalUrl = baseUrl ? `${baseUrl}${langPrefix}/legal` : `${langPrefix}/legal`;
    const jsonLd = toSafeJsonLd({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'WebPage',
          name: 'Informations légales',
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
              name: 'Informations légales',
              item: canonicalUrl,
            },
          ],
        },
      ],
    });

    return res.render('legal/index', {
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
      pages,
    });
  } catch (err) {
    return next(err);
  }
}

async function getLegalPage(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const baseUrl = getPublicBaseUrlFromReq(req);
    const langPrefix = req.lang === 'en' ? '/en' : '';
    const pathWithoutLang = res.locals.currentPathWithoutLang || req.path;
    const hreflang = buildHreflangSet(baseUrl, pathWithoutLang);
    const slug = req.params && req.params.slug ? String(req.params.slug) : '';

    const page = await getLegalPageBySlug({ slug, dbConnected });
    if (!page) {
      return res.status(404).render('errors/404', {
        title: `Page introuvable - ${brand.NAME}`,
      });
    }

    const canonicalUrl = baseUrl ? `${baseUrl}${langPrefix}/legal/${encodeURIComponent(page.slug)}` : `${langPrefix}/legal/${encodeURIComponent(page.slug)}`;
    const contentText = stripHtml(page && page.contentHtml ? page.contentHtml : '');
    const metaDescription = truncateText(
      normalizeMetaText(contentText || `${page.title} sur ${brand.NAME}.`),
      160
    );
    const title = `${page.title} | ${brand.NAME}`;
    const jsonLd = toSafeJsonLd({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'WebPage',
          name: page.title,
          url: canonicalUrl,
          description: metaDescription,
          dateModified: page && page.updatedAt ? new Date(page.updatedAt).toISOString() : undefined,
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
              name: 'Informations légales',
              item: baseUrl ? `${baseUrl}/legal` : '/legal',
            },
            {
              '@type': 'ListItem',
              position: 3,
              name: page.title,
              item: canonicalUrl,
            },
          ],
        },
      ],
    });

    return res.render('legal/page', {
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
      page,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getLegalIndex,
  getLegalPage,
};
