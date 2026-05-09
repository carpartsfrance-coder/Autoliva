'use strict';

const Order = require('../../models/Order');
const AttributionTouch = require('../../models/AttributionTouch');
const AbandonedCart = require('../../models/AbandonedCart');
const {
  ALLOWED_PERIODS,
  DEFAULT_PERIOD,
  getStartDateForPeriod,
  getPreviousPeriodRange,
  safePeriod,
} = require('../util/period');
const { eurFromCents, pct, deltaPct, jsonResult } = require('../util/format');

const PAID_STATUSES = ['paid', 'processing', 'shipped', 'delivered', 'completed'];

const BASE_ORDER_MATCH = {
  paymentStatus: 'paid',
  status: { $in: PAID_STATUSES },
  deletedAt: null,
};

async function aggregateOrdersInRange(startDate, endDate) {
  const match = { ...BASE_ORDER_MATCH };
  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = startDate;
    if (endDate) match.createdAt.$lt = endDate;
  }
  const result = await Order.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        orders: { $sum: 1 },
        revenueCents: { $sum: '$totalCents' },
      },
    },
  ]);
  const row = result[0] || { orders: 0, revenueCents: 0 };
  return {
    orders: row.orders,
    revenueCents: row.revenueCents,
    aovCents: row.orders > 0 ? Math.round(row.revenueCents / row.orders) : 0,
  };
}

async function aggregateUniqueVisitsInRange(startDate, endDate) {
  const match = {};
  if (startDate || endDate) {
    match.createdAt = {};
    if (startDate) match.createdAt.$gte = startDate;
    if (endDate) match.createdAt.$lt = endDate;
  }
  const result = await AttributionTouch.aggregate([
    { $match: match },
    { $group: { _id: '$sessionId' } },
    { $count: 'visits' },
  ]);
  return result[0]?.visits || 0;
}

async function aggregateTrafficMix(startDate) {
  const match = {};
  if (startDate) match.createdAt = { $gte: startDate };

  const rows = await AttributionTouch.aggregate([
    { $match: match },
    {
      $group: {
        _id: {
          source: { $ifNull: ['$utmSource', ''] },
          medium: { $ifNull: ['$utmMedium', ''] },
          hasGclid: { $cond: [{ $and: [{ $ifNull: ['$gclid', false] }, { $ne: ['$gclid', ''] }] }, true, false] },
          hasFbclid: { $cond: [{ $and: [{ $ifNull: ['$fbclid', false] }, { $ne: ['$fbclid', ''] }] }, true, false] },
          hasMsclkid: { $cond: [{ $and: [{ $ifNull: ['$msclkid', false] }, { $ne: ['$msclkid', ''] }] }, true, false] },
        },
        sessions: { $addToSet: '$sessionId' },
      },
    },
    { $project: { _id: 0, source: '$_id.source', medium: '$_id.medium', hasGclid: '$_id.hasGclid', hasFbclid: '$_id.hasFbclid', hasMsclkid: '$_id.hasMsclkid', visits: { $size: '$sessions' } } },
  ]);

  const buckets = { paid_google: 0, paid_facebook: 0, paid_microsoft: 0, paid_other: 0, organic: 0, referral: 0, email: 0, direct: 0 };
  for (const r of rows) {
    const src = (r.source || '').toLowerCase();
    const med = (r.medium || '').toLowerCase();
    if (med === 'cpc' || med === 'paid' || med === 'ppc' || src === 'google_ads' || r.hasGclid) {
      if (r.hasGclid || src.includes('google')) buckets.paid_google += r.visits;
      else if (r.hasFbclid || src.includes('facebook') || src.includes('meta')) buckets.paid_facebook += r.visits;
      else if (r.hasMsclkid || src.includes('bing') || src.includes('microsoft')) buckets.paid_microsoft += r.visits;
      else buckets.paid_other += r.visits;
    } else if (med === 'organic' || (src && !med && (src.includes('google') || src.includes('bing') || src.includes('duckduckgo')))) {
      buckets.organic += r.visits;
    } else if (med === 'email' || med === 'newsletter') {
      buckets.email += r.visits;
    } else if (med === 'referral' || (src && !med)) {
      buckets.referral += r.visits;
    } else {
      buckets.direct += r.visits;
    }
  }
  const total = Object.values(buckets).reduce((a, b) => a + b, 0);
  const mix = {};
  for (const [k, v] of Object.entries(buckets)) {
    mix[k] = { visits: v, sharePct: pct(v, total) };
  }
  return { totalVisits: total, mix };
}

async function topProducts(startDate, limit) {
  const match = { ...BASE_ORDER_MATCH };
  if (startDate) match.createdAt = { $gte: startDate };
  return Order.aggregate([
    { $match: match },
    { $unwind: '$items' },
    {
      $group: {
        _id: { productId: '$items.productId', name: '$items.name' },
        unitsSold: { $sum: '$items.quantity' },
        revenueCents: { $sum: '$items.lineTotalCents' },
      },
    },
    { $sort: { revenueCents: -1 } },
    { $limit: limit },
    {
      $project: {
        _id: 0,
        productId: '$_id.productId',
        name: '$_id.name',
        unitsSold: 1,
        revenueCents: 1,
      },
    },
  ]);
}

async function abandonedCartLoss(startDate) {
  const match = { status: { $in: ['abandoned', 'reminded_1', 'reminded_2', 'reminded_3', 'expired'] } };
  if (startDate) match.abandonedAt = { $gte: startDate };
  const result = await AbandonedCart.aggregate([
    { $match: match },
    { $group: { _id: null, count: { $sum: 1 }, valueCents: { $sum: '$totalAmountCents' } } },
  ]);
  const row = result[0] || { count: 0, valueCents: 0 };
  return { count: row.count, valueCents: row.valueCents };
}

const definition = {
  name: 'getBusinessOverview',
  description:
    "Vue de pilotage globale Car Parts France pour une période donnée : CA, nombre de commandes, panier moyen (AOV), nombre de visites uniques, taux de conversion, mix sources de trafic (organique / payé Google/Facebook/Microsoft / direct / referral / email), top 5 produits par CA, et estimation du CA perdu sur paniers abandonnés. Compare automatiquement avec la période précédente. À utiliser pour répondre à 'comment va le business ?', 'CA du mois', 'évolution vs mois dernier'.",
  inputSchema: {
    type: 'object',
    properties: {
      period: {
        type: 'string',
        enum: ['7d', '30d', '90d', '365d', 'all'],
        description: "Période d'analyse glissante. Défaut : 30d.",
      },
      topProductsLimit: {
        type: 'integer',
        minimum: 1,
        maximum: 20,
        description: 'Nombre de produits dans le top. Défaut : 5.',
      },
    },
    additionalProperties: false,
  },
};

async function handler(args = {}) {
  const period = safePeriod(args.period || DEFAULT_PERIOD);
  const limit = Math.min(Math.max(parseInt(args.topProductsLimit, 10) || 5, 1), 20);
  const startDate = getStartDateForPeriod(period);
  const previous = getPreviousPeriodRange(period);

  const [current, previousData, currentVisits, previousVisits, traffic, top, abandoned] = await Promise.all([
    aggregateOrdersInRange(startDate, null),
    period === 'all'
      ? Promise.resolve({ orders: 0, revenueCents: 0, aovCents: 0 })
      : aggregateOrdersInRange(previous.start, previous.end),
    aggregateUniqueVisitsInRange(startDate, null),
    period === 'all' ? Promise.resolve(0) : aggregateUniqueVisitsInRange(previous.start, previous.end),
    aggregateTrafficMix(startDate),
    topProducts(startDate, limit),
    abandonedCartLoss(startDate),
  ]);

  return jsonResult({
    period,
    startDate,
    current: {
      revenueEur: eurFromCents(current.revenueCents),
      orders: current.orders,
      aovEur: eurFromCents(current.aovCents),
      uniqueVisits: currentVisits,
      conversionRatePct: pct(current.orders, currentVisits),
    },
    previous:
      period === 'all'
        ? null
        : {
            revenueEur: eurFromCents(previousData.revenueCents),
            orders: previousData.orders,
            aovEur: eurFromCents(previousData.aovCents),
            uniqueVisits: previousVisits,
            conversionRatePct: pct(previousData.orders, previousVisits),
          },
    deltaVsPreviousPct:
      period === 'all'
        ? null
        : {
            revenue: deltaPct(current.revenueCents, previousData.revenueCents),
            orders: deltaPct(current.orders, previousData.orders),
            aov: deltaPct(current.aovCents, previousData.aovCents),
            visits: deltaPct(currentVisits, previousVisits),
          },
    trafficMix: traffic,
    topProducts: top.map((p) => ({
      productId: p.productId,
      name: p.name,
      unitsSold: p.unitsSold,
      revenueEur: eurFromCents(p.revenueCents),
    })),
    abandonedCartsLoss: {
      count: abandoned.count,
      valueEur: eurFromCents(abandoned.valueCents),
    },
  });
}

module.exports = { definition, handler };
