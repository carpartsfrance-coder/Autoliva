'use strict';

const { t, DEFAULT_LANG } = require('../services/i18n');

/** Langue préférée du navigateur (1er tag d'Accept-Language). Ex.
 *  "de-DE,de;q=0.9,en;q=0.8" → "de". Sert UNIQUEMENT à proposer (jamais à
 *  rediriger) — Accept-Language reflète le réglage de langue de l'utilisateur,
 *  bien plus pertinent que l'IP pour une question de langue. */
function primaryAcceptLanguage(header) {
  if (!header || typeof header !== 'string') return '';
  const first = header.split(',')[0].trim().toLowerCase();
  return first.split(/[-;]/)[0];
}

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

  // Bannière de suggestion de langue (douce, jamais de redirection) :
  //   browserLangPref  — langue préférée du navigateur (pour proposer)
  //   langSuggestHidden — l'utilisateur a déjà fermé/choisi (cookie) → on se tait
  res.locals.browserLangPref = primaryAcceptLanguage(req.headers['accept-language']);
  res.locals.langSuggestHidden = /(?:^|;\s*)hideLangSuggest=1(?:;|$)/.test(req.headers.cookie || '');

  next();
}

module.exports = i18nMiddleware;
