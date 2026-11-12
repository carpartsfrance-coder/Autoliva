'use strict';

const crypto = require('crypto');
const AttributionTouch = require('../models/AttributionTouch');
const { classifyReferrer, isBotUserAgent, refererHost } = require('../services/sourceVisite');

const QUERY_PARAMS = [
  'gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid',
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_content', 'utm_term',
];

const COOKIE_LAST = 'cpf_attr';
const COOKIE_FIRST = 'cpf_attr_first';
const COOKIE_MAX_AGE_S = 90 * 24 * 60 * 60; // 90 jours

const MAX_FIELD_LEN = 256;
const MAX_PATH_LEN = 500;

function trim(value, max = MAX_FIELD_LEN) {
  if (typeof value !== 'string') return '';
  return value.length > max ? value.slice(0, max) : value;
}

function shouldCapture(req) {
  if (req.method !== 'GET') return false;
  const accept = String(req.headers.accept || '');
  if (!accept.includes('text/html')) return false;
  const p = req.path || '';
  if (/^\/(media|uploads|sav-files|api|admin\/api|css|js|images|favicon|robots|sitemap)/i.test(p)) return false;
  if (/\.(css|js|map|ico|png|jpe?g|gif|svg|webp|woff2?|ttf|pdf|xml|txt|json)$/i.test(p)) return false;
  return true;
}

function extractFromQuery(query) {
  if (!query || typeof query !== 'object') return null;
  let hasAny = false;
  const out = {};
  for (const key of QUERY_PARAMS) {
    const raw = query[key];
    if (typeof raw === 'string' && raw.length > 0) {
      out[key] = trim(raw);
      hasAny = true;
    }
  }
  return hasAny ? out : null;
}

function normalize(extracted) {
  return {
    gclid: extracted.gclid || '',
    gbraid: extracted.gbraid || '',
    wbraid: extracted.wbraid || '',
    fbclid: extracted.fbclid || '',
    msclkid: extracted.msclkid || '',
    utmSource: extracted.utm_source || '',
    utmMedium: extracted.utm_medium || '',
    utmCampaign: extracted.utm_campaign || '',
    utmContent: extracted.utm_content || '',
    utmTerm: extracted.utm_term || '',
  };
}

function hashIp(ip) {
  if (!ip) return '';
  return crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 32);
}

// Cookie léger : juste les champs utiles côté client / au checkout.
function buildCookiePayload(touch) {
  return {
    gclid: touch.gclid || '',
    gbraid: touch.gbraid || '',
    wbraid: touch.wbraid || '',
    fbclid: touch.fbclid || '',
    msclkid: touch.msclkid || '',
    utmSource: touch.utmSource || '',
    utmMedium: touch.utmMedium || '',
    utmCampaign: touch.utmCampaign || '',
    utmContent: touch.utmContent || '',
    utmTerm: touch.utmTerm || '',
    landingPath: touch.landingPath || '',
    referrer: touch.referrer || '',
    capturedAt: touch.capturedAt instanceof Date ? touch.capturedAt.toISOString() : String(touch.capturedAt || ''),
  };
}

function readCookie(req, name) {
  const raw = req && req.headers && req.headers.cookie;
  if (typeof raw !== 'string' || !raw) return null;
  const parts = raw.split(';');
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const k = part.slice(0, eq).trim();
    if (k !== name) continue;
    const v = part.slice(eq + 1).trim();
    try {
      return JSON.parse(decodeURIComponent(v));
    } catch (_) {
      return null;
    }
  }
  return null;
}

// Extrait le client_id GA4 depuis le cookie _ga (format: GA1.1.1234567890.1700000000).
function readGaClientId(req) {
  const raw = req && req.headers && req.headers.cookie;
  if (typeof raw !== 'string' || !raw) return '';
  const m = raw.match(/_ga=GA\d+\.\d+\.(\d+\.\d+)/);
  return m ? m[1] : '';
}

function writeCookie(res, name, value, { maxAgeS = COOKIE_MAX_AGE_S, httpOnly = false } = {}) {
  const isProd = process.env.NODE_ENV === 'production';
  const payload = encodeURIComponent(JSON.stringify(value));
  if (payload.length > 3500) return; // garde-fou taille cookie
  const parts = [
    `${name}=${payload}`,
    `Max-Age=${maxAgeS}`,
    'Path=/',
    'SameSite=Lax',
  ];
  if (isProd) parts.push('Secure');
  // cpf_attr / cpf_attr_first : volontairement PAS HttpOnly, le snippet
  // client les lit en backup. Données non sensibles (pas de PII, pas d'auth).
  if (httpOnly) parts.push('HttpOnly');
  res.append('Set-Cookie', parts.join('; '));
}

function clearCookie(res, name) {
  const isProd = process.env.NODE_ENV === 'production';
  res.append('Set-Cookie', [`${name}=`, 'Max-Age=0', 'Path=/', 'SameSite=Lax', ...(isProd ? ['Secure'] : []), 'HttpOnly'].join('; '));
}

// Une visite sans gclid ni utm est-elle une ARRIVÉE à enregistrer ?
// Oui si elle vient d'un moteur de recherche, d'un assistant IA ou d'un autre
// site. Non pour la navigation interne, les retours de paiement, les visites
// sans référent (impossible de distinguer un humain d'un robot, et chaque
// enregistrement créerait une session en base — cf. le diagnostic des
// « sessions fantômes » d'août 2026 dans app.js), les robots déclarés et les
// pages chargées dans un cadre (iframe) d'un autre site.
function isUnmarkedArrival(req) {
  const dest = String(req.headers['sec-fetch-dest'] || '').toLowerCase();
  if (dest && dest !== 'document') return false;
  const kind = classifyReferrer(String(req.headers.referer || ''), req.hostname || '');
  if (kind !== 'organic' && kind !== 'ai' && kind !== 'referral') return false;
  return !isBotUserAgent(String(req.headers['user-agent'] || ''));
}

/* ── Visites gratuites : comptées seulement quand le navigateur revient ──
 *
 * Diagnostic du 08/11/2026, une heure après la mise en ligne du comptage des
 * visites gratuites : 101 visites « Google gratuit » comptées en une heure,
 * contre ~10 clics par heure dans Search Console et 14 sessions Google vues
 * par le traceur du navigateur. Le surplus : des robots qui se présentent
 * comme Chrome avec un faux référent Google, et les préchargements de Google
 * (Chrome télécharge à l'avance les premiers résultats, que l'internaute
 * clique ou non). Aucun des deux ne garde de cookie : chaque requête faisait
 * une « visite » et une session en base.
 *
 * Désormais, la première requête d'une arrivée gratuite ne pose qu'un cookie
 * d'attente (cpf_arr) : ni session, ni écriture en base. La visite est
 * enregistrée quand le navigateur revient avec ce cookie — en quelques
 * secondes par le traceur de la page (/api/analytics/track), sinon à la page
 * suivante. Un robot sans mémoire ne revient jamais ; un préchargement non
 * cliqué non plus. Un navigateur qui nous a déjà rendu un de nos cookies a
 * prouvé qu'il les garde : son arrivée est enregistrée tout de suite.
 *
 * Les visites marquées (gclid, utm…) ne changent pas : enregistrées tout de
 * suite, comme avant — l'import des conversions Google Ads en dépend. */
const COOKIE_ARRIVAL = 'cpf_arr';
const ARRIVAL_MAX_AGE_S = 30 * 60;
const SESSION_COOKIE = 'carpartsfrance.sid';
const OUR_COOKIES_REGEX = new RegExp(`(?:^|;\\s*)(?:${[COOKIE_LAST, COOKIE_FIRST, COOKIE_ARRIVAL, SESSION_COOKIE].map((c) => c.replace(/\./g, '\\.')).join('|')})=`);

// Préchargement (Chrome, Google, Firefox) : personne ne regarde encore la page.
function isPrefetch(req) {
  const h = req.headers || {};
  const purpose = String(h['sec-purpose'] || h.purpose || h['x-purpose'] || h['x-moz'] || '').toLowerCase();
  return /prefetch|prerender|preview/.test(purpose);
}

// Le navigateur nous a-t-il renvoyé un cookie que nous avions posé ?
function hasOurCookie(req) {
  const raw = req && req.headers && req.headers.cookie;
  return typeof raw === 'string' && OUR_COOKIES_REGEX.test(raw);
}

function buildTouch(req, norm, base = {}) {
  return {
    ...norm,
    landingPath: trim(base.landingPath || req.originalUrl || req.url || '/', MAX_PATH_LEN),
    referrer: trim(base.referrer != null ? String(base.referrer) : String(req.headers.referer || ''), MAX_PATH_LEN),
    userAgent: trim(String(req.headers['user-agent'] || '')),
    ipHash: hashIp(req.ip),
    lang: trim(base.lang != null ? String(base.lang) : (req.lang || ''), 16),
    capturedAt: base.capturedAt instanceof Date ? base.capturedAt : new Date(),
  };
}

function readPendingArrival(req) {
  const p = readCookie(req, COOKIE_ARRIVAL);
  if (!p || typeof p !== 'object' || typeof p.id !== 'string' || !/^[a-f0-9]{16,32}$/.test(p.id)) return null;
  const capturedAt = p.capturedAt ? new Date(p.capturedAt) : null;
  if (!capturedAt || Number.isNaN(capturedAt.getTime())) return null;
  return {
    id: p.id,
    referrer: typeof p.referrer === 'string' ? p.referrer : '',
    landingPath: typeof p.landingPath === 'string' ? p.landingPath : '/',
    lang: typeof p.lang === 'string' ? p.lang : '',
    capturedAt,
  };
}

/* Enregistre une arrivée : audit Mongo, session, cookies 90 jours. Commun aux
   visites marquées (gclid, utm…) et aux visites gratuites confirmées. */
function recordTouch(req, res, norm, touch, { arrivalId = '' } = {}) {
  // 1. Audit trail Mongo (fire & forget — jamais bloquant).
  const sessionId = (req.sessionID || (req.session && req.session.id) || '').toString();
  const userId = (req.session && req.session.user && req.session.user._id) || null;
  const hadFirstTouch = Boolean(
    (req.session && req.session.attribution && req.session.attribution.firstTouch)
      || readCookie(req, COOKIE_FIRST)
  );
  const doc = {
    sessionId,
    userId,
    touchType: hadFirstTouch ? 'last' : 'first',
    ...touch,
  };
  // Arrivée gratuite : la visite ne compte que confirmée par le navigateur
  // (voir plus haut). Idempotent : deux requêtes qui confirment la même
  // arrivée (traceur + page suivante) n'en font qu'une.
  const ecriture = arrivalId
    ? AttributionTouch.updateOne(
      { arrivalId },
      { $setOnInsert: { ...doc, arrivalId, confirmedArrival: true } },
      { upsert: true }
    )
    : AttributionTouch.create(doc);
  ecriture.catch((err) => {
    console.warn('[captureAttribution] mongo insert failed:', err && err.message);
  });

  // 2. Session : firstTouch immuable, lastTouch écrasé — SAUF si le nouveau
  //    touch n'a AUCUN identifiant de clic publicitaire alors que l'actuel en
  //    a un. Cas réel : clic Google Ads (gclid) puis retour via un lien
  //    email/newsletter (utm_source seul) → sans ce garde-fou le gclid était
  //    remis à '' et la commande devenait invisible pour l'import Ads.
  //    (L'audit AttributionTouch, lui, enregistre TOUS les touches.)
  const hasClickId = (t) => !!(t && (t.gclid || t.gbraid || t.wbraid || t.fbclid || t.msclkid));
  const sessionLast = req.session && req.session.attribution && req.session.attribution.lastTouch;
  const cookieLast = readCookie(req, COOKIE_LAST);
  // Le cookie compte aussi : un gclid d'une session précédente (fenêtre 90 j)
  // reste attribuable — un touch sans clic ne doit pas l'effacer non plus.
  const preserveLast = !hasClickId(norm) && (hasClickId(sessionLast) || hasClickId(cookieLast));

  if (req.session) {
    if (!req.session.attribution) req.session.attribution = {};
    if (!req.session.attribution.firstTouch) {
      req.session.attribution.firstTouch = touch;
    }
    if (!preserveLast) req.session.attribution.lastTouch = touch;
    // visitTouch : la DERNIÈRE arrivée enregistrée (pub, moteur, IA, autre
    // site), toujours écrasée par la suivante. Contrairement à lastTouch, elle
    // ne garde pas un vieux gclid quand le client revient par Google gratuit :
    // c'est elle qui dit si une vente vient de la pub ou d'une visite gratuite
    // (modèle « visit » du tableau marketing). Une visite directe ne l'écrase
    // pas : elle garde alors l'arrivée précédente de la même session.
    req.session.attribution.visitTouch = touch;
  }

  // 3. Cookies first-party (90j) — backup si la session expire.
  //    Deux arrivées dans la même requête (arrivée en attente confirmée + clic
  //    pub) : le cookie « premier contact » garde la première.
  const cookiePayload = buildCookiePayload(touch);
  if (!preserveLast) writeCookie(res, COOKIE_LAST, cookiePayload);
  if (!readCookie(req, COOKIE_FIRST) && !req._cpfPremierContactEcrit) {
    writeCookie(res, COOKIE_FIRST, cookiePayload);
    req._cpfPremierContactEcrit = true;
  }
}

/* Même arrivée gratuite déjà enregistrée dans cette session il y a moins de
   30 minutes (même site d'origine) : c'est la même visite. Évite qu'un robot
   qui garde les cookies et envoie toujours le même référent crée un
   enregistrement par page. */
const MEME_VISITE_MS = 30 * 60 * 1000;
function sameRecentArrival(req, referrer) {
  const v = req.session && req.session.attribution && req.session.attribution.visitTouch;
  if (!v || v.gclid || v.gbraid || v.wbraid || v.fbclid || v.msclkid || v.utmSource || v.utmMedium || v.utmCampaign) return false;
  const quand = v.capturedAt ? new Date(v.capturedAt).getTime() : NaN;
  if (!Number.isFinite(quand) || Date.now() - quand > MEME_VISITE_MS) return false;
  return refererHost(String(v.referrer || '')) === refererHost(String(referrer || ''));
}

async function captureAttribution(req, res, next) {
  try {
    // 0. Arrivée gratuite en attente : le navigateur revient avec le cookie
    //    d'attente (traceur de la page, page suivante, ajout au panier…). C'est
    //    une vraie visite : on l'enregistre, à la date de l'arrivée.
    const enAttente = readPendingArrival(req);
    if (enAttente && !isPrefetch(req)) {
      recordTouch(req, res, normalize({}), buildTouch(req, normalize({}), enAttente), { arrivalId: enAttente.id });
      clearCookie(res, COOKIE_ARRIVAL);
    }

    if (!shouldCapture(req)) return next();

    const extracted = extractFromQuery(req.query || {});
    if (extracted) {
      // Visite marquée (gclid, utm…) : enregistrée tout de suite, comme avant.
      const norm = normalize(extracted);
      recordTouch(req, res, norm, buildTouch(req, norm));
      return next();
    }

    if (!isUnmarkedArrival(req)) return next();

    const norm = normalize({});
    if (hasOurCookie(req) && !isPrefetch(req)) {
      // Navigateur connu (il nous a rendu un cookie) : enregistrée tout de
      // suite — sauf si c'est la même visite qu'il y a quelques minutes.
      if (!sameRecentArrival(req, req.headers.referer)) {
        recordTouch(req, res, norm, buildTouch(req, norm), { arrivalId: crypto.randomBytes(12).toString('hex') });
      }
      return next();
    }

    // Première requête d'un inconnu (ou préchargement) : cookie d'attente
    // seulement — ni session, ni écriture en base.
    const touch = buildTouch(req, norm);
    writeCookie(res, COOKIE_ARRIVAL, {
      id: crypto.randomBytes(12).toString('hex'),
      referrer: touch.referrer,
      landingPath: touch.landingPath,
      lang: touch.lang,
      capturedAt: touch.capturedAt.toISOString(),
    }, { maxAgeS: ARRIVAL_MAX_AGE_S, httpOnly: true });
    return next();
  } catch (err) {
    console.warn('[captureAttribution] error:', err && err.message);
    return next();
  }
}

// Construit le sous-document Order.attribution à partir de la session + cookies + GA.
// À appeler au moment de Order.create dans le checkout.
function buildOrderAttribution(req) {
  const session = (req.session && req.session.attribution) || {};

  // Fallback cookies (cas session expirée ou rotée).
  const cookieFirst = readCookie(req, COOKIE_FIRST);
  const cookieLast = readCookie(req, COOKIE_LAST);

  const firstTouch = session.firstTouch || cookieFirst || null;
  let lastTouch = session.lastTouch || cookieLast || firstTouch || null;
  // Si le lastTouch retenu ne porte aucun identifiant de clic mais que le
  // cookie (ou le firstTouch) en a un encore valable (90 j), on préfère
  // celui-là : c'est lui qui rend la commande attribuable côté Google Ads.
  const hasClick = (t) => !!(t && (t.gclid || t.gbraid || t.wbraid || t.fbclid || t.msclkid));
  if (!hasClick(lastTouch)) {
    if (hasClick(cookieLast)) lastTouch = cookieLast;
    else if (hasClick(firstTouch)) lastTouch = firstTouch;
  }

  if (!firstTouch && !lastTouch) {
    return undefined;
  }

  function shape(t) {
    if (!t) return undefined;
    return {
      gclid: t.gclid || '',
      gbraid: t.gbraid || '',
      wbraid: t.wbraid || '',
      fbclid: t.fbclid || '',
      msclkid: t.msclkid || '',
      utmSource: t.utmSource || '',
      utmMedium: t.utmMedium || '',
      utmCampaign: t.utmCampaign || '',
      utmContent: t.utmContent || '',
      utmTerm: t.utmTerm || '',
      landingPath: t.landingPath || '',
      referrer: t.referrer || '',
      capturedAt: t.capturedAt ? new Date(t.capturedAt) : null,
    };
  }

  return {
    firstTouch: shape(firstTouch),
    lastTouch: shape(lastTouch),
    // Dernière arrivée de la session avant la commande (session seulement :
    // un client qui n'est jamais arrivé que directement n'en a pas).
    visitTouch: shape(session.visitTouch) || null,
    ga4ClientId: readGaClientId(req),
  };
}

module.exports = captureAttribution;
module.exports.buildOrderAttribution = buildOrderAttribution;
module.exports.isUnmarkedArrival = isUnmarkedArrival;
module.exports.readCookie = readCookie;
module.exports.readGaClientId = readGaClientId;
module.exports.COOKIE_LAST = COOKIE_LAST;
module.exports.COOKIE_FIRST = COOKIE_FIRST;
module.exports.isPrefetch = isPrefetch;
module.exports.hasOurCookie = hasOurCookie;
module.exports.COOKIE_ARRIVAL = COOKIE_ARRIVAL;
