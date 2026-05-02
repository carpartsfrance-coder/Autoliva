const mongoose = require('mongoose');
const SiteSettings = require('../models/SiteSettings');
const Product = require('../models/Product');
const brand = require('../config/brand');

const FEATURED_PRODUCTS_LIMIT = 4;

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : value ? String(value).trim() : '';
}

function getSafeUrl(value) {
  const input = getTrimmedString(value);
  if (!input) return '';
  if (!/^https?:\/\//i.test(input)) return '';
  return input;
}

function buildEnvFallback() {
  return {
    promoBannerText: getTrimmedString(process.env.PROMO_BANNER_TEXT) || '',
    promoBannerCode: getTrimmedString(process.env.PROMO_BANNER_CODE) || '',
    aboutTitle: getTrimmedString(process.env.HOME_ABOUT_TITLE) || 'Notre histoire',
    aboutText:
      getTrimmedString(process.env.HOME_ABOUT_TEXT)
      || `${brand.NAME} accompagne particuliers et professionnels avec des pièces testées, des conseils précis et un suivi humain pour trouver la bonne référence rapidement.`,
    facebookUrl: getSafeUrl(process.env.SOCIAL_FACEBOOK_URL),
    instagramUrl: getSafeUrl(process.env.SOCIAL_INSTAGRAM_URL),
    youtubeUrl: getSafeUrl(process.env.SOCIAL_YOUTUBE_URL),
  };
}

let cached = null;
let cachedAt = 0;
const CACHE_TTL_MS = 30 * 1000;

async function getSiteSettings() {
  const doc = await SiteSettings.findOne({ key: 'site' }).lean();
  return doc || null;
}

async function getSiteSettingsMergedWithFallback({ bypassCache = false } = {}) {
  const fallback = buildEnvFallback();
  const now = Date.now();

  if (!bypassCache && cached && now - cachedAt < CACHE_TTL_MS) {
    return cached;
  }

  try {
    const saved = await getSiteSettings();
    if (!saved) {
      cached = fallback;
      cachedAt = now;
      return fallback;
    }

    const merged = {
      promoBannerText: saved.promoBannerText || '',
      promoBannerCode: saved.promoBannerCode || '',
      aboutTitle: saved.aboutTitle || fallback.aboutTitle,
      aboutText: saved.aboutText || fallback.aboutText,
      facebookUrl: getSafeUrl(saved.facebookUrl) || fallback.facebookUrl,
      instagramUrl: getSafeUrl(saved.instagramUrl) || fallback.instagramUrl,
      youtubeUrl: getSafeUrl(saved.youtubeUrl) || fallback.youtubeUrl,
    };

    cached = merged;
    cachedAt = now;
    return merged;
  } catch (err) {
    cached = fallback;
    cachedAt = now;
    return fallback;
  }
}

function sanitizeForm(body) {
  const b = body && typeof body === 'object' ? body : {};
  return {
    promoBannerText: getTrimmedString(b.promoBannerText),
    promoBannerCode: getTrimmedString(b.promoBannerCode),
    aboutTitle: getTrimmedString(b.aboutTitle),
    aboutText: getTrimmedString(b.aboutText),
    facebookUrl: getSafeUrl(b.facebookUrl),
    instagramUrl: getSafeUrl(b.instagramUrl),
    youtubeUrl: getSafeUrl(b.youtubeUrl),
  };
}

async function updateSiteSettingsFromForm(body) {
  const data = sanitizeForm(body);

  const updated = await SiteSettings.findOneAndUpdate(
    { key: 'site' },
    { $set: { key: 'site', ...data } },
    { new: true, upsert: true }
  ).lean();

  cached = {
    promoBannerText: updated && updated.promoBannerText ? updated.promoBannerText : '',
    promoBannerCode: updated && updated.promoBannerCode ? updated.promoBannerCode : '',
    aboutTitle: updated && updated.aboutTitle ? updated.aboutTitle : buildEnvFallback().aboutTitle,
    aboutText: updated && updated.aboutText ? updated.aboutText : buildEnvFallback().aboutText,
    facebookUrl: updated && updated.facebookUrl ? getSafeUrl(updated.facebookUrl) : '',
    instagramUrl: updated && updated.instagramUrl ? getSafeUrl(updated.instagramUrl) : '',
    youtubeUrl: updated && updated.youtubeUrl ? getSafeUrl(updated.youtubeUrl) : '',
  };
  cachedAt = Date.now();

  return updated;
}

// ────────────────────────────────────────────────────────────────────────────
// Hero slides
// ────────────────────────────────────────────────────────────────────────────

/**
 * Slides par défaut (utilisées si l'admin n'a rien configuré en DB).
 * Brand-aware via brand.NAME.
 */
function getDefaultHeroSlides() {
  return [
    {
      imageUrl: '/images/hero-home.png',
      imageAlt: brand.NAME,
      badge: 'Service Premium',
      title: 'Pièces auto reconditionnées, d’occasion et testées',
      description: `${brand.NAME} accompagne particuliers et professionnels avec des pièces fiables, un devis rapide et une livraison express en 48/72h.`,
      ctaPrimaryText: 'Demander un Devis Gratuit',
      ctaPrimaryUrl: '/devis',
      ctaSecondaryText: 'Parcourir le catalogue',
      ctaSecondaryUrl: '/produits',
      sortOrder: 0,
      isActive: true,
    },
    {
      imageUrl: '/images/hero-boite-transfert.jpeg',
      imageAlt: 'Boîte de transfert et pont différentiel reconditionnés',
      badge: 'Transmission',
      title: 'Boîtes de transfert & ponts différentiels reconditionnés',
      description: 'Notre gamme reconditionnée est testée et garantie 2 ans, pour une fiabilité maximale.',
      ctaPrimaryText: 'Demander un Devis Gratuit',
      ctaPrimaryUrl: '/devis',
      ctaSecondaryText: 'Parcourir le catalogue',
      ctaSecondaryUrl: '/produits',
      sortOrder: 1,
      isActive: true,
    },
    {
      imageUrl: '/images/hero-moteur-reconditionne.jpeg',
      imageAlt: 'Moteurs reconditionnés',
      badge: 'Moteur',
      title: 'Moteurs reconditionnés : performance & sérénité',
      description: 'Porsche, Range Rover, BMW… des moteurs testés et reconditionnés avec exigence, disponibles rapidement.',
      ctaPrimaryText: 'Demander un Devis Gratuit',
      ctaPrimaryUrl: '/devis',
      ctaSecondaryText: 'Parcourir le catalogue',
      ctaSecondaryUrl: '/produits',
      sortOrder: 2,
      isActive: true,
    },
  ];
}

function sanitizeHeroSlide(s) {
  const o = s && typeof s === 'object' ? s : {};
  return {
    imageUrl: getTrimmedString(o.imageUrl),
    imageAlt: getTrimmedString(o.imageAlt),
    badge: getTrimmedString(o.badge),
    title: getTrimmedString(o.title),
    description: getTrimmedString(o.description),
    ctaPrimaryText: getTrimmedString(o.ctaPrimaryText),
    ctaPrimaryUrl: getTrimmedString(o.ctaPrimaryUrl),
    ctaSecondaryText: getTrimmedString(o.ctaSecondaryText),
    ctaSecondaryUrl: getTrimmedString(o.ctaSecondaryUrl),
    sortOrder: Number.isFinite(Number(o.sortOrder)) ? Number(o.sortOrder) : 0,
    isActive: o.isActive === false || o.isActive === 'false' || o.isActive === '0' ? false : true,
  };
}

function sanitizeHeroSlidesArray(slides) {
  if (!Array.isArray(slides)) return [];
  return slides
    .map(sanitizeHeroSlide)
    .filter((s) => s.imageUrl || s.title || s.description) // garder seulement les slides utiles
    .sort((a, b) => a.sortOrder - b.sortOrder);
}

/**
 * Retourne les hero slides à afficher (DB si présent et non vide, sinon defaults).
 * Filtre les slides inactives.
 */
async function getHeroSlidesForDisplay() {
  try {
    const saved = await getSiteSettings();
    const dbSlides = saved && Array.isArray(saved.heroSlides) ? saved.heroSlides : [];
    const activeFromDb = dbSlides
      .filter((s) => s && s.isActive !== false && (s.imageUrl || s.title))
      .sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    if (activeFromDb.length > 0) return activeFromDb.map(sanitizeHeroSlide);
    return getDefaultHeroSlides();
  } catch (err) {
    return getDefaultHeroSlides();
  }
}

/**
 * Retourne les slides côté admin (toutes, y compris inactives, dans l'ordre actuel).
 * Si la DB est vide, retourne les defaults pour seed initial.
 */
async function getHeroSlidesForAdmin() {
  try {
    const saved = await getSiteSettings();
    const dbSlides = saved && Array.isArray(saved.heroSlides) ? saved.heroSlides : [];
    if (dbSlides.length > 0) {
      return dbSlides
        .map((s) => ({
          _id: s._id ? String(s._id) : '',
          ...sanitizeHeroSlide(s),
        }))
        .sort((a, b) => a.sortOrder - b.sortOrder);
    }
    // Premier accès : on retourne les defaults (l'admin pourra les éditer/sauvegarder)
    return getDefaultHeroSlides().map((s) => ({ _id: '', ...s }));
  } catch (err) {
    return getDefaultHeroSlides().map((s) => ({ _id: '', ...s }));
  }
}

async function updateHeroSlides(slides) {
  const sanitized = sanitizeHeroSlidesArray(slides);
  // Réassigne les sortOrder en fonction de la position du tableau pour avoir un ordre cohérent
  const ordered = sanitized.map((s, idx) => ({ ...s, sortOrder: idx }));

  const updated = await SiteSettings.findOneAndUpdate(
    { key: 'site' },
    { $set: { key: 'site', heroSlides: ordered } },
    { new: true, upsert: true }
  ).lean();

  return updated && Array.isArray(updated.heroSlides) ? updated.heroSlides : [];
}

// ────────────────────────────────────────────────────────────────────────────
// Produits vedette (section "Découvrez Nos Pièces" sur la home)
// ────────────────────────────────────────────────────────────────────────────

function sanitizeFeaturedIds(rawIds) {
  if (!Array.isArray(rawIds)) return [];
  const seen = new Set();
  const result = [];
  for (const v of rawIds) {
    const id = typeof v === 'string' ? v.trim() : v && v.toString ? v.toString() : '';
    if (!id) continue;
    if (!mongoose.Types.ObjectId.isValid(id)) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    if (result.length >= FEATURED_PRODUCTS_LIMIT) break;
  }
  return result;
}

async function getFeaturedProductIds() {
  const saved = await getSiteSettings();
  const ids = saved && Array.isArray(saved.featuredProductIds) ? saved.featuredProductIds : [];
  return sanitizeFeaturedIds(ids.map((id) => (id ? String(id) : '')));
}

async function updateFeaturedProductIds(rawIds) {
  const ids = sanitizeFeaturedIds(rawIds);
  const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));

  const updated = await SiteSettings.findOneAndUpdate(
    { key: 'site' },
    { $set: { key: 'site', featuredProductIds: objectIds } },
    { new: true, upsert: true }
  ).lean();

  return updated && Array.isArray(updated.featuredProductIds)
    ? updated.featuredProductIds.map((id) => String(id))
    : [];
}

/**
 * Retourne les produits vedette à afficher sur la home, dans l'ordre choisi.
 * Si moins de FEATURED_PRODUCTS_LIMIT sont configurés, complète avec les
 * produits récemment mis à jour. Si rien n'est configuré du tout, fallback
 * complet sur les produits récents (comportement historique).
 */
async function getFeaturedProductsForDisplay() {
  const ids = await getFeaturedProductIds();

  if (!ids.length) {
    return Product.find({}).sort({ updatedAt: -1 }).limit(FEATURED_PRODUCTS_LIMIT).lean();
  }

  const objectIds = ids.map((id) => new mongoose.Types.ObjectId(id));
  const found = await Product.find({ _id: { $in: objectIds } }).lean();
  const byId = new Map(found.map((p) => [String(p._id), p]));
  const ordered = ids.map((id) => byId.get(id)).filter(Boolean);

  if (ordered.length >= FEATURED_PRODUCTS_LIMIT) {
    return ordered.slice(0, FEATURED_PRODUCTS_LIMIT);
  }

  const missing = FEATURED_PRODUCTS_LIMIT - ordered.length;
  const excludeIds = ordered.map((p) => p._id).filter(Boolean);
  const fillers = await Product.find({ _id: { $nin: excludeIds } })
    .sort({ updatedAt: -1 })
    .limit(missing)
    .lean();

  return ordered.concat(fillers);
}

/**
 * Retourne les slots côté admin : exactement FEATURED_PRODUCTS_LIMIT slots,
 * chaque slot étant soit un produit (avec id, name, sku, imageUrl) soit null.
 * Plus la liste de tous les produits du catalogue pour le picker.
 */
async function getFeaturedProductsForAdmin() {
  const [ids, allProducts] = await Promise.all([
    getFeaturedProductIds(),
    Product.find({})
      .select('_id name sku brand imageUrl')
      .sort({ name: 1 })
      .lean(),
  ]);

  const byId = new Map(allProducts.map((p) => [String(p._id), p]));
  const slots = [];
  for (let i = 0; i < FEATURED_PRODUCTS_LIMIT; i += 1) {
    const id = ids[i] || '';
    const product = id ? byId.get(id) : null;
    slots.push({
      position: i + 1,
      productId: id || '',
      product: product
        ? {
            id: String(product._id),
            name: product.name || '',
            sku: product.sku || '',
            brand: product.brand || '',
            imageUrl: product.imageUrl || '',
          }
        : null,
    });
  }

  const productOptions = allProducts.map((p) => ({
    id: String(p._id),
    name: p.name || '',
    sku: p.sku || '',
    brand: p.brand || '',
    imageUrl: p.imageUrl || '',
  }));

  return { slots, productOptions, limit: FEATURED_PRODUCTS_LIMIT };
}

module.exports = {
  buildEnvFallback,
  getSiteSettings,
  getSiteSettingsMergedWithFallback,
  updateSiteSettingsFromForm,
  // Hero slides
  getDefaultHeroSlides,
  getHeroSlidesForDisplay,
  getHeroSlidesForAdmin,
  updateHeroSlides,
  sanitizeHeroSlide,
  // Featured products
  FEATURED_PRODUCTS_LIMIT,
  getFeaturedProductIds,
  updateFeaturedProductIds,
  getFeaturedProductsForDisplay,
  getFeaturedProductsForAdmin,
};
