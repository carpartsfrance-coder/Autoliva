const mongoose = require('mongoose');

const BlogPost = require('../models/BlogPost');
const Product = require('../models/Product');
const { buildProductPublicPath, getPublicBaseUrlFromReq } = require('../services/productPublic');
const { markdownToHtml, escapeHtml } = require('../services/blogContent');
const { buildHreflangSet } = require('../services/i18n');
const { buildSeoMediaUrl } = require('../services/mediaStorage');
const brand = require('../config/brand');

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeComparableText(value) {
  let input = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!input) return '';
  try {
    input = input.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  } catch (e) {
  }
  input = input.replace(/[^a-z0-9\s-]/g, ' ');
  input = input.replace(/\s+/g, ' ').trim();
  return input;
}

function getComparableTokens(value) {
  const normalized = normalizeComparableText(value);
  if (!normalized) return [];
  const stop = new Set(['et', 'de', 'la', 'le', 'les', 'des', 'du', 'un', 'une', 'd', 'a', 'au', 'aux']);
  return normalized
    .split(' ')
    .map((t) => t.trim())
    .filter(Boolean)
    .filter((t) => t.length >= 3)
    .filter((t) => !stop.has(t));
}

function stripDuplicateLeadingTitleFromMarkdown(markdown, title) {
  const raw = typeof markdown === 'string' ? markdown.replace(/\r\n?/g, '\n') : '';
  if (!raw.trim()) return '';

  const titleTokens = getComparableTokens(title);
  if (!titleTokens.length) return raw;

  const lines = raw.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i += 1;
  if (i >= lines.length) return raw;

  const first = lines[i].trim();
  const boldOnly = /^\*\*([^*]+)\*\*$/.exec(first);
  const h1 = /^#\s+(.+)$/.exec(first);
  const candidate = boldOnly ? boldOnly[1].trim() : h1 ? h1[1].trim() : '';
  if (!candidate) return raw;

  const candTokens = getComparableTokens(candidate);
  if (!candTokens.length) return raw;

  const titleSet = new Set(titleTokens);
  const candSet = new Set(candTokens);
  let common = 0;
  for (const t of candSet) {
    if (titleSet.has(t)) common += 1;
  }
  const minLen = Math.min(titleSet.size, candSet.size) || 1;
  const similarity = common / minLen;

  const containsCore = titleSet.has('boite') && titleSet.has('transfert') && candSet.has('boite') && candSet.has('transfert');
  const looksDuplicate = (common >= 4 && similarity >= 0.6) || (containsCore && common >= 3);
  if (!looksDuplicate) return raw;

  lines.splice(i, 1);
  if (i < lines.length && !lines[i].trim()) lines.splice(i, 1);
  return lines.join('\n').trim();
}

function stripLeadingParagraphFromMarkdown(markdown) {
  const raw = typeof markdown === 'string' ? markdown.replace(/\r\n?/g, '\n') : '';
  if (!raw.trim()) return '';
  const lines = raw.split('\n');

  let i = 0;
  while (i < lines.length && !lines[i].trim()) i += 1;
  if (i >= lines.length) return raw;

  const first = lines[i].trim();
  const isStructural = first.startsWith('# ')
    || first.startsWith('## ')
    || first.startsWith('### ')
    || first.startsWith('```')
    || first.startsWith('>')
    || first === '---'
    || first === '***'
    || /^(-|\*)\s+/.test(first)
    || /^\*\*([^*]+)\*\*$/.test(first)
    || /^\d+[).]\s+/.test(first);

  if (isStructural) return raw;

  let j = i;
  while (j < lines.length && lines[j].trim()) j += 1;
  lines.splice(i, j - i);

  while (i < lines.length && !lines[i].trim()) lines.splice(i, 1);
  return lines.join('\n').trim();
}

function stripLeadingSeoNoiseFromMarkdown(markdown) {
  const raw = typeof markdown === 'string' ? markdown.replace(/\r\n?/g, '\n') : '';
  if (!raw.trim()) return '';

  const lines = raw.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i += 1;
  if (i >= lines.length) return raw;

  const maxScan = Math.min(lines.length, i + 15);
  let removed = 0;

  for (let k = i; k < maxScan; k += 1) {
    const t = String(lines[k] || '').trim();
    if (!t) break;
    const low = normalizeComparableText(t);
    const isMetaTitle = low.startsWith('meta title') || low.startsWith('metatitle') || low.startsWith('seo title');
    const isMetaDesc = low.startsWith('meta description') || low.startsWith('metadescription') || low.startsWith('seo description');
    const isSlug = low.startsWith('slug');
    const isPrimaryKw = low.startsWith('mot cle principal') || low.startsWith('mot-cl') || low.startsWith('mot cle');
    const isSecondaryKw = low.startsWith('mots cles secondaires') || low.startsWith('mots cles');
    const hasSep = t.includes(':') || t.includes(' - ') || t.includes('—');
    const isSeoLine = (isMetaTitle || isMetaDesc || isSlug || isPrimaryKw || isSecondaryKw) && hasSep;
    if (!isSeoLine) break;
    lines[k] = '';
    removed += 1;
  }

  if (!removed) return raw;
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stripLeadingHorizontalRulesFromMarkdown(markdown) {
  const raw = typeof markdown === 'string' ? markdown.replace(/\r\n?/g, '\n') : '';
  if (!raw.trim()) return '';

  const lines = raw.split('\n');
  let i = 0;
  while (i < lines.length && !lines[i].trim()) i += 1;
  if (i >= lines.length) return raw;

  let removed = 0;
  for (let k = i; k < Math.min(lines.length, i + 10); k += 1) {
    const t = String(lines[k] || '').trim();
    if (!t) continue;
    if (t === '---' || t === '***') {
      lines[k] = '';
      removed += 1;
      continue;
    }
    break;
  }

  if (!removed) return raw;
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function stripLeadingSommaireSectionFromMarkdown(markdown) {
  const raw = typeof markdown === 'string' ? markdown.replace(/\r\n?/g, '\n') : '';
  if (!raw.trim()) return '';

  const lines = raw.split('\n');
  const maxScan = Math.min(lines.length, 120);

  function isSommaireHeading(line) {
    const t = String(line || '').trim();
    if (!t) return false;
    const h = /^(#{1,4})\s+(.+)$/.exec(t);
    const bold = /^\*\*([^*]+)\*\*$/.exec(t);
    const candidate = h ? h[2] : bold ? bold[1] : '';
    if (!candidate) return false;
    return normalizeComparableText(candidate) === 'sommaire';
  }

  function isListLine(line) {
    const t = String(line || '').trim();
    if (!t) return false;
    return /^(-|\*)\s+/.test(t) || /^\d+[).]\s+/.test(t);
  }

  let start = -1;
  for (let i = 0; i < maxScan; i += 1) {
    if (isSommaireHeading(lines[i])) {
      start = i;
      break;
    }
  }
  if (start === -1) return raw;

  let j = start + 1;
  while (j < lines.length && !lines[j].trim()) j += 1;

  let hasList = false;
  while (j < lines.length) {
    const t = String(lines[j] || '').trim();
    if (!t) {
      j += 1;
      if (hasList) break;
      continue;
    }
    if (isListLine(t)) {
      hasList = true;
      j += 1;
      continue;
    }
    if (!hasList) return raw;
    break;
  }

  if (!hasList) return raw;

  lines.splice(start, Math.max(1, j - start));
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function getPostContentHtml(post) {
  if (!post) return '';
  if (typeof post.contentMarkdown === 'string' && post.contentMarkdown.trim()) {
    return markdownToHtml(post.contentMarkdown);
  }
  if (typeof post.contentHtml === 'string' && post.contentHtml.trim()) return post.contentHtml;
  return '';
}

function normalizeMetaText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function truncateText(value, max) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) return '';
  if (!Number.isFinite(max) || max <= 0) return input;
  if (input.length <= max) return input;
  return `${input.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function stripHtml(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/<[^>]*>/g, ' ')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function toSafeJsonLd(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function formatDateFR(value) {
  try {
    if (!value) return '';
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' }).format(d);
  } catch (err) {
    return '';
  }
}

function clampInt(value, { min, max, fallback } = {}) {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value || ''), 10);
  if (!Number.isFinite(n)) return fallback;
  const floored = Math.floor(n);
  if (Number.isFinite(min) && floored < min) return min;
  if (Number.isFinite(max) && floored > max) return max;
  return floored;
}

function estimateReadingTimeMinutes(text) {
  const plain = stripHtml(text);
  if (!plain) return 0;
  const words = plain.split(/\s+/).filter(Boolean).length;
  const minutes = Math.ceil(words / 220);
  return clampInt(minutes, { min: 1, max: 60, fallback: 1 });
}

function resolveAbsoluteUrl(baseUrl, rawUrl) {
  const input = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!input) return '';
  if (/^https?:\/\//i.test(input)) return input;
  if (!baseUrl) return input;
  if (input.startsWith('/')) return `${baseUrl}${input}`;
  return `${baseUrl}/${input}`;
}

function buildBlogIndexUrl(baseUrl, query = {}) {
  const q = getTrimmedString(query.q);
  const category = getTrimmedString(query.category);
  const page = Number(query.page);

  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (category) params.set('category', category);
  if (Number.isFinite(page) && page > 1) params.set('page', String(page));

  const qs = params.toString();
  const path = qs ? `/blog?${qs}` : '/blog';
  if (!baseUrl) return path;
  return `${baseUrl}${path}`;
}

function buildCategories(articles) {
  const map = new Map();
  for (const a of articles || []) {
    if (!a || !a.category || !a.category.slug) continue;
    const slug = getTrimmedString(a.category.slug);
    const label = getTrimmedString(a.category.label) || slug;
    if (!slug) continue;
    if (!map.has(slug)) map.set(slug, { slug, label });
  }
  return Array.from(map.values()).sort((a, b) => a.label.localeCompare(b.label, 'fr'));
}

function getBlogIndex(req, res) {
  (async () => {
    const dbConnected = mongoose.connection.readyState === 1;
    const baseUrl = getPublicBaseUrlFromReq(req);
    const langPrefix = req.lang === 'en' ? '/en' : '';
    const pathWithoutLang = res.locals.currentPathWithoutLang || req.path;
    const hreflang = buildHreflangSet(baseUrl, pathWithoutLang);

    const q = getTrimmedString(req.query.q);
    const category = getTrimmedString(req.query.category);
    const page = Math.max(1, Number(req.query.page) || 1);

    const title = `${brand.NAME} | Blog Expertise Automobile`;
    const metaDescription =
      "Guides techniques, conseils d'entretien et expertise automobile : retrouvez nos articles pour mieux choisir, diagnostiquer et entretenir vos pièces.";

    const shouldNoIndex = Boolean(q) || Boolean(category) || page > 1;
    const metaRobots = shouldNoIndex ? 'noindex, follow' : res.locals.metaRobots;

    const ogTitle = title;
    const ogDescription = normalizeMetaText(metaDescription);
    const ogType = 'website';

    if (!dbConnected) {
      const canonicalUrl = buildBlogIndexUrl(baseUrl, { q, category, page: 1 });
      const ogUrl = canonicalUrl;
      return res.render('blog/index', {
        title,
        metaDescription: normalizeMetaText(metaDescription),
        canonicalUrl,
        ...hreflang,
        ogTitle,
        ogDescription,
        ogUrl,
        ogSiteName: brand.NAME,
        ogType,
        ogImage: '',
        metaRobots,
        featured: null,
        categories: [],
        currentCategory: category,
        q,
        articles: [],
        popularArticles: [],
        page: 1,
        totalPages: 1,
      });
    }

    const featuredDoc = await BlogPost.findOne({ isPublished: true, isFeatured: true })
      .sort({ publishedAt: -1, createdAt: -1 })
      .lean();

    const baseFilter = { isPublished: true };
    if (category) {
      baseFilter['category.slug'] = category;
    }
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      baseFilter.$or = [{ title: { $regex: rx } }, { excerpt: { $regex: rx } }];
    }

    const showFeatured = !q && !category && page <= 1;

    const listingFilter = {
      ...baseFilter,
      ...((showFeatured && featuredDoc && featuredDoc.slug) ? { slug: { $ne: featuredDoc.slug } } : {}),
    };

    const perPage = 4;
    const total = await BlogPost.countDocuments(listingFilter);
    const totalPages = Math.max(1, Math.ceil(total / perPage));
    const safePage = Math.min(page, totalPages);

    const docs = await BlogPost.find(listingFilter)
      .sort({ publishedAt: -1, createdAt: -1 })
      .skip((safePage - 1) * perPage)
      .limit(perPage)
      .lean();

    const allForCategories = await BlogPost.find({ isPublished: true })
      .select('category')
      .lean();

    const mappedAll = docs.map((d) => {
      const publishedAt = d && d.publishedAt ? d.publishedAt : d && d.createdAt ? d.createdAt : null;
      const contentHtml = getPostContentHtml(d);
      const minutes = Number.isFinite(d.readingTimeMinutes) && d.readingTimeMinutes > 0
        ? d.readingTimeMinutes
        : estimateReadingTimeMinutes(contentHtml || '');

      return {
        slug: d.slug,
        title: d.title,
        excerpt: d.excerpt,
        imageUrl: buildSeoMediaUrl(d.coverImageUrl, d.title),
        category: d.category && d.category.slug ? { slug: d.category.slug, label: d.category.label || d.category.slug } : null,
        dateLabel: formatDateFR(publishedAt),
        readTimeLabel: `${minutes} min`,
        featured: d.isFeatured === true,
        url: `/blog/${encodeURIComponent(d.slug)}`,
      };
    });

    const categories = buildCategories(
      (allForCategories || []).map((d) => ({
        category: d && d.category ? d.category : null,
      }))
    );

    const featured = showFeatured && featuredDoc
      ? {
          slug: featuredDoc.slug,
          title: featuredDoc.title,
          excerpt: featuredDoc.excerpt,
          imageUrl: buildSeoMediaUrl(featuredDoc.coverImageUrl, featuredDoc.title),
          category: featuredDoc.category && featuredDoc.category.slug ? { slug: featuredDoc.category.slug, label: featuredDoc.category.label || featuredDoc.category.slug } : null,
          dateLabel: formatDateFR(featuredDoc.publishedAt || featuredDoc.createdAt),
          readTimeLabel: `${Number.isFinite(featuredDoc.readingTimeMinutes) && featuredDoc.readingTimeMinutes > 0 ? featuredDoc.readingTimeMinutes : estimateReadingTimeMinutes(getPostContentHtml(featuredDoc) || '')} min`,
          url: `/blog/${encodeURIComponent(featuredDoc.slug)}`,
        }
      : null;

    const canonicalUrl = buildBlogIndexUrl(baseUrl, { q, category, page: safePage });
    const ogUrl = canonicalUrl;

    const ogImage = featured && featured.imageUrl ? resolveAbsoluteUrl(baseUrl, featured.imageUrl) : '';

    const blogBreadcrumbJsonLd = toSafeJsonLd({
      '@context': 'https://schema.org',
      '@type': 'BreadcrumbList',
      itemListElement: [
        { '@type': 'ListItem', position: 1, name: 'Accueil', item: baseUrl ? `${baseUrl}/` : '/' },
        { '@type': 'ListItem', position: 2, name: 'Blog', item: canonicalUrl },
      ],
    });

    const popularArticles = await BlogPost.find({ isPublished: true })
      .sort({ publishedAt: -1, createdAt: -1 })
      .limit(5)
      .select('slug title category')
      .lean();

    const popularView = (popularArticles || []).map((p, idx) => ({
      rank: String(idx + 1).padStart(2, '0'),
      title: p.title,
      meta: `${(p.category && p.category.label) ? p.category.label : 'Blog'} • récent`,
      url: `/blog/${encodeURIComponent(p.slug)}`,
    }));

    return res.render('blog/index', {
      title,
      metaDescription: normalizeMetaText(metaDescription),
      canonicalUrl,
      ...hreflang,
      ogTitle,
      ogDescription,
      ogUrl,
      ogSiteName: brand.NAME,
      ogType,
      ogImage,
      metaRobots,
      jsonLd: blogBreadcrumbJsonLd,
      featured,
      categories,
      currentCategory: category,
      q,
      articles: mappedAll,
      popularArticles: popularView,
      page: safePage,
      totalPages,
    });
  })().catch((err) => {
    console.error(err);
    return res.status(500).render('errors/500', { title: `Erreur - ${brand.NAME}` });
  });
}

function buildBlogPostCanonical(baseUrl, slug) {
  const path = `/blog/${encodeURIComponent(slug)}`;
  return baseUrl ? `${baseUrl}${path}` : path;
}

async function getBlogPost(req, res) {
  return (async () => {
    const dbConnected = mongoose.connection.readyState === 1;
    const baseUrl = getPublicBaseUrlFromReq(req);
    const langPrefix = req.lang === 'en' ? '/en' : '';
    const pathWithoutLang = res.locals.currentPathWithoutLang || req.path;
    const hreflang = buildHreflangSet(baseUrl, pathWithoutLang);

    const slugParam = typeof req.params.slug === 'string' ? req.params.slug.trim().toLowerCase() : '';
    if (!slugParam) {
      return res.status(404).render('errors/404', { title: `Page introuvable - ${brand.NAME}` });
    }

    if (!dbConnected) {
      return res.status(503).render('errors/500', { title: `Erreur - ${brand.NAME}` });
    }

    const post = await BlogPost.findOne({ slug: slugParam, isPublished: true }).lean();
    if (!post) {
      return res.status(404).render('errors/404', { title: `Page introuvable - ${brand.NAME}` });
    }

    const cleanedMarkdown = (post && typeof post.contentMarkdown === 'string' && post.contentMarkdown.trim())
      ? stripLeadingSommaireSectionFromMarkdown(
          stripLeadingSeoNoiseFromMarkdown(
            stripDuplicateLeadingTitleFromMarkdown(post.contentMarkdown, post.title)
          )
        )
      : '';

    const finalMarkdown = cleanedMarkdown
      ? stripLeadingHorizontalRulesFromMarkdown(cleanedMarkdown)
      : '';

    let contentHtml = finalMarkdown
      ? markdownToHtml(finalMarkdown)
      : getPostContentHtml(post);

    const canonicalUrl = (() => {
      const customPath = post.seo && post.seo.canonicalPath ? post.seo.canonicalPath.trim() : '';
      if (customPath) {
        return resolveAbsoluteUrl(baseUrl, customPath);
      }
      return buildBlogPostCanonical(baseUrl, post.slug);
    })();

    const computedDesc = truncateText(stripHtml(post.excerpt || contentHtml || ''), 160);
    const metaDescription = normalizeMetaText(post.seo && post.seo.metaDescription ? post.seo.metaDescription : computedDesc);
    const title = normalizeMetaText(post.seo && post.seo.metaTitle ? post.seo.metaTitle : `${post.title} - ${brand.NAME}`);

    const excerptForView = post.excerpt || computedDesc;

    if (!post.excerpt && finalMarkdown) {
      const withoutLeadParagraph = stripLeadingParagraphFromMarkdown(finalMarkdown);
      if (withoutLeadParagraph && withoutLeadParagraph !== finalMarkdown) {
        contentHtml = markdownToHtml(withoutLeadParagraph);
      }
    }

    const ogTitle = title;
    const ogDescription = metaDescription;
    const ogUrl = canonicalUrl;
    const ogType = 'article';
    const ogImageRaw = (post.seo && post.seo.ogImageUrl) ? post.seo.ogImageUrl : post.coverImageUrl;
    const ogImage = ogImageRaw ? resolveAbsoluteUrl(baseUrl, ogImageRaw) : '';

    const publishedAt = post.publishedAt || post.createdAt || null;
    const updatedAt = post.updatedAt || publishedAt || null;
    const readingTimeMinutes = Number.isFinite(post.readingTimeMinutes) && post.readingTimeMinutes > 0
      ? post.readingTimeMinutes
      : estimateReadingTimeMinutes(contentHtml || '');

    let related = [];
    if (Array.isArray(post.relatedProductIds) && post.relatedProductIds.length) {
      related = await Product.find({ _id: { $in: post.relatedProductIds } })
        .select('_id name priceCents imageUrl slug')
        .lean();
    }

    const relatedView = (related || []).map((p) => {
      const priceEuros = Number.isFinite(p.priceCents) ? (p.priceCents / 100).toFixed(2).replace('.', ',') : '';
      return {
        id: String(p._id),
        name: p.name || '',
        priceLabel: priceEuros ? `${priceEuros} €` : '',
        imageUrl: buildSeoMediaUrl(p.imageUrl, p.name),
        url: buildProductPublicPath(p),
      };
    });

    if (related.length && contentHtml) {
      const p = related[0];
      const cents = Number.isFinite(p.priceCents) ? p.priceCents : 0;
      const priceEuros = (cents / 100).toFixed(2).replace('.', ',');
      const troisFois = cents > 50000
        ? `soit 3x ${(cents / 300).toFixed(2).replace('.', ',')} € sans frais`
        : '';
      const prodUrl = buildProductPublicPath(p);
      const ctaHtml = `<div class="blog-product-cta" data-product-cta="1">`
        + `<span class="cta-eyebrow">Pièce reconditionnée — Garantie 2 ans</span>`
        + `<h3 class="cta-title">${escapeHtml(p.name || '')}</h3>`
        + `<span class="cta-price">${priceEuros} € TTC</span>`
        + (troisFois ? `<span class="cta-price-sub">${troisFois}</span>` : '')
        + `<ul class="cta-features">`
        + `<li>Testé et garanti 24 mois</li>`
        + `<li>Livraison express 24/48h</li>`
        + `<li>Support technique dédié</li>`
        + `<li>Paiement sécurisé en 3x sans frais</li>`
        + `</ul>`
        + `<a class="cta-btn" href="${escapeHtml(prodUrl)}">Voir la fiche produit</a>`
        + `<a class="cta-btn-outline" href="/contact">Contacter un technicien</a>`
        + `</div>`;
      contentHtml = contentHtml.replace(
        /<div class="blog-product-cta" data-product-cta="1"><\/div>/g,
        ctaHtml
      );
    }

    const similarDocs = await BlogPost.find({
      isPublished: true,
      slug: { $ne: post.slug },
      ...(post.category && post.category.slug ? { 'category.slug': post.category.slug } : {}),
    })
      .sort({ publishedAt: -1, createdAt: -1 })
      .limit(4)
      .select('slug title coverImageUrl')
      .lean();

    const similarPosts = (similarDocs || []).map((s) => ({
      slug: s.slug,
      title: s.title,
      imageUrl: buildSeoMediaUrl(s.coverImageUrl, s.title),
      url: `/blog/${encodeURIComponent(s.slug)}`,
    }));

    const breadcrumbItems = [
      {
        '@type': 'ListItem',
        position: 1,
        name: 'Accueil',
        item: baseUrl ? `${baseUrl}/` : '/',
      },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'Blog',
        item: baseUrl ? `${baseUrl}/blog` : '/blog',
      },
      {
        '@type': 'ListItem',
        position: 3,
        name: post.title,
        item: canonicalUrl,
      },
    ];

    const jsonLdObj = {
      '@type': 'BlogPosting',
      headline: post.title,
      description: computedDesc || undefined,
      image: ogImage ? [ogImage] : undefined,
      datePublished: publishedAt ? new Date(publishedAt).toISOString() : undefined,
      dateModified: updatedAt ? new Date(updatedAt).toISOString() : undefined,
      author: {
        '@type': 'Person',
        name: post.authorName || brand.NAME,
      },
      publisher: {
        '@type': 'Organization',
        name: brand.NAME,
        url: baseUrl || undefined,
        logo: {
          '@type': 'ImageObject',
          url: baseUrl ? `${baseUrl}/images/logo-v2.png` : '/images/logo-v2.png',
        },
      },
      mainEntityOfPage: {
        '@type': 'WebPage',
        '@id': canonicalUrl,
      },
    };

    const faqItems = [];
    if (contentHtml) {
      const faqIdx = contentHtml.indexOf('FAQ') !== -1
        ? contentHtml.indexOf('FAQ')
        : contentHtml.indexOf('Questions fréquentes') !== -1
          ? contentHtml.indexOf('Questions fréquentes')
          : -1;
      if (faqIdx !== -1) {
        const faqSection = contentHtml.slice(faqIdx);
        const faqRegex = /<h[23][^>]*>(.*?)<\/h[23]>\s*<p>(.*?)<\/p>/gi;
        let faqMatch;
        while ((faqMatch = faqRegex.exec(faqSection)) !== null) {
          const question = stripHtml(faqMatch[1]).trim();
          const answer = stripHtml(faqMatch[2]).trim();
          if (question.endsWith('?') && question.length > 10 && answer) {
            faqItems.push({ question, answer });
          }
        }
      }
    }

    const graphItems = [
      jsonLdObj,
      {
        '@type': 'BreadcrumbList',
        itemListElement: breadcrumbItems,
      },
    ];

    if (faqItems.length >= 2) {
      graphItems.push({
        '@type': 'FAQPage',
        mainEntity: faqItems.map((f) => ({
          '@type': 'Question',
          name: f.question,
          acceptedAnswer: {
            '@type': 'Answer',
            text: f.answer,
          },
        })),
      });
    }

    const jsonLd = toSafeJsonLd({
      '@context': 'https://schema.org',
      '@graph': graphItems,
    });

    const ogArticlePublishedTime = publishedAt ? new Date(publishedAt).toISOString() : '';
    const ogArticleModifiedTime = updatedAt ? new Date(updatedAt).toISOString() : '';

    return res.render('blog/show', {
      title,
      metaDescription,
      canonicalUrl,
      ...hreflang,
      ogTitle,
      ogDescription,
      ogUrl,
      ogSiteName: brand.NAME,
      ogType,
      ogArticlePublishedTime,
      ogArticleModifiedTime,
      ogImage,
      jsonLd,
      metaRobots: post.seo && post.seo.metaRobots ? post.seo.metaRobots : res.locals.metaRobots,
      post: {
        title: post.title,
        slug: post.slug,
        excerpt: excerptForView,
        coverImageUrl: buildSeoMediaUrl(post.coverImageUrl, post.title),
        category: post.category && post.category.slug ? { slug: post.category.slug, label: post.category.label || post.category.slug } : null,
        authorName: post.authorName || 'Expert CarParts',
        dateLabel: formatDateFR(publishedAt),
        readingTimeLabel: `${readingTimeMinutes} min de lecture`,
        contentHtml: contentHtml || '',
      },
      relatedProducts: relatedView,
      similarPosts,
    });
  })().catch((err) => {
    console.error(err);
    return res.status(500).render('errors/500', { title: `Erreur - ${brand.NAME}` });
  });
}

module.exports = {
  getBlogIndex,
  getBlogPost,
};
