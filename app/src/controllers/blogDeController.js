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
const Product = require('../models/Product');
const { buildProductPublicPath, getPublicBaseUrlFromReq } = require('../services/productPublic');
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

function escapeHtml(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
  const minutes = Math.ceil(words / 200);
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

// ── Hreflang helpers ─────────────────────────────────────────────────────

function buildHreflangSetForBlogPost(baseUrl, slug) {
  const tags = [];
  const frUrl = baseUrl ? `${baseUrl}/blog/${encodeURIComponent(slug)}` : `/blog/${encodeURIComponent(slug)}`;
  const deUrl = baseUrl ? `${baseUrl}/de/blog/${encodeURIComponent(slug)}` : `/de/blog/${encodeURIComponent(slug)}`;
  tags.push({ lang: 'fr', href: frUrl });
  tags.push({ lang: 'de', href: deUrl });
  tags.push({ lang: 'x-default', href: frUrl });
  return { hreflangTags: tags };
}

function buildHreflangSetForBlogIndex(baseUrl) {
  const tags = [];
  const frUrl = baseUrl ? `${baseUrl}/blog` : '/blog';
  const deUrl = baseUrl ? `${baseUrl}/de/blog` : '/de/blog';
  tags.push({ lang: 'fr', href: frUrl });
  tags.push({ lang: 'de', href: deUrl });
  tags.push({ lang: 'x-default', href: frUrl });
  return { hreflangTags: tags };
}

// ── Réécriture des liens internes /blog/X → /de/blog/X (si X est traduit en DE) ─

async function rewriteInternalBlogLinks(html, currentSlug) {
  if (!html || typeof html !== 'string') return html;

  // Trouve tous les slugs référencés dans href="/blog/<slug>" ou href="/blog/<slug>/"
  const slugs = new Set();
  const linkRe = /href="\/blog\/([a-z0-9][a-z0-9\-]*)\/?"/gi;
  let m;
  while ((m = linkRe.exec(html)) !== null) {
    slugs.add(m[1].toLowerCase());
  }
  if (slugs.size === 0) return html;

  // Vérifie en BDD lesquels sont traduits en DE
  const translated = await BlogPost.find({
    slug: { $in: Array.from(slugs) },
    isPublished: true,
    'localizations.de.translatedAt': { $ne: null },
  }).select('slug').lean();

  const translatedSet = new Set(translated.map((d) => String(d.slug || '').toLowerCase()));
  if (translatedSet.size === 0) return html;

  // Réécrit href="/blog/<slug>" → href="/de/blog/<slug>" UNIQUEMENT si traduit.
  // On préserve les non-traduits en /blog/ pour ne pas générer de 404 chaînés.
  return html.replace(/href="\/blog\/([a-z0-9][a-z0-9\-]*)(\/)?"/gi, (full, slug, trailing) => {
    const lower = slug.toLowerCase();
    if (translatedSet.has(lower)) {
      return `href="/de/blog/${slug}${trailing || ''}"`;
    }
    return full;
  });
}

// ── CTA produit allemand inline (remplace le placeholder dans contentHtml) ──

function buildGermanProductCta(product) {
  const cents = Number.isFinite(product.priceCents) ? product.priceCents : 0;
  const priceEuros = (cents / 100).toFixed(2).replace('.', ',');
  const dreiRaten = cents > 50000
    ? `bzw. 3 Raten à ${(cents / 300).toFixed(2).replace('.', ',')} € ohne Aufpreis`
    : '';
  const prodUrl = buildProductPublicPath(product); // FR pour l'instant (Phase 3 = produits DE)
  const safeName = escapeHtml(product.name || '');
  const safeUrl = escapeHtml(prodUrl);

  return `<div class="blog-product-cta" data-product-cta="1">`
    + `<span class="cta-eyebrow">Instandgesetztes Teil — 2 Jahre Garantie</span>`
    + `<h3 class="cta-title">${safeName}</h3>`
    + `<span class="cta-price">${priceEuros} € inkl. MwSt.</span>`
    + (dreiRaten ? `<span class="cta-price-sub">${dreiRaten}</span>` : '')
    + `<ul class="cta-features">`
    + `<li>Geprüft, 24 Monate Garantie</li>`
    + `<li>Lieferung 3-5 Werktage</li>`
    + `<li>Dedizierter Technik-Support</li>`
    + `<li>Sichere Zahlung in 3 Raten ohne Aufpreis</li>`
    + `</ul>`
    + `<a class="cta-btn" href="${safeUrl}">Zum Produkt</a>`
    + `<a class="cta-btn-outline" href="/de/contact">Techniker kontaktieren</a>`
    + `</div>`;
}

// ── Index DE — liste des articles traduits (avec pagination) ────────────────

async function getBlogIndexDe(req, res) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const baseUrl = getPublicBaseUrlFromReq(req);

    res.set('Content-Language', 'de');

    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = 12;

    const title = `${brand.NAME} | Auto-Expertise Blog`;
    const metaDescription = 'Technische Ratgeber, Wartungstipps und Auto-Expertise: Diagnose, Austausch und Vergleich von Antriebsteilen für VAG, BMW, Mercedes, Porsche und mehr.';
    const canonicalUrl = baseUrl ? `${baseUrl}/de/blog${page > 1 ? `?page=${page}` : ''}` : `/de/blog${page > 1 ? `?page=${page}` : ''}`;

    const hreflang = buildHreflangSetForBlogIndex(baseUrl);
    const ogLocale = 'de_DE';
    const ogLocaleAlternate = 'fr_FR';

    const baseLocals = {
      title, metaDescription, canonicalUrl,
      ...hreflang,
      ogTitle: title, ogDescription: metaDescription, ogUrl: canonicalUrl, ogSiteName: brand.NAME, ogType: 'website', ogImage: '',
      ogLocale, ogLocaleAlternate,
      metaRobots: page > 1 ? 'noindex, follow' : 'index, follow',
      featured: null, categories: [], currentCategory: '', q: '',
    };

    if (!dbConnected) {
      return res.render('blog/index', { ...baseLocals, articles: [], popularArticles: [], page: 1, totalPages: 1 });
    }

    const filter = {
      isPublished: true,
      'localizations.de.translatedAt': { $ne: null },
    };

    const total = await BlogPost.countDocuments(filter);
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const safePage = Math.min(page, totalPages);

    const docs = await BlogPost.find(filter)
      .sort({ publishedAt: -1, createdAt: -1 })
      .skip((safePage - 1) * perPage)
      .limit(perPage)
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
        readTimeLabel: `${estimateReadingTimeMinutes(de.contentHtml || '')} Min.`,
        featured: false,
        url: `/de/blog/${encodeURIComponent(d.slug)}`,
      };
    });

    const popularDocs = await BlogPost.find(filter)
      .sort({ publishedAt: -1, createdAt: -1 })
      .limit(5)
      .select('slug title localizations.de.title category')
      .lean();
    const popularArticles = popularDocs.map((p, idx) => ({
      rank: String(idx + 1).padStart(2, '0'),
      title: (p.localizations && p.localizations.de && p.localizations.de.title) || p.title,
      meta: `${(p.category && p.category.label) ? p.category.label : 'Blog'} • aktuell`,
      url: `/de/blog/${encodeURIComponent(p.slug)}`,
    }));

    return res.render('blog/index', {
      ...baseLocals,
      articles,
      popularArticles,
      page: safePage,
      totalPages,
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

    res.set('Content-Language', 'de');

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

    const hreflang = buildHreflangSetForBlogPost(baseUrl, post.slug);

    const publishedAt = post.publishedAt || post.createdAt || null;
    const updatedAt = de.translatedAt || post.updatedAt || publishedAt || null;

    const ogImageRaw = (post.seo && post.seo.ogImageUrl) ? post.seo.ogImageUrl : post.coverImageUrl;
    const ogImage = ogImageRaw ? resolveAbsoluteUrl(baseUrl, ogImageRaw) : '';

    // Réécriture des liens internes /blog/X → /de/blog/X quand X est traduit
    let contentHtml = await rewriteInternalBlogLinks(de.contentHtml || '', post.slug);

    // Produits liés : on récupère, on construit le CTA inline avec labels DE,
    // on remplace le placeholder <div class="blog-product-cta" data-product-cta="1"></div>.
    let related = [];
    if (Array.isArray(post.relatedProductIds) && post.relatedProductIds.length) {
      related = await Product.find({ _id: { $in: post.relatedProductIds } })
        .select('_id name priceCents imageUrl slug')
        .lean();
    }

    const relatedProducts = (related || []).map((p) => {
      const priceEuros = Number.isFinite(p.priceCents) ? (p.priceCents / 100).toFixed(2).replace('.', ',') : '';
      return {
        id: String(p._id),
        name: p.name || '',
        priceLabel: priceEuros ? `${priceEuros} € inkl. MwSt.` : '',
        imageUrl: buildSeoMediaUrl(p.imageUrl, p.name),
        url: buildProductPublicPath(p), // /produits/<slug> FR — Phase 3 = produits DE
      };
    });

    if (related.length && contentHtml) {
      const ctaHtml = buildGermanProductCta(related[0]);
      contentHtml = contentHtml.replace(
        /<div class="blog-product-cta" data-product-cta="1"><\/div>/g,
        ctaHtml
      );
    }

    // Articles similaires : uniquement parmi ceux traduits en DE, même catégorie
    const similarDocs = await BlogPost.find({
      isPublished: true,
      slug: { $ne: post.slug },
      'localizations.de.translatedAt': { $ne: null },
      ...(post.category && post.category.slug ? { 'category.slug': post.category.slug } : {}),
    })
      .sort({ publishedAt: -1, createdAt: -1 })
      .limit(4)
      .select('slug title localizations.de.title coverImageUrl')
      .lean();

    const similarPosts = similarDocs.map((s) => {
      const sDe = (s.localizations && s.localizations.de) || {};
      return {
        slug: s.slug,
        title: sDe.title || s.title,
        imageUrl: buildSeoMediaUrl(s.coverImageUrl, sDe.title || s.title),
        url: `/de/blog/${encodeURIComponent(s.slug)}`,
      };
    });

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
      ogLocale: 'de_DE',
      ogLocaleAlternate: 'fr_FR',
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
        contentHtml: contentHtml || '',
      },
      relatedProducts,
      similarPosts,
      blogLinking: { detectedVehicleLandings: [] }, // Phase 3 (landing véhicules pas encore traduits)
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
