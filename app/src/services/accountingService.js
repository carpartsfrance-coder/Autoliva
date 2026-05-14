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
const mollie = require('./mollie');
const { buildOrderInvoicePdfBuffer } = require('./invoicePdf');
const { buildCreditNotePdfBuffer } = require('./creditNotePdf');

const TVA_RATE = 0.20;

function eur(cents) {
  const n = Number(cents) || 0;
  return (n / 100).toFixed(2);
}

/**
 * Décompose un TTC en HT + TVA selon le taux par défaut.
 * On arrondit la TVA à 2 décimales puis on déduit HT pour garantir
 * que HT + TVA = TTC à l'euro près.
 */
function splitVat(totalCents) {
  const ttc = Number(totalCents) || 0;
  if (ttc <= 0) return { htCents: 0, vatCents: 0, ttcCents: 0 };
  const vatCents = Math.round(ttc - ttc / (1 + TVA_RATE));
  const htCents = ttc - vatCents;
  return { htCents, vatCents, ttcCents: ttc };
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
 * Retourne les KPI principaux pour le mois donné.
 */
async function getMonthSummary(year, month) {
  const { from, to, year: y, month: m } = getMonthRange(year, month);

  /* Factures émises sur la période */
  const invoiceAgg = await Order.aggregate([
    { $match: { 'invoice.issuedAt': { $gte: from, $lt: to } } },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        totalCents: { $sum: { $ifNull: ['$totalCents', 0] } },
      },
    },
  ]);
  const invoiceCount = invoiceAgg[0] ? invoiceAgg[0].count : 0;
  const invoiceTtcCents = invoiceAgg[0] ? invoiceAgg[0].totalCents : 0;
  const invoiceSplit = splitVat(invoiceTtcCents);

  /* Avoirs émis sur la période */
  const creditNoteAgg = await Order.aggregate([
    { $match: { 'creditNotes.issuedAt': { $gte: from, $lt: to } } },
    { $unwind: '$creditNotes' },
    { $match: { 'creditNotes.issuedAt': { $gte: from, $lt: to } } },
    {
      $group: {
        _id: null,
        count: { $sum: 1 },
        totalCents: { $sum: { $ifNull: ['$creditNotes.totalCents', 0] } },
      },
    },
  ]);
  const creditNoteCount = creditNoteAgg[0] ? creditNoteAgg[0].count : 0;
  const creditNoteTtcCents = creditNoteAgg[0] ? creditNoteAgg[0].totalCents : 0;
  const creditNoteSplit = splitVat(creditNoteTtcCents);

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

  /* CA net = factures TTC - avoirs TTC */
  const netTtcCents = invoiceTtcCents - creditNoteTtcCents;
  const netSplit = splitVat(netTtcCents);

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
      .select('_id number invoice totalCents accountType billingAddress molliePaymentId scalapayOrderToken paymentProvider creditNotes refunds')
      .lean(),
    Order.countDocuments(query),
  ]);

  const rows = docs.map((order) => {
    const split = splitVat(order.totalCents);
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
    const split = splitVat(r.creditNote.totalCents);
    return {
      orderId: String(r._id),
      orderNumber: r.number,
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
    'ModePaiement',
    'FactureLiee',    // pour les avoirs : n° de la facture initiale
    'Motif',          // pour les avoirs
  ];
  const lines = [csvRow(header)];

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
      (TVA_RATE * 100).toFixed(2),
      eur(inv.vatCents),
      eur(inv.ttcCents),
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
      (TVA_RATE * 100).toFixed(2),
      '-' + eur(cn.vatCents),
      '-' + eur(cn.ttcCents),
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
          const safeNumber = (order.invoice && order.invoice.number) || `commande-${order.number}`;
          archive.append(buffer, { name: `factures/${safeNumber}.pdf` });
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
          const safeNumber = cn.number || `avoir-${order.number}-${cn._id || ''}`;
          archive.append(buffer, { name: `avoirs/${safeNumber}.pdf` });
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

/* ════════════════════════════════════════════════════════════════
 * Réconciliation Mollie payouts ↔ factures
 * ════════════════════════════════════════════════════════════════
 *
 * Principe :
 *   Mollie verse l'argent par "settlements" (virements groupés).
 *   Un settlement = 1 virement bancaire qui agrège N paiements + soustrait
 *   les éventuels remboursements et frais Mollie de la période.
 *
 *   Le comptable veut vérifier : "ce virement de 4 327,12 € reçu le 12 mai
 *   correspond à quelles ventes ?" Il faut aussi voir s'il y a des écarts
 *   (paiement Mollie sans facture en base, montant différent, etc.).
 *
 * Cette fonction fait :
 *   1. Récupère les settlements Mollie du mois
 *   2. Pour chacun, récupère ses paiements (+ refunds inclus)
 *   3. Match chaque paiement à un Order via molliePaymentId
 *   4. Calcule : sommes brutes, fees Mollie, refunds, net theorique vs
 *      net réel du settlement → si ≠, on flag
 *   5. Retourne une structure prête à afficher
 *
 * Comme l'API Mollie est externe et peut être lente, on prend une option
 * `skipMollie` pour les tests / le cas où la clé n'est pas configurée.
 */
async function getMollieReconciliation({ year, month, skipMollie = false } = {}) {
  const { from, to, year: y, month: m } = getMonthRange(year, month);

  if (skipMollie || !process.env.MOLLIE_API_KEY) {
    return {
      year: y, month: m, from, to,
      configured: false,
      message: 'MOLLIE_API_KEY non configurée — réconciliation indisponible.',
      settlements: [],
    };
  }

  let settlements = [];
  try {
    settlements = await mollie.listSettlements({ from, to });
  } catch (err) {
    console.error('[accounting] listSettlements échec :', err && err.message);
    return {
      year: y, month: m, from, to,
      configured: true,
      message: `Erreur API Mollie : ${err && err.message ? err.message : 'inconnue'}`,
      settlements: [],
    };
  }

  /* Récupère TOUS les molliePaymentId qu'on va matcher pour limiter le find */
  const allPaymentIds = [];
  const settlementDetails = [];
  for (const s of settlements) {
    let payments = [];
    let refunds = [];
    try {
      [payments, refunds] = await Promise.all([
        mollie.listSettlementPayments(s.id),
        mollie.listSettlementRefunds(s.id),
      ]);
    } catch (err) {
      console.error('[accounting] settlement detail échec', s.id, err && err.message);
    }
    settlementDetails.push({ settlement: s, payments, refunds });
    for (const p of payments) if (p.id) allPaymentIds.push(p.id);
  }

  /* Single query pour matcher les Mollie payments aux Orders */
  const ordersByMollieId = new Map();
  if (allPaymentIds.length > 0) {
    const orders = await Order.find({ molliePaymentId: { $in: allPaymentIds } })
      .select('_id number molliePaymentId totalCents invoice billingAddress accountType status')
      .lean();
    for (const o of orders) ordersByMollieId.set(String(o.molliePaymentId), o);
  }

  /* Compose le retour pour la vue */
  const rows = settlementDetails.map(({ settlement, payments, refunds }) => {
    const amountCents = settlement.amount && settlement.amount.value
      ? Math.round(parseFloat(settlement.amount.value) * 100)
      : 0;

    /* Détail des paiements + matching commande */
    let paymentsSumCents = 0;
    let paymentsSettlementSumCents = 0;
    const paymentRows = payments.map((p) => {
      const grossCents = p.amount && p.amount.value
        ? Math.round(parseFloat(p.amount.value) * 100)
        : 0;
      const settledCents = p.settlementAmount && p.settlementAmount.value
        ? Math.round(parseFloat(p.settlementAmount.value) * 100)
        : 0;
      paymentsSumCents += grossCents;
      paymentsSettlementSumCents += settledCents;

      const order = ordersByMollieId.get(String(p.id)) || null;
      return {
        mollieId: p.id,
        status: p.status,
        createdAt: p.createdAt,
        method: p.method,
        grossCents,
        settledCents,
        feesCents: grossCents - settledCents,
        order: order ? {
          id: String(order._id),
          number: order.number,
          invoiceNumber: order.invoice && order.invoice.number ? order.invoice.number : '',
          totalCents: order.totalCents,
          status: order.status,
          customer: order.billingAddress && order.billingAddress.fullName ? order.billingAddress.fullName : '—',
          matchesAmount: order.totalCents === grossCents,
        } : null,
      };
    });

    /* Refunds inclus dans le settlement (montants négatifs) */
    let refundsSumCents = 0;
    let refundsSettlementSumCents = 0;
    const refundRows = refunds.map((r) => {
      const grossCents = r.amount && r.amount.value
        ? Math.round(parseFloat(r.amount.value) * 100)
        : 0;
      const settledCents = r.settlementAmount && r.settlementAmount.value
        ? Math.round(parseFloat(r.settlementAmount.value) * 100)
        : 0;
      refundsSumCents += grossCents;
      refundsSettlementSumCents += settledCents;
      return {
        mollieId: r.id,
        paymentId: r.paymentId,
        status: r.status,
        createdAt: r.createdAt,
        grossCents,
        settledCents,
        description: r.description || '',
      };
    });

    /* Anomalies sur ce settlement */
    const issues = [];
    /* Paiement Mollie sans commande en base */
    const orphanPayments = paymentRows.filter((p) => !p.order);
    if (orphanPayments.length > 0) {
      issues.push({
        severity: 'high',
        kind: 'payment_without_order',
        message: `${orphanPayments.length} paiement(s) Mollie sans commande en base.`,
      });
    }
    /* Paiement avec montant ≠ commande */
    const mismatchAmount = paymentRows.filter((p) => p.order && !p.order.matchesAmount);
    if (mismatchAmount.length > 0) {
      issues.push({
        severity: 'medium',
        kind: 'amount_mismatch',
        message: `${mismatchAmount.length} paiement(s) avec un montant qui ne matche pas la commande liée.`,
      });
    }
    /* Paiement payé mais sans facture émise */
    const noInvoice = paymentRows.filter((p) => p.order && p.status === 'paid' && !p.order.invoiceNumber);
    if (noInvoice.length > 0) {
      issues.push({
        severity: 'high',
        kind: 'paid_no_invoice',
        message: `${noInvoice.length} paiement(s) payé(s) sans facture émise sur la commande liée.`,
      });
    }

    /* Sanity check global : la somme settlement des paiements - refunds
     * doit matcher le montant du settlement (modulo arrondis Mollie). */
    const computedNetCents = paymentsSettlementSumCents - refundsSettlementSumCents;
    const diffCents = amountCents - computedNetCents;

    return {
      id: settlement.id,
      reference: settlement.reference || '',
      settledAt: settlement.settledAt || null,
      status: settlement.status,
      amountCents,
      paymentsCount: payments.length,
      paymentsSumCents,
      paymentsSettlementSumCents,
      refundsCount: refunds.length,
      refundsSumCents,
      refundsSettlementSumCents,
      feesCents: paymentsSumCents - paymentsSettlementSumCents,
      computedNetCents,
      diffCents,
      payments: paymentRows,
      refunds: refundRows,
      issues,
    };
  });

  return {
    year: y, month: m, from, to,
    configured: true,
    settlements: rows,
  };
}

module.exports = {
  TVA_RATE,
  eur,
  splitVat,
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
  getMollieReconciliation,
};
