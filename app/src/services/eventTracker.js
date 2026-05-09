'use strict';

// Helper centralisé pour fire un AnalyticsEvent depuis n'importe quel
// controller. Toujours non-bloquant (fire & forget) : si la base est down
// ou indisponible, on n'interrompt jamais le flow utilisateur.

const crypto = require('crypto');
const mongoose = require('mongoose');
const AnalyticsEvent = require('../models/AnalyticsEvent');

function hashEmail(email) {
  if (typeof email !== 'string') return '';
  const trimmed = email.trim().toLowerCase();
  if (!trimmed || !trimmed.includes('@')) return '';
  return crypto.createHash('sha256').update(trimmed).digest('hex');
}

function hashIp(ip) {
  if (!ip) return '';
  return crypto.createHash('sha256').update(String(ip)).digest('hex').slice(0, 32);
}

function getDeviceType(userAgent) {
  const ua = String(userAgent || '').toLowerCase();
  if (/mobile|android|iphone|ipod/.test(ua) && !/ipad|tablet/.test(ua)) return 'mobile';
  if (/ipad|tablet/.test(ua)) return 'tablet';
  return 'desktop';
}

// Lit les infos d'attribution depuis req.session ou les cookies (héritage
// de captureAttribution.js déjà en place).
function readAttributionFromReq(req) {
  const s = (req && req.session && req.session.attribution) || {};
  const last = s.lastTouch || s.firstTouch || {};
  return {
    source: last.utmSource || '',
    medium: last.utmMedium || '',
    campaign: last.utmCampaign || '',
    referrer: last.referrer || '',
    gclid: last.gclid || '',
  };
}

function readSessionId(req) {
  if (!req) return '';
  return (req.sessionID || (req.session && req.session.id) || '').toString();
}

function readUserId(req) {
  if (!req || !req.session || !req.session.user) return null;
  const u = req.session.user;
  if (u._id && mongoose.Types.ObjectId.isValid(u._id)) return u._id;
  return null;
}

function readEmailHashFromSession(req) {
  // Priorité : email mémorisé pendant la session (login, formulaire, etc.)
  if (req && req.session && typeof req.session.emailHash === 'string') {
    return req.session.emailHash;
  }
  // Sinon, si user connecté, hash de son email actuel
  if (req && req.session && req.session.user && req.session.user.email) {
    return hashEmail(req.session.user.email);
  }
  return '';
}

// Mémorise un email hashé en session pour stitcher les events futurs
// (même session) à cet humain. Appeler depuis login/register/newsletter.
function rememberEmail(req, email) {
  if (!req || !req.session) return '';
  const h = hashEmail(email);
  if (h) req.session.emailHash = h;
  return h;
}

/**
 * Enregistre un event analytics. Non-bloquant.
 *
 * @param {Object} req - Express request (pour session, attribution, IP, UA)
 * @param {string} type - Type d'event ('add_to_cart', 'click_phone', etc.)
 * @param {Object} [data] - Champs additionnels selon le type d'event
 */
function track(req, type, data = {}) {
  try {
    if (!req || typeof type !== 'string' || !type) return;
    if (mongoose.connection.readyState !== 1) return;

    const attr = readAttributionFromReq(req);
    const sessionId = readSessionId(req);
    const userId = readUserId(req);
    const emailHash = readEmailHashFromSession(req) || '';

    const userAgent = (req.headers && req.headers['user-agent']) || '';
    const deviceType = getDeviceType(userAgent);

    const doc = {
      type: type.slice(0, 40),
      sessionId,
      userId,
      emailHash,
      source: attr.source,
      medium: attr.medium,
      campaign: attr.campaign,
      referrer: attr.referrer,
      gclid: attr.gclid,
      page: data.page || (req.originalUrl || '').slice(0, 500),
      pageTitle: data.pageTitle || '',
      durationMs: Number.isFinite(data.durationMs) ? data.durationMs : 0,
      productId: data.productId || null,
      productName: (data.productName || '').slice(0, 200),
      productSku: (data.productSku || '').slice(0, 80),
      productPriceCents: Number.isFinite(data.productPriceCents) ? data.productPriceCents : 0,
      searchQuery: (data.searchQuery || '').slice(0, 200),
      searchResultCount: Number.isFinite(data.searchResultCount) ? data.searchResultCount : -1,
      funnelStep: (data.funnelStep || '').slice(0, 40),
      interaction: (data.interaction || '').slice(0, 60),
      converted: data.converted === true,
      cart: {
        itemsCount: Number.isFinite(data.cartItemsCount) ? data.cartItemsCount : 0,
        totalCents: Number.isFinite(data.cartTotalCents) ? data.cartTotalCents : 0,
        qtyChange: Number.isFinite(data.qtyChange) ? data.qtyChange : 0,
      },
      orderId: data.orderId || null,
      orderNumber: (data.orderNumber || '').slice(0, 60),
      orderTotalCents: Number.isFinite(data.orderTotalCents) ? data.orderTotalCents : 0,
      target: (data.target || '').slice(0, 200),
      meta: data.meta || null,
      deviceType,
      userAgent: String(userAgent).slice(0, 300),
      ipHash: hashIp(req.ip),
    };

    AnalyticsEvent.create(doc).catch((err) => {
      console.warn('[eventTracker] insert failed:', err && err.message);
    });
  } catch (err) {
    console.warn('[eventTracker] error:', err && err.message);
  }
}

module.exports = {
  track,
  hashEmail,
  rememberEmail,
};
