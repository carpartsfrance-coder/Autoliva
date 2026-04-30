'use strict';

const { t, DEFAULT_LANG } = require('../services/i18n');

/**
 * i18n middleware — detects language from URL prefix.
 *
 * Sets:
 *   req.lang                      — 'fr' | 'en' | 'de'
 *   res.locals.lang               — same, for templates
 *   res.locals.langPrefix         — '/de' or '' (FR par défaut, EN désactivé)
 *   res.locals.alternateLangPrefix — préfixe de la langue alternative
 *   res.locals.currentPathWithoutLang — path stripped of /de or /en prefix
 *   res.locals.t(key, params)     — bound translation function
 */
function i18nMiddleware(req, res, next) {
  const pathLower = req.path.toLowerCase();
  const isGerman  = pathLower === '/de' || pathLower.startsWith('/de/');
  const isEnglish = pathLower === '/en' || pathLower.startsWith('/en/');

  req.lang = isGerman ? 'de' : (isEnglish ? 'en' : DEFAULT_LANG);
  res.locals.lang = req.lang;

  if (isGerman) {
    res.locals.langPrefix = '/de';
    res.locals.alternateLangPrefix = '';
  } else if (isEnglish) {
    res.locals.langPrefix = '/en';
    res.locals.alternateLangPrefix = '';
  } else {
    res.locals.langPrefix = '';
    res.locals.alternateLangPrefix = '/de';
  }

  // Path without the /xx prefix — used for building alternate-language URLs
  const rawPath = req.originalUrl || req.url || '/';
  if (isGerman) {
    const stripped = rawPath.replace(/^\/de(\/|$)/, '/$1').replace(/^\/\//, '/');
    res.locals.currentPathWithoutLang = stripped || '/';
  } else if (isEnglish) {
    const stripped = rawPath.replace(/^\/en(\/|$)/, '/$1').replace(/^\/\//, '/');
    res.locals.currentPathWithoutLang = stripped || '/';
  } else {
    res.locals.currentPathWithoutLang = rawPath;
  }

  // Bound translation function for EJS templates
  res.locals.t = (key, params) => t(req.lang, key, params);

  next();
}

module.exports = i18nMiddleware;
