const SiteSettings = require('../models/SiteSettings');
const brand = require('../config/brand');

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

module.exports = {
  buildEnvFallback,
  getSiteSettings,
  getSiteSettingsMergedWithFallback,
  updateSiteSettingsFromForm,
};
