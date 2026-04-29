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

async function getSitemapXml(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const baseUrl = getPublicBaseUrlFromReq(req);

    let products = [];
    let categories = [];
    let legalPages = [];
    let blogPosts = [];
    if (dbConnected) {
      /* Filtre sitemap : seuls les produits publiés (default true) sont inclus.
       * Évite que Google crawle des brouillons / produits désactivés. */
      products = await Product.find({ isPublished: { $ne: false } })
        .select('_id slug name updatedAt imageUrl galleryUrls')
        .sort({ updatedAt: -1 })
        .lean();

      categories = await Category.find({ isActive: true })
        .select('_id slug updatedAt')
        .sort({ sortOrder: 1, name: 1 })
        .lean();

      legalPages = await LegalPage.find({ isPublished: { $ne: false } })
        .select('_id slug updatedAt')
        .sort({ sortOrder: 1, title: 1 })
        .lean();

      blogPosts = await BlogPost.find({ isPublished: true })
        .select('_id slug title updatedAt publishedAt coverImageUrl')
        .sort({ publishedAt: -1, updatedAt: -1 })
        .lean();
    } else {
      products = (demoProducts || []).slice();

      const bySlug = new Map();
      for (const p of demoProducts || []) {
        const raw = p && typeof p.category === 'string' ? p.category.trim() : '';
        if (!raw) continue;
        const main = raw.includes('>') ? raw.split('>')[0].trim() : raw;
        const slug = main
          .normalize('NFD')
          .replace(/[\u0300-\u036f]/g, '')
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '');
        if (!slug) continue;
        if (!bySlug.has(slug)) bySlug.set(slug, { slug, updatedAt: null });
      }
      categories = Array.from(bySlug.values());

      legalPages = (DEFAULT_LEGAL_PAGES || []).map((p) => ({ slug: p.slug, updatedAt: null }));
      blogPosts = [];
    }

    const urls = [];

    function resolveUrl(path) {
      return baseUrl ? `${baseUrl}${path}` : path;
    }

    urls.push({ loc: resolveUrl('/'), lastmod: '' });
    urls.push({ loc: resolveUrl('/produits'), lastmod: '' });
    urls.push({ loc: resolveUrl('/categorie'), lastmod: '' });
    urls.push({ loc: resolveUrl('/pieces-auto'), lastmod: '' });
    urls.push({ loc: resolveUrl('/blog'), lastmod: '' });
    urls.push({ loc: resolveUrl('/contact'), lastmod: '' });
    urls.push({ loc: resolveUrl('/devis'), lastmod: '' });
    urls.push({ loc: resolveUrl('/faq'), lastmod: '' });
    urls.push({ loc: resolveUrl('/notre-histoire'), lastmod: '' });
    urls.push({ loc: resolveUrl('/legal'), lastmod: '' });

    for (const lp of legalPages || []) {
      if (!lp || !lp.slug) continue;
      urls.push({ loc: resolveUrl(`/legal/${encodeURIComponent(lp.slug)}`), lastmod: toIsoDate(lp.updatedAt) });
    }

    for (const c of categories || []) {
      if (!c || !c.slug) continue;
      const loc = buildCategoryPublicUrl(c, { req });
      if (!loc) continue;
      urls.push({ loc, lastmod: toIsoDate(c.updatedAt) });
    }

    /* Vehicle landing pages — /pieces-auto/:make, /:make/:model, /:make/:model/:category.
       On ne liste que les couples qui ont au moins 1 produit compatible
       (sinon Google trouverait des 404 dans le sitemap).

       NOTE perf : les pages /:make/:model/:category sont les "money pages" (forte
       conversion). Elles génèrent potentiellement beaucoup d'URLs (n_makes ×
       n_models × n_categories). On limite avec listCategorySlugsForVehicle qui
       ne retourne que les catégories ayant ≥1 produit pour le couple. */
    if (dbConnected) {
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

            /* Money pages : :make/:model/:category. */
            const cats = await vehicleService.listCategorySlugsForVehicle({ make: make.name, model: model.name });
            for (const cat of cats) {
              urls.push({ loc: resolveUrl(`/pieces-auto/${make.slug}/${model.slug}/${cat.slug}`), lastmod: '' });
            }
          }
        }
      } catch (err) {
        console.error('[sitemap] vehicle landings : erreur ignorée :', err && err.message ? err.message : err);
      }
    }

    /* OEM reference landing pages — /reference/:ref.
       Une URL par référence unique présente dans compatibleReferences[] de
       au moins 1 produit publié. Les mécanos pros Googlent ces refs directement,
       conversion rate très haute. Limit raisonnable pour éviter sitemap énorme. */
    if (dbConnected) {
      try {
        const refRows = await Product.aggregate([
          { $match: { isPublished: { $ne: false }, compatibleReferences: { $exists: true, $ne: [] } } },
          { $unwind: '$compatibleReferences' },
          { $project: { ref: { $trim: { input: '$compatibleReferences' } } } },
          { $match: { ref: { $regex: /^[A-Za-z0-9._\-/]{4,50}$/ } } },
          { $group: { _id: { $toUpper: '$ref' } } },
          { $sort: { _id: 1 } },
          { $limit: 5000 }, // safety cap
        ]);
        for (const row of refRows || []) {
          if (!row || !row._id) continue;
          urls.push({ loc: resolveUrl(`/reference/${encodeURIComponent(row._id)}`), lastmod: '' });
        }
      } catch (err) {
        console.error('[sitemap] OEM references : erreur ignorée :', err && err.message ? err.message : err);
      }
    }

    for (const p of products) {
      if (!p || !p._id) continue;
      const loc = buildProductPublicUrl(p, { req });
      if (!loc) continue;

      /* Collect all product images for the image sitemap */
      const imageUrls = [];
      if (p.imageUrl) imageUrls.push(buildSeoMediaUrl(p.imageUrl, p.name));
      if (Array.isArray(p.galleryUrls)) {
        for (const u of p.galleryUrls) {
          if (typeof u === 'string' && u.trim()) imageUrls.push(buildSeoMediaUrl(u.trim(), p.name));
        }
      }

      urls.push({ loc, lastmod: toIsoDate(p.updatedAt), images: imageUrls, imageTitle: p.name || '' });
    }

    for (const bp of blogPosts || []) {
      if (!bp || !bp.slug) continue;
      const loc = resolveUrl(`/blog/${encodeURIComponent(String(bp.slug))}`);
      const last = bp.updatedAt || bp.publishedAt || null;
      const blogImages = [];
      if (bp.coverImageUrl) blogImages.push(buildSeoMediaUrl(bp.coverImageUrl, bp.title));
      urls.push({ loc, lastmod: toIsoDate(last), images: blogImages, imageTitle: bp.title || '' });
    }

    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n` +
      `<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"\n` +
      `        xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">\n` +
      urls
        .map((u) => {
          const lastmod = u.lastmod ? `\n    <lastmod>${escapeXml(u.lastmod)}</lastmod>` : '';
          const imageXml = (u.images || [])
            .filter(Boolean)
            .map((imgUrl) => {
              const absImgUrl = baseUrl ? `${baseUrl}${imgUrl}` : imgUrl;
              const title = u.imageTitle ? `\n      <image:title>${escapeXml(u.imageTitle)}</image:title>` : '';
              return `\n    <image:image>\n      <image:loc>${escapeXml(absImgUrl)}</image:loc>${title}\n    </image:image>`;
            })
            .join('');
          return `  <url>\n    <loc>${escapeXml(u.loc)}</loc>${lastmod}${imageXml}\n  </url>`;
        })
        .join('\n') +
      `\n</urlset>\n`;

    res.set('Content-Type', 'application/xml; charset=utf-8');
    res.set('Cache-Control', 'public, max-age=600');
    return res.status(200).send(xml);
  } catch (err) {
    return next(err);
  }
}

function getRobotsTxt(req, res) {
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
  const sitemapUrl = baseUrl ? `${baseUrl}/sitemap.xml` : '/sitemap.xml';

  const body = [
    'User-agent: *',
    'Allow: /',
    'Disallow: /admin',
    'Disallow: /panier',
    'Disallow: /commande',
    'Disallow: /compte',
    '',
    `Sitemap: ${sitemapUrl}`,
    '',
  ].join('\n');

  res.set('Content-Type', 'text/plain; charset=utf-8');
  res.set('Cache-Control', 'public, max-age=600');
  return res.status(200).send(body);
}

module.exports = {
  getSitemapXml,
  getRobotsTxt,
};
