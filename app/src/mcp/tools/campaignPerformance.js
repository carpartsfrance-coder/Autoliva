'use strict';

const { getMarketingDashboardData } = require('../../services/marketingAggregations');
const { eurFromCents, jsonResult } = require('../util/format');

const definition = {
  name: 'getCampaignPerformance',
  description:
    "Performance par campagne et source de trafic : visites uniques, commandes, CA, panier moyen, taux de conversion. Inclut les campagnes UTM nommées + les buckets virtuels (Google Ads sans UTM, Facebook Ads sans UTM, Microsoft Ads sans UTM, trafic organique, assistants IA, sites référents, direct, commandes web sans source, commandes hors site). Choix du modèle d'attribution : 'last' (dernier clic ; garde un gclid jusqu'à 90 jours, donc favorise la pub, par défaut), 'first' (premier clic) ou 'visit' (dernière arrivée avant la commande, sans favoriser la pub : le plus juste pour comparer pub et gratuit, rempli pour les commandes depuis novembre 2026). Les visites directes sans référent ne sont pas comptées ; le chiffre exact des clics Google gratuits est dans Search Console. À utiliser pour 'quelles campagnes performent', 'où mettre le budget Google Ads', 'comparer SEO vs paid', 'quelle source convertit le mieux'.",
  inputSchema: {
    type: 'object',
    properties: {
      period: { type: 'string', enum: ['7d', '30d', '90d', '365d', 'all'], description: "Période d'analyse. Défaut : 30d." },
      attributionModel: { type: 'string', enum: ['last', 'first', 'visit'], description: "Modèle d'attribution. Défaut : last." },
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
