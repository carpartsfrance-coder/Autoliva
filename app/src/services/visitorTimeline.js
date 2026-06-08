'use strict';

// Service d'agrégation pour la page /admin/visiteurs.
// Fournit deux fonctions :
//   - listRecentSessions : la liste des dernières sessions avec leur source
//     et un mini-aperçu de leur activité.
//   - getSessionTimeline : tous les events d'une session (et des sessions
//     liées via emailHash / userId pour le cross-device) en ordre chronologique.

const mongoose = require('mongoose');
const AnalyticsEvent = require('../models/AnalyticsEvent');

const PAID_ORDER_STATUSES = ['paid', 'processing', 'label_created', 'shipped', 'delivered', 'completed'];

const ALLOWED_PERIODS = new Set(['1h', '24h', '7d', '30d']);
const DEFAULT_PERIOD = '24h';

function getStartDateForPeriod(period) {
  const now = Date.now();
  const ms = {
    '1h': 60 * 60 * 1000,
    '24h': 24 * 60 * 60 * 1000,
    '7d': 7 * 24 * 60 * 60 * 1000,
    '30d': 30 * 24 * 60 * 60 * 1000,
  }[period];
  return ms ? new Date(now - ms) : new Date(now - 24 * 60 * 60 * 1000);
}

// Liste les dernières sessions avec un résumé.
async function listRecentSessions({ period = DEFAULT_PERIOD, source = '', campaign = '', converted = '', search = '', limit = 50 } = {}) {
  const safePeriod = ALLOWED_PERIODS.has(period) ? period : DEFAULT_PERIOD;
  const since = getStartDateForPeriod(safePeriod);

  const match = { createdAt: { $gte: since }, sessionId: { $ne: '' } };
  if (source) match.source = source.toLowerCase();
  if (campaign) match.campaign = campaign;
  if (search) {
    const rx = new RegExp(escapeRegex(search), 'i');
    match.$or = [
      { sessionId: rx },
      { searchQuery: rx },
      { productName: rx },
      { campaign: rx },
      { target: rx },
      { orderNumber: rx },
    ];
  }

  // Pipeline : group par sessionId, calcule des aggréges, joint user
  const pipeline = [
    { $match: match },
    { $sort: { createdAt: -1 } },
    {
      $group: {
        _id: '$sessionId',
        userId: { $first: '$userId' },
        emailHash: { $max: '$emailHash' },
        source: { $first: '$source' },
        medium: { $first: '$medium' },
        campaign: { $first: '$campaign' },
        gclid: { $first: '$gclid' },
        deviceType: { $first: '$deviceType' },
        firstSeenAt: { $min: '$createdAt' },
        lastSeenAt: { $max: '$createdAt' },
        eventCount: { $sum: 1 },
        pageviewCount: {
          $sum: { $cond: [{ $eq: ['$type', 'pageview'] }, 1, 0] },
        },
        addToCartCount: {
          $sum: { $cond: [{ $eq: ['$type', 'add_to_cart'] }, 1, 0] },
        },
        clickPhoneCount: {
          $sum: { $cond: [{ $eq: ['$type', 'click_phone'] }, 1, 0] },
        },
        clickEmailCount: {
          $sum: { $cond: [{ $eq: ['$type', 'click_email'] }, 1, 0] },
        },
        clickWhatsappCount: {
          $sum: { $cond: [{ $eq: ['$type', 'click_whatsapp'] }, 1, 0] },
        },
        orderId: {
          $max: {
            $cond: [{ $eq: ['$type', 'order_placed'] }, '$orderId', null],
          },
        },
        orderTotalCents: {
          $max: {
            $cond: [{ $eq: ['$type', 'order_placed'] }, '$orderTotalCents', null],
          },
        },
        lastPage: { $first: '$page' },
      },
    },
    { $match: convertedFilter(converted) },
    { $sort: { lastSeenAt: -1 } },
    { $limit: Math.min(Math.max(parseInt(limit, 10) || 50, 1), 200) },
  ];

  const rows = await AnalyticsEvent.aggregate(pipeline);
  return rows;
}

function convertedFilter(value) {
  if (value === 'converted') return { orderId: { $ne: null } };
  if (value === 'not_converted') return { orderId: null };
  return {};
}

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Timeline complète d'une session, avec stitching cross-device si email hash
// ou userId connu.
async function getSessionTimeline(sessionId) {
  if (!sessionId || typeof sessionId !== 'string') return null;

  // 1) Trouve les identifiants liés (userId, emailHash) sur cette session
  const link = await AnalyticsEvent.findOne(
    { sessionId, $or: [{ userId: { $ne: null } }, { emailHash: { $ne: '' } }] },
    { userId: 1, emailHash: 1 }
  ).lean();

  // 2) Trouve toutes les sessions reliées (cross-device)
  const sessionsToInclude = new Set([sessionId]);
  if (link && (link.userId || link.emailHash)) {
    const linkedQuery = { $or: [] };
    if (link.userId) linkedQuery.$or.push({ userId: link.userId });
    if (link.emailHash) linkedQuery.$or.push({ emailHash: link.emailHash });
    const linkedSessions = await AnalyticsEvent.distinct('sessionId', linkedQuery);
    for (const s of linkedSessions) sessionsToInclude.add(s);
  }

  // 3) Récupère tous les events de toutes les sessions liées
  const events = await AnalyticsEvent.find({ sessionId: { $in: Array.from(sessionsToInclude) } })
    .sort({ createdAt: 1 })
    .limit(2000)
    .lean();

  // 4) Identité humaine : si on a un userId, charge l'utilisateur
  let user = null;
  if (link && link.userId && mongoose.Types.ObjectId.isValid(link.userId)) {
    try {
      const User = require('../models/User');
      user = await User.findById(link.userId).select('_id email firstName lastName accountType companyName').lean();
    } catch (_) { /* ignore */ }
  }

  // 5) Commande(s) liée(s) si conversion
  const orderIds = events.map((e) => e.orderId).filter(Boolean);
  let orders = [];
  if (orderIds.length) {
    try {
      const Order = require('../models/Order');
      orders = await Order.find({ _id: { $in: orderIds } })
        .select('_id number status totalCents createdAt')
        .lean();
    } catch (_) { /* ignore */ }
  }

  // 6) Calcul de stats agrégés sur le visiteur
  const summary = {
    sessionsCount: sessionsToInclude.size,
    eventsCount: events.length,
    firstSeenAt: events[0] ? events[0].createdAt : null,
    lastSeenAt: events.length ? events[events.length - 1].createdAt : null,
    pageviewCount: events.filter((e) => e.type === 'pageview').length,
    addToCartCount: events.filter((e) => e.type === 'add_to_cart').length,
    removeFromCartCount: events.filter((e) => e.type === 'remove_from_cart').length,
    clickPhoneCount: events.filter((e) => e.type === 'click_phone').length,
    clickEmailCount: events.filter((e) => e.type === 'click_email').length,
    clickWhatsappCount: events.filter((e) => e.type === 'click_whatsapp').length,
    converted: !!orders.length,
    revenueCents: orders.reduce((sum, o) => {
      if (PAID_ORDER_STATUSES.includes(o.status)) return sum + (o.totalCents || 0);
      return sum;
    }, 0),
  };

  // 7) Source principale (depuis le 1er event)
  const firstEv = events[0] || {};
  const source = {
    source: firstEv.source || '',
    medium: firstEv.medium || '',
    campaign: firstEv.campaign || '',
    gclid: firstEv.gclid || '',
    referrer: firstEv.referrer || '',
    deviceType: firstEv.deviceType || '',
  };

  return {
    sessionId,
    relatedSessions: Array.from(sessionsToInclude),
    user,
    orders,
    source,
    summary,
    events,
  };
}

module.exports = {
  listRecentSessions,
  getSessionTimeline,
  ALLOWED_PERIODS,
  DEFAULT_PERIOD,
};
