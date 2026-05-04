/**
 * GET /google-merchant-feed.xml
 *
 * Endpoint Express pour Google Merchant Center.
 * Génère un feed XML RSS 2.0 conforme à la spec Google Merchant à partir
 * de la base produits autoliva.com.
 *
 * Conçu pour autoliva.com (Node + Express + MongoDB, hébergé Render.com).
 *
 * USAGE
 * -----
 *   const merchantFeedRoute = require('./routes/google-merchant-feed');
 *   app.get('/google-merchant-feed.xml', merchantFeedRoute);
 *
 * IMPORTANT
 * ---------
 *   - `loadProducts()` est câblée sur le modèle Mongoose Product (carpartsfrance →
 *     autoliva). Si on ajoute plus tard `condition` et `brand` en DB, retirer
 *     les heuristiques aval (déjà côté `classifyCondition` / `inferBrand`).
 *   - Le résultat est mis en cache 1h en mémoire process pour éviter de
 *     recalculer le feed à chaque crawl Google (Merchant fetch toutes les
 *     ~24h, mais d'autres outils peuvent solliciter l'URL).
 */

const mongoose = require('mongoose');
const Product = require('../models/Product');
const { buildSeoMediaUrl } = require('../services/mediaStorage');

const xmlEscape = (s) => {
  if (s === null || s === undefined) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
};

const REFURB_KW = ['reconditionn', 'echange-standard', 'echange-st', 'remanufactur'];
const USED_KW = ['occasion'];
const NEW_KW = ['neuf', 'neuve'];

const CAR_BRANDS = [
  'BMW', 'Audi', 'Volkswagen', 'VW', 'Seat', 'Skoda', 'Porsche',
  'Mercedes', 'Mercedes-Benz', 'Land Rover', 'Range Rover', 'Jaguar',
  'Mini', 'Ford', 'Renault', 'Peugeot', 'Citroen', 'Citroën',
  'Opel', 'Chevrolet', 'Nissan', 'Infiniti', 'Toyota', 'Lexus',
  'Hyundai', 'Kia', 'Volvo', 'Dodge', 'Jeep', 'Chrysler',
  'Fiat', 'Alfa Romeo', 'Lancia', 'Tesla', 'Subaru', 'Mazda',
];

function classifyCondition({ slug = '', title = '', explicit }) {
  if (explicit && ['new', 'refurbished', 'used'].includes(explicit)) {
    return explicit;
  }
  const haystack = `${slug} ${title}`.toLowerCase();
  if (USED_KW.some((k) => haystack.includes(k))) return 'used';
  if (NEW_KW.some((k) => haystack.includes(k)) && !REFURB_KW.some((k) => haystack.includes(k))) {
    return 'new';
  }
  if (REFURB_KW.some((k) => haystack.includes(k))) return 'refurbished';
  return 'refurbished'; // default — 80%+ du catalogue est reconditionné
}

function inferBrand(...texts) {
  const joined = texts.filter(Boolean).join(' ');
  for (const b of CAR_BRANDS) {
    const re = new RegExp(`\\b${b.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(joined)) return ['BMW', 'VW'].includes(b) ? b.toUpperCase() : b;
  }
  return null;
}

function availabilityToG(av) {
  if (!av) return 'in_stock';
  const a = String(av).toLowerCase();
  if (a.includes('outofstock') || a.includes('out_of_stock') || a === 'oos') return 'out_of_stock';
  if (a.includes('preorder') || a.includes('pre_order')) return 'preorder';
  if (a.includes('backorder')) return 'backorder';
  return 'in_stock';
}

function stripHtml(value) {
  return String(value || '')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

/* `badges.condition` est un champ libre côté admin ("Reconditionné", "Occasion",
 * "Neuf"…). On normalise vers les 3 valeurs Google Merchant ; sinon null pour
 * laisser `classifyCondition` jouer ses heuristiques. */
function normalizeCondition(value) {
  if (!value) return null;
  const s = String(value).toLowerCase().trim();
  if (['new', 'refurbished', 'used'].includes(s)) return s;
  if (/(reconditionn|refurbi|échange standard|echange standard|reman)/.test(s)) return 'refurbished';
  if (/(occasion|used|seconde main)/.test(s)) return 'used';
  if (/(neuf|new)/.test(s)) return 'new';
  return null;
}

/**
 * Charge les produits publiés depuis Mongo et les remappe vers la forme
 * consommée par `productToFeedItem`. Si la DB n'est pas connectée (boot),
 * retourne un tableau vide — Merchant Center retentera plus tard.
 *
 * Champs retournés :
 *   _id, slug, sku, name, description, priceCents, currency, stock, images,
 *   category, condition, brand, isPublished
 */
async function loadProducts() {
  if (mongoose.connection.readyState !== 1) return [];

  const docs = await Product.find({ isPublished: { $ne: false } })
    .select(
      '_id name slug sku description shortDescription priceCents inStock stockQty ' +
      'imageUrl galleryUrls galleryTypes category brand badges'
    )
    .lean();

  return docs.map((p) => {
    const seoPath = (raw) => buildSeoMediaUrl(raw, p.name) || raw;

    const images = [];
    if (p.imageUrl && typeof p.imageUrl === 'string' && p.imageUrl.trim()) {
      images.push({ path: seoPath(p.imageUrl.trim()) });
    }
    if (Array.isArray(p.galleryUrls)) {
      const types = Array.isArray(p.galleryTypes) ? p.galleryTypes : [];
      p.galleryUrls.forEach((u, i) => {
        if (typeof u === 'string' && u.trim() && (types[i] || 'image') === 'image') {
          images.push({ path: seoPath(u.trim()) });
        }
      });
    }

    const description = stripHtml(p.description || p.shortDescription || p.name || '');

    const stockQty = typeof p.stockQty === 'number' ? p.stockQty : null;
    const stock = stockQty !== null ? stockQty : (p.inStock !== false);

    const condition = (p.badges && p.badges.condition)
      ? normalizeCondition(p.badges.condition)
      : null;

    return {
      _id: p._id,
      slug: typeof p.slug === 'string' ? p.slug : '',
      sku: typeof p.sku === 'string' ? p.sku : '',
      name: typeof p.name === 'string' ? p.name : '',
      description,
      priceCents: Number(p.priceCents) || 0,
      currency: 'EUR',
      stock,
      images,
      category: typeof p.category === 'string' ? p.category : '',
      condition,
      brand: typeof p.brand === 'string' && p.brand.trim() ? p.brand.trim() : null,
      isPublished: true,
    };
  });
}

function productToFeedItem(p) {
  const baseUrl = 'https://autoliva.com';
  const link = `${baseUrl}/product/${p.slug}/`;

  const mainImage = (p.images && p.images[0] && p.images[0].path) || null;
  const additionalImages = (p.images || []).slice(1, 11).map((i) => i.path).filter(Boolean);

  const imageUrl = (path) => {
    if (!path) return null;
    if (path.startsWith('http')) return path;
    // Ajouter l'extension .jpeg pour Google (sinon il rejette le format)
    const withSlash = path.startsWith('/') ? path : `/${path}`;
    return `${baseUrl}${withSlash}${withSlash.match(/\.(jpe?g|png|gif|webp)$/i) ? '' : '.jpeg'}`;
  };

  if (!mainImage) return null; // pas d'image = produit ineligible Google Merchant

  const priceEuros = (Number(p.priceCents) / 100).toFixed(2);
  const inStock = typeof p.stock === 'boolean' ? p.stock : Number(p.stock) > 0;
  const availability = inStock ? 'in_stock' : 'out_of_stock';

  const title = (p.name || '').trim().slice(0, 150);
  const description = (p.description || title).trim().slice(0, 5000);

  const condition = classifyCondition({
    slug: p.slug || '',
    title,
    explicit: p.condition,
  });

  const brand = p.brand || inferBrand(title) || 'Autoliva';

  return {
    id: String(p._id),
    title,
    description,
    link,
    image_link: imageUrl(mainImage),
    additional_image_link: additionalImages.map(imageUrl).filter(Boolean),
    price: `${priceEuros} ${p.currency || 'EUR'}`,
    availability,
    condition,
    brand,
    mpn: p.sku || String(p._id),
    identifier_exists: 'no',
    google_product_category: '888', // Vehicles & Parts > Vehicle Parts & Accessories
    product_type: p.category || '',
  };
}

function buildFeedXml(items) {
  const now = new Date().toUTCString();
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">');
  lines.push('  <channel>');
  lines.push('    <title>Autoliva — Google Merchant Feed</title>');
  lines.push('    <link>https://autoliva.com</link>');
  lines.push('    <description>Pièces auto reconditionnées, occasion et testées sur banc</description>');
  lines.push(`    <lastBuildDate>${now}</lastBuildDate>`);
  for (const it of items) {
    lines.push('    <item>');
    lines.push(`      <g:id>${xmlEscape(it.id)}</g:id>`);
    lines.push(`      <g:title>${xmlEscape(it.title)}</g:title>`);
    lines.push(`      <g:description><![CDATA[${(it.description || '').replace(/]]>/g, ']]]]><![CDATA[>')}]]></g:description>`);
    lines.push(`      <g:link>${xmlEscape(it.link)}</g:link>`);
    lines.push(`      <g:image_link>${xmlEscape(it.image_link)}</g:image_link>`);
    for (const ai of it.additional_image_link) {
      lines.push(`      <g:additional_image_link>${xmlEscape(ai)}</g:additional_image_link>`);
    }
    lines.push(`      <g:price>${xmlEscape(it.price)}</g:price>`);
    lines.push(`      <g:availability>${xmlEscape(it.availability)}</g:availability>`);
    lines.push(`      <g:condition>${xmlEscape(it.condition)}</g:condition>`);
    lines.push(`      <g:brand>${xmlEscape(it.brand)}</g:brand>`);
    lines.push(`      <g:mpn>${xmlEscape(it.mpn)}</g:mpn>`);
    lines.push(`      <g:identifier_exists>${xmlEscape(it.identifier_exists)}</g:identifier_exists>`);
    lines.push(`      <g:google_product_category>${xmlEscape(it.google_product_category)}</g:google_product_category>`);
    if (it.product_type) {
      lines.push(`      <g:product_type>${xmlEscape(it.product_type)}</g:product_type>`);
    }
    lines.push('    </item>');
  }
  lines.push('  </channel>');
  lines.push('</rss>');
  return lines.join('\n');
}

// Cache mémoire process — 1h
let cache = { xml: null, builtAt: 0 };
const CACHE_TTL_MS = 60 * 60 * 1000;

async function buildFeedCached() {
  const now = Date.now();
  if (cache.xml && now - cache.builtAt < CACHE_TTL_MS) return cache.xml;
  const products = await module.exports.loadProducts();
  const items = products.map(productToFeedItem).filter(Boolean);
  // Tri stable par id pour des diffs propres
  items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const xml = buildFeedXml(items);
  cache = { xml, builtAt: now };
  return xml;
}

module.exports = async function googleMerchantFeed(req, res) {
  try {
    const xml = await buildFeedCached();
    /* Le middleware express-session pose un Set-Cookie sur toutes les réponses
       (rolling: true) ; on nettoie pour ne pas casser le cache CDN ni le crawl
       Merchant. Inoffensif si la route est montée avant session — défensif. */
    res.removeHeader('Set-Cookie');
    res.set({
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    });
    res.send(xml);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.error('[google-merchant-feed] error:', err);
    res.status(500).set('Content-Type', 'text/plain').send('Feed generation failed');
  }
};

// Export interne pour tests / régénération forcée
module.exports.loadProducts = loadProducts;
module.exports.buildFeedCached = buildFeedCached;
module.exports.productToFeedItem = productToFeedItem;
module.exports.classifyCondition = classifyCondition;
module.exports.inferBrand = inferBrand;
module.exports.availabilityToG = availabilityToG;
module.exports._invalidateCache = function invalidateCache() {
  cache = { xml: null, builtAt: 0 };
};
