/*
 * comptableController — handlers de l'espace /comptable.
 *
 * Toutes les actions sont en LECTURE SEULE sauf la déconnexion.
 * Chaque téléchargement ou export est tracé dans AuditLog (RGPD).
 *
 * On ne logge PAS les simples pages-listes pour ne pas inonder l'audit log :
 * seules les actions à valeur juridique/traçabilité (téléchargement de
 * document, génération d'export) sont auditées.
 */

const mongoose = require('mongoose');

const accountingService = require('../services/accountingService');
const audit = require('../services/auditLogger');
const { getRoleLabel } = require('../permissions');

const SAFE_PAGE_LIMITS = [25, 50, 100, 200];

function parseIntOr(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

function getRequestedMonth(req) {
  /* Priorité :
   *   1. ?year=&month= dans la querystring
   *   2. ?period=YYYY-MM (raccourci utilisé dans les liens)
   *   3. mois en cours
   */
  const now = new Date();
  let year = now.getFullYear();
  let month = now.getMonth() + 1;

  const period = (req.query && typeof req.query.period === 'string') ? req.query.period.trim() : '';
  const matchPeriod = /^(\d{4})-(\d{1,2})$/.exec(period);
  if (matchPeriod) {
    year = parseInt(matchPeriod[1], 10);
    month = parseInt(matchPeriod[2], 10);
  } else {
    const qy = parseIntOr(req.query && req.query.year, NaN);
    const qm = parseIntOr(req.query && req.query.month, NaN);
    if (Number.isFinite(qy) && qy >= 2020 && qy <= 2100) year = qy;
    if (Number.isFinite(qm) && qm >= 1 && qm <= 12) month = qm;
  }

  return { year, month };
}

function getRequestedRange(req) {
  /* Pour les listes : ?from=YYYY-MM-DD&to=YYYY-MM-DD, sinon mois courant */
  const fromStr = (req.query && typeof req.query.from === 'string') ? req.query.from.trim() : '';
  const toStr = (req.query && typeof req.query.to === 'string') ? req.query.to.trim() : '';

  let from = null;
  let to = null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(fromStr)) {
    const d = new Date(`${fromStr}T00:00:00.000Z`);
    if (!Number.isNaN(d.getTime())) from = d;
  }
  if (/^\d{4}-\d{2}-\d{2}$/.test(toStr)) {
    const d = new Date(`${toStr}T00:00:00.000Z`);
    if (!Number.isNaN(d.getTime())) {
      /* On ajoute 1 jour pour que la borne supérieure soit exclusive */
      to = new Date(d.getTime() + 24 * 60 * 60 * 1000);
    }
  }

  if (!from && !to) {
    const { year, month } = getRequestedMonth(req);
    const range = accountingService.getMonthRange(year, month);
    return { from: range.from, to: range.to, year: range.year, month: range.month, isCustom: false };
  }

  return { from, to, year: null, month: null, isCustom: true };
}

function getPagination(req) {
  const page = Math.max(1, parseIntOr(req.query && req.query.page, 1));
  let limit = parseIntOr(req.query && req.query.limit, 50);
  if (!SAFE_PAGE_LIMITS.includes(limit)) limit = 50;
  return { page, limit };
}

function getSearch(req) {
  const raw = req.query && typeof req.query.q === 'string' ? req.query.q.trim() : '';
  return raw.slice(0, 100); // limite défensive
}

function buildPeriodNav(year, month) {
  const current = new Date(year, month - 1, 1);
  const prev = new Date(year, month - 2, 1);
  const next = new Date(year, month, 1);
  return {
    currentLabel: current.toLocaleString('fr-FR', { month: 'long', year: 'numeric' }),
    currentPeriod: `${year}-${String(month).padStart(2, '0')}`,
    prevPeriod: `${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`,
    nextPeriod: `${next.getFullYear()}-${String(next.getMonth() + 1).padStart(2, '0')}`,
  };
}

function viewLocals(req, extra = {}) {
  const u = req.session && req.session.admin ? req.session.admin : null;
  return Object.assign({
    currentUser: u,
    userFullName: u ? [u.firstName, u.lastName].filter(Boolean).join(' ') : '',
    userRoleLabel: u ? getRoleLabel(u.role) : '',
  }, extra);
}

/**
 * Construit l'URL pour une page donnée en conservant tous les autres
 * paramètres de filtre (q, from, to, period, limit). Utilisé pour la
 * pagination des listes.
 */
function buildPageUrl(basePath, currentQuery, overrides = {}) {
  const params = new URLSearchParams();
  const merged = Object.assign({}, currentQuery || {}, overrides);
  for (const [key, value] of Object.entries(merged)) {
    if (value === null || value === undefined || value === '') continue;
    params.set(key, String(value));
  }
  const qs = params.toString();
  return qs ? `${basePath}?${qs}` : basePath;
}

/* ════════════════════════════════════════════════════════════════
 * Dashboard
 * ════════════════════════════════════════════════════════════════ */

async function getDashboard(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    if (!dbConnected) {
      return res.render('comptable/dashboard', viewLocals(req, {
        pageTitle: 'Tableau de bord',
        dbConnected: false,
        summary: null,
        trend: [],
        anomalies: [],
        period: buildPeriodNav(new Date().getFullYear(), new Date().getMonth() + 1),
      }));
    }

    const { year, month } = getRequestedMonth(req);
    const [summary, trend, anomalies] = await Promise.all([
      accountingService.getMonthSummary(year, month),
      accountingService.getTwelveMonthTrend(new Date(year, month - 1, 1)),
      accountingService.findAnomalies({ year, month }),
    ]);

    return res.render('comptable/dashboard', viewLocals(req, {
      pageTitle: 'Tableau de bord',
      dbConnected: true,
      summary,
      trend,
      anomalies,
      period: buildPeriodNav(year, month),
    }));
  } catch (err) {
    return next(err);
  }
}

/* ════════════════════════════════════════════════════════════════
 * Factures
 * ════════════════════════════════════════════════════════════════ */

async function getInvoicesList(req, res, next) {
  try {
    const range = getRequestedRange(req);
    const pagination = getPagination(req);
    const search = getSearch(req);

    const data = await accountingService.listInvoices({
      from: range.from,
      to: range.to,
      page: pagination.page,
      limit: pagination.limit,
      search,
    });

    const prevPageUrl = data.page > 1
      ? buildPageUrl('/comptable/factures', req.query, { page: data.page - 1 })
      : null;
    const nextPageUrl = data.page < data.pageCount
      ? buildPageUrl('/comptable/factures', req.query, { page: data.page + 1 })
      : null;

    return res.render('comptable/invoices', viewLocals(req, {
      pageTitle: 'Factures',
      range,
      pagination,
      search,
      data,
      prevPageUrl,
      nextPageUrl,
      period: range.year && range.month ? buildPeriodNav(range.year, range.month) : null,
    }));
  } catch (err) {
    return next(err);
  }
}

async function getInvoicePdf(req, res, next) {
  try {
    const { orderId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).send('Identifiant de commande invalide.');
    }

    const buffer = await accountingService.getInvoicePdfBuffer(orderId);
    if (!buffer || !buffer.length) {
      return res.status(404).send('Facture introuvable.');
    }

    await audit.log({
      req,
      action: 'comptable.invoice.download',
      entityType: 'order',
      entityId: String(orderId),
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="facture-${orderId}.pdf"`);
    return res.end(buffer);
  } catch (err) {
    return next(err);
  }
}

/* ════════════════════════════════════════════════════════════════
 * Avoirs
 * ════════════════════════════════════════════════════════════════ */

async function getCreditNotesList(req, res, next) {
  try {
    const range = getRequestedRange(req);
    const pagination = getPagination(req);
    const search = getSearch(req);

    const data = await accountingService.listCreditNotes({
      from: range.from,
      to: range.to,
      page: pagination.page,
      limit: pagination.limit,
      search,
    });

    const prevPageUrl = data.page > 1
      ? buildPageUrl('/comptable/avoirs', req.query, { page: data.page - 1 })
      : null;
    const nextPageUrl = data.page < data.pageCount
      ? buildPageUrl('/comptable/avoirs', req.query, { page: data.page + 1 })
      : null;

    return res.render('comptable/credit-notes', viewLocals(req, {
      pageTitle: 'Avoirs',
      range,
      pagination,
      search,
      data,
      prevPageUrl,
      nextPageUrl,
      period: range.year && range.month ? buildPeriodNav(range.year, range.month) : null,
    }));
  } catch (err) {
    return next(err);
  }
}

async function getCreditNotePdf(req, res, next) {
  try {
    const { orderId, creditNoteNumber } = req.params;
    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).send('Identifiant de commande invalide.');
    }
    if (!creditNoteNumber || !/^AV-\d{4}-\d+$/.test(creditNoteNumber)) {
      return res.status(400).send("Numéro d'avoir invalide.");
    }

    const buffer = await accountingService.getCreditNotePdfBufferFor(orderId, creditNoteNumber);
    if (!buffer || !buffer.length) {
      return res.status(404).send('Avoir introuvable.');
    }

    await audit.log({
      req,
      action: 'comptable.creditNote.download',
      entityType: 'order',
      entityId: String(orderId),
      after: { creditNoteNumber },
    });

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${creditNoteNumber}.pdf"`);
    return res.end(buffer);
  } catch (err) {
    return next(err);
  }
}

/* ════════════════════════════════════════════════════════════════
 * Remboursements
 * ════════════════════════════════════════════════════════════════ */

async function getRefundsList(req, res, next) {
  try {
    const range = getRequestedRange(req);
    const pagination = getPagination(req);
    const search = getSearch(req);

    const data = await accountingService.listRefunds({
      from: range.from,
      to: range.to,
      page: pagination.page,
      limit: pagination.limit,
      search,
    });

    const prevPageUrl = data.page > 1
      ? buildPageUrl('/comptable/remboursements', req.query, { page: data.page - 1 })
      : null;
    const nextPageUrl = data.page < data.pageCount
      ? buildPageUrl('/comptable/remboursements', req.query, { page: data.page + 1 })
      : null;

    return res.render('comptable/refunds', viewLocals(req, {
      pageTitle: 'Remboursements',
      range,
      pagination,
      search,
      data,
      prevPageUrl,
      nextPageUrl,
      period: range.year && range.month ? buildPeriodNav(range.year, range.month) : null,
    }));
  } catch (err) {
    return next(err);
  }
}

/* ════════════════════════════════════════════════════════════════
 * Réconciliation Mollie payouts ↔ factures
 * ════════════════════════════════════════════════════════════════ */

async function getReconciliation(req, res, next) {
  try {
    const { year, month } = getRequestedMonth(req);
    const data = await accountingService.getMollieReconciliation({ year, month });

    return res.render('comptable/reconciliation', viewLocals(req, {
      pageTitle: 'Réconciliation Mollie',
      data,
      period: buildPeriodNav(year, month),
    }));
  } catch (err) {
    return next(err);
  }
}

/* ════════════════════════════════════════════════════════════════
 * Exports CSV + ZIP
 * ════════════════════════════════════════════════════════════════ */

async function getMonthlyCsvExport(req, res, next) {
  try {
    const year = parseIntOr(req.params.year, NaN);
    const month = parseIntOr(req.params.month, NaN);
    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
      return res.status(400).send('Période invalide.');
    }

    const { filename, content, invoiceCount, creditNoteCount } = await accountingService.buildMonthlyCsv(year, month);

    await audit.log({
      req,
      action: 'comptable.export.csv',
      entityType: 'accounting_export',
      entityId: `${year}-${String(month).padStart(2, '0')}`,
      after: { invoiceCount, creditNoteCount },
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    return res.end(content);
  } catch (err) {
    return next(err);
  }
}

async function getMonthlyPdfZipExport(req, res, next) {
  try {
    const year = parseIntOr(req.params.year, NaN);
    const month = parseIntOr(req.params.month, NaN);
    if (!Number.isFinite(year) || !Number.isFinite(month) || month < 1 || month > 12) {
      return res.status(400).send('Période invalide.');
    }

    /* On logge AVANT le streaming car une fois que le ZIP commence à être
     * envoyé, on ne peut plus modifier la réponse. */
    await audit.log({
      req,
      action: 'comptable.export.zip',
      entityType: 'accounting_export',
      entityId: `${year}-${String(month).padStart(2, '0')}`,
    });

    return accountingService.streamMonthlyPdfZip(res, year, month);
  } catch (err) {
    return next(err);
  }
}

/* ════════════════════════════════════════════════════════════════
 * Déconnexion
 * ════════════════════════════════════════════════════════════════ */

function postLogout(req, res) {
  if (req.session) {
    delete req.session.admin;
    if (typeof req.session.save === 'function') {
      return req.session.save(() => res.redirect('/admin/connexion'));
    }
  }
  return res.redirect('/admin/connexion');
}

module.exports = {
  getDashboard,
  getInvoicesList,
  getInvoicePdf,
  getCreditNotesList,
  getCreditNotePdf,
  getRefundsList,
  getReconciliation,
  getMonthlyCsvExport,
  getMonthlyPdfZipExport,
  postLogout,
};
