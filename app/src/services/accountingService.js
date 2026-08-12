/*
 * accountingService — fournit toutes les données nécessaires à l'espace
 * comptable (/comptable) : KPI mensuels, listes paginées de factures /
 * avoirs / remboursements, détection d'anomalies, exports CSV + ZIP.
 *
 * Conventions :
 *  - Toutes les sommes sont stockées en CENTIMES (Number) en BDD.
 *    Les libellés exposés (CSV, vues) convertissent en EUR avec 2 décimales.
 *  - TVA appliquée par défaut : 20% sur le TTC (hardcodée comme dans
 *    invoicePdf.js — à dériver dynamiquement si on intègre un système
 *    multi-taux plus tard).
 *  - Une "facture" est un Order avec `invoice.number` non vide ET
 *    `invoice.issuedAt` rempli.
 *  - Un "avoir" vit dans Order.creditNotes[] (un Order peut en avoir 0..N).
 *  - Un "remboursement" vit dans Order.refunds[].
 */

const archiver = require('archiver');

const Order = require('../models/Order');
const User = require('../models/User');
const { buildOrderInvoicePdfBuffer } = require('./invoicePdf');
const { buildCreditNotePdfBuffer } = require('./creditNotePdf');

const TVA_RATE = 0.20;

function eur(cents) {
  const n = Number(cents) || 0;
  return (n / 100).toFixed(2);
}

/* `splitVat(totalCents)` a été retiré : il appliquait 20 % à n'importe quel
   montant, sans regarder le régime de la vente. C'est précisément l'hypothèse
   qui envoyait au comptable une TVA collectée qui n'était pas due. Le laisser
   exporté à côté de son remplaçant, c'est garantir qu'il resservira un jour.
   → utiliser `splitVatCommande(order[, montant])`. */

/** Le régime réellement appliqué à une vente, sous une forme stable pour la compta. */
function regimeDeCommande(order) {
  if (order && order.vat && order.vat.reverseCharge) return 'autoliquidation';
  if (String((order && order.vatScheme) || 'normal') === 'margin') return 'marge';
  return 'normal';
}

/**
 * Décompose une commande en HT + TVA — SELON SON RÉGIME.
 *
 * C'est le cœur du problème que ce module avait : il appliquait 20 % à tout,
 * y compris aux ventes sous marge et aux livraisons autoliquidées. Le CSV
 * partait donc chez le comptable avec une TVA collectée qui n'existait pas.
 *
 *  • normal            → 20 % sur le prix, consigne exclue de la base.
 *  • marge (297 A)     → 20 % sur (prix de vente − prix d'achat) SEULEMENT.
 *  • autoliquidation   → aucune TVA collectée, le preneur la déclare.
 *
 * `amountCents` permet de décomposer un AVOIR : la TVA à reverser suit la
 * même proportion que celle qui avait été collectée sur la vente. Sur une
 * vente sous marge, rembourser 50 % du prix ne reverse pas 50 % du prix en
 * TVA, mais 50 % de la TVA sur la marge — d'où le prorata plutôt qu'un
 * nouveau calcul sur le montant remboursé.
 *
 * Dans tous les cas HT + TVA = montant, pour que la balance du comptable tombe.
 */
function splitVatCommande(order, amountCents) {
  const totalCents = Number(order && order.totalCents) || 0;
  const montant = Number.isFinite(amountCents) ? Number(amountCents) : totalCents;
  const regime = regimeDeCommande(order);

  if (montant <= 0) return { htCents: 0, vatCents: 0, ttcCents: 0, regime, rate: 0 };

  if (regime === 'autoliquidation') {
    return { htCents: montant, vatCents: 0, ttcCents: montant, regime, rate: 0 };
  }

  /* Consigne = caution remboursable → hors base TVA. La facture PDF l'excluait
     déjà ; l'export ne le faisait pas. Les deux documents décrivent la même
     vente : ils ne peuvent pas annoncer deux TVA différentes. */
  const consigneCents = order && order.consigne && Number.isFinite(order.consigne.chargedTotalCents)
    ? order.consigne.chargedTotalCents
    : 0;
  const baseTotale = Math.max(0, totalCents - consigneCents);

  if (regime === 'marge') {
    const achatCents = order && order.purchase && Number.isFinite(order.purchase.priceCents)
      ? order.purchase.priceCents
      : 0;
    const margeCents = Math.max(0, baseTotale - achatCents);
    const tvaVente = Math.round(margeCents - margeCents / (1 + TVA_RATE));
    /* Prorata pour les avoirs (sur la vente entière, `montant` vaut le total
       et le ratio vaut 1). */
    const vatCents = totalCents > 0 ? Math.round(tvaVente * (montant / totalCents)) : 0;
    return { htCents: montant - vatCents, vatCents, ttcCents: montant, regime, rate: TVA_RATE };
  }

  const baseProratisee = totalCents > 0 ? baseTotale * (montant / totalCents) : 0;
  const vatCents = Math.round(baseProratisee - baseProratisee / (1 + TVA_RATE));
  return { htCents: montant - vatCents, vatCents, ttcCents: montant, regime, rate: TVA_RATE };
}

function getMonthRange(year, month) {
  const y = Number(year);
  const m = Number(month);
  if (!Number.isFinite(y) || !Number.isFinite(m) || m < 1 || m > 12) {
    const now = new Date();
    const from = new Date(now.getFullYear(), now.getMonth(), 1, 0, 0, 0, 0);
    const to = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
    return { from, to, year: from.getFullYear(), month: from.getMonth() + 1 };
  }
  const from = new Date(y, m - 1, 1, 0, 0, 0, 0);
  const to = new Date(y, m, 1, 0, 0, 0, 0);
  return { from, to, year: y, month: m };
}

function paymentMethodLabel(order) {
  if (!order) return '—';
  if (order.molliePaymentId) return 'Mollie';
  if (order.scalapayOrderToken) return 'Scalapay';
  if (order.paymentProvider) return order.paymentProvider;
  return '—';
}

function refundMethodLabel(method) {
  switch ((method || '').toLowerCase()) {
    case 'mollie': return 'Mollie';
    case 'scalapay': return 'Scalapay';
    case 'bank_transfer': return 'Virement';
    case 'cash': return 'Espèces';
    case 'other': return 'Autre';
    case 'manual': return 'Manuel';
    default: return method || '—';
  }
}

/* ════════════════════════════════════════════════════════════════
 * KPI dashboard — agrégations Mongo pour un mois donné
 * ════════════════════════════════════════════════════════════════ */

/**
 * Étapes d'agrégation qui posent `_tvaCents` sur chaque commande, selon son
 * régime — la transposition Mongo de `splitVatCommande()`.
 *
 * Le tableau de bord additionnait 20 % de tout ce qui passait. Il annonçait
 * donc une TVA collectée supérieure à la TVA réellement due dès qu'une vente
 * relevait de la marge ou de l'autoliquidation : le chiffre le plus regardé
 * du mois était le plus faux.
 *
 * TVA = base × 20/120, soit base ÷ 6.
 */
function etapesTvaParRegime() {
  const baseHorsConsigne = {
    $max: [0, { $subtract: [{ $ifNull: ['$totalCents', 0] }, { $ifNull: ['$consigne.chargedTotalCents', 0] }] }],
  };
  return [
    {
      $addFields: {
        _regime: {
          $cond: [
            { $eq: ['$vat.reverseCharge', true] },
            'autoliquidation',
            { $cond: [{ $eq: ['$vatScheme', 'margin'] }, 'marge', 'normal'] },
          ],
        },
        _baseCents: baseHorsConsigne,
      },
    },
    {
      $addFields: {
        _tvaCents: {
          $switch: {
            branches: [
              { case: { $eq: ['$_regime', 'autoliquidation'] }, then: 0 },
              {
                case: { $eq: ['$_regime', 'marge'] },
                then: {
                  $round: [{
                    $divide: [
                      { $max: [0, { $subtract: ['$_baseCents', { $ifNull: ['$purchase.priceCents', 0] }] }] },
                      6,
                    ],
                  }, 0],
                },
              },
            ],
            default: { $round: [{ $divide: ['$_baseCents', 6] }, 0] },
          },
        },
      },
    },
  ];
}

/**
 * Retourne les KPI principaux pour le mois donné.
 */
async function getMonthSummary(year, month) {
  const { from, to, year: y, month: m } = getMonthRange(year, month);

  /* Factures émises sur la période */
  const invoiceAgg = await Order.aggregate([
    { $match: { 'invoice.issuedAt': { $gte: from, $lt: to } } },
    ...etapesTvaParRegime(),
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        totalCents: { $sum: { $ifNull: ['$totalCents', 0] } },
        vatCents: { $sum: '$_tvaCents' },
      },
    },
  ]);
  const invoiceCount = invoiceAgg[0] ? invoiceAgg[0].count : 0;
  const invoiceTtcCents = invoiceAgg[0] ? invoiceAgg[0].totalCents : 0;
  const invoiceVatCents = invoiceAgg[0] ? invoiceAgg[0].vatCents : 0;
  const invoiceSplit = { ttcCents: invoiceTtcCents, vatCents: invoiceVatCents, htCents: invoiceTtcCents - invoiceVatCents };

  /* Avoirs émis sur la période */
  const creditNoteAgg = await Order.aggregate([
    { $match: { 'creditNotes.issuedAt': { $gte: from, $lt: to } } },
    { $unwind: '$creditNotes' },
    { $match: { 'creditNotes.issuedAt': { $gte: from, $lt: to } } },
    ...etapesTvaParRegime(),
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        totalCents: { $sum: { $ifNull: ['$creditNotes.totalCents', 0] } },
        /* La TVA à reverser suit la proportion de ce qui avait été collecté :
           un avoir de la moitié du prix annule la moitié de la TVA de la
           vente, pas 20 % du montant remboursé (faux sous le régime de la
           marge, et faux aussi sur une vente autoliquidée). */
        vatCents: {
          $sum: {
            $round: [{
              $multiply: [
                '$_tvaCents',
                {
                  $cond: [
                    { $gt: [{ $ifNull: ['$totalCents', 0] }, 0] },
                    { $divide: [{ $ifNull: ['$creditNotes.totalCents', 0] }, '$totalCents'] },
                    0,
                  ],
                },
              ],
            }, 0],
          },
        },
      },
    },
  ]);
  const creditNoteCount = creditNoteAgg[0] ? creditNoteAgg[0].count : 0;
  const creditNoteTtcCents = creditNoteAgg[0] ? creditNoteAgg[0].totalCents : 0;
  const creditNoteVatCents = creditNoteAgg[0] ? creditNoteAgg[0].vatCents : 0;
  const creditNoteSplit = {
    ttcCents: creditNoteTtcCents,
    vatCents: creditNoteVatCents,
    htCents: creditNoteTtcCents - creditNoteVatCents,
  };

  /* Remboursements émis sur la période */
  const refundAgg = await Order.aggregate([
    { $match: { 'refunds.createdAt': { $gte: from, $lt: to } } },
    { $unwind: '$refunds' },
    { $match: { 'refunds.createdAt': { $gte: from, $lt: to } } },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        totalCents: { $sum: { $ifNull: ['$refunds.amountCents', 0] } },
      },
    },
  ]);
  const refundCount = refundAgg[0] ? refundAgg[0].count : 0;
  const refundCents = refundAgg[0] ? refundAgg[0].totalCents : 0;

  /* CA net = factures TTC - avoirs TTC. La TVA nette se DÉDUIT des deux
     agrégats ci-dessus : la recalculer sur le net appliquerait 20 % à un
     montant dont on sait déjà qu'il mélange plusieurs régimes. */
  const netTtcCents = invoiceTtcCents - creditNoteTtcCents;
  const netVatCents = invoiceVatCents - creditNoteVatCents;
  const netSplit = { ttcCents: netTtcCents, vatCents: netVatCents, htCents: netTtcCents - netVatCents };

  return {
    year: y,
    month: m,
    from,
    to,
    invoices: {
      count: invoiceCount,
      ttcCents: invoiceTtcCents,
      htCents: invoiceSplit.htCents,
      vatCents: invoiceSplit.vatCents,
    },
    creditNotes: {
      count: creditNoteCount,
      ttcCents: creditNoteTtcCents,
      htCents: creditNoteSplit.htCents,
      vatCents: creditNoteSplit.vatCents,
    },
    refunds: {
      count: refundCount,
      amountCents: refundCents,
    },
    net: {
      ttcCents: netTtcCents,
      htCents: netSplit.htCents,
      vatCents: netSplit.vatCents,
    },
  };
}

/**
 * Tendance sur les 12 derniers mois (incluant le mois courant).
 * Sert au graphique du dashboard.
 */
async function getTwelveMonthTrend(referenceDate) {
  const ref = referenceDate instanceof Date ? referenceDate : new Date();
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(ref.getFullYear(), ref.getMonth() - i, 1);
    months.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }
  const summaries = await Promise.all(months.map((m) => getMonthSummary(m.year, m.month)));
  return summaries.map((s) => ({
    year: s.year,
    month: s.month,
    label: new Date(s.year, s.month - 1, 1).toLocaleString('fr-FR', { month: 'short', year: '2-digit' }),
    invoicesTtcCents: s.invoices.ttcCents,
    creditNotesTtcCents: s.creditNotes.ttcCents,
    netTtcCents: s.net.ttcCents,
  }));
}

/* ════════════════════════════════════════════════════════════════
 * Détection d'anomalies — pour le bloc "Santé compta"
 * ════════════════════════════════════════════════════════════════ */

/**
 * Liste les écarts détectés sur le mois (max 50 anomalies retournées
 * pour ne pas alourdir l'UI). Une anomalie = quelque chose qu'un
 * comptable ou owner devrait regarder de près.
 */
async function findAnomalies({ year, month } = {}) {
  const { from, to } = getMonthRange(year, month);
  const anomalies = [];

  /* 1. Commande payée depuis +24h sans facture émise */
  const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);
  const paidNoInvoice = await Order.find({
    paymentStatus: 'paid',
    'invoice.number': { $in: [null, ''] },
    molliePaidAt: { $lt: oneDayAgo },
    status: { $nin: ['draft', 'cancelled'] },
  })
    .select('_id number totalCents molliePaidAt')
    .limit(20)
    .lean();
  for (const o of paidNoInvoice) {
    anomalies.push({
      severity: 'high',
      kind: 'paid_without_invoice',
      orderId: String(o._id),
      orderNumber: o.number,
      message: `Commande ${o.number} payée depuis ${o.molliePaidAt ? new Date(o.molliePaidAt).toLocaleDateString('fr-FR') : '—'} mais aucune facture n'a été émise.`,
      amountCents: o.totalCents,
    });
  }

  /* 2. Remboursement émis sans avoir associé */
  const refundsNoCN = await Order.aggregate([
    { $match: { 'refunds.0': { $exists: true } } },
    { $unwind: '$refunds' },
    {
      $match: {
        'refunds.createdAt': { $gte: from, $lt: to },
        $or: [
          { 'refunds.creditNoteNumber': { $in: [null, ''] } },
          { 'refunds.creditNoteNumber': { $exists: false } },
        ],
      },
    },
    { $limit: 20 },
    {
      $project: {
        _id: 1,
        number: 1,
        refundAmount: '$refunds.amountCents',
        refundDate: '$refunds.createdAt',
        refundMethod: '$refunds.method',
      },
    },
  ]);
  for (const r of refundsNoCN) {
    anomalies.push({
      severity: 'high',
      kind: 'refund_without_credit_note',
      orderId: String(r._id),
      orderNumber: r.number,
      message: `Remboursement de ${eur(r.refundAmount)} € (${refundMethodLabel(r.refundMethod)}) sur ${r.number} sans avoir légal associé.`,
      amountCents: r.refundAmount,
    });
  }

  /* 3. Avoir sans PDF stocké (régénération nécessaire) */
  const cnNoPdf = await Order.aggregate([
    { $match: { 'creditNotes.0': { $exists: true } } },
    { $unwind: '$creditNotes' },
    {
      $match: {
        'creditNotes.issuedAt': { $gte: from, $lt: to },
        $or: [
          { 'creditNotes.pdfSizeBytes': { $in: [null, 0] } },
          { 'creditNotes.pdfSizeBytes': { $exists: false } },
        ],
      },
    },
    { $limit: 10 },
    {
      $project: {
        _id: 1,
        number: 1,
        cnNumber: '$creditNotes.number',
        cnTotal: '$creditNotes.totalCents',
      },
    },
  ]);
  for (const c of cnNoPdf) {
    anomalies.push({
      severity: 'medium',
      kind: 'credit_note_missing_pdf',
      orderId: String(c._id),
      orderNumber: c.number,
      message: `Avoir ${c.cnNumber} (${eur(c.cnTotal)} €) sans PDF stocké — sera régénéré à la volée au téléchargement.`,
      amountCents: c.cnTotal,
    });
  }

  /* Sort par sévérité (high d'abord) puis date */
  const severityRank = { high: 0, medium: 1, low: 2 };
  anomalies.sort((a, b) => (severityRank[a.severity] || 9) - (severityRank[b.severity] || 9));

  return anomalies.slice(0, 50);
}

/* ════════════════════════════════════════════════════════════════
 * Listes paginées
 * ════════════════════════════════════════════════════════════════ */

async function listInvoices({ from, to, page = 1, limit = 50, search = '' } = {}) {
  const query = {
    'invoice.number': { $nin: [null, ''] },
    'invoice.issuedAt': {},
  };
  if (from instanceof Date) query['invoice.issuedAt'].$gte = from;
  if (to instanceof Date) query['invoice.issuedAt'].$lt = to;
  if (!from && !to) delete query['invoice.issuedAt'];

  const trimmedSearch = typeof search === 'string' ? search.trim() : '';
  if (trimmedSearch) {
    const regex = new RegExp(trimmedSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    query.$or = [
      { 'invoice.number': regex },
      { number: regex },
      { 'billingAddress.fullName': regex },
    ];
  }

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(200, Math.max(10, Number(limit) || 50));
  const skip = (safePage - 1) * safeLimit;

  const [docs, total] = await Promise.all([
    Order.find(query)
      .sort({ 'invoice.issuedAt': -1 })
      .skip(skip)
      .limit(safeLimit)
      .select('_id number invoice totalCents accountType billingAddress molliePaymentId scalapayOrderToken paymentProvider creditNotes refunds vatScheme purchase vat consigne')
      .lean(),
    Order.countDocuments(query),
  ]);

  const rows = docs.map((order) => {
    const split = splitVatCommande(order);
    return {
      orderId: String(order._id),
      orderNumber: order.number,
      invoiceNumber: order.invoice && order.invoice.number ? order.invoice.number : '',
      issuedAt: order.invoice && order.invoice.issuedAt ? order.invoice.issuedAt : null,
      customer: order.billingAddress && order.billingAddress.fullName ? order.billingAddress.fullName : '—',
      country: order.billingAddress && order.billingAddress.country ? order.billingAddress.country : 'France',
      accountType: order.accountType || 'particulier',
      paymentMethod: paymentMethodLabel(order),
      ttcCents: order.totalCents || 0,
      htCents: split.htCents,
      vatCents: split.vatCents,
      regime: split.regime,
      purchaseCents: order.purchase && Number.isFinite(order.purchase.priceCents) ? order.purchase.priceCents : null,
      supplier: (order.purchase && order.purchase.supplier) || '',
      supplierInvoiceRef: (order.purchase && order.purchase.invoiceRef) || '',
      hasCreditNotes: Array.isArray(order.creditNotes) && order.creditNotes.length > 0,
      hasRefunds: Array.isArray(order.refunds) && order.refunds.length > 0,
    };
  });

  return {
    rows,
    total,
    page: safePage,
    limit: safeLimit,
    pageCount: Math.max(1, Math.ceil(total / safeLimit)),
  };
}

async function listCreditNotes({ from, to, page = 1, limit = 50, search = '' } = {}) {
  const matchStage = {};
  if (from instanceof Date || to instanceof Date) {
    matchStage['creditNotes.issuedAt'] = {};
    if (from instanceof Date) matchStage['creditNotes.issuedAt'].$gte = from;
    if (to instanceof Date) matchStage['creditNotes.issuedAt'].$lt = to;
  }

  const trimmedSearch = typeof search === 'string' ? search.trim() : '';
  let searchExpr = null;
  if (trimmedSearch) {
    const regex = new RegExp(trimmedSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    searchExpr = {
      $or: [
        { 'creditNotes.number': regex },
        { number: regex },
        { 'invoice.number': regex },
        { 'billingAddress.fullName': regex },
      ],
    };
  }

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(200, Math.max(10, Number(limit) || 50));
  const skip = (safePage - 1) * safeLimit;

  const pipeline = [
    { $match: { 'creditNotes.0': { $exists: true } } },
    { $unwind: '$creditNotes' },
  ];
  if (Object.keys(matchStage).length) pipeline.push({ $match: matchStage });
  if (searchExpr) pipeline.push({ $match: searchExpr });
  pipeline.push({ $sort: { 'creditNotes.issuedAt': -1 } });

  const [rowsRaw, totalArr] = await Promise.all([
    Order.aggregate([
      ...pipeline,
      { $skip: skip },
      { $limit: safeLimit },
      {
        $project: {
          _id: 1,
          number: 1,
          billingAddress: 1,
          invoice: 1,
          accountType: 1,
          /* Le régime de l'avoir est celui de la vente d'origine : un avoir ne
             requalifie pas l'opération, il l'annule en tout ou partie. */
          totalCents: 1,
          vatScheme: 1,
          purchase: 1,
          vat: 1,
          consigne: 1,
          creditNote: '$creditNotes',
        },
      },
    ]),
    Order.aggregate([
      ...pipeline,
      { $count: 'count' },
    ]),
  ]);

  const total = totalArr[0] ? totalArr[0].count : 0;
  const rows = rowsRaw.map((r) => {
    const split = splitVatCommande(r, r.creditNote.totalCents);
    return {
      orderId: String(r._id),
      orderNumber: r.number,
      regime: split.regime,
      creditNoteNumber: r.creditNote.number || '',
      issuedAt: r.creditNote.issuedAt || null,
      invoiceNumber: r.invoice && r.invoice.number ? r.invoice.number : '',
      reason: r.creditNote.reason || '',
      customer: r.billingAddress && r.billingAddress.fullName ? r.billingAddress.fullName : '—',
      country: r.billingAddress && r.billingAddress.country ? r.billingAddress.country : 'France',
      accountType: r.accountType || 'particulier',
      ttcCents: r.creditNote.totalCents || 0,
      htCents: split.htCents,
      vatCents: split.vatCents,
      hasPdf: !!(r.creditNote.pdfSizeBytes && r.creditNote.pdfSizeBytes > 0),
    };
  });

  return {
    rows,
    total,
    page: safePage,
    limit: safeLimit,
    pageCount: Math.max(1, Math.ceil(total / safeLimit)),
  };
}

async function listRefunds({ from, to, page = 1, limit = 50, search = '' } = {}) {
  const matchStage = {};
  if (from instanceof Date || to instanceof Date) {
    matchStage['refunds.createdAt'] = {};
    if (from instanceof Date) matchStage['refunds.createdAt'].$gte = from;
    if (to instanceof Date) matchStage['refunds.createdAt'].$lt = to;
  }

  const trimmedSearch = typeof search === 'string' ? search.trim() : '';
  let searchExpr = null;
  if (trimmedSearch) {
    const regex = new RegExp(trimmedSearch.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    searchExpr = {
      $or: [
        { 'refunds.creditNoteNumber': regex },
        { 'refunds.providerRefundId': regex },
        { number: regex },
        { 'invoice.number': regex },
        { 'billingAddress.fullName': regex },
      ],
    };
  }

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(200, Math.max(10, Number(limit) || 50));
  const skip = (safePage - 1) * safeLimit;

  const pipeline = [
    { $match: { 'refunds.0': { $exists: true } } },
    { $unwind: '$refunds' },
  ];
  if (Object.keys(matchStage).length) pipeline.push({ $match: matchStage });
  if (searchExpr) pipeline.push({ $match: searchExpr });
  pipeline.push({ $sort: { 'refunds.createdAt': -1 } });

  const [rowsRaw, totalArr] = await Promise.all([
    Order.aggregate([
      ...pipeline,
      { $skip: skip },
      { $limit: safeLimit },
      {
        $project: {
          _id: 1,
          number: 1,
          billingAddress: 1,
          invoice: 1,
          refund: '$refunds',
        },
      },
    ]),
    Order.aggregate([
      ...pipeline,
      { $count: 'count' },
    ]),
  ]);

  const total = totalArr[0] ? totalArr[0].count : 0;
  const rows = rowsRaw.map((r) => ({
    orderId: String(r._id),
    orderNumber: r.number,
    invoiceNumber: r.invoice && r.invoice.number ? r.invoice.number : '',
    creditNoteNumber: r.refund.creditNoteNumber || '',
    createdAt: r.refund.createdAt || null,
    method: r.refund.method || 'manual',
    methodLabel: refundMethodLabel(r.refund.method),
    providerRefundId: r.refund.providerRefundId || '',
    providerStatus: r.refund.providerStatus || '',
    reason: r.refund.reason || '',
    customer: r.billingAddress && r.billingAddress.fullName ? r.billingAddress.fullName : '—',
    amountCents: r.refund.amountCents || 0,
  }));

  return {
    rows,
    total,
    page: safePage,
    limit: safeLimit,
    pageCount: Math.max(1, Math.ceil(total / safeLimit)),
  };
}

/* ════════════════════════════════════════════════════════════════
 * Export CSV mensuel
 * ════════════════════════════════════════════════════════════════ */

function csvCell(value) {
  if (value === null || value === undefined) return '';
  const s = String(value);
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes(';')) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function csvRow(cells) {
  return cells.map(csvCell).join(';');
}

function frDate(d) {
  if (!d) return '';
  const date = d instanceof Date ? d : new Date(d);
  if (!date.getTime()) return '';
  const dd = String(date.getDate()).padStart(2, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const yyyy = date.getFullYear();
  return `${dd}/${mm}/${yyyy}`;
}

/**
 * Construit le CSV mensuel : 1 ligne par facture + 1 ligne par avoir.
 * Format générique compatible avec les imports manuels de la plupart
 * des logiciels comptables (Pennylane, Sage, EBP, Cegid).
 *
 * Séparateur : ';' (norme FR). Encodage : UTF-8 BOM (compat Excel FR).
 */
async function buildMonthlyCsv(year, month) {
  const { from, to } = getMonthRange(year, month);

  const [invoiceRows, creditNoteRows] = await Promise.all([
    listInvoices({ from, to, page: 1, limit: 10000 }),
    listCreditNotes({ from, to, page: 1, limit: 10000 }),
  ]);

  const header = [
    'Type',           // FACTURE | AVOIR
    'Numero',         // n° facture ou n° avoir
    'Date',           // jj/mm/aaaa
    'NumeroCommande',
    'Client',
    'TypeClient',     // particulier | pro
    'Pays',
    'HT',             // 1234.56
    'TauxTVA',        // 20.00
    'TVA',
    'TTC',
    /* ── Colonnes ajoutées pour le régime de TVA ────────────────────────────
     * Sans elles, une vente sous marge et une vente au taux normal se
     * ressemblaient trait pour trait dans le fichier : le comptable ne
     * pouvait que supposer 20 % partout. Le régime est désormais explicite,
     * et le prix d'achat l'accompagne — c'est la base de calcul de la marge
     * (art. 297 A du CGI), donc la seule façon de vérifier le montant. */
    'RegimeTVA',      // normal | marge | autoliquidation
    'PrixAchat',      // renseigné sur les ventes sous marge
    'BaseTVA',        // assiette réellement taxée (la marge, le cas échéant)
    'Fournisseur',
    'FactureFournisseur',
    'ModePaiement',
    'FactureLiee',    // pour les avoirs : n° de la facture initiale
    'Motif',          // pour les avoirs
  ];
  const lines = [csvRow(header)];

  /* Le taux affiché n'est plus une constante : sur une livraison autoliquidée
     il n'y a pas de taux du tout, et écrire « 20.00 » en face d'une TVA à
     0,00 € donnait un fichier qui se contredisait lui-même. */
  const tauxAffiche = (regime) => (regime === 'autoliquidation' ? '0.00' : (TVA_RATE * 100).toFixed(2));
  /* Assiette réellement taxée : le prix pour une vente normale, la seule marge
     pour une vente sous marge. C'est le chiffre que le comptable recalcule. */
  const baseTva = (row) => eur(row.regime === 'autoliquidation' ? 0 : Math.round(row.vatCents / TVA_RATE));

  for (const inv of invoiceRows.rows) {
    lines.push(csvRow([
      'FACTURE',
      inv.invoiceNumber,
      frDate(inv.issuedAt),
      inv.orderNumber,
      inv.customer,
      inv.accountType,
      inv.country,
      eur(inv.htCents),
      tauxAffiche(inv.regime),
      eur(inv.vatCents),
      eur(inv.ttcCents),
      inv.regime,
      inv.purchaseCents == null ? '' : eur(inv.purchaseCents),
      baseTva(inv),
      inv.supplier || '',
      inv.supplierInvoiceRef || '',
      inv.paymentMethod,
      '',
      '',
    ]));
  }

  for (const cn of creditNoteRows.rows) {
    lines.push(csvRow([
      'AVOIR',
      cn.creditNoteNumber,
      frDate(cn.issuedAt),
      cn.orderNumber,
      cn.customer,
      cn.accountType,
      cn.country,
      '-' + eur(cn.htCents),
      tauxAffiche(cn.regime),
      '-' + eur(cn.vatCents),
      '-' + eur(cn.ttcCents),
      cn.regime,
      '',
      '-' + baseTva(cn),
      '',
      '',
      '',
      cn.invoiceNumber,
      cn.reason,
    ]));
  }

  /* BOM UTF-8 pour qu'Excel lise les accents correctement */
  const bom = '﻿';
  return {
    filename: `compta_${year}_${String(month).padStart(2, '0')}.csv`,
    content: bom + lines.join('\r\n') + '\r\n',
    invoiceCount: invoiceRows.rows.length,
    creditNoteCount: creditNoteRows.rows.length,
  };
}

/* ════════════════════════════════════════════════════════════════
 * Export ZIP mensuel (PDF factures + PDF avoirs)
 * ════════════════════════════════════════════════════════════════ */

/**
 * Streame un ZIP du mois dans `res`. Contient :
 *   factures/F-2026-000001.pdf …
 *   avoirs/AV-2026-0001.pdf …
 *
 * Les PDF d'avoirs sont lus depuis Order.creditNotes.pdfData (Buffer).
 * Si un avoir n'a pas de pdfData (cas legacy), il est régénéré à la volée.
 * Les PDF de factures sont régénérés à chaque fois (la base ne stocke
 * pas leurs Buffer, et leur contenu est purement déterministe).
 */
/**
 * Construit le ZIP du mois EN MÉMOIRE (Buffer) plutôt qu'en streaming.
 *
 * Raison : on a constaté en prod (autoliva.com derrière Render +
 * Cloudflare) que le streaming chunked du ZIP arrivait au client
 * corrompu — fichier que macOS refuse d'ouvrir ("format non pris en
 * charge"). Cause exacte non identifiée (gzip dynamique côté CDN,
 * buffering Render, race sur res.flushHeaders + pipe…). En passant
 * sur du "build complet puis send en une fois" :
 *
 *  - aucun chunked transfer-encoding : Content-Length connu d'avance
 *  - aucun risque de troncature au milieu du flux
 *  - si une erreur survient pendant la génération, on peut encore
 *    répondre 500 proprement (headers pas encore envoyés)
 *
 * Coût mémoire : pour un mois moyen avec ~50 factures ce sont
 * ~30-50 MB en RAM le temps de la requête. Acceptable. Si on atteint
 * un jour des volumes > 500 factures/mois, il faudra basculer sur un
 * job async qui pré-génère le ZIP de la veille en stockage.
 */
async function buildMonthlyPdfZipBuffer(year, month) {
  const { from, to } = getMonthRange(year, month);
  const monthLabel = `${year}-${String(month).padStart(2, '0')}`;

  /* Collecteur Buffer : un Writable qui empile les chunks émis par
   * archiver. À la fin on Buffer.concat() pour obtenir le ZIP complet. */
  const { Writable } = require('stream');
  const chunks = [];
  const collector = new Writable({
    write(chunk, encoding, cb) { chunks.push(chunk); cb(); },
  });

  const archive = archiver('zip', { zlib: { level: 6 } });

  /* On capture toutes les erreurs archiver — si on en attrape une on
   * lève pour que le caller renvoie 500 proprement. */
  let archiveError = null;
  archive.on('error', (err) => {
    archiveError = err;
    console.error('[accounting] archive error:', err && err.message);
  });
  archive.on('warning', (err) => {
    console.warn('[accounting] archive warning:', err && err.message);
  });

  archive.pipe(collector);

  /* README en tête */
  archive.append([
    `Export comptable — ${monthLabel}`,
    `Période : du ${frDate(from)} (00h00) au ${frDate(new Date(to.getTime() - 1))} (23h59)`,
    `Généré le : ${frDate(new Date())}`,
    '',
    'Source : autoliva.com — Car Parts France',
    '',
    'Voir aussi : export CSV du mois pour la saisie comptable.',
  ].join('\r\n'), { name: 'README.txt' });

  /* Compteurs pour le SUMMARY final */
  let invoiceWritten = 0;
  let creditNoteWritten = 0;
  let invoiceFailed = 0;
  let creditNoteFailed = 0;
  let fatalError = null;

  try {
    const invoiceOrders = await Order.find({
      'invoice.number': { $nin: [null, ''] },
      'invoice.issuedAt': { $gte: from, $lt: to },
    })
      .select('_id number invoice totalCents items billingAddress shippingAddress userId accountType currency shippingCostCents itemsSubtotalCents promoCode promoDiscountCents itemsTotalAfterDiscountCents clientDiscountCents createdAt')
      .lean();

    /* Récupération des avoirs.
     *
     * Subtilité Mongoose : il ne faut PAS appeler `.lean()` ici parce que :
     *
     *  1. Avec `.select('+creditNotes.pdfData ...')` la projection envoyée
     *     à MongoDB ne contient QUE creditNotes.pdfData (pas les autres
     *     sous-champs). Du coup en lean on récupère un sous-doc {pdfData}
     *     sans `number` ni `issuedAt` — la boucle interne (qui filtre par
     *     issuedAt) skip alors TOUS les avoirs.
     *
     *  2. Avec lean, `pdfData` est retourné comme `BSON Binary` au lieu
     *     d'un `Buffer` Node, ce qui casse `Buffer.isBuffer(cn.pdfData)`
     *     et nous fait basculer inutilement sur la regen.
     *
     * Sans lean, Mongoose hydrate les docs complets : tous les sous-
     * champs sont présents et `pdfData` est un vrai `Buffer`. Le surcoût
     * mémoire est négligeable pour ~100 avoirs/mois max.
     *
     * On ne peut pas lister `creditNotes` en parent de
     * `+creditNotes.pdfData` (path collision Mongo). Et expliciter tous
     * les sous-champs (`creditNotes.number creditNotes.issuedAt …`) +
     * convertir Binary→Buffer marche aussi mais c'est plus verbeux et
     * fragile. Drop `.lean()` est la solution la plus simple et robuste. */
    const creditNoteOrders = await Order.find({
      'creditNotes.issuedAt': { $gte: from, $lt: to },
    })
      .select('+creditNotes.pdfData');

    /* Préfetch users (un seul find $in vs N findById) */
    const userIds = new Set();
    for (const o of invoiceOrders) if (o.userId) userIds.add(String(o.userId));
    for (const o of creditNoteOrders) if (o.userId) userIds.add(String(o.userId));
    const usersList = userIds.size
      ? await User.find({ _id: { $in: Array.from(userIds) } })
          .select('_id email firstName lastName accountType siret tvaIntracom companyName phone addresses')
          .lean()
      : [];
    const usersById = new Map(usersList.map((u) => [String(u._id), u]));

    /* Factures — regen via pdfkit, séquentiellement (CPU-bound,
     * paralléliser ne gagnerait rien en mono-thread Node). */
    for (const order of invoiceOrders) {
      try {
        const user = order.userId ? usersById.get(String(order.userId)) || null : null;
        const buffer = await buildOrderInvoicePdfBuffer({ order, user });
        if (buffer && buffer.length) {
          /* Nommage : numéro de commande en premier (pour navigation compta),
             suivi du numéro de facture si dispo. Fallback sur juste le n° commande. */
          const cpNum = order.number || `commande-${order._id || 'inconnue'}`;
          const invNum = order.invoice && order.invoice.number ? order.invoice.number : '';
          const safeName = invNum ? `${cpNum}_${invNum}` : cpNum;
          archive.append(buffer, { name: `factures/${safeName}.pdf` });
          invoiceWritten++;
        } else {
          invoiceFailed++;
        }
      } catch (e) {
        console.error('[accounting] PDF facture ratée pour', order.number, e && e.message);
        invoiceFailed++;
      }
    }

    /* Avoirs — lecture du Buffer si dispo, sinon regen */
    for (const order of creditNoteOrders) {
      if (!Array.isArray(order.creditNotes)) continue;
      for (const cn of order.creditNotes) {
        if (!cn || !cn.issuedAt) continue;
        const issuedAt = cn.issuedAt instanceof Date ? cn.issuedAt : new Date(cn.issuedAt);
        if (issuedAt < from || issuedAt >= to) continue;

        let buffer = null;
        if (cn.pdfData && Buffer.isBuffer(cn.pdfData) && cn.pdfData.length > 0) {
          buffer = cn.pdfData;
        } else {
          try {
            const user = order.userId ? usersById.get(String(order.userId)) || null : null;
            const refund = Array.isArray(order.refunds) && Number.isInteger(cn.refundIndex)
              ? order.refunds[cn.refundIndex] || null
              : null;
            buffer = await buildCreditNotePdfBuffer({ order, user, creditNote: cn, refund });
          } catch (e) {
            console.error('[accounting] PDF avoir raté pour', cn.number, e && e.message);
            creditNoteFailed++;
            continue;
          }
        }

        if (buffer && buffer.length) {
          /* Nommage : numéro de commande en premier (cohérent avec les factures). */
          const cpNum = order.number || `commande-${order._id || 'inconnue'}`;
          const avNum = cn.number ? cn.number : `avoir-${cn._id || ''}`;
          const safeName = `${cpNum}_${avNum}`;
          archive.append(buffer, { name: `avoirs/${safeName}.pdf` });
          creditNoteWritten++;
        } else {
          creditNoteFailed++;
        }
      }
    }
  } catch (err) {
    fatalError = err;
    console.error('[accounting] ZIP fatal error:', err && err.message);
  }

  /* SUMMARY final */
  archive.append([
    `Résumé de l'export — ${monthLabel}`,
    '',
    `Factures incluses : ${invoiceWritten}${invoiceFailed > 0 ? ` (${invoiceFailed} en échec)` : ''}`,
    `Avoirs incluses  : ${creditNoteWritten}${creditNoteFailed > 0 ? ` (${creditNoteFailed} en échec)` : ''}`,
    '',
    fatalError
      ? `⚠ ERREUR : ${fatalError.message || 'inconnue'} — l'export est probablement incomplet.`
      : '✓ Export terminé sans erreur fatale.',
    '',
    `Généré le : ${new Date().toISOString()}`,
  ].join('\r\n'), { name: 'SUMMARY.txt' });

  /* On attend à la fois la fin de l'archive ET la fin du collecteur
   * pour être sûrs que tous les chunks sont arrivés dans `chunks`. */
  await new Promise((resolve, reject) => {
    collector.on('finish', resolve);
    collector.on('error', reject);
    archive.finalize().catch(reject);
  });

  if (archiveError) throw archiveError;

  return {
    buffer: Buffer.concat(chunks),
    filename: `compta_${monthLabel}_pdfs.zip`,
    invoiceCount: invoiceWritten,
    creditNoteCount: creditNoteWritten,
  };
}

/**
 * @deprecated Conservé pour compat — utilise buildMonthlyPdfZipBuffer
 * et send en une fois. Le streaming chunked posait problème avec le
 * couple Render + Cloudflare (cf. PR #56-57).
 */
async function streamMonthlyPdfZip(res, year, month) {
  const { buffer, filename } = await buildMonthlyPdfZipBuffer(year, month);
  res.setHeader('Content-Type', 'application/zip');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.setHeader('Content-Length', String(buffer.length));
  res.setHeader('Cache-Control', 'no-store');
  return res.end(buffer);
}

/* ════════════════════════════════════════════════════════════════
 * Récupération d'un PDF unitaire (facture ou avoir)
 * ════════════════════════════════════════════════════════════════ */

async function getInvoicePdfBuffer(orderId) {
  const order = await Order.findById(orderId).lean();
  if (!order || !order.invoice || !order.invoice.number) return null;
  const user = order.userId
    ? await User.findById(order.userId).select('_id email firstName lastName accountType siret tvaIntracom companyName phone addresses').lean()
    : null;
  return buildOrderInvoicePdfBuffer({ order, user });
}

async function getCreditNotePdfBufferFor(orderId, creditNoteNumber) {
  /* Pas de .lean() ici, même raison que dans buildMonthlyPdfZipBuffer :
   * avec lean + .select('+creditNotes.pdfData'), seul pdfData est chargé
   * (cn.number = undefined → find() ne matche jamais) et pdfData revient
   * en BSON Binary au lieu de Buffer. */
  const order = await Order.findById(orderId)
    .select('+creditNotes.pdfData');
  if (!order || !Array.isArray(order.creditNotes)) return null;
  const cn = order.creditNotes.find((c) => c && c.number === creditNoteNumber);
  if (!cn) return null;
  if (cn.pdfData && Buffer.isBuffer(cn.pdfData) && cn.pdfData.length > 0) {
    return cn.pdfData;
  }
  /* Fallback régénération */
  const user = order.userId
    ? await User.findById(order.userId).select('_id email firstName lastName accountType siret tvaIntracom companyName phone addresses').lean()
    : null;
  const refund = Array.isArray(order.refunds) && Number.isInteger(cn.refundIndex)
    ? order.refunds[cn.refundIndex] || null
    : null;
  return buildCreditNotePdfBuffer({ order, user, creditNote: cn, refund });
}

module.exports = {
  TVA_RATE,
  eur,
  splitVatCommande,
  regimeDeCommande,
  getMonthRange,
  getMonthSummary,
  getTwelveMonthTrend,
  findAnomalies,
  listInvoices,
  listCreditNotes,
  listRefunds,
  buildMonthlyCsv,
  buildMonthlyPdfZipBuffer,
  streamMonthlyPdfZip,
  getInvoicePdfBuffer,
  getCreditNotePdfBufferFor,
};
