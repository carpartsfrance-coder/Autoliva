'use strict';

const { t, DEFAULT_LANG } = require('../services/i18n');
const { estRobot } = require('../services/robots');

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

  // Mémorise la langue de la DERNIÈRE PAGE DE CONTENU visitée (GET), pour que le
  // TUNNEL d'achat (panier + checkout, servis sur des URLs FR) s'affiche dans
  // cette langue. Bidirectionnel : /de/… → 'de', page FR → 'fr'.
  //   - On EXCLUT le tunnel lui-même (/panier, /commande) : il SUIT la
  //     préférence, il ne la fixe pas (sinon on ne pourrait jamais la changer).
  //   - On EXCLUT les POST (un add-to-cart en URL FR ne doit pas changer la langue).
  // Avant, on ne posait que 'de' sans jamais réinitialiser : un visiteur FR ayant
  // consulté une page /de restait bloqué en ALLEMAND au panier (bug corrigé ici).
  if (req.session && req.method === 'GET') {
    const inCheckoutTunnel = pathLower === '/panier' || pathLower.startsWith('/panier/')
      || pathLower === '/commande' || pathLower.startsWith('/commande/');
    if (!inCheckoutTunnel) {
      /* N'écrire QUE si la valeur change. Écrire « fr » (le défaut) dans une
       * session vierge suffisait à la persister 30 jours en base pour chaque
       * visiteur, robot compris : c'était, avec `accountType`, la cause des
       * 1,9 million de sessions dont 92 % vides (diagnostic du 08/2026).
       * Le tunnel lit déjà `preferredLang === 'de' ? 'de' : 'fr'`
       * (services/i18n.js) : une valeur absente vaut « fr ». */
      if (isGerman) {
        /* Jamais pour un ROBOT (plan de reprise SEO du 14/09/2026, action
         * A4.7). Un robot n'envoie pas de cookie : chaque page /de qu'il
         * lisait — Googlebot compris — créait une session de 30 jours dans
         * MongoDB, pour une langue de tunnel qu'il n'atteindra jamais. Or
         * Google a exploré 17 000 pages allemandes le 09/09. La règle porte
         * sur le User-Agent déclaré (services/robots.js, la même liste que
         * les statistiques) : un faux Googlebot n'a pas plus besoin de session
         * que le vrai. Les visiteurs humains ne changent pas : langue du
         * tunnel, gclid, panier invité et jointures d'audience restent. */
        if (req.session.preferredLang !== 'de' && !estRobot(req.headers && req.headers['user-agent'])) {
          req.session.preferredLang = 'de';
        }
      } else if (!isEnglish) {
        if (req.session.preferredLang !== undefined && req.session.preferredLang !== 'fr') {
          req.session.preferredLang = 'fr';
        }
      }
    }
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
