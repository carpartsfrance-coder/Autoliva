'use strict';

const Order = require('../../models/Order');
const AbandonedCart = require('../../models/AbandonedCart');
const ReturnRequest = require('../../models/ReturnRequest');
const { ALLOWED_PERIODS, DEFAULT_PERIOD, getStartDateForPeriod, safePeriod } = require('../util/period');
const { eurFromCents, pct, jsonResult } = require('../util/format');

const PAID_STATUSES = ['paid', 'processing', 'shipped', 'delivered', 'completed'];

const definition = {
  name: 'getFunnelLeaks',
  description:
    "Diagnostic des fuites du funnel : (1) paniers abandonnés (volume, valeur perdue, top produits perdus, taux de récupération via les emails de relance), (2) produits avec un taux de retour SAV anormal sur la période, (3) répartition des statuts de retour (en attente / accepté / remboursé). À utiliser pour 'où je perds de l'argent', 'pourquoi mon taux de conversion baisse', 'quels produits posent problème en SAV', 'la relance panier abandonné fonctionne-t-elle'.",
  inputSchema: {
    type: 'object',
    properties: {
      period: { type: 'string', enum: ['7d', '30d', '90d', '365d', 'all'], description: "Période d'analyse. Défaut : 30d." },
      topLostProductsLimit: {
        type: 'integer',
        minimum: 1,
        maximum: 50,
        description: 'Nombre de produits dans le top des paniers abandonnés. Défaut : 10.',
      },
      returnRateThresholdPct: {
        type: 'number',
        minimum: 0,
        maximum: 100,
        description: "Seuil de taux de retour (en %) au-dessus duquel un produit est jugé 'à risque'. Défaut : 5.",
      },
      minOrdersForReturnRate: {
        type: 'integer',
        minimum: 1,
        description: "Nombre minimum de commandes d'un produit pour calculer un taux de retour fiable. Défaut : 5.",
      },
    },
    additionalProperties: false,
  },
};

async function abandonedCartsAnalysis(startDate, topLimit) {
  const baseMatch = {};
  if (startDate) baseMatch.abandonedAt = { $gte: startDate };

  const breakdown = await AbandonedCart.aggregate([
    { $match: baseMatch },
    {
      $group: {
        _id: '$status',
        count: { $sum: 1 },
        valueCents: { $sum: '$totalAmountCents' },
      },
    },
  ]);

  const byStatus = {};
  let totalCount = 0;
  let totalValueCents = 0;
  let recoveredCount = 0;
  let recoveredValueCents = 0;
  for (const r of breakdown) {
    byStatus[r._id] = { count: r.count, valueEur: eurFromCents(r.valueCents) };
    totalCount += r.count;
    totalValueCents += r.valueCents;
    if (r._id === 'recovered') {
      recoveredCount = r.count;
      recoveredValueCents = r.valueCents;
    }
  }

  const topLost = await AbandonedCart.aggregate([
    { $match: { ...baseMatch, status: { $ne: 'recovered' } } },
    { $unwind: '$items' },
    {
      $group: {
        _id: { productId: '$items.productId', name: '$items.name' },
        timesAbandoned: { $sum: '$items.quantity' },
        valueLostCents: { $sum: { $multiply: ['$items.price', '$items.quantity'] } },
      },
    },
    { $sort: { valueLostCents: -1 } },
    { $limit: topLimit },
    {
      $project: {
        _id: 0,
        productId: '$_id.productId',
        name: '$_id.name',
        timesAbandoned: 1,
        valueLostEur: { $divide: ['$valueLostCents', 100] },
      },
    },
  ]);

  return {
    totals: {
      count: totalCount,
      valueLostEur: eurFromCents(totalValueCents - recoveredValueCents),
      recoveredCount,
      recoveredValueEur: eurFromCents(recoveredValueCents),
      recoveryRatePct: pct(recoveredCount, totalCount),
    },
    byStatus,
    topLostProducts: topLost,
  };
}

async function returnRiskAnalysis(startDate, threshold, minOrders) {
  const orderMatch = {
    paymentStatus: 'paid',
    status: { $in: PAID_STATUSES },
    deletedAt: null,
  };
  if (startDate) orderMatch.createdAt = { $gte: startDate };

  const sales = await Order.aggregate([
    { $match: orderMatch },
    { $unwind: '$items' },
    { $match: { 'items.productId': { $ne: null } } },
    {
      $group: {
        _id: { productId: '$items.productId', name: '$items.name' },
        ordersSet: { $addToSet: '$_id' },
      },
    },
    {
      $project: {
        _id: 0,
        productId: '$_id.productId',
        name: '$_id.name',
        ordersCount: { $size: '$ordersSet' },
      },
    },
  ]);

  const returnMatch = { status: { $in: ['accepte', 'en_transit', 'recu', 'rembourse', 'cloture'] } };
  if (startDate) returnMatch.createdAt = { $gte: startDate };
  const returnedOrders = await ReturnRequest.aggregate([
    { $match: returnMatch },
    { $group: { _id: '$orderId' } },
  ]);
  const returnedOrderIds = returnedOrders.map((r) => r._id);

  const returnsByProduct = new Map();
  if (returnedOrderIds.length > 0) {
    const orders = await Order.find({ _id: { $in: returnedOrderIds } }, { items: 1 }).lean();
    for (const order of orders) {
      const seen = new Set();
      for (const item of order.items || []) {
        if (!item.productId) continue;
        const key = String(item.productId);
        if (seen.has(key)) continue;
        seen.add(key);
        returnsByProduct.set(key, (returnsByProduct.get(key) || 0) + 1);
      }
    }
  }

  const atRisk = sales
    .filter((s) => s.ordersCount >= minOrders)
    .map((s) => {
      const key = String(s.productId);
      const returnsCount = returnsByProduct.get(key) || 0;
      return {
        productId: s.productId,
        name: s.name,
        ordersCount: s.ordersCount,
        returnsCount,
        returnRatePct: pct(returnsCount, s.ordersCount),
      };
    })
    .filter((r) => r.returnRatePct >= threshold)
    .sort((a, b) => b.returnRatePct - a.returnRatePct);

  return atRisk;
}

async function returnStatusBreakdown(startDate) {
  const match = {};
  if (startDate) match.createdAt = { $gte: startDate };
  const rows = await ReturnRequest.aggregate([
    { $match: match },
    { $group: { _id: '$status', count: { $sum: 1 } } },
  ]);
  const out = {};
  let total = 0;
  for (const r of rows) {
    out[r._id] = r.count;
    total += r.count;
  }
  return { total, byStatus: out };
}

async function handler(args = {}) {
  const period = safePeriod(args.period || DEFAULT_PERIOD);
  const topLimit = Math.min(Math.max(parseInt(args.topLostProductsLimit, 10) || 10, 1), 50);
  const threshold = typeof args.returnRateThresholdPct === 'number' ? args.returnRateThresholdPct : 5;
  const minOrders = Math.max(parseInt(args.minOrdersForReturnRate, 10) || 5, 1);
  const startDate = getStartDateForPeriod(period);

  const [carts, atRisk, returnStatuses] = await Promise.all([
    abandonedCartsAnalysis(startDate, topLimit),
    returnRiskAnalysis(startDate, threshold, minOrders),
    returnStatusBreakdown(startDate),
  ]);

  return jsonResult({
    period,
    startDate,
    abandonedCarts: carts,
    productsAtRisk: {
      threshold: { returnRatePct: threshold, minOrders },
      count: atRisk.length,
      rows: atRisk,
    },
    returnsBreakdown: returnStatuses,
  });
}

module.exports = { definition, handler };
