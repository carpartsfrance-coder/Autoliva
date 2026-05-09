'use strict';

const { getMarketingDashboardData } = require('../../services/marketingAggregations');
const { eurFromCents, jsonResult } = require('../util/format');

const definition = {
  name: 'getCampaignPerformance',
  description:
    "Performance par campagne et source de trafic : visites uniques, commandes, CA, panier moyen, taux de conversion. Inclut les campagnes UTM nommées + les buckets virtuels (Google Ads sans UTM, Facebook Ads sans UTM, Microsoft Ads sans UTM, Direct/SEO, pré-tracking). Choix du modèle d'attribution : 'last' (dernier clic, par défaut) ou 'first' (premier clic). À utiliser pour 'quelles campagnes performent', 'où mettre le budget Google Ads', 'comparer SEO vs paid', 'quelle source convertit le mieux'.",
  inputSchema: {
    type: 'object',
    properties: {
      period: { type: 'string', enum: ['7d', '30d', '90d', '365d', 'all'], description: "Période d'analyse. Défaut : 30d." },
      attributionModel: { type: 'string', enum: ['last', 'first'], description: "Modèle d'attribution. Défaut : last." },
      sortBy: {
        type: 'string',
        enum: ['revenue', 'orders', 'visits', 'aov', 'conversionRate', 'campaign'],
        description: 'Critère de tri. Défaut : revenue.',
      },
      sortDir: { type: 'string', enum: ['asc', 'desc'], description: 'Sens du tri. Défaut : desc.' },
    },
    additionalProperties: false,
  },
};

async function handler(args = {}) {
  const data = await getMarketingDashboardData({
    period: args.period,
    model: args.attributionModel,
    sortField: args.sortBy,
    sortDir: args.sortDir,
  });

  const rows = data.rows.map((r) => ({
    label: r.displayLabel,
    bucket: r.bucket,
    isVirtualBucket: !!r.bucket,
    campaign: r.campaign,
    source: r.source,
    medium: r.medium,
    visits: r.visits,
    orders: r.orders,
    revenueEur: eurFromCents(r.revenueCents),
    aovEur: eurFromCents(r.aovCents),
    conversionRatePct: Number((r.conversionRate * 100).toFixed(2)),
  }));

  return jsonResult({
    period: data.period,
    attributionModel: data.model,
    sortBy: data.sortField,
    sortDir: data.sortDir,
    startDate: data.startDate,
    totals: {
      visits: data.totals.visits,
      orders: data.totals.orders,
      revenueEur: eurFromCents(data.totals.revenueCents),
      aovEur: eurFromCents(data.totals.aovCents),
      conversionRatePct: Number((data.totals.conversionRate * 100).toFixed(2)),
    },
    rowsCount: rows.length,
    rows,
  });
}

module.exports = { definition, handler };
