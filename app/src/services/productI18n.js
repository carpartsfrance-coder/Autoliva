'use strict';
/* Localisation des fiches produit (DE d'abord). Fonctions PURES — sans DB ni
 * Express — pour rester testables et réutilisables par la route /de/produits
 * ET le sitemap DE.
 *
 * Principe : l'allemand est un CALQUE sur la fiche FR. On ne sert la version
 * traduite que si `translatedAt` est posé ; sinon la route fait un 301 vers la
 * fiche FR (jamais de page à moitié traduite indexée). Si un champ donné n'est
 * pas traduit, on garde le FR pour CE champ → jamais de trou. */

const SUPPORTED_LANGS = ['de'];

function isSupportedLang(lang) {
  return SUPPORTED_LANGS.indexOf(lang) >= 0;
}

function getLoc(product, lang) {
  return (product && product.localizations && product.localizations[lang]) ? product.localizations[lang] : null;
}

const nonEmptyStr = (v) => typeof v === 'string' && v.trim() !== '';
const nonEmptyArr = (v) => Array.isArray(v) && v.length > 0;

/** Une traduction n'est "servable" que si translatedAt est posé. */
function isTranslated(product, lang) {
  const loc = getLoc(product, lang);
  return Boolean(loc && loc.translatedAt);
}

/** Slug à utiliser sous /<lang>/produits/… : slug localisé sinon slug FR. */
function localizedSlug(product, lang) {
  const loc = getLoc(product, lang);
  if (loc && nonEmptyStr(loc.slug)) return loc.slug.trim();
  return (product && product.slug) ? product.slug : '';
}

/**
 * Renvoie une COPIE de la fiche avec les champs rédactionnels traduits
 * superposés (NE MUTE PAS l'original). Seuls les champs traduits non vides
 * remplacent le FR. Les codes / compatibilités / prix restent ceux de la
 * fiche FR (jamais traduits).
 */
function localizeProduct(product, lang) {
  if (!product || !isSupportedLang(lang)) return product;
  const loc = getLoc(product, lang);
  if (!loc) return product;

  const base = typeof product.toObject === 'function' ? product.toObject() : product;
  const out = { ...base };

  if (nonEmptyStr(loc.name)) out.name = loc.name;
  if (nonEmptyStr(loc.shortDescription)) out.shortDescription = loc.shortDescription;
  if (nonEmptyStr(loc.description)) out.description = loc.description;
  if (nonEmptyArr(loc.keyPoints)) out.keyPoints = loc.keyPoints;
  if (nonEmptyArr(loc.inclusions)) out.inclusions = loc.inclusions;
  if (nonEmptyArr(loc.exclusions)) out.exclusions = loc.exclusions;
  if (nonEmptyArr(loc.specs)) out.specs = loc.specs;
  if (nonEmptyArr(loc.reconditioningSteps)) out.reconditioningSteps = loc.reconditioningSteps;
  if (nonEmptyArr(loc.faqs)) out.faqs = loc.faqs;
  if (loc.seo && (nonEmptyStr(loc.seo.metaTitle) || nonEmptyStr(loc.seo.metaDescription))) {
    out.seo = {
      ...(out.seo || {}),
      metaTitle: nonEmptyStr(loc.seo.metaTitle) ? loc.seo.metaTitle : ((out.seo && out.seo.metaTitle) || ''),
      metaDescription: nonEmptyStr(loc.seo.metaDescription) ? loc.seo.metaDescription : ((out.seo && out.seo.metaDescription) || ''),
    };
  }

  // Métadonnées utiles à la couche de rendu (canonical FR/DE, hreflang).
  out._lang = lang;
  out._frSlug = base.slug || '';
  out._localizedSlug = localizedSlug(product, lang);
  return out;
}

/** Chemin canonique FR d'une fiche (slug, sinon _id pour les fiches sans slug). */
function frProductPath(product) {
  const slug = (product && product.slug) ? product.slug : (product && product._id ? String(product._id) : '');
  return '/produits/' + encodeURIComponent(slug);
}

/** Chemin localisé d'une fiche (ex. /de/produits/<slug>). */
function localizedProductPath(product, lang) {
  return '/' + lang + '/produits/' + encodeURIComponent(localizedSlug(product, lang));
}

module.exports = {
  SUPPORTED_LANGS,
  isSupportedLang,
  isTranslated,
  localizeProduct,
  localizedSlug,
  frProductPath,
  localizedProductPath,
};
