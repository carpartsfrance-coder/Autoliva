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

/* Appels de données lancés PAR une page (sélecteur de véhicule, autocomplétion
   du header) : jamais une page que le visiteur lit. */
const CHEMINS_DONNEES = /^(?:\/de)?(?:\/api(?:\/|$)|\/rechercher\/suggest(?:\/|$))/;

/**
 * La requête est-elle une VRAIE navigation vers une page HTML ?
 *
 * Seules celles-ci fixent la langue mémorisée. La page d'accueil /de lance
 * d'elle-même GET /api/vehicules, et l'autocomplétion GET /rechercher/suggest :
 * ces URL françaises remettaient « fr », et le panier, le paiement, Order.lang
 * et les e-mails d'un acheteur allemand repassaient en français sans qu'il ait
 * quitté l'allemand.
 *
 * Un navigateur récent envoie ses métadonnées au complet : Sec-Fetch-Mode:
 * navigate + Sec-Fetch-Dest: document pour la page principale, « cors » /
 * « empty » pour un fetch(). On ne s'y fie que si Sec-Fetch-Dest est présent :
 * un client HTTP qui n'envoie que Sec-Fetch-Mode (le fetch de Node pose
 * « cors » d'office, sans Dest) n'est pas un navigateur et relève de la règle
 * suivante. Les navigateurs anciens n'envoient rien : un fetch() y garde un
 * Accept sans text/html, ou le X-Requested-With de nos scripts. Un Accept
 * ABSENT ne vient pas d'un navigateur (script, robot) : on le laisse passer,
 * la règle robot plus bas s'applique toujours.
 */
function estNavigationHtml(req, pathLower) {
  if (CHEMINS_DONNEES.test(pathLower)) return false;
  const h = req.headers || {};
  const destination = String(h['sec-fetch-dest'] || '').trim().toLowerCase();
  if (destination) {
    if (destination !== 'document') return false;
    const mode = String(h['sec-fetch-mode'] || '').trim().toLowerCase();
    if (mode && mode !== 'navigate') return false;
  }
  if (h['x-requested-with']) return false;
  /* Préchargement spéculatif (<link rel=prefetch>, Chrome) : le visiteur n'a
     pas encore ouvert la page. */
  const intention = String(h['sec-purpose'] || h.purpose || '').toLowerCase();
  if (intention.includes('prefetch')) return false;
  if (typeof h.accept === 'string' && h.accept.trim() && !/text\/html/i.test(h.accept)) return false;
  return true;
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
  //   - On EXCLUT le tunnel lui-même (/panier, /commande, /compte) : il SUIT la
  //     préférence, il ne la fixe pas (sinon on ne pourrait jamais la changer).
  //   - On EXCLUT les POST (un add-to-cart en URL FR ne doit pas changer la langue).
  // Avant, on ne posait que 'de' sans jamais réinitialiser : un visiteur FR ayant
  // consulté une page /de restait bloqué en ALLEMAND au panier (bug corrigé ici).
  /* Tout l'espace compte suit aussi la préférence (ni il la fixe, ni il la
     remet). Le bouton « Zur Kasse » menait à /compte/connexion, et les liens
     « Konto » / « Bestellung verfolgen » des pages /de à /compte… (301 depuis
     /de/compte…) : ces URL FR remettaient « fr », et toute la commande
     allemande — paiement Mollie et e-mails compris — basculait en français. */
  const inCheckoutTunnel = pathLower === '/panier' || pathLower.startsWith('/panier/')
    || pathLower === '/commande' || pathLower.startsWith('/commande/')
    || pathLower === '/compte' || pathLower.startsWith('/compte/');
  /* Le sélecteur FR/DE du header s'en sert : sur ces pages, l'URL ne dit pas
     la langue, il faut la choisir explicitement (?lang=). */
  res.locals.langFollowsPreference = inCheckoutTunnel;

  /* Choix EXPLICITE (?lang=fr|de, sélecteur de langue) : seule façon de changer
     de langue depuis le tunnel ou le compte, qui ne la fixent plus. Sans lui,
     un visiteur français resté en « de » ne pouvait plus sortir de l'allemand
     sur la connexion ou le panier. Prioritaire sur la règle du chemin. */
  const langDemandee = req.query && typeof req.query.lang === 'string' ? req.query.lang.trim().toLowerCase() : '';
  const choixExplicite = langDemandee === 'de' || langDemandee === 'fr' ? langDemandee : '';
  /* Ni le choix explicite ni la règle du chemin ne s'appliquent à un appel de
     données (voir estNavigationHtml). */
  const navigation = req.method === 'GET' && estNavigationHtml(req, pathLower);

  if (req.session && navigation && choixExplicite) {
    /* Même règle anti-sessions vides que plus bas : « fr » n'est écrit que si
       une autre valeur existait, « de » jamais pour un robot. */
    if (choixExplicite === 'de') {
      if (req.session.preferredLang !== 'de' && !estRobot(req.headers && req.headers['user-agent'])) {
        req.session.preferredLang = 'de';
      }
    } else if (req.session.preferredLang !== undefined && req.session.preferredLang !== 'fr') {
      req.session.preferredLang = 'fr';
    }
  } else if (req.session && navigation) {
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

  /* Lien vers une page qui N'EXISTE QU'EN FRANÇAIS (sécurité, suivi SAV…)
     depuis une page rendue en allemand. Sans ?lang=de, le GET de cette page
     française remettait la session en « fr » : le panier, le paiement,
     Order.lang et les e-mails d'un acheteur allemand basculaient parce qu'il
     avait ouvert « So erkennen Sie uns ». Lue à l'appel : le tunnel rebinde
     res.locals.lang après ce middleware (services/i18n.js, applyCheckoutLocale).
     Même règle que les redirections (services/i18n.js) : un ROBOT voit l'URL
     nue, sans paramètre à explorer — le plan de reprise SEO compte les URL
     qu'on donne à Google, et celle-ci n'apporte rien. */
  const robotIci = estRobot(req.headers && req.headers['user-agent']);
  res.locals.lienFr = (url) => {
    const chemin = String(url || '');
    if (robotIci || res.locals.lang !== 'de' || !chemin.startsWith('/')) return chemin;
    return chemin + (chemin.includes('?') ? '&' : '?') + 'lang=de';
  };

  /* Langue du tunnel pour le sélecteur FR/DE du header : sur une page de compte
     restée en français (profil, adresses, factures…), la page ne dit pas la
     langue de session. Le header affichait « FR » actif et un lien FR sans
     ?lang=fr alors que le panier était déjà en allemand : impossible d'en
     sortir depuis ces pages. Lue APRÈS la mise à jour ci-dessus. */
  res.locals.tunnelLang = (req.session && req.session.preferredLang === 'de') ? 'de' : 'fr';

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
module.exports.estNavigationHtml = estNavigationHtml;
