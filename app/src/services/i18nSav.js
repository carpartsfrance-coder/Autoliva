/*
 * i18n SAV — vanilla, sans dépendance.
 *
 * - Charge les locales depuis app/src/locales/sav.{lang}.json au démarrage.
 * - Expose t(key, locale) qui supporte les clés en notation pointée :
 *     t('step2.title', 'fr') → "Votre pièce et son montage"
 * - resolveLocale(req) regarde dans l'ordre :
 *     1. req.query.lang (?lang=en)
 *     2. req.session.savLocale (sticky)
 *     3. cookie 'lang'
 *     4. Accept-Language
 *     5. fallback 'fr'
 * - middleware() : injecte req.savLocale, res.locals.savLocale, res.locals.tSav.
 */

const fs = require('fs');
const path = require('path');
const brand = require('../config/brand');

const LOCALES_DIR = path.join(__dirname, '..', 'locales');
const SUPPORTED = ['fr', 'en'];
const FALLBACK = 'fr';

const dictionaries = {};
SUPPORTED.forEach((lang) => {
  try {
    const file = path.join(LOCALES_DIR, `sav.${lang}.json`);
    if (fs.existsSync(file)) {
      dictionaries[lang] = JSON.parse(fs.readFileSync(file, 'utf-8'));
    } else {
      dictionaries[lang] = {};
    }
  } catch (e) {
    console.error('[i18nSav] failed to load', lang, e.message);
    dictionaries[lang] = {};
  }
});

function getByPath(obj, dotted) {
  if (!obj || !dotted) return undefined;
  return dotted.split('.').reduce(function (acc, k) {
    return acc && acc[k] != null ? acc[k] : undefined;
  }, obj);
}

function t(key, locale, params) {
  var lang = SUPPORTED.indexOf(locale) >= 0 ? locale : FALLBACK;
  var v = getByPath(dictionaries[lang], key);
  if (v == null && lang !== FALLBACK) {
    v = getByPath(dictionaries[FALLBACK], key);
  }
  if (v == null) return key; // dernière option : retourner la clé pour debug
  if (typeof v !== 'string') return v;
  var merged = Object.assign({ brandName: brand.NAME }, params && typeof params === 'object' ? params : {});
  Object.keys(merged).forEach(function (k) {
    v = v.replace(new RegExp('%' + k + '%', 'g'), String(merged[k]));
  });
  return v;
}

function resolveLocale(req) {
  if (req.query && req.query.lang && SUPPORTED.indexOf(req.query.lang) >= 0) {
    if (req.session) req.session.savLocale = req.query.lang;
    return req.query.lang;
  }
  if (req.session && req.session.savLocale && SUPPORTED.indexOf(req.session.savLocale) >= 0) {
    return req.session.savLocale;
  }
  if (req.cookies && req.cookies.lang && SUPPORTED.indexOf(req.cookies.lang) >= 0) {
    return req.cookies.lang;
  }
  var al = (req.headers && req.headers['accept-language']) || '';
  var first = al.split(',')[0].slice(0, 2).toLowerCase();
  if (SUPPORTED.indexOf(first) >= 0) return first;
  return FALLBACK;
}

function middleware() {
  return function (req, res, next) {
    var loc = resolveLocale(req);
    req.savLocale = loc;
    res.locals.savLocale = loc;
    res.locals.savSupportedLocales = SUPPORTED;
    res.locals.tSav = function (key, params) { return t(key, loc, params); };
    next();
  };
}

module.exports = { t, resolveLocale, middleware, SUPPORTED, FALLBACK };
