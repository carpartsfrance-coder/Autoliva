const mongoose = require('mongoose');

const Product = require('../models/Product');
const Category = require('../models/Category');
const LegalPage = require('../models/LegalPage');
const BlogPost = require('../models/BlogPost');
const demoProducts = require('../demoProducts');
const { buildProductPublicUrl, getPublicBaseUrlFromReq } = require('../services/productPublic');
const { buildCategoryPublicUrl } = require('../services/categoryPublic');
const { DEFAULT_LEGAL_PAGES } = require('../services/legalPages');
const { buildSeoMediaUrl } = require('../services/mediaStorage');

function escapeXml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function toIsoDate(value) {
  try {
    if (!value) return '';
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return d.toISOString();
  } catch (err) {
    return '';
  }
}

/* ─── Helpers de rendu XML ────────────────────────────────────────────── */

function renderUrlset(urls, { withImages = false } = {}) {
  const ns = withImages
    ? `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">`
    : `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;

  const body = urls.map((u) => {
    const lastmod = u.lastmod ? `\n    <lastmod>${escapeXml(u.lastmod)}</lastmod>` : '';
    const imageXml = withImages
      ? (u.images || [])
        .filter(Boolean)
        .map((imgUrl) => {
          const title = u.imageTitle ? `\n      <image:title>${escapeXml(u.imageTitle)}</image:title>` : '';
          return `\n    <image:image>\n      <image:loc>${escapeXml(imgUrl)}</image:loc>${title}\n    </image:image>`;
        })
        .join('')
      : '';
    return `  <url>\n    <loc>${escapeXml(u.loc)}</loc>${lastmod}${imageXml}\n  </url>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n${ns}\n${body}\n</urlset>\n`;
}

function renderSitemapIndex(sitemaps) {
  const body = sitemaps.map((s) => {
    const lastmod = s.lastmod ? `\n    <lastmod>${escapeXml(s.lastmod)}</lastmod>` : '';
    return `  <sitemap>\n    <loc>${escapeXml(s.loc)}</loc>${lastmod}\n  </sitemap>`;
  }).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>\n` +
    `<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n` +
    body + `\n</sitemapindex>\n`;
}

function sendXml(res, xml) {
  /* Le middleware express-session ajoute un Set-Cookie sur toutes les réponses
     (rolling: true). Sur un sitemap public, ce cookie casse le cache CDN et
     peut faire échouer le crawl Google ("Impossible de lire le sitemap"
     dans Search Console). On nettoie donc le header avant l'envoi. */
  res.removeHeader('Set-Cookie');
  res.set('Content-Type', 'application/xml; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=600');
  return res.status(200).send(xml);
}

function absMediaUrl(baseUrl, mediaPath) {
  if (!mediaPath) return '';
  return baseUrl ? `${baseUrl}${mediaPath}` : mediaPath;
}

/* ─── Sous-sitemaps ──────────────────────────────────────────────────── */

async function buildPagesUrls(baseUrl, dbConnected) {
  const resolveUrl = (path) => baseUrl ? `${baseUrl}${path}` : path;
  const urls = [
    { loc: resolveUrl('/'), lastmod: '' },
    { loc: resolveUrl('/produits'), lastmod: '' },
    { loc: resolveUrl('/categorie'), lastmod: '' },
    { loc: resolveUrl('/pieces-auto'), lastmod: '' },
    { loc: resolveUrl('/blog'), lastmod: '' },
    { loc: resolveUrl('/contact'), lastmod: '' },
    { loc: resolveUrl('/devis'), lastmod: '' },
    { loc: resolveUrl('/faq'), lastmod: '' },
    { loc: resolveUrl('/notre-histoire'), lastmod: '' },
    { loc: resolveUrl('/legal'), lastmod: '' },
  ];

  let legalPages = [];
  if (dbConnected) {
    legalPages = await LegalPage.find({ isPublished: { $ne: false } })
      .select('_id slug updatedAt')
      .sort({ sortOrder: 1, title: 1 })
      .lean();
  } else {
    legalPages = (DEFAULT_LEGAL_PAGES || []).map((p) => ({ slug: p.slug, updatedAt: null }));
  }

  for (const lp of legalPages) {
    if (!lp || !lp.slug) continue;
    urls.push({ loc: resolveUrl(`/legal/${encodeURIComponent(lp.slug)}`), lastmod: toIsoDate(lp.updatedAt) });
  }
  return urls;
}

async function buildCategoriesUrls(req, dbConnected) {
  if (!dbConnected) {
    /* Mode demo (sans DB) : construire les catégories depuis demoProducts. */
    const bySlug = new Map();
    for (const p of demoProducts || []) {
      const raw = p && typeof p.category === 'string' ? p.category.trim() : '';
      if (!raw) continue;
      const main = raw.includes('>') ? raw.split('>')[0].trim() : raw;
      const slug = main.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
        .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      if (!slug) continue;
      if (!bySlug.has(slug)) bySlug.set(slug, { slug, updatedAt: null });
    }
    const urls = [];
    for (const c of bySlug.values()) {
      const loc = buildCategoryPublicUrl(c, { req });
      if (loc) urls.push({ loc, lastmod: '' });
    }
    return urls;
  }

  const cats = await Category.find({ isActive: true })
    .select('_id slug updatedAt')
    .sort({ sortOrder: 1, name: 1 })
    .lean();
  const urls = [];
  for (const c of cats) {
    if (!c || !c.slug) continue;
    const loc = buildCategoryPublicUrl(c, { req });
    if (!loc) continue;
    urls.push({ loc, lastmod: toIsoDate(c.updatedAt) });
  }
  return urls;
}

async function buildProductsUrls(req, baseUrl, dbConnected) {
  let products = [];
  if (dbConnected) {
    products = await Product.find({ isPublished: { $ne: false } })
      .select('_id slug name updatedAt imageUrl galleryUrls')
      .sort({ updatedAt: -1 })
      .lean();
  } else {
    products = (demoProducts || []).slice();
  }

  const urls = [];
  for (const p of products) {
    if (!p || !p._id) continue;
    const loc = buildProductPublicUrl(p, { req });
    if (!loc) continue;
    const images = [];
    if (p.imageUrl) images.push(absMediaUrl(baseUrl, buildSeoMediaUrl(p.imageUrl, p.name)));
    if (Array.isArray(p.galleryUrls)) {
      for (const u of p.galleryUrls) {
        if (typeof u === 'string' && u.trim()) {
          images.push(absMediaUrl(baseUrl, buildSeoMediaUrl(u.trim(), p.name)));
        }
      }
    }
    urls.push({ loc, lastmod: toIsoDate(p.updatedAt), images, imageTitle: p.name || '' });
  }
  return urls;
}

async function buildVehiclesUrls(req, baseUrl, dbConnected) {
  if (!dbConnected) return [];
  const urls = [];
  const resolveUrl = (path) => baseUrl ? `${baseUrl}${path}` : path;
  try {
    const vehicleService = require('../services/vehicleLandingService');
    const makes = await vehicleService.listMakes();
    for (const make of makes) {
      const makeCount = await vehicleService.countCompatibleProducts({ make: make.name });
      if (makeCount === 0) continue;
      urls.push({ loc: resolveUrl(`/pieces-auto/${make.slug}`), lastmod: '' });
      for (const model of (make.models || [])) {
        const modelCount = await vehicleService.countCompatibleProducts({ make: make.name, model: model.name });
        if (modelCount === 0) continue;
        urls.push({ loc: resolveUrl(`/pieces-auto/${make.slug}/${model.slug}`), lastmod: '' });
        const cats = await vehicleService.listCategorySlugsForVehicle({ make: make.name, model: model.name });
        for (const cat of cats) {
          urls.push({ loc: resolveUrl(`/pieces-auto/${make.slug}/${model.slug}/${cat.slug}`), lastmod: '' });
        }
      }
    }
  } catch (err) {
    console.error('[sitemap] vehicle landings : erreur ignorée :', err && err.message ? err.message : err);
  }
  return urls;
}

async function buildReferencesUrls(baseUrl, dbConnected) {
  if (!dbConnected) return [];
  const resolveUrl = (path) => baseUrl ? `${baseUrl}${path}` : path;
  const urls = [];
  try {
    const refRows = await Product.aggregate([
      { $match: { isPublished: { $ne: false }, compatibleReferences: { $exists: true, $ne: [] } } },
      { $unwind: '$compatibleReferences' },
      { $project: { ref: { $trim: { input: '$compatibleReferences' } } } },
      { $match: { ref: { $regex: /^[A-Za-z0-9._\-/]{4,50}$/ } } },
      { $group: { _id: { $toUpper: '$ref' } } },
      { $sort: { _id: 1 } },
      { $limit: 5000 },
    ]);
    for (const row of refRows || []) {
      if (!row || !row._id) continue;
      urls.push({ loc: resolveUrl(`/reference/${encodeURIComponent(row._id)}`), lastmod: '' });
    }
  } catch (err) {
    console.error('[sitemap] OEM references : erreur ignorée :', err && err.message ? err.message : err);
  }
  return urls;
}

async function buildBlogUrls(baseUrl, dbConnected) {
  if (!dbConnected) return [];
  const resolveUrl = (path) => baseUrl ? `${baseUrl}${path}` : path;
  const posts = await BlogPost.find({ isPublished: true })
    .select('_id slug title updatedAt publishedAt coverImageUrl')
    .sort({ publishedAt: -1, updatedAt: -1 })
    .lean();
  const urls = [];
  for (const bp of posts) {
    if (!bp || !bp.slug) continue;
    const loc = resolveUrl(`/blog/${encodeURIComponent(String(bp.slug))}`);
    const last = bp.updatedAt || bp.publishedAt || null;
    const images = [];
    if (bp.coverImageUrl) images.push(absMediaUrl(baseUrl, buildSeoMediaUrl(bp.coverImageUrl, bp.title)));
    urls.push({ loc, lastmod: toIsoDate(last), images, imageTitle: bp.title || '' });
  }
  return urls;
}

/* Sitemap DE : ne liste QUE les articles avec une traduction allemande
 * effectivement publiée (localizations.de.translatedAt non null). Un article
 * en cours de traduction n'apparaît pas, ce qui évite à Google d'indexer une
 * 404 ou un fallback FR. */
async function buildBlogUrlsDe(baseUrl, dbConnected) {
  if (!dbConnected) return [];
  const resolveUrl = (path) => baseUrl ? `${baseUrl}${path}` : path;
  const posts = await BlogPost.find({
    isPublished: true,
    'localizations.de.translatedAt': { $ne: null },
  })
    .select('_id slug title updatedAt publishedAt coverImageUrl localizations.de.translatedAt localizations.de.title')
    .sort({ publishedAt: -1, updatedAt: -1 })
    .lean();
  const urls = [];
  for (const bp of posts) {
    if (!bp || !bp.slug) continue;
    const deLoc = bp.localizations && bp.localizations.de;
    if (!deLoc || !deLoc.translatedAt) continue;
    const loc = resolveUrl(`/de/blog/${encodeURIComponent(String(bp.slug))}`);
    // lastmod = max(translatedAt, updatedAt) pour signaler les retraductions
    const last = (deLoc.translatedAt && bp.updatedAt && new Date(deLoc.translatedAt) > new Date(bp.updatedAt))
      ? deLoc.translatedAt
      : (bp.updatedAt || bp.publishedAt || deLoc.translatedAt || null);
    const images = [];
    const imgTitle = deLoc.title || bp.title;
    if (bp.coverImageUrl) images.push(absMediaUrl(baseUrl, buildSeoMediaUrl(bp.coverImageUrl, imgTitle)));
    urls.push({ loc, lastmod: toIsoDate(last), images, imageTitle: imgTitle || '' });
  }
  return urls;
}

/* ─── Routes ─────────────────────────────────────────────────────────── */

/* /sitemap.xml — sitemap index pointant vers les sous-sitemaps.
   Si l'index est désactivé (SITEMAP_LEGACY_FLAT=true) on retourne le format
   monolithique pour compat. */
async function getSitemapXml(req, res, next) {
  try {
    const baseUrl = getPublicBaseUrlFromReq(req);

    if (process.env.SITEMAP_LEGACY_FLAT === 'true') {
      return getLegacyFlatSitemap(req, res, next);
    }

    const resolveUrl = (path) => baseUrl ? `${baseUrl}${path}` : path;
    const now = new Date().toISOString();
    const sitemaps = [
      { loc: resolveUrl('/sitemap-pages.xml'), lastmod: now },
      { loc: resolveUrl('/sitemap-categories.xml'), lastmod: now },
      { loc: resolveUrl('/sitemap-products.xml'), lastmod: now },
      { loc: resolveUrl('/sitemap-vehicles.xml'), lastmod: now },
      { loc: resolveUrl('/sitemap-references.xml'), lastmod: now },
      { loc: resolveUrl('/sitemap-blog.xml'), lastmod: now },
      { loc: resolveUrl('/sitemap-blog-de.xml'), lastmod: now },
    ];

    return sendXml(res, renderSitemapIndex(sitemaps));
  } catch (err) {
    return next(err);
  }
}

/* Format flat : tout dans un seul sitemap.xml (anciennement la valeur par
   défaut). Conservé en flag pour rollback rapide si besoin. */
async function getLegacyFlatSitemap(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const baseUrl = getPublicBaseUrlFromReq(req);

    const all = []
      .concat(await buildPagesUrls(baseUrl, dbConnected))
      .concat(await buildCategoriesUrls(req, dbConnected))
      .concat(await buildVehiclesUrls(req, baseUrl, dbConnected))
      .concat(await buildReferencesUrls(baseUrl, dbConnected))
      .concat(await buildProductsUrls(req, baseUrl, dbConnected))
      .concat(await buildBlogUrls(baseUrl, dbConnected));

    return sendXml(res, renderUrlset(all, { withImages: true }));
  } catch (err) {
    return next(err);
  }
}

async function getSitemapPages(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const baseUrl = getPublicBaseUrlFromReq(req);
    const urls = await buildPagesUrls(baseUrl, dbConnected);
    return sendXml(res, renderUrlset(urls));
  } catch (err) {
    return next(err);
  }
}

async function getSitemapCategories(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const urls = await buildCategoriesUrls(req, dbConnected);
    return sendXml(res, renderUrlset(urls));
  } catch (err) {
    return next(err);
  }
}

async function getSitemapProducts(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const baseUrl = getPublicBaseUrlFromReq(req);
    const urls = await buildProductsUrls(req, baseUrl, dbConnected);
    return sendXml(res, renderUrlset(urls, { withImages: true }));
  } catch (err) {
    return next(err);
  }
}

async function getSitemapVehicles(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const baseUrl = getPublicBaseUrlFromReq(req);
    const urls = await buildVehiclesUrls(req, baseUrl, dbConnected);
    return sendXml(res, renderUrlset(urls));
  } catch (err) {
    return next(err);
  }
}

async function getSitemapReferences(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const baseUrl = getPublicBaseUrlFromReq(req);
    const urls = await buildReferencesUrls(baseUrl, dbConnected);
    return sendXml(res, renderUrlset(urls));
  } catch (err) {
    return next(err);
  }
}

async function getSitemapBlog(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const baseUrl = getPublicBaseUrlFromReq(req);
    const urls = await buildBlogUrls(baseUrl, dbConnected);
    return sendXml(res, renderUrlset(urls, { withImages: true }));
  } catch (err) {
    return next(err);
  }
}

async function getSitemapBlogDe(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const baseUrl = getPublicBaseUrlFromReq(req);
    const urls = await buildBlogUrlsDe(baseUrl, dbConnected);
    return sendXml(res, renderUrlset(urls, { withImages: true }));
  } catch (err) {
    return next(err);
  }
}

function getRobotsTxt(req, res) {
  /* Même pollution Set-Cookie que sur sitemap : on nettoie. */
  res.removeHeader('Set-Cookie');

  if (process.env.FORCE_NOINDEX === 'true') {
    const body = [
      'User-agent: *',
      'Disallow: /',
      '',
    ].join('\n');

    res.set('Content-Type', 'text/plain; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=600');
    return res.status(200).send(body);
  }

  const baseUrl = getPublicBaseUrlFromReq(req);
  const abs = (path) => (baseUrl ? `${baseUrl}${path}` : path);

  const lines = [
    '# =====================================================',
    '# robots.txt — autoliva.com',
    '# Optimisé suite migration carpartsfrance.fr',
    '# =====================================================',
    '',
    'User-agent: *',
    'Allow: /',
    '',
    '# --- Zones privées ---',
    'Disallow: /admin',
    'Disallow: /admin/',
    'Disallow: /panier',
    'Disallow: /panier/',
    'Disallow: /commande',
    'Disallow: /commande/',
    'Disallow: /compte',
    'Disallow: /compte/',
    'Disallow: /mon-compte',
    'Disallow: /mon-compte/',
    'Disallow: /checkout',
    'Disallow: /checkout/',
    'Disallow: /cart',
    'Disallow: /cart/',
    '',
    '# --- URLs paramétrées WooCommerce résiduelles (CRITIQUE) ---',
    'Disallow: /*?s=',
    'Disallow: /*?post_type=',
    'Disallow: /*?filter_cat=',
    'Disallow: /*?filter_tag=',
    'Disallow: /*?filter_*=',
    'Disallow: /*?add-to-cart=',
    'Disallow: /*?remove_item=',
    'Disallow: /*?undo_item=',
    'Disallow: /*?shop_view=',
    'Disallow: /*?orderby=',
    'Disallow: /*?per_page=',
    'Disallow: /*?min_price=',
    'Disallow: /*?max_price=',
    'Disallow: /*?wpf=',
    'Disallow: /*?paged=',
    'Disallow: /*?currency=',
    'Disallow: /*?utm_*=',
    'Disallow: /*?fbclid=',
    'Disallow: /*?gclid=',
    'Disallow: /*?msclkid=',
    'Disallow: /*?mc_cid=',
    'Disallow: /*?mc_eid=',
    '',
    '# --- Recherches internes ---',
    'Disallow: /search/',
    'Disallow: /?s=',
    '',
    '# --- Pages utilisateur ---',
    'Disallow: /wishlist',
    'Disallow: /wishlist/',
    'Disallow: /lost-password',
    'Disallow: /reset-password',
    'Disallow: /devis-en-cours/',
    'Disallow: /commande-recue/',
    'Disallow: /confirmation/',
    'Disallow: /thank-you/',
    '',
    '# --- Endpoints techniques ---',
    'Disallow: /api/',
    'Disallow: /_next/',
    'Disallow: /feed/',
    '',
    '# --- Bots indésirables ---',
    'User-agent: AhrefsBot',
    'Crawl-delay: 5',
    '',
    'User-agent: SemrushBot',
    'Crawl-delay: 5',
    '',
    'User-agent: MJ12bot',
    'Disallow: /',
    '',
    'User-agent: DotBot',
    'Disallow: /',
    '',
    '# --- Sitemaps ---',
    `Sitemap: ${abs('/sitemap.xml')}`,
    `Sitemap: ${abs('/sitemap-pages.xml')}`,
    `Sitemap: ${abs('/sitemap-categories.xml')}`,
    `Sitemap: ${abs('/sitemap-products.xml')}`,
    `Sitemap: ${abs('/sitemap-vehicles.xml')}`,
    `Sitemap: ${abs('/sitemap-references.xml')}`,
    `Sitemap: ${abs('/sitemap-blog.xml')}`,
    `Sitemap: ${abs('/sitemap-blog-de.xml')}`,
    '',
  ];

  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=600');
  return res.status(200).send(lines.join('\n'));
}

module.exports = {
  getSitemapXml,
  getRobotsTxt,
  getSitemapPages,
  getSitemapCategories,
  getSitemapProducts,
  getSitemapVehicles,
  getSitemapReferences,
  getSitemapBlog,
  getSitemapBlogDe,
};
