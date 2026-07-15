'use strict';

const crypto = require('crypto');
const AttributionTouch = require('../models/AttributionTouch');

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

function writeCookie(res, name, value) {
  const isProd = process.env.NODE_ENV === 'production';
  const payload = encodeURIComponent(JSON.stringify(value));
  if (payload.length > 3500) return; // garde-fou taille cookie
  const parts = [
    `${name}=${payload}`,
    `Max-Age=${COOKIE_MAX_AGE_S}`,
    'Path=/',
    'SameSite=Lax',
  ];
  if (isProd) parts.push('Secure');
  // Volontairement PAS HttpOnly : le snippet client le lit en backup.
  // Données non sensibles (pas de PII, pas d'auth).
  res.append('Set-Cookie', parts.join('; '));
}

async function captureAttribution(req, res, next) {
  try {
    if (!shouldCapture(req)) return next();

    const extracted = extractFromQuery(req.query || {});
    if (!extracted) return next();

    const norm = normalize(extracted);
    const touch = {
      ...norm,
      landingPath: trim(req.originalUrl || req.url || '/', MAX_PATH_LEN),
      referrer: trim(String(req.headers.referer || ''), MAX_PATH_LEN),
      userAgent: trim(String(req.headers['user-agent'] || '')),
      ipHash: hashIp(req.ip),
      lang: req.lang || '',
      capturedAt: new Date(),
    };

    // 1. Audit trail Mongo (fire & forget — jamais bloquant).
    const sessionId = (req.sessionID || (req.session && req.session.id) || '').toString();
    const userId = (req.session && req.session.user && req.session.user._id) || null;
    const hadFirstTouch = Boolean(
      (req.session && req.session.attribution && req.session.attribution.firstTouch)
        || readCookie(req, COOKIE_FIRST)
    );

    AttributionTouch.create({
      sessionId,
      userId,
      touchType: hadFirstTouch ? 'last' : 'first',
      ...touch,
    }).catch((err) => {
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
    }

    // 3. Cookies first-party (90j) — backup si la session expire.
    const cookiePayload = buildCookiePayload(touch);
    if (!preserveLast) writeCookie(res, COOKIE_LAST, cookiePayload);
    if (!readCookie(req, COOKIE_FIRST)) {
      writeCookie(res, COOKIE_FIRST, cookiePayload);
    }

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
    ga4ClientId: readGaClientId(req),
  };
}

module.exports = captureAttribution;
module.exports.buildOrderAttribution = buildOrderAttribution;
module.exports.readCookie = readCookie;
module.exports.readGaClientId = readGaClientId;
module.exports.COOKIE_LAST = COOKIE_LAST;
module.exports.COOKIE_FIRST = COOKIE_FIRST;
