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
const blogProductCta = require('../services/blogProductCta');
const nettoyageArticle = require('../services/nettoyageArticle');
const signatureArticle = require('../services/signatureArticle');
const { buildSeoMediaUrl } = require('../services/mediaStorage');
const brand = require('../config/brand');
const datesSeo = require('../services/datesSeo');
/* Politique d'indexation (plan de reprise SEO du 14/09/2026, action A5.5) :
   les 134 articles allemands en 410 n'apparaissent dans aucune liste. La
   couche allemande entière relève de la famille « de » (noindex par le
   chemin), qui la garde en ligne : rien d'autre n'est écarté ici. */
const { publicBlogFilter, retirerLiensDisparus } = require('../services/seoIndexPolicy');

const LANG_PREFIX = '/de';

/* Les catégories du blog ne sont pas traduites en base : la liste allemande
   affichait « Transmission > Boîte de transfert » sous des titres allemands.
   19 valeurs distinctes, indexées par SLUG parce que les libellés stockés ont
   des variantes d'encodage (« Différentiel », « DiffÃ©rentiel »). */
const BLOG_CATEGORIES_DE = require('../locales/blogCategoriesDe.json');

/* Les fiches produit existent en allemand : un article allemand ne doit plus
   renvoyer vers la fiche française, ni citer son titre français. */
function produitNomDe(p) {
  const de = (p && p.localizations && p.localizations.de) || {};
  return (de.translatedAt && de.name) ? de.name : ((p && p.name) || '');
}

function produitUrlDe(p) {
  const de = (p && p.localizations && p.localizations.de) || {};
  if (!de.translatedAt) return buildProductPublicPath(p);
  const slug = (de.slug && String(de.slug).trim()) || p.slug || String(p._id);
  return `/de/produits/${encodeURIComponent(slug)}-${p._id}`;
}

function blogCategoryLabelDe(category) {
  if (!category) return '';
  const slug = String(category.slug || '').trim().toLowerCase();
  return BLOG_CATEGORIES_DE[slug] || String(category.label || slug || '');
}

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
  const translated = await BlogPost.find(publicBlogFilter({
    slug: { $in: Array.from(slugs) },
    isPublished: true,
    'localizations.de.translatedAt': { $ne: null },
  }, { lang: 'de' })).select('slug').lean();

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
  /* Même encadré que le français, même règle : il ne dit que ce que dit la
     fiche (état traduit, garantie saisie, délai traduit) — plan SEO A11.
     Il promettait « 2 Jahre Garantie » et « 24 Monate » sur toute pièce. */
  return blogProductCta.construireCta(product, {
    lang: 'de',
    url: produitUrlDe(product),
    nom: produitNomDe(product),
  });
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

    const filter = publicBlogFilter({
      isPublished: true,
      'localizations.de.translatedAt': { $ne: null },
    }, { lang: 'de' });

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
        category: d.category && d.category.slug ? { slug: d.category.slug, label: blogCategoryLabelDe(d.category) } : null,
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
      meta: `${blogCategoryLabelDe(p.category) || 'Blog'} • aktuell`,
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
      return res.redirect(301, '/blog');
    }
    if (!dbConnected) {
      return res.status(503).render('errors/500', { title: `Fehler - ${brand.NAME}` });
    }

    const post = await BlogPost.findOne(publicBlogFilter({ slug: slugParam, isPublished: true }, { lang: 'de', page: true })).lean();
    if (!post) {
      // Article DE inexistant → on essaie l'équivalent FR avant de 404.
      return res.redirect(301, `/blog/${encodeURIComponent(slugParam)}`);
    }

    if (!isTranslated(post)) {
      // L'article FR existe mais la traduction DE n'est pas faite → 301
      // vers la version FR plutôt que 404 (préserve PageRank + UX). Élimine
      // les ~6 alertes "4XX pages" sur /de/blog/* dans Semrush.
      return res.redirect(301, `/blog/${encodeURIComponent(post.slug)}`);
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
    /* Dernière modification de la page ALLEMANDE : sa traduction, sinon la
       publication. Jamais updatedAt (plan de reprise SEO, action A4.5). */
    const modifieLe = datesSeo.dateModificationArticleDe(post);

    const ogImageRaw = (post.seo && post.seo.ogImageUrl) ? post.seo.ogImageUrl : post.coverImageUrl;
    const ogImage = ogImageRaw ? resolveAbsoluteUrl(baseUrl, ogImageRaw) : '';

    // Réécriture des liens internes /blog/X → /de/blog/X quand X est traduit
    /* Mêmes restes de chaîne que le français, retirés avant la réécriture des
       liens internes (les liens de préproduction deviennent /blog/x, puis
       /de/blog/x) — plan SEO A12. */
    let contentHtml = await rewriteInternalBlogLinks(nettoyageArticle.nettoyerHtml(de.contentHtml || '', { lang: 'de' }), post.slug);
    /* Liens vers un article en 410 (/blog/x, /de/blog/x, autoliva.com,
       carpartsfrance.fr) : le texte reste, la balise <a> part. */
    contentHtml = retirerLiensDisparus(contentHtml);

    // Produits liés : on récupère, on construit le CTA inline avec labels DE,
    // on remplace le placeholder <div class="blog-product-cta" data-product-cta="1"></div>.
    let related = [];
    if (Array.isArray(post.relatedProductIds) && post.relatedProductIds.length) {
      related = await Product.find({ _id: { $in: post.relatedProductIds } })
        .select('_id name priceCents imageUrl slug localizations.de.name localizations.de.slug localizations.de.translatedAt ' + blogProductCta.CHAMPS_FICHE)
        .lean();
    }

    const relatedProducts = (related || []).map((p) => {
      const priceEuros = Number.isFinite(p.priceCents) ? (p.priceCents / 100).toFixed(2).replace('.', ',') : '';
      const nom = produitNomDe(p);
      return {
        id: String(p._id),
        name: nom,
        priceLabel: priceEuros ? `${priceEuros} € inkl. MwSt.` : '',
        imageUrl: buildSeoMediaUrl(p.imageUrl, nom),
        url: produitUrlDe(p),
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
    const similarDocs = await BlogPost.find(publicBlogFilter({
      isPublished: true,
      slug: { $ne: post.slug },
      'localizations.de.translatedAt': { $ne: null },
      ...(post.category && post.category.slug ? { 'category.slug': post.category.slug } : {}),
    }, { lang: 'de' }))
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
          dateModified: datesSeo.isoPasse(modifieLe) || undefined,
          inLanguage: 'de',
          author: signatureArticle.signature(post, { lang: 'de', marque: brand.NAME, baseUrl }).auteurJsonLd,
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
      ogArticleModifiedTime:  datesSeo.isoPasse(modifieLe),
      ogImage,
      jsonLd,
      metaRobots: 'index, follow',
      post: {
        title: de.title,
        slug: post.slug,
        excerpt: de.excerpt || computedDesc,
        coverImageUrl: buildSeoMediaUrl(post.coverImageUrl, de.title),
        category: post.category && post.category.slug ? { slug: post.category.slug, label: blogCategoryLabelDe(post.category) } : null,
        ...(() => {
          const signe = signatureArticle.signature(post, { lang: 'de', marque: brand.NAME, baseUrl });
          return { authorName: signe.nom, verification: signe.verification, mentionIa: signe.mentionIa };
        })(),
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
