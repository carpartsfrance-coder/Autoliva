'use strict';

/**
 * blogDeController.js
 * Sert les versions allemandes des articles depuis BlogPost.localizations.de.
 *
 * Stratégie : on construit un "post hybride" avec les champs DE qui surchargent
 * les champs FR à la racine, puis on rend la même vue blog/show.ejs que la FR.
 * Avantage : on hérite de toute la logique de templating sans la dupliquer.
 *
 * Un article n'est exposé en DE que s'il a `localizations.de.translatedAt` non
 * null. Sinon → 404 (pas de fallback FR pour éviter le contenu mixte SEO).
 */

const mongoose = require('mongoose');

const BlogPost = require('../models/BlogPost');
const { getPublicBaseUrlFromReq } = require('../services/productPublic');
const { buildSeoMediaUrl } = require('../services/mediaStorage');
const brand = require('../config/brand');

const LANG_PREFIX = '/de';

// ── Helpers ──────────────────────────────────────────────────────────────

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeMetaText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function stripHtml(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#39;/g, "'").replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function truncateText(value, max) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) return '';
  if (!Number.isFinite(max) || max <= 0) return input;
  if (input.length <= max) return input;
  return `${input.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function formatDateDE(value) {
  try {
    if (!value) return '';
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('de-DE', { day: '2-digit', month: 'long', year: 'numeric' }).format(d);
  } catch (_) { return ''; }
}

function estimateReadingTimeMinutes(text) {
  const plain = stripHtml(text);
  if (!plain) return 1;
  const words = plain.split(/\s+/).filter(Boolean).length;
  const minutes = Math.ceil(words / 200); // DE est légèrement plus lent FR pour un lecteur natif
  return Math.max(1, Math.min(60, minutes));
}

function resolveAbsoluteUrl(baseUrl, rawUrl) {
  const input = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!input) return '';
  if (/^https?:\/\//i.test(input)) return input;
  if (!baseUrl) return input;
  if (input.startsWith('/')) return `${baseUrl}${input}`;
  return `${baseUrl}/${input}`;
}

function toSafeJsonLd(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c').replace(/>/g, '\\u003e').replace(/&/g, '\\u0026');
}

function isTranslated(post) {
  return Boolean(
    post && post.localizations && post.localizations.de && post.localizations.de.translatedAt
  );
}

// ── Hreflang helper ──────────────────────────────────────────────────────

function buildHreflangSetForBlog(baseUrl, slug, hasFr, hasDe) {
  const tags = [];
  const frUrl = baseUrl ? `${baseUrl}/blog/${encodeURIComponent(slug)}` : `/blog/${encodeURIComponent(slug)}`;
  const deUrl = baseUrl ? `${baseUrl}/de/blog/${encodeURIComponent(slug)}` : `/de/blog/${encodeURIComponent(slug)}`;
  if (hasFr) tags.push({ lang: 'fr', href: frUrl });
  if (hasDe) tags.push({ lang: 'de', href: deUrl });
  // x-default = FR (langue par défaut du site)
  if (hasFr) tags.push({ lang: 'x-default', href: frUrl });
  return { hreflangTags: tags };
}

function buildHreflangSetForIndex(baseUrl, hasFr, hasDe) {
  const tags = [];
  const frUrl = baseUrl ? `${baseUrl}/blog` : '/blog';
  const deUrl = baseUrl ? `${baseUrl}/de/blog` : '/de/blog';
  if (hasFr) tags.push({ lang: 'fr', href: frUrl });
  if (hasDe) tags.push({ lang: 'de', href: deUrl });
  if (hasFr) tags.push({ lang: 'x-default', href: frUrl });
  return { hreflangTags: tags };
}

// ── Index DE — liste des articles traduits ──────────────────────────────

async function getBlogIndexDe(req, res) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const baseUrl = getPublicBaseUrlFromReq(req);

    const title = `${brand.NAME} | Auto-Expertise Blog`;
    const metaDescription = 'Technische Ratgeber, Wartungstipps und Auto-Expertise: Diagnose, Austausch und Vergleich von Antriebsteilen für VAG, BMW, Mercedes, Porsche und mehr.';
    const canonicalUrl = baseUrl ? `${baseUrl}/de/blog` : '/de/blog';

    const hreflang = buildHreflangSetForIndex(baseUrl, true, true);

    if (!dbConnected) {
      return res.render('blog/index', {
        title, metaDescription, canonicalUrl,
        ...hreflang,
        ogTitle: title, ogDescription: metaDescription, ogUrl: canonicalUrl, ogSiteName: brand.NAME, ogType: 'website', ogImage: '',
        metaRobots: 'index, follow',
        featured: null, categories: [], currentCategory: '', q: '', articles: [], popularArticles: [],
        page: 1, totalPages: 1,
      });
    }

    const filter = {
      isPublished: true,
      'localizations.de.translatedAt': { $ne: null },
    };

    const docs = await BlogPost.find(filter)
      .sort({ publishedAt: -1, createdAt: -1 })
      .limit(20)
      .lean();

    const articles = docs.map((d) => {
      const de = (d.localizations && d.localizations.de) || {};
      const publishedAt = d.publishedAt || d.createdAt || null;
      return {
        slug: d.slug,
        title: de.title || d.title,
        excerpt: de.excerpt || d.excerpt,
        imageUrl: buildSeoMediaUrl(d.coverImageUrl, de.title || d.title),
        category: d.category && d.category.slug ? { slug: d.category.slug, label: d.category.label || d.category.slug } : null,
        dateLabel: formatDateDE(publishedAt),
        readTimeLabel: `${estimateReadingTimeMinutes(de.contentHtml || '')} min`,
        featured: false,
        url: `/de/blog/${encodeURIComponent(d.slug)}`,
      };
    });

    return res.render('blog/index', {
      title, metaDescription, canonicalUrl,
      ...hreflang,
      ogTitle: title, ogDescription: metaDescription, ogUrl: canonicalUrl, ogSiteName: brand.NAME, ogType: 'website', ogImage: '',
      metaRobots: 'index, follow',
      featured: null,
      categories: [],
      currentCategory: '',
      q: '',
      articles,
      popularArticles: [],
      page: 1,
      totalPages: 1,
    });
  } catch (err) {
    console.error('[blogDe] index error :', err);
    return res.status(500).render('errors/500', { title: `Fehler - ${brand.NAME}` });
  }
}

// ── Article DE — vue article unique ──────────────────────────────────────

async function getBlogPostDe(req, res) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const baseUrl = getPublicBaseUrlFromReq(req);
    const slugParam = typeof req.params.slug === 'string' ? req.params.slug.trim().toLowerCase() : '';

    if (!slugParam) {
      return res.status(404).render('errors/404', { title: `Seite nicht gefunden - ${brand.NAME}` });
    }
    if (!dbConnected) {
      return res.status(503).render('errors/500', { title: `Fehler - ${brand.NAME}` });
    }

    const post = await BlogPost.findOne({ slug: slugParam, isPublished: true }).lean();
    if (!post) {
      return res.status(404).render('errors/404', { title: `Seite nicht gefunden - ${brand.NAME}` });
    }

    if (!isTranslated(post)) {
      // Article existe mais pas (encore) traduit en DE → 404 propre côté DE
      return res.status(404).render('errors/404', { title: `Seite nicht gefunden - ${brand.NAME}` });
    }

    const de = post.localizations.de;

    const canonicalUrl = baseUrl
      ? `${baseUrl}/de/blog/${encodeURIComponent(post.slug)}`
      : `/de/blog/${encodeURIComponent(post.slug)}`;

    const computedDesc = truncateText(stripHtml(de.excerpt || de.contentHtml || ''), 160);
    const metaDescription = normalizeMetaText(
      (de.seo && de.seo.metaDescription) ? de.seo.metaDescription : computedDesc
    );
    const titleTag = normalizeMetaText(
      (de.seo && de.seo.metaTitle) ? de.seo.metaTitle : `${de.title} - ${brand.NAME}`
    );

    const hreflang = buildHreflangSetForBlog(baseUrl, post.slug, true, true);

    const publishedAt = post.publishedAt || post.createdAt || null;
    const updatedAt = de.translatedAt || post.updatedAt || publishedAt || null;

    const ogImageRaw = (post.seo && post.seo.ogImageUrl) ? post.seo.ogImageUrl : post.coverImageUrl;
    const ogImage = ogImageRaw ? resolveAbsoluteUrl(baseUrl, ogImageRaw) : '';

    const breadcrumbItems = [
      { '@type': 'ListItem', position: 1, name: 'Startseite', item: baseUrl ? `${baseUrl}/de` : '/de' },
      { '@type': 'ListItem', position: 2, name: 'Blog',       item: baseUrl ? `${baseUrl}/de/blog` : '/de/blog' },
      { '@type': 'ListItem', position: 3, name: de.title,     item: canonicalUrl },
    ];

    const jsonLd = toSafeJsonLd({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'BlogPosting',
          headline: de.title,
          description: computedDesc || undefined,
          image: ogImage ? [ogImage] : undefined,
          datePublished: publishedAt ? new Date(publishedAt).toISOString() : undefined,
          dateModified: updatedAt ? new Date(updatedAt).toISOString() : undefined,
          inLanguage: 'de',
          author: { '@type': 'Person', name: post.authorName || brand.NAME },
          publisher: {
            '@type': 'Organization',
            name: brand.NAME,
            url: baseUrl || undefined,
            logo: {
              '@type': 'ImageObject',
              url: baseUrl ? `${baseUrl}/images/logo-v2.png` : '/images/logo-v2.png',
            },
          },
          mainEntityOfPage: { '@type': 'WebPage', '@id': canonicalUrl },
        },
        { '@type': 'BreadcrumbList', itemListElement: breadcrumbItems },
      ],
    });

    return res.render('blog/show', {
      title: titleTag,
      metaDescription,
      canonicalUrl,
      ...hreflang,
      ogTitle: titleTag,
      ogDescription: metaDescription,
      ogUrl: canonicalUrl,
      ogSiteName: brand.NAME,
      ogType: 'article',
      ogArticlePublishedTime: publishedAt ? new Date(publishedAt).toISOString() : '',
      ogArticleModifiedTime:  updatedAt   ? new Date(updatedAt).toISOString()   : '',
      ogImage,
      jsonLd,
      metaRobots: 'index, follow',
      post: {
        title: de.title,
        slug: post.slug,
        excerpt: de.excerpt || computedDesc,
        coverImageUrl: buildSeoMediaUrl(post.coverImageUrl, de.title),
        category: post.category && post.category.slug ? { slug: post.category.slug, label: post.category.label || post.category.slug } : null,
        authorName: post.authorName || 'Autoliva-Experte',
        dateLabel: formatDateDE(publishedAt),
        readingTimeLabel: `${estimateReadingTimeMinutes(de.contentHtml)} Min. Lesezeit`,
        contentHtml: de.contentHtml || '',
      },
      relatedProducts: [],   // Phase 3 : produits localisés DE
      similarPosts: [],      // Phase 3 : articles similaires DE
      blogLinking: { detectedVehicleLandings: [] },
    });
  } catch (err) {
    console.error('[blogDe] post error :', err);
    return res.status(500).render('errors/500', { title: `Fehler - ${brand.NAME}` });
  }
}

module.exports = {
  getBlogIndexDe,
  getBlogPostDe,
  LANG_PREFIX,
};
