'use strict';

const fr = require('../locales/fr.json');
const en = require('../locales/en.json');
const brand = require('../config/brand');

const dictionaries = { fr, en };
const SUPPORTED_LANGS = ['fr', 'en'];
const DEFAULT_LANG = 'fr';

/**
 * Translate a key for the given language.
 * Falls back to French if key is missing in the target language.
 * Supports %param% interpolation. `%brandName%` is auto-injected from
 * the active brand config; callers can override by passing brandName in params.
 */
function t(lang, key, params) {
  const dict = dictionaries[lang] || dictionaries[DEFAULT_LANG];
  let value = dict[key] || dictionaries[DEFAULT_LANG][key] || key;
  const merged = { brandName: brand.NAME, ...(params && typeof params === 'object' ? params : {}) };
  for (const [k, v] of Object.entries(merged)) {
    value = value.replace(new RegExp(`%${k}%`, 'g'), String(v));
  }
  return value;
}

/**
 * Build hreflang URLs for a given page path (without language prefix).
 * @param {string} baseUrl - e.g. "https://carpartsfrance.fr"
 * @param {string} pathWithoutLang - e.g. "/produits" or "/product/slug/"
 * @returns {{ hreflangFr: string, hreflangEn: string, hreflangDefault: string }}
 */
function buildHreflangSet(baseUrl, pathWithoutLang) {
  const base = baseUrl || '';
  const path = pathWithoutLang || '/';
  const normalizedPath = path.startsWith('/') ? path : `/${path}`;

  return {
    hreflangFr: `${base}${normalizedPath}`,
    hreflangEn: `${base}/en${normalizedPath === '/' ? '' : normalizedPath}`,
    hreflangDefault: `${base}${normalizedPath}`,
  };
}

module.exports = { t, buildHreflangSet, SUPPORTED_LANGS, DEFAULT_LANG };
