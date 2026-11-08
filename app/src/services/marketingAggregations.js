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
const { FILTRE_VISITES_COMPTEES, ORGANIC_REFERRER_REGEX, AI_REFERRER_REGEX } = require('./sourceVisite');

const PAID_ORDER_STATUSES = ['paid', 'processing', 'label_created', 'shipped', 'delivered', 'completed'];

const ALLOWED_PERIODS = new Set(['7d', '30d', '90d', '365d', 'all']);
const DEFAULT_PERIOD = '30d';

// 'visit' : la source de la visite où la commande a été passée (Order.attribution.visitTouch).
const ALLOWED_MODELS = new Set(['last', 'first', 'visit']);
const DEFAULT_MODEL = 'last';

const ALLOWED_SORT_FIELDS = new Set(['campaign', 'visits', 'orders', 'revenue', 'aov', 'conversionRate']);
const DEFAULT_SORT_FIELD = 'revenue';
const DEFAULT_SORT_DIR = 'desc';

// Sentinelles pour les buckets virtuels (apparaissent dans `row.bucket`).
const BUCKET_LEGACY = '__legacy__';      // Commande web sans source connue (visite directe, ou avant le suivi)
const BUCKET_OFFLINE = '__offline__';    // Commande hors site : téléphone, WhatsApp, saisie manuelle…
const BUCKET_DIRECT = '__direct__';      // Vrai direct (referrer vide, pas d'UTM, pas de clickid)
const BUCKET_ORGANIC = '__organic__';    // SEO : referrer = moteur de recherche, pas d'UTM, pas de clickid
const BUCKET_AI = '__ai__';              // Assistant IA (ChatGPT, Perplexity…) sans UTM
const BUCKET_REFERRAL = '__referral__';  // Autre site référent, sans UTM
const BUCKET_GADS_NO_UTM = '__gads__';   // Google Ads gclid sans UTM
const BUCKET_FB_NO_UTM = '__fb__';       // Facebook Ads fbclid sans UTM
const BUCKET_MS_NO_UTM = '__msads__';    // Microsoft Ads msclkid sans UTM
const VIRTUAL_BUCKETS = new Set([BUCKET_LEGACY, BUCKET_OFFLINE, BUCKET_DIRECT, BUCKET_ORGANIC, BUCKET_AI, BUCKET_REFERRAL, BUCKET_GADS_NO_UTM, BUCKET_FB_NO_UTM, BUCKET_MS_NO_UTM]);

// Regex des référents (moteurs, assistants IA) : src/services/sourceVisite.js.
// Un référent vers nos propres domaines n'est pas une source.
const OWN_REFERRER_REGEX = /^https?:\/\/(?:[a-z0-9-]+\.)*autoliva\.(com|fr|de)(?:[\/?#:]|$)/i;

// Drapeaux de référent, communs aux visites et aux commandes.
function referrerFlags(path) {
  const ref = { $ifNull: [path, ''] };
  return {
    hasOrganicReferrer: { $cond: [{ $regexMatch: { input: ref, regex: ORGANIC_REFERRER_REGEX } }, true, false] },
    hasAiReferrer: { $cond: [{ $regexMatch: { input: ref, regex: AI_REFERRER_REGEX } }, true, false] },
    hasExternalReferrer: {
      $cond: [
        { $and: [{ $ne: [ref, ''] }, { $not: [{ $regexMatch: { input: ref, regex: OWN_REFERRER_REGEX } }] }] },
        true,
        false,
      ],
    },
  };
}

function getStartDateForPeriod(period) {
  if (period === 'all') return null;
  const days = { '7d': 7, '30d': 30, '90d': 90, '365d': 365 }[period];
  if (!days) return null;
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  start.setDate(start.getDate() - days);
  return start;
}

function pad2(n) { return String(n).padStart(2, '0'); }
function fmtYmd(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }

// Parse une date 'YYYY-MM-DD' en Date locale (minuit), en rejetant les dates
// invalides type 2026-02-31 (Date les « roule » sinon).
function parseYmd(s) {
  if (typeof s !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s.trim());
  if (!m) return null;
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(y, mo - 1, d);
  if (dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return null;
  return dt;
}

// Résout la plage de dates effective. Une période PERSONNALISÉE (from+to valides,
// from <= to) prend la priorité sur le preset. Sinon on retombe sur le preset
// (ou le défaut). Retourne aussi from/to formatés pour ré-afficher les champs.
function resolveDateRange({ period, from, to } = {}) {
  const fromDt = parseYmd(from);
  const toDt = parseYmd(to);
  if (fromDt && toDt && fromDt.getTime() <= toDt.getTime()) {
    const start = new Date(fromDt); start.setHours(0, 0, 0, 0);
    const end = new Date(toDt); end.setHours(23, 59, 59, 999);
    return { period: 'custom', startDate: start, endDate: end, from: fmtYmd(start), to: fmtYmd(toDt) };
  }
  const safePeriod = ALLOWED_PERIODS.has(period) ? period : DEFAULT_PERIOD;
  return { period: safePeriod, startDate: getStartDateForPeriod(safePeriod), endDate: null, from: '', to: '' };
}

// Construit le filtre Mongo sur createdAt (borne basse et/ou haute incluse).
function createdAtFilter(startDate, endDate) {
  const f = {};
  if (startDate) f.$gte = startDate;
  if (endDate) f.$lte = endDate;
  return Object.keys(f).length ? f : null;
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

// Pipeline visites : groupe par UTM + flags "auto-tag" et référent, compte
// les sessions distinctes.
async function aggregateVisits(startDate, endDate) {
  // Visites gratuites : seulement celles confirmées par le navigateur (robots
  // et préchargements exclus, voir captureAttribution).
  const match = { ...FILTRE_VISITES_COMPTEES };
  const ca = createdAtFilter(startDate, endDate);
  if (ca) match.createdAt = ca;

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
          ...referrerFlags('$referrer'),
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
        hasAiReferrer: '$_id.hasAiReferrer',
        hasExternalReferrer: '$_id.hasExternalReferrer',
        visits: { $size: '$sessions' },
      },
    },
  ];

  return AttributionTouch.aggregate(pipeline);
}

function touchFieldForModel(model) {
  if (model === 'first') return 'attribution.firstTouch';
  if (model === 'visit') return 'attribution.visitTouch';
  return 'attribution.lastTouch';
}

async function aggregateOrders(startDate, endDate, model) {
  const touchField = touchFieldForModel(model);
  const match = {
    paymentStatus: 'paid',
    status: { $in: PAID_ORDER_STATUSES },
    deletedAt: null,
  };
  const ca = createdAtFilter(startDate, endDate);
  if (ca) match.createdAt = ca;

  const pipeline = [
    { $match: match },
    {
      $group: {
        _id: {
          campaign: { $ifNull: [`$${touchField}.utmCampaign`, ''] },
          source: { $ifNull: [`$${touchField}.utmSource`, ''] },
          medium: { $ifNull: [`$${touchField}.utmMedium`, ''] },
          hasAttribution: { $cond: [{ $ifNull: [`$${touchField}`, false] }, true, false] },
          // Commande hors site (téléphone, WhatsApp, saisie admin) : elle n'a
          // jamais eu de visite à rattacher.
          isOffline: {
            $cond: [
              {
                $or: [
                  { $eq: [{ $ifNull: ['$isManual', false] }, true] },
                  { $ne: [{ $ifNull: ['$source.channel', 'website'] }, 'website'] },
                ],
              },
              true,
              false,
            ],
          },
          hasGclid: { $cond: [{ $and: [{ $ifNull: [`$${touchField}.gclid`, false] }, { $ne: [`$${touchField}.gclid`, ''] }] }, true, false] },
          hasGbraid: { $cond: [{ $and: [{ $ifNull: [`$${touchField}.gbraid`, false] }, { $ne: [`$${touchField}.gbraid`, ''] }] }, true, false] },
          hasWbraid: { $cond: [{ $and: [{ $ifNull: [`$${touchField}.wbraid`, false] }, { $ne: [`$${touchField}.wbraid`, ''] }] }, true, false] },
          hasFbclid: { $cond: [{ $and: [{ $ifNull: [`$${touchField}.fbclid`, false] }, { $ne: [`$${touchField}.fbclid`, ''] }] }, true, false] },
          hasMsclkid: { $cond: [{ $and: [{ $ifNull: [`$${touchField}.msclkid`, false] }, { $ne: [`$${touchField}.msclkid`, ''] }] }, true, false] },
          ...referrerFlags(`$${touchField}.referrer`),
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
        isOffline: '$_id.isOffline',
        hasGclid: '$_id.hasGclid',
        hasGbraid: '$_id.hasGbraid',
        hasWbraid: '$_id.hasWbraid',
        hasFbclid: '$_id.hasFbclid',
        hasMsclkid: '$_id.hasMsclkid',
        hasOrganicReferrer: '$_id.hasOrganicReferrer',
        hasAiReferrer: '$_id.hasAiReferrer',
        hasExternalReferrer: '$_id.hasExternalReferrer',
        orders: 1,
        revenueCents: 1,
      },
    },
  ];

  return Order.aggregate(pipeline);
}

function bucketRow(bucket) {
  return { key: bucket, bucket, campaign: '', source: '', medium: '' };
}

// Classification d'une ligne brute (visite OU commande) en bucket d'affichage.
// Retourne { key, bucket, campaign, source, medium }.
//
// @param row    le résultat brut de l'agrégation
// @param hasAttr `true` si le champ Order.attribution.<touch> existait pour la commande.
//                Pour les visites, toujours `true` (car AttributionTouch existe par définition).
function classifyRow(row, hasAttr) {
  if (!hasAttr) {
    // Une commande téléphone / WhatsApp / saisie admin n'a pas de visite :
    // on la sépare des commandes web dont la source est inconnue.
    return bucketRow(row.isOffline ? BUCKET_OFFLINE : BUCKET_LEGACY);
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
  if (row.hasGclid || row.hasGbraid || row.hasWbraid) return bucketRow(BUCKET_GADS_NO_UTM);
  if (row.hasFbclid) return bucketRow(BUCKET_FB_NO_UTM);
  if (row.hasMsclkid) return bucketRow(BUCKET_MS_NO_UTM);

  // Pas d'UTM, pas de clickid : on regarde d'où vient la visite.
  if (row.hasOrganicReferrer) return bucketRow(BUCKET_ORGANIC);
  if (row.hasAiReferrer) return bucketRow(BUCKET_AI);
  if (row.hasExternalReferrer) return bucketRow(BUCKET_REFERRAL);

  // Aucun identifiant : vrai direct (URL tapée, favoris, app email, etc.)
  return bucketRow(BUCKET_DIRECT);
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
    return { displayLabel: 'Commandes web sans source', displaySource: '(direct ou avant suivi)', displayBadge: 'slate', displayIcon: 'history', isVirtual: true, isCampaign: false };
  }
  if (row.bucket === BUCKET_OFFLINE) {
    return { displayLabel: 'Commandes hors site', displaySource: 'Téléphone, WhatsApp…', displayBadge: 'slate', displayIcon: 'call', isVirtual: true, isCampaign: false };
  }
  if (row.bucket === BUCKET_AI) {
    return { displayLabel: 'Assistants IA', displaySource: 'ChatGPT, Perplexity…', displayBadge: 'emerald', displayIcon: 'smart_toy', isVirtual: true, isCampaign: false };
  }
  if (row.bucket === BUCKET_REFERRAL) {
    return { displayLabel: 'Sites référents', displaySource: 'Liens depuis d\'autres sites', displayBadge: 'emerald', displayIcon: 'link', isVirtual: true, isCampaign: false };
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

async function getMarketingDashboardData({ period = DEFAULT_PERIOD, model = DEFAULT_MODEL, sortField, sortDir, from, to } = {}) {
  const range = resolveDateRange({ period, from, to });
  const safeModel = ALLOWED_MODELS.has(model) ? model : DEFAULT_MODEL;

  const [visitsRaw, ordersRaw] = await Promise.all([
    aggregateVisits(range.startDate, range.endDate),
    aggregateOrders(range.startDate, range.endDate, safeModel),
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

  // Les commandes sans source (web inconnue, hors site) ne sont jamais incluses
  // dans les totaux : elles n'ont pas de visite en face.
  // Tout le reste (organique, IA, référents, sans UTM, campagnes) est inclus.
  const totals = rows.reduce(
    (acc, r) => {
      if (r.bucket === BUCKET_LEGACY || r.bucket === BUCKET_OFFLINE) return acc;
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
    period: range.period,
    from: range.from,
    to: range.to,
    model: safeModel,
    sortField: ALLOWED_SORT_FIELDS.has(sortField) ? sortField : DEFAULT_SORT_FIELD,
    sortDir: sortDir === 'asc' ? 'asc' : 'desc',
    startDate: range.startDate,
    endDate: range.endDate,
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
  classifyRow,
  touchFieldForModel,
  BUCKET_LEGACY,
  BUCKET_OFFLINE,
  BUCKET_DIRECT,
  BUCKET_ORGANIC,
  BUCKET_AI,
  BUCKET_REFERRAL,
  BUCKET_GADS_NO_UTM,
  BUCKET_FB_NO_UTM,
  BUCKET_MS_NO_UTM,
  VIRTUAL_BUCKETS,
};
