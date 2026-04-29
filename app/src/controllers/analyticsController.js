const mongoose = require('mongoose');

const AnalyticsEvent = require('../models/AnalyticsEvent');
const Order = require('../models/Order');

/* ------------------------------------------------------------------ */
/*  API: receive tracking events from frontend                        */
/* ------------------------------------------------------------------ */

async function postTrackEvent(req, res) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    if (!dbConnected) return res.status(204).end();

    const body = req.body;
    if (!body || typeof body !== 'object') return res.status(204).end();

    const events = Array.isArray(body.events) ? body.events : (body.type ? [body] : []);
    if (events.length === 0) return res.status(204).end();

    // Limit batch size
    const batch = events.slice(0, 20);

    const docs = [];
    for (const ev of batch) {
      if (!ev || typeof ev.type !== 'string') continue;
      const type = ev.type.trim().slice(0, 40);
      if (!type) continue;

      docs.push({
        type,
        sessionId: sanitize(ev.sessionId, 64),
        source: sanitize(ev.source, 60),
        medium: sanitize(ev.medium, 60),
        campaign: sanitize(ev.campaign, 120),
        referrer: sanitize(ev.referrer, 500),
        page: sanitize(ev.page, 500),
        productId: isObjectId(ev.productId) ? ev.productId : null,
        productName: sanitize(ev.productName, 200),
        searchQuery: sanitize(ev.searchQuery, 200),
        searchResultCount: typeof ev.searchResultCount === 'number' ? Math.max(-1, Math.floor(ev.searchResultCount)) : -1,
        funnelStep: sanitize(ev.funnelStep, 40),
        interaction: sanitize(ev.interaction, 60),
        converted: ev.converted === true,
        deviceType: sanitize(ev.deviceType, 20),
      });
    }

    if (docs.length > 0) {
      await AnalyticsEvent.insertMany(docs, { ordered: false });
    }

    return res.status(204).end();
  } catch (err) {
    // Silent fail — analytics should never break the site
    console.error('[analytics] track error:', err.message);
    return res.status(204).end();
  }
}

/* ------------------------------------------------------------------ */
/*  Admin: analytics dashboard                                         */
/* ------------------------------------------------------------------ */

async function getAnalyticsDashboard(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;

    // Determine date range: custom (from/to) or preset (days)
    const fromParam = typeof req.query.from === 'string' ? req.query.from.trim() : '';
    const toParam = typeof req.query.to === 'string' ? req.query.to.trim() : '';
    const daysParam = parseInt(req.query.days, 10);

    let since, days, customFrom = '', customTo = '';
    const isCustom = /^\d{4}-\d{2}-\d{2}$/.test(fromParam) && /^\d{4}-\d{2}-\d{2}$/.test(toParam);

    if (isCustom) {
      since = new Date(fromParam + 'T00:00:00');
      const until = new Date(toParam + 'T23:59:59.999');
      // Validate dates
      if (isNaN(since.getTime()) || isNaN(until.getTime()) || since > until) {
        since = new Date();
        since.setDate(since.getDate() - 30);
        since.setHours(0, 0, 0, 0);
        days = 30;
      } else {
        days = Math.max(1, Math.ceil((until - since) / (1000 * 60 * 60 * 24)));
        customFrom = fromParam;
        customTo = toParam;
      }
    } else {
      days = daysParam > 0 && daysParam <= 365 ? daysParam : 30;
      since = new Date();
      since.setDate(since.getDate() - days);
      since.setHours(0, 0, 0, 0);
    }

    // Previous period for trend comparison (same duration before `since`)
    const prevSince = new Date(since);
    prevSince.setDate(prevSince.getDate() - days);

    const emptyTrend = { delta: null, label: 'Nouveau' };
    let data = {
      days,
      customFrom,
      customTo,
      conversionBySource: [],
      failedSearches: [],
      funnelSteps: [],
      productClicks: [],
      topPages: [],
      deviceBreakdown: { desktop: 0, mobile: 0, tablet: 0, total: 0, desktopPct: '0.0', mobilePct: '0.0', tabletPct: '0.0' },
      dailyTraffic: [],
      commercialKpis: { revenue: 0, orderCount: 0, avgBasket: 0, conversionRate: 0 },
      totalSessions: 0,
      totalPageviews: 0,
      totalSearches: 0,
      trends: {
        pageviews: emptyTrend,
        sessions: emptyTrend,
        searches: emptyTrend,
        revenue: emptyTrend,
        orderCount: emptyTrend,
        avgBasket: emptyTrend,
        conversionRate: emptyTrend,
      },
    };

    if (dbConnected) {
      data = await buildDashboardData(since, prevSince, days);
      data.customFrom = customFrom;
      data.customTo = customTo;
    }

    return res.render('admin/analytics', {
      active: 'analytics',
      ...data,
    });
  } catch (err) {
    return next(err);
  }
}

async function buildDashboardData(since, prevSince, days) {
  // Run all aggregations in parallel (current + previous period)
  const [
    conversionBySource,
    failedSearches,
    funnelRaw,
    productClicks,
    totals,
    dailyTraffic,
    commercialKpis,
    prevTotals,
    prevCommercialKpis,
    topPages,
    deviceBreakdown,
  ] = await Promise.all([
    // 1. Conversion rate by traffic source
    getConversionBySource(since),
    // 3. Searches with no results
    getFailedSearches(since),
    // 4. Funnel steps
    getFunnelSteps(since),
    // 5. Product interaction heatmap
    getProductClicks(since),
    // Totals
    getTotals(since),
    // 6. Daily traffic for chart
    getDailyTraffic(since, days),
    // 7. Commercial KPIs (CA, commandes, panier moyen)
    getCommercialKpis(since),
    // Previous period totals for trends
    getTotalsForRange(prevSince, since),
    getCommercialKpis(prevSince, since),
    // 8. Top pages
    getTopPages(since),
    // 9. Device breakdown
    getDeviceBreakdown(since),
  ]);

  // Calculate trends
  const trends = {
    pageviews: calcTrend(totals.totalPageviews, prevTotals.totalPageviews),
    sessions: calcTrend(totals.totalSessions, prevTotals.totalSessions),
    searches: calcTrend(totals.totalSearches, prevTotals.totalSearches),
    revenue: calcTrend(commercialKpis.revenue, prevCommercialKpis.revenue),
    orderCount: calcTrend(commercialKpis.orderCount, prevCommercialKpis.orderCount),
    avgBasket: calcTrend(commercialKpis.avgBasket, prevCommercialKpis.avgBasket),
    conversionRate: calcTrend(commercialKpis.conversionRate, prevCommercialKpis.conversionRate),
  };

  return {
    days,
    conversionBySource,
    failedSearches,
    funnelSteps: funnelRaw,
    productClicks,
    dailyTraffic,
    commercialKpis,
    topPages,
    deviceBreakdown,
    trends,
    ...totals,
  };
}

function calcTrend(current, previous) {
  if (previous === 0 && current === 0) return { delta: 0, label: '0.0' };
  if (previous === 0) return { delta: null, label: 'Nouveau' };
  const delta = ((current - previous) / previous) * 100;
  return { delta: parseFloat(delta.toFixed(1)), label: (delta >= 0 ? '+' : '') + delta.toFixed(1) };
}

/* --- 1. Taux de conversion par source de trafic --- */
async function getConversionBySource(since) {
  // Get all sessions with their source and whether they converted
  const result = await AnalyticsEvent.aggregate([
    { $match: { createdAt: { $gte: since }, type: 'pageview' } },
    {
      $group: {
        _id: '$sessionId',
        source: { $first: '$source' },
        medium: { $first: '$medium' },
        converted: { $max: { $cond: ['$converted', 1, 0] } },
      },
    },
    {
      $group: {
        _id: { source: { $ifNull: ['$source', 'direct'] }, medium: { $ifNull: ['$medium', ''] } },
        sessions: { $sum: 1 },
        conversions: { $sum: '$converted' },
      },
    },
    { $sort: { sessions: -1 } },
    { $limit: 15 },
  ]);

  return result.map((r) => ({
    source: r._id.source || 'direct',
    medium: r._id.medium || '(none)',
    sessions: r.sessions,
    conversions: r.conversions,
    rate: r.sessions > 0 ? ((r.conversions / r.sessions) * 100).toFixed(1) : '0.0',
  }));
}

/* --- 3. Recherches sans résultat --- */
async function getFailedSearches(since) {
  const result = await AnalyticsEvent.aggregate([
    {
      $match: {
        createdAt: { $gte: since },
        type: 'search',
        searchResultCount: 0,
      },
    },
    {
      $group: {
        _id: { $toLower: '$searchQuery' },
        count: { $sum: 1 },
        lastSearched: { $max: '$createdAt' },
      },
    },
    { $sort: { count: -1 } },
    { $limit: 30 },
  ]);

  return result.map((r) => ({
    query: r._id,
    count: r.count,
    lastSearched: r.lastSearched,
  }));
}

/* --- 4. Taux d'abandon par étape du tunnel --- */
async function getFunnelSteps(since) {
  const stepOrder = ['landing', 'product_view', 'add_to_cart', 'checkout_shipping', 'checkout_payment', 'order_confirmed'];
  const stepLabels = {
    landing: 'Page d\'accueil',
    product_view: 'Fiche produit',
    add_to_cart: 'Ajout au panier',
    checkout_shipping: 'Livraison',
    checkout_payment: 'Paiement',
    order_confirmed: 'Commande confirmée',
  };

  const result = await AnalyticsEvent.aggregate([
    { $match: { createdAt: { $gte: since }, type: 'funnel_step' } },
    {
      $group: {
        _id: '$sessionId',
        steps: { $addToSet: '$funnelStep' },
      },
    },
  ]);

  // Count how many sessions reached each step
  const stepCounts = {};
  for (const step of stepOrder) stepCounts[step] = 0;

  for (const session of result) {
    for (const step of stepOrder) {
      if (session.steps.includes(step)) {
        stepCounts[step]++;
      }
    }
  }

  const totalSessions = stepCounts.landing || 0;

  return stepOrder.map((step, i) => {
    const count = stepCounts[step];
    const prev = i > 0 ? stepCounts[stepOrder[i - 1]] : count;
    let dropoff = '—';
    if (i === 0) {
      dropoff = '—';
    } else if (prev > 0) {
      dropoff = (((prev - count) / prev) * 100).toFixed(1);
    }

    return {
      step,
      label: stepLabels[step] || step,
      count,
      percentage: totalSessions > 0 ? ((count / totalSessions) * 100).toFixed(1) : '—',
      dropoff,
    };
  });
}

/* --- 5. Clics / interactions sur les fiches produit --- */
async function getProductClicks(since) {
  const result = await AnalyticsEvent.aggregate([
    { $match: { createdAt: { $gte: since }, type: 'product_interaction' } },
    {
      $group: {
        _id: { interaction: '$interaction', productName: '$productName' },
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1 } },
    { $limit: 50 },
  ]);

  // Also get interaction summary (totals by type)
  const summary = await AnalyticsEvent.aggregate([
    { $match: { createdAt: { $gte: since }, type: 'product_interaction' } },
    {
      $group: {
        _id: '$interaction',
        count: { $sum: 1 },
        uniqueProducts: { $addToSet: '$productName' },
      },
    },
    { $sort: { count: -1 } },
  ]);

  const interactionLabels = {
    image_click: 'Clic sur image',
    description_expand: 'Lecture description',
    compatibility_check: 'Vérif. compatibilité',
    faq_expand: 'Ouverture FAQ',
    add_to_cart_click: 'Clic ajout panier',
    specs_view: 'Consultation specs',
  };

  return {
    details: result.map((r) => ({
      interaction: r._id.interaction,
      interactionLabel: interactionLabels[r._id.interaction] || r._id.interaction,
      productName: r._id.productName,
      count: r.count,
    })),
    summary: summary.map((r) => ({
      interaction: r._id,
      label: interactionLabels[r._id] || r._id,
      count: r.count,
      uniqueProducts: r.uniqueProducts ? r.uniqueProducts.length : 0,
    })),
  };
}

/* --- Totals --- */
async function getTotals(since) {
  const [pageviews, sessions, searches] = await Promise.all([
    AnalyticsEvent.countDocuments({ type: 'pageview', createdAt: { $gte: since } }),
    AnalyticsEvent.distinct('sessionId', { type: 'pageview', createdAt: { $gte: since } }).then((r) => r.length),
    AnalyticsEvent.countDocuments({ type: 'search', createdAt: { $gte: since } }),
  ]);

  return {
    totalPageviews: pageviews,
    totalSessions: sessions,
    totalSearches: searches,
  };
}

/* --- Totals for a specific range (previous period) --- */
async function getTotalsForRange(from, to) {
  const filter = { createdAt: { $gte: from, $lt: to } };
  const [pageviews, sessions, searches] = await Promise.all([
    AnalyticsEvent.countDocuments({ type: 'pageview', ...filter }),
    AnalyticsEvent.distinct('sessionId', { type: 'pageview', ...filter }).then((r) => r.length),
    AnalyticsEvent.countDocuments({ type: 'search', ...filter }),
  ]);

  return {
    totalPageviews: pageviews,
    totalSessions: sessions,
    totalSearches: searches,
  };
}

/* --- 7. KPIs commerciaux (CA, commandes, panier moyen, taux de conversion) --- */
async function getCommercialKpis(since, until) {
  // Count paid/validated orders in the period
  const paidStatuses = ['paid', 'completed', 'captured'];
  const validOrderStatuses = ['paid', 'processing', 'shipped', 'delivered', 'completed'];

  const dateFilter = until ? { $gte: since, $lt: until } : { $gte: since };

  const result = await Order.aggregate([
    {
      $match: {
        createdAt: dateFilter,
        status: { $nin: ['draft', 'cancelled', 'refunded'] },
        archived: { $ne: true },
        deletedAt: null,
        $or: [
          { paymentStatus: { $in: paidStatuses } },
          { status: { $in: validOrderStatuses } },
        ],
      },
    },
    {
      $group: {
        _id: null,
        totalCents: { $sum: '$totalCents' },
        count: { $sum: 1 },
      },
    },
  ]);

  const row = result[0] || { totalCents: 0, count: 0 };
  const revenue = row.totalCents / 100;
  const orderCount = row.count;
  const avgBasket = orderCount > 0 ? revenue / orderCount : 0;

  // Get sessions count for conversion rate
  const sessionFilter = until
    ? { type: 'pageview', createdAt: { $gte: since, $lt: until } }
    : { type: 'pageview', createdAt: { $gte: since } };
  const sessionCount = await AnalyticsEvent.distinct('sessionId', sessionFilter).then((r) => r.length);

  const conversionRate = sessionCount > 0 ? (orderCount / sessionCount) * 100 : 0;

  return {
    revenue,
    orderCount,
    avgBasket,
    conversionRate,
  };
}

/* --- 9. Répartition par appareil --- */
async function getDeviceBreakdown(since) {
  const result = await AnalyticsEvent.aggregate([
    {
      $match: {
        createdAt: { $gte: since },
        type: 'pageview',
        deviceType: { $in: ['desktop', 'mobile', 'tablet'] },
      },
    },
    {
      $group: {
        _id: '$sessionId',
        deviceType: { $first: '$deviceType' },
      },
    },
    {
      $group: {
        _id: '$deviceType',
        count: { $sum: 1 },
      },
    },
    { $sort: { count: -1 } },
  ]);

  const map = { desktop: 0, mobile: 0, tablet: 0 };
  for (const r of result) {
    if (map.hasOwnProperty(r._id)) map[r._id] = r.count;
  }

  const total = map.desktop + map.mobile + map.tablet;

  return {
    desktop: map.desktop,
    mobile: map.mobile,
    tablet: map.tablet,
    total,
    desktopPct: total > 0 ? ((map.desktop / total) * 100).toFixed(1) : '0.0',
    mobilePct: total > 0 ? ((map.mobile / total) * 100).toFixed(1) : '0.0',
    tabletPct: total > 0 ? ((map.tablet / total) * 100).toFixed(1) : '0.0',
  };
}

/* --- 8. Top pages visitées --- */
async function getTopPages(since) {
  const result = await AnalyticsEvent.aggregate([
    { $match: { createdAt: { $gte: since }, type: 'pageview' } },
    {
      $group: {
        _id: '$page',
        views: { $sum: 1 },
        uniqueVisitors: { $addToSet: '$sessionId' },
      },
    },
    { $sort: { views: -1 } },
    { $limit: 10 },
  ]);

  // Try to resolve product names for product URLs
  const Product = require('../models/Product');
  const pages = [];

  for (const r of result) {
    const page = r._id || '/';
    const views = r.views;
    const visitors = r.uniqueVisitors ? r.uniqueVisitors.length : 0;

    let productName = '';
    let isProduct = false;

    // Match product URLs like /product/some-slug/ or /produits/some-slug/
    const productMatch = page.match(/^\/(en\/)?(product|produits)\/([^/]+)/);
    if (productMatch) {
      isProduct = true;
      const slug = productMatch[3];
      try {
        const product = await Product.findOne({ slug }).select('name').lean();
        if (product) productName = product.name;
      } catch (e) { /* ignore */ }
    }

    pages.push({
      page,
      views,
      visitors,
      isProduct,
      productName,
    });
  }

  return pages;
}

/* --- 6. Trafic quotidien pour graphique --- */
async function getDailyTraffic(since, days) {
  const result = await AnalyticsEvent.aggregate([
    { $match: { createdAt: { $gte: since }, type: 'pageview' } },
    {
      $group: {
        _id: {
          date: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        },
        pageviews: { $sum: 1 },
        sessions: { $addToSet: '$sessionId' },
      },
    },
    { $sort: { '_id.date': 1 } },
  ]);

  // Build a map of existing data
  const dataMap = {};
  for (const r of result) {
    dataMap[r._id.date] = {
      date: r._id.date,
      pageviews: r.pageviews,
      sessions: r.sessions ? r.sessions.length : 0,
    };
  }

  // Fill in all days in the range (including days with 0 traffic)
  const output = [];
  const current = new Date(since);
  const now = new Date();
  now.setHours(23, 59, 59, 999);

  while (current <= now) {
    const key = current.toISOString().slice(0, 10);
    output.push(dataMap[key] || { date: key, pageviews: 0, sessions: 0 });
    current.setDate(current.getDate() + 1);
  }

  return output;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function sanitize(value, maxLen) {
  if (typeof value !== 'string') return '';
  return value.trim().slice(0, maxLen);
}

function isObjectId(value) {
  if (!value) return false;
  return mongoose.Types.ObjectId.isValid(value);
}

/* ------------------------------------------------------------------ */
/*  POST: add search synonym to a product                              */
/* ------------------------------------------------------------------ */

async function postAddSynonym(req, res) {
  try {
    const Product = require('../models/Product');
    const terme = sanitize(req.body.terme, 200).toLowerCase();
    const productId = sanitize(req.body.product_id, 30);

    if (!terme || !productId || !mongoose.Types.ObjectId.isValid(productId)) {
      return res.status(400).json({ ok: false, error: 'Terme et product_id requis.' });
    }

    const product = await Product.findById(productId);
    if (!product) {
      return res.status(404).json({ ok: false, error: 'Produit introuvable.' });
    }

    // Add synonym if not already present
    if (!product.searchSynonyms) product.searchSynonyms = [];
    if (!product.searchSynonyms.includes(terme)) {
      product.searchSynonyms.push(terme);
      await product.save();
    }

    return res.json({ ok: true, terme, productName: product.name });
  } catch (err) {
    console.error('[analytics] synonym error:', err.message);
    return res.status(500).json({ ok: false, error: 'Erreur serveur.' });
  }
}

module.exports = {
  postTrackEvent,
  getAnalyticsDashboard,
  postAddSynonym,
};
