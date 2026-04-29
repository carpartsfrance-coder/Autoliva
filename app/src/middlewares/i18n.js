'use strict';

const { t, buildHreflangSet, DEFAULT_LANG } = require('../services/i18n');

/**
 * i18n middleware — detects language from URL prefix.
 *
 * Sets:
 *   req.lang                      — 'fr' or 'en'
 *   res.locals.lang               — same, for templates
 *   res.locals.langPrefix         — '/en' or ''
 *   res.locals.alternateLangPrefix — opposite of langPrefix
 *   res.locals.currentPathWithoutLang — path stripped of /en prefix
 *   res.locals.t(key, params)     — bound translation function
 */
function i18nMiddleware(req, res, next) {
  const pathLower = req.path.toLowerCase();
  const isEnglish = pathLower === '/en' || pathLower.startsWith('/en/');

  req.lang = isEnglish ? 'en' : DEFAULT_LANG;
  res.locals.lang = req.lang;
  res.locals.langPrefix = req.lang === 'en' ? '/en' : '';
  res.locals.alternateLangPrefix = req.lang === 'en' ? '' : '/en';

  // Path without the /en prefix — used for building alternate-language URLs
  const rawPath = req.originalUrl || req.url || '/';
  if (isEnglish) {
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
