'use strict';

const Order = require('../../models/Order');
const Product = require('../../models/Product');
const ReturnRequest = require('../../models/ReturnRequest');
const { ALLOWED_PERIODS, DEFAULT_PERIOD, getStartDateForPeriod, safePeriod } = require('../util/period');
const { eurFromCents, pct, jsonResult } = require('../util/format');

const PAID_STATUSES = ['paid', 'processing', 'shipped', 'delivered', 'completed'];

const ALLOWED_SORT = new Set(['revenue', 'units', 'aov', 'returnRate']);
const DEFAULT_SORT = 'revenue';

const definition = {
  name: 'getProductPerformance',
  description:
    "Performance par produit sur la période : ventes (unités), CA, panier moyen produit, taux de retour SAV. Identifie les vaches à lait et les sous-performants. À utiliser pour 'quels sont mes meilleurs produits', 'sur quoi miser', 'quels produits ont un taux de retour anormal', 'quels produits ne se vendent plus'.",
  inputSchema: {
    type: 'object',
    properties: {
      period: { type: 'string', enum: ['7d', '30d', '90d', '365d', 'all'], description: "Période d'analyse. Défaut : 30d." },
      sortBy: { type: 'string', enum: ['revenue', 'units', 'aov', 'returnRate'], description: 'Critère de tri. Défaut : revenue.' },
      limit: { type: 'integer', minimum: 1, maximum: 100, description: 'Nombre de produits à retourner. Défaut : 20.' },
      includeZeroSales: {
        type: 'boolean',
        description: "Si true, inclut les produits actifs qui n'ont eu AUCUNE vente sur la période (utile pour identifier les sous-performants). Défaut : false.",
      },
    },
    additionalProperties: false,
  },
};

async function handler(args = {}) {
  const period = safePeriod(args.period || DEFAULT_PERIOD);
  const sortBy = ALLOWED_SORT.has(args.sortBy) ? args.sortBy : DEFAULT_SORT;
  const limit = Math.min(Math.max(parseInt(args.limit, 10) || 20, 1), 100);
  const includeZero = !!args.includeZeroSales;
  const startDate = getStartDateForPeriod(period);

  const orderMatch = {
    paymentStatus: 'paid',
    status: { $in: PAID_STATUSES },
    deletedAt: null,
  };
  if (startDate) orderMatch.createdAt = { $gte: startDate };

  const salesByProduct = await Order.aggregate([
    { $match: orderMatch },
    { $unwind: '$items' },
    { $match: { 'items.productId': { $ne: null } } },
    {
      $group: {
        _id: '$items.productId',
        unitsSold: { $sum: '$items.quantity' },
        revenueCents: { $sum: '$items.lineTotalCents' },
        orderLines: { $sum: 1 },
        ordersSet: { $addToSet: '$_id' },
      },
    },
    {
      $project: {
        _id: 1,
        unitsSold: 1,
        revenueCents: 1,
        orderLines: 1,
        ordersCount: { $size: '$ordersSet' },
      },
    },
  ]);

  const productIds = salesByProduct.map((r) => r._id);

  const returnMatch = { status: { $in: ['accepte', 'en_transit', 'recu', 'rembourse', 'cloture'] } };
  if (startDate) returnMatch.createdAt = { $gte: startDate };
  const returnsByOrderId = await ReturnRequest.aggregate([
    { $match: returnMatch },
    { $group: { _id: '$orderId' } },
  ]);
  const returnedOrderIds = new Set(returnsByOrderId.map((r) => String(r._id)));

  const returnsByProduct = new Map();
  if (returnedOrderIds.size > 0) {
    const returnedOrders = await Order.find(
      { _id: { $in: Array.from(returnedOrderIds) } },
      { items: 1 }
    ).lean();
    for (const order of returnedOrders) {
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

  const products = await Product.find(
    productIds.length > 0
      ? { _id: { $in: productIds } }
      : {},
    { name: 1, sku: 1, category: 1, brand: 1, priceCents: 1, inStock: 1, stockQty: 1 }
  ).lean();
  const productById = new Map(products.map((p) => [String(p._id), p]));

  const rows = salesByProduct.map((r) => {
    const key = String(r._id);
    const p = productById.get(key);
    const returnsCount = returnsByProduct.get(key) || 0;
    const aovCents = r.ordersCount > 0 ? Math.round(r.revenueCents / r.ordersCount) : 0;
    return {
      productId: r._id,
      name: p?.name || '(produit supprimé)',
      sku: p?.sku || '',
      category: p?.category || '',
      brand: p?.brand || '',
      currentPriceEur: eurFromCents(p?.priceCents || 0),
      inStock: p?.inStock ?? null,
      stockQty: p?.stockQty ?? null,
      unitsSold: r.unitsSold,
      revenueEur: eurFromCents(r.revenueCents),
      ordersCount: r.ordersCount,
      aovEur: eurFromCents(aovCents),
      returnsCount,
      returnRatePct: pct(returnsCount, r.ordersCount),
    };
  });

  if (includeZero) {
    const soldIds = new Set(productIds.map(String));
    const inactive = await Product.find(
      { _id: { $nin: Array.from(soldIds) }, inStock: true },
      { name: 1, sku: 1, category: 1, brand: 1, priceCents: 1, inStock: 1, stockQty: 1 }
    ).lean();
    for (const p of inactive) {
      rows.push({
        productId: p._id,
        name: p.name,
        sku: p.sku,
        category: p.category,
        brand: p.brand,
        currentPriceEur: eurFromCents(p.priceCents || 0),
        inStock: p.inStock,
        stockQty: p.stockQty ?? null,
        unitsSold: 0,
        revenueEur: 0,
        ordersCount: 0,
        aovEur: 0,
        returnsCount: 0,
        returnRatePct: 0,
      });
    }
  }

  rows.sort((a, b) => {
    if (sortBy === 'units') return b.unitsSold - a.unitsSold;
    if (sortBy === 'aov') return b.aovEur - a.aovEur;
    if (sortBy === 'returnRate') return b.returnRatePct - a.returnRatePct;
    return b.revenueEur - a.revenueEur;
  });

  return jsonResult({
    period,
    startDate,
    sortBy,
    productsCount: rows.length,
    rows: rows.slice(0, limit),
  });
}

module.exports = { definition, handler };
