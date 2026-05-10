'use strict';

// Agrégations marketing pour le dashboard /admin/marketing :
//   - visites uniques par campagne (depuis AttributionTouch)
//   - commandes + CA par campagne (depuis Order.attribution.<lastTouch|firstTouch>)
//
// On merge ensuite côté JS pour calculer AOV, taux de conversion,
// et compléter les campagnes "visites mais pas encore de vente".
//
// Subtilité : un clic Google Ads avec auto-tagging mais SANS UTM dans l'URL
// arrive avec un gclid mais campaign/source/medium vides. On le classe alors
// dans un bucket "Google Ads (sans UTM)" plutôt que dans Direct/SEO. Idem
// pour Facebook (fbclid) et Microsoft Ads (msclkid).

const Order = require('../models/Order');
const AttributionTouch = require('../models/AttributionTouch');

const PAID_ORDER_STATUSES = ['paid', 'processing', 'shipped', 'delivered', 'completed'];

const ALLOWED_PERIODS = new Set(['7d', '30d', '90d', '365d', 'all']);
const DEFAULT_PERIOD = '30d';

const ALLOWED_MODELS = new Set(['last', 'first']);
const DEFAULT_MODEL = 'last';

const ALLOWED_SORT_FIELDS = new Set(['campaign', 'visits', 'orders', 'revenue', 'aov', 'conversionRate']);
const DEFAULT_SORT_FIELD = 'revenue';
const DEFAULT_SORT_DIR = 'desc';

// Sentinelles pour les buckets virtuels (apparaissent dans `row.bucket`).
const BUCKET_LEGACY = '__legacy__';      // Commandes d'avant le tracking
const BUCKET_DIRECT = '__direct__';      // Vrai direct (referrer vide, pas d'UTM, pas de clickid)
const BUCKET_ORGANIC = '__organic__';    // SEO : referrer = moteur de recherche, pas d'UTM, pas de clickid
const BUCKET_GADS_NO_UTM = '__gads__';   // Google Ads gclid sans UTM
const BUCKET_FB_NO_UTM = '__fb__';       // Facebook Ads fbclid sans UTM
const BUCKET_MS_NO_UTM = '__msads__';    // Microsoft Ads msclkid sans UTM
const VIRTUAL_BUCKETS = new Set([BUCKET_LEGACY, BUCKET_DIRECT, BUCKET_ORGANIC, BUCKET_GADS_NO_UTM, BUCKET_FB_NO_UTM, BUCKET_MS_NO_UTM]);

// Regex Mongo : détecte les referrers issus de moteurs de recherche.
// Couvre Google (toutes TLD), Bing, DuckDuckGo, Brave, Qwant, Yahoo,
// Ecosia, Startpage, Lilo, Yandex (ya.ru inclus).
//
// Note : chaque hostname doit se terminer par un séparateur (/?#) ou la fin
// de string. Les TLD sont limitées à 2-4 chars pour éviter les faux
// positifs type "google.someshady.com".
const ORGANIC_REFERRER_REGEX = /^https?:\/\/(?:[a-z0-9-]+\.)*(google\.[a-z]{2,4}(?:\.[a-z]{2})?|bing\.com|duckduckgo\.com|search\.brave\.com|brave\.com|qwant\.com|[a-z]+\.search\.yahoo\.com|search\.yahoo\.com|yahoo\.com|ecosia\.org|startpage\.com|search\.lilo\.org|lilo\.org|yandex\.[a-z]{2,4}(?:\.[a-z]{2})?|ya\.ru)(?:[\/?#]|$)/i;

function getStartDateForPeriod(period) {
  if (period === 'all') return null;
  const days = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 }[period];
  if (!days) return null;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - days);
  return start;
}

function buildKey(campaign, source, medium) {
  return [campaign || '', source || '', medium || ''].join('||');
}

function emptyRow(key, campaign, source, medium, bucket) {
  return {
    key,
    bucket: bucket || null,
    campaign: campaign || '',
    source: source || '',
    medium: medium || '',
    visits: 0,
    orders: 0,
    revenueCents: 0,
  };
}

// Pipeline visites : groupe par UTM + flags "auto-tag" booléens, compte
// les sessions distinctes.
async function aggregateVisits(startDate) {
  const match = {};
  if (startDate) match.createdAt = { $gte: startDate };

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: {
          campaign: { $ifNull: ['$utmCampaign', ''] },
          source: { $ifNull: ['$utmSource', ''] },
          medium: { $ifNull: ['$utmMedium', ''] },
          hasGclid: { $cond: [{ $and: [{ $ifNull: ['$gclid', false] }, { $ne: ['$gclid', ''] }] }, true, false] },
          hasGbraid: { $cond: [{ $and: [{ $ifNull: ['$gbraid', false] }, { $ne: ['$gbraid', ''] }] }, true, false] },
          hasWbraid: { $cond: [{ $and: [{ $ifNull: ['$wbraid', false] }, { $ne: ['$wbraid', ''] }] }, true, false] },
          hasFbclid: { $cond: [{ $and: [{ $ifNull: ['$fbclid', false] }, { $ne: ['$fbclid', ''] }] }, true, false] },
          hasMsclkid: { $cond: [{ $and: [{ $ifNull: ['$msclkid', false] }, { $ne: ['$msclkid', ''] }] }, true, false] },
          hasOrganicReferrer: {
            $cond: [
              { $regexMatch: { input: { $ifNull: ['$referrer', ''] }, regex: ORGANIC_REFERRER_REGEX } },
              true,
              false,
            ],
          },
        },
        sessions: { $addToSet: '$sessionId' },
      },
    },
    {
      $project: {
        _id: 0,
        campaign: '$_id.campaign',
        source: '$_id.source',
        medium: '$_id.medium',
        hasGclid: '$_id.hasGclid',
        hasGbraid: '$_id.hasGbraid',
        hasWbraid: '$_id.hasWbraid',
        hasFbclid: '$_id.hasFbclid',
        hasMsclkid: '$_id.hasMsclkid',
        hasOrganicReferrer: '$_id.hasOrganicReferrer',
        visits: { $size: '$sessions' },
      },
    },
  ];

  return AttributionTouch.aggregate(pipeline);
}

async function aggregateOrders(startDate, model) {
  const touchField = model === 'first' ? 'attribution.firstTouch' : 'attribution.lastTouch';
  const match = {
    paymentStatus: 'paid',
    status: { $in: PAID_ORDER_STATUSES },
    deletedAt: null,
  };
  if (startDate) match.createdAt = { $gte: startDate };

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: {
          campaign: { $ifNull: [`$${touchField}.utmCampaign`, ''] },
          source: { $ifNull: [`$${touchField}.utmSource`, ''] },
          medium: { $ifNull: [`$${touchField}.utmMedium`, ''] },
          hasAttribution: { $cond: [{ $ifNull: [`$${touchField}`, false] }, true, false] },
          hasGclid: { $cond: [{ $and: [{ $ifNull: [`$${touchField}.gclid`, false] }, { $ne: [`$${touchField}.gclid`, ''] }] }, true, false] },
          hasGbraid: { $cond: [{ $and: [{ $ifNull: [`$${touchField}.gbraid`, false] }, { $ne: [`$${touchField}.gbraid`, ''] }] }, true, false] },
          hasWbraid: { $cond: [{ $and: [{ $ifNull: [`$${touchField}.wbraid`, false] }, { $ne: [`$${touchField}.wbraid`, ''] }] }, true, false] },
          hasFbclid: { $cond: [{ $and: [{ $ifNull: [`$${touchField}.fbclid`, false] }, { $ne: [`$${touchField}.fbclid`, ''] }] }, true, false] },
          hasMsclkid: { $cond: [{ $and: [{ $ifNull: [`$${touchField}.msclkid`, false] }, { $ne: [`$${touchField}.msclkid`, ''] }] }, true, false] },
          hasOrganicReferrer: {
            $cond: [
              { $regexMatch: { input: { $ifNull: [`$${touchField}.referrer`, ''] }, regex: ORGANIC_REFERRER_REGEX } },
              true,
              false,
            ],
          },
        },
        orders: { $sum: 1 },
        revenueCents: { $sum: '$totalCents' },
      },
    },
    {
      $project: {
        _id: 0,
        campaign: '$_id.campaign',
        source: '$_id.source',
        medium: '$_id.medium',
        hasAttribution: '$_id.hasAttribution',
        hasGclid: '$_id.hasGclid',
        hasGbraid: '$_id.hasGbraid',
        hasWbraid: '$_id.hasWbraid',
        hasFbclid: '$_id.hasFbclid',
        hasMsclkid: '$_id.hasMsclkid',
        hasOrganicReferrer: '$_id.hasOrganicReferrer',
        orders: 1,
        revenueCents: 1,
      },
    },
  ];

  return Order.aggregate(pipeline);
}

// Classification d'une ligne brute (visite OU commande) en bucket d'affichage.
// Retourne { key, bucket, campaign, source, medium }.
//
// @param row    le résultat brut de l'agrégation
// @param hasAttr `true` si le champ Order.attribution.<touch> existait pour la commande.
//                Pour les visites, toujours `true` (car AttributionTouch existe par définition).
function classifyRow(row, hasAttr) {
  if (!hasAttr) {
    return { key: BUCKET_LEGACY, bucket: BUCKET_LEGACY, campaign: '', source: '', medium: '' };
  }

  // Une UTM identifiable → ligne campagne normale
  if (row.campaign || row.source || row.medium) {
    return {
      key: buildKey(row.campaign, row.source, row.medium),
      bucket: null,
      campaign: row.campaign || '',
      source: row.source || '',
      medium: row.medium || '',
    };
  }

  // Pas d'UTM mais un identifiant de clic publicitaire → bucket "sans UTM"
  if (row.hasGclid || row.hasGbraid || row.hasWbraid) {
    return { key: BUCKET_GADS_NO_UTM, bucket: BUCKET_GADS_NO_UTM, campaign: '', source: '', medium: '' };
  }
  if (row.hasFbclid) {
    return { key: BUCKET_FB_NO_UTM, bucket: BUCKET_FB_NO_UTM, campaign: '', source: '', medium: '' };
  }
  if (row.hasMsclkid) {
    return { key: BUCKET_MS_NO_UTM, bucket: BUCKET_MS_NO_UTM, campaign: '', source: '', medium: '' };
  }

  // Pas d'UTM, pas de clickid, mais referrer = moteur de recherche → SEO organique
  if (row.hasOrganicReferrer) {
    return { key: BUCKET_ORGANIC, bucket: BUCKET_ORGANIC, campaign: '', source: '', medium: '' };
  }

  // Aucun identifiant : vrai direct (URL tapée, favoris, app email, etc.)
  return { key: BUCKET_DIRECT, bucket: BUCKET_DIRECT, campaign: '', source: '', medium: '' };
}

function buildSorter(field, dir) {
  const sign = dir === 'asc' ? 1 : -1;
  return (a, b) => {
    const f = ALLOWED_SORT_FIELDS.has(field) ? field : DEFAULT_SORT_FIELD;
    const aVirtual = !!a.bucket;
    const bVirtual = !!b.bucket;
    if (aVirtual && !bVirtual) return 1;
    if (!aVirtual && bVirtual) return -1;

    let av, bv;
    if (f === 'campaign') {
      av = (a.campaign || a.displayLabel || '').toLowerCase();
      bv = (b.campaign || b.displayLabel || '').toLowerCase();
      return av.localeCompare(bv) * sign;
    }
    if (f === 'visits') { av = a.visits; bv = b.visits; }
    else if (f === 'orders') { av = a.orders; bv = b.orders; }
    else if (f === 'revenue') { av = a.revenueCents; bv = b.revenueCents; }
    else if (f === 'aov') { av = a.aovCents; bv = b.aovCents; }
    else if (f === 'conversionRate') { av = a.conversionRate; bv = b.conversionRate; }
    else { av = a.revenueCents; bv = b.revenueCents; }

    if (av < bv) return -1 * sign;
    if (av > bv) return 1 * sign;
    return 0;
  };
}

// Renvoie les props d'affichage (label + couleur + icône) pour une ligne.
// Réutilisé par la vue, qui n'a alors plus aucune logique de classification.
function getDisplayProps(row) {
  if (row.bucket === BUCKET_LEGACY) {
    return { displayLabel: 'Pré-tracking', displaySource: '(pré-tracking)', displayBadge: 'slate', displayIcon: 'history', isVirtual: true, isCampaign: false };
  }
  if (row.bucket === BUCKET_DIRECT) {
    return { displayLabel: 'Direct', displaySource: '(direct)', displayBadge: 'slate', displayIcon: 'language', isVirtual: true, isCampaign: false };
  }
  if (row.bucket === BUCKET_ORGANIC) {
    return { displayLabel: 'Trafic organique (SEO)', displaySource: 'Moteurs de recherche', displayBadge: 'emerald', displayIcon: 'travel_explore', isVirtual: true, isCampaign: false };
  }
  if (row.bucket === BUCKET_GADS_NO_UTM) {
    return { displayLabel: 'Google Ads (sans UTM)', displaySource: 'Google Ads', displayBadge: 'amber', displayIcon: 'ads_click', isVirtual: true, isCampaign: false };
  }
  if (row.bucket === BUCKET_FB_NO_UTM) {
    return { displayLabel: 'Facebook Ads (sans UTM)', displaySource: 'Facebook Ads', displayBadge: 'blue', displayIcon: 'ads_click', isVirtual: true, isCampaign: false };
  }
  if (row.bucket === BUCKET_MS_NO_UTM) {
    return { displayLabel: 'Microsoft Ads (sans UTM)', displaySource: 'Microsoft Ads', displayBadge: 'sky', displayIcon: 'ads_click', isVirtual: true, isCampaign: false };
  }

  // Ligne campagne normale → délégué à classifyTouch (déjà testé)
  const { classifyTouch } = require('./attributionDisplay');
  const cls = classifyTouch({
    utmSource: row.source,
    utmMedium: row.medium,
    gclid: '',
    fbclid: '',
    msclkid: '',
  });
  return {
    displayLabel: cls.label,
    displaySource: row.source || cls.label,
    displayBadge: cls.badge,
    displayIcon: cls.icon,
    isVirtual: false,
    isCampaign: true,
  };
}

async function getMarketingDashboardData({ period = DEFAULT_PERIOD, model = DEFAULT_MODEL, sortField, sortDir } = {}) {
  const safePeriod = ALLOWED_PERIODS.has(period) ? period : DEFAULT_PERIOD;
  const safeModel = ALLOWED_MODELS.has(model) ? model : DEFAULT_MODEL;
  const startDate = getStartDateForPeriod(safePeriod);

  const [visitsRaw, ordersRaw] = await Promise.all([
    aggregateVisits(startDate),
    aggregateOrders(startDate, safeModel),
  ]);

  const rowsByKey = new Map();

  for (const v of visitsRaw) {
    const cls = classifyRow(v, true);
    if (!rowsByKey.has(cls.key)) rowsByKey.set(cls.key, emptyRow(cls.key, cls.campaign, cls.source, cls.medium, cls.bucket));
    rowsByKey.get(cls.key).visits += v.visits;
  }

  for (const o of ordersRaw) {
    const cls = classifyRow(o, o.hasAttribution);
    if (!rowsByKey.has(cls.key)) rowsByKey.set(cls.key, emptyRow(cls.key, cls.campaign, cls.source, cls.medium, cls.bucket));
    const row = rowsByKey.get(cls.key);
    row.orders += o.orders;
    row.revenueCents += o.revenueCents;
  }

  const rows = Array.from(rowsByKey.values()).map((r) => {
    const aovCents = r.orders > 0 ? Math.round(r.revenueCents / r.orders) : 0;
    const conversionRate = r.visits > 0 ? r.orders / r.visits : 0;
    const display = getDisplayProps(r);
    return { ...r, aovCents, conversionRate, ...display };
  });

  rows.sort(buildSorter(sortField || DEFAULT_SORT_FIELD, sortDir || DEFAULT_SORT_DIR));

  // Le pré-tracking n'est jamais inclus dans les totaux (chiffres d'avant la PR 1).
  // Tout le reste (Direct, sans UTM, campagnes nommées) est inclus.
  const totals = rows.reduce(
    (acc, r) => {
      if (r.bucket === BUCKET_LEGACY) return acc;
      acc.visits += r.visits;
      acc.orders += r.orders;
      acc.revenueCents += r.revenueCents;
      return acc;
    },
    { visits: 0, orders: 0, revenueCents: 0 }
  );
  totals.aovCents = totals.orders > 0 ? Math.round(totals.revenueCents / totals.orders) : 0;
  totals.conversionRate = totals.visits > 0 ? totals.orders / totals.visits : 0;

  return {
    period: safePeriod,
    model: safeModel,
    sortField: ALLOWED_SORT_FIELDS.has(sortField) ? sortField : DEFAULT_SORT_FIELD,
    sortDir: sortDir === 'asc' ? 'asc' : 'desc',
    startDate,
    rows,
    totals,
  };
}

module.exports = {
  getMarketingDashboardData,
  ALLOWED_PERIODS,
  ALLOWED_MODELS,
  ALLOWED_SORT_FIELDS,
  DEFAULT_PERIOD,
  DEFAULT_MODEL,
  DEFAULT_SORT_FIELD,
  DEFAULT_SORT_DIR,
  // Exposé pour les tests
  BUCKET_LEGACY,
  BUCKET_DIRECT,
  BUCKET_ORGANIC,
  BUCKET_GADS_NO_UTM,
  BUCKET_FB_NO_UTM,
  BUCKET_MS_NO_UTM,
  VIRTUAL_BUCKETS,
};
