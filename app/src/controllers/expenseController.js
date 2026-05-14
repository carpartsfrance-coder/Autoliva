/*
 * expenseController — UI /admin/charges (owner only).
 *
 * Liste, création, édition et suppression des charges d'entreprise.
 * Saisie en EUR (parsée en centimes côté serveur). Les charges auto
 * (frais Mollie capturés via webhook) sont visibles mais NON modifiables :
 * l'UI grise les boutons et le POST refuse si source !== 'manual'.
 */

const mongoose = require('mongoose');

const Expense = require('../models/Expense');
const expenseService = require('../services/expenseService');
const auditLogger = require('../services/auditLogger');

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parsePriceToCents(value) {
  /* Accepte "1234.56", "1234,56", "1 234,56" — retourne centimes ou null. */
  const str = getTrimmedString(value).replace(/\s/g, '').replace(',', '.');
  if (!str) return null;
  const n = Number(str);
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

function parseDateInput(value) {
  const s = getTrimmedString(value);
  if (!s) return null;
  /* Format attendu : YYYY-MM-DD (HTML5 input type=date) */
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (!m) return null;
  const d = new Date(Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10), 12, 0, 0));
  return Number.isFinite(d.getTime()) ? d : null;
}

function formatDateForInput(date) {
  if (!date) return '';
  const d = date instanceof Date ? date : new Date(date);
  if (!Number.isFinite(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function formatPriceForInput(cents) {
  if (!Number.isFinite(cents)) return '';
  return (cents / 100).toFixed(2).replace('.', ',');
}

function getCurrentAdminEmail(req) {
  return req.session && req.session.admin && req.session.admin.email ? req.session.admin.email : '';
}

/* ════════════════════════════════════════════════════════════════
 * LIST — GET /admin/charges
 * ════════════════════════════════════════════════════════════════ */

async function getListPage(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const now = new Date();

    /* Filtres */
    const filterCategory = getTrimmedString(req.query.category);
    const filterPeriod = getTrimmedString(req.query.period); // YYYY-MM
    const flash = req.session.expensesFlash || null;
    delete req.session.expensesFlash;

    let year = now.getFullYear();
    let month = now.getMonth() + 1;
    const periodMatch = /^(\d{4})-(\d{1,2})$/.exec(filterPeriod);
    if (periodMatch) {
      year = parseInt(periodMatch[1], 10);
      month = parseInt(periodMatch[2], 10);
    }

    if (!dbConnected) {
      return res.render('admin/expenses-list', {
        title: 'Admin - Charges',
        dbConnected: false,
        rows: [], totalCents: 0, byCategory: {}, total: 0,
        filterCategory, period: buildPeriodNav(year, month),
        categories: expenseService.EXPENSE_CATEGORIES,
        categoryLabels: expenseService.CATEGORY_LABELS,
        flash,
      });
    }

    /* Vue principale : agrégation MENSUELLE (one-shot du mois + récurrents
     * projetés). C'est ce que le user veut voir : "qu'est-ce qui a pesé
     * sur mai 2026 ?" */
    const monthly = await expenseService.getMonthlyTotals(year, month);

    /* Tri par date desc + récurrents en premier (date originale) */
    const rows = monthly.items
      .map((e) => ({
        id: String(e._id),
        category: e.category,
        categoryLabel: expenseService.categoryLabel(e.category),
        amountCents: e.amountCents,
        date: e.date,
        description: e.description,
        recurring: !!e.recurring,
        recurringEndDate: e.recurringEndDate || null,
        source: e.source || 'manual',
        editable: (e.source || 'manual') === 'manual',
        relatedOrderId: e.relatedOrderId ? String(e.relatedOrderId) : null,
      }))
      .filter((r) => !filterCategory || r.category === filterCategory)
      .sort((a, b) => new Date(b.date) - new Date(a.date));

    const filteredTotal = rows.reduce((s, r) => s + r.amountCents, 0);

    return res.render('admin/expenses-list', {
      title: 'Admin - Charges',
      dbConnected: true,
      rows,
      total: rows.length,
      totalCents: filteredTotal,
      byCategory: monthly.byCategory,
      grandTotalCents: monthly.totalCents,
      filterCategory,
      period: buildPeriodNav(year, month),
      categories: expenseService.EXPENSE_CATEGORIES,
      categoryLabels: expenseService.CATEGORY_LABELS,
      flash,
    });
  } catch (err) {
    return next(err);
  }
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
    year, month,
  };
}

/* ════════════════════════════════════════════════════════════════
 * NEW — GET /admin/charges/nouvelle
 * ════════════════════════════════════════════════════════════════ */

function getNewForm(req, res) {
  const flash = req.session.expensesFlash || null;
  delete req.session.expensesFlash;
  return res.render('admin/expenses-form', {
    title: 'Admin - Nouvelle charge',
    isEdit: false,
    expense: null,
    form: {
      category: 'marketing',
      amount: '',
      date: formatDateForInput(new Date()),
      description: '',
      recurring: false,
      recurringEndDate: '',
      attachmentUrl: '',
    },
    categories: expenseService.EXPENSE_CATEGORIES,
    categoryLabels: expenseService.CATEGORY_LABELS,
    flash,
  });
}

/* ════════════════════════════════════════════════════════════════
 * CREATE — POST /admin/charges/nouvelle
 * ════════════════════════════════════════════════════════════════ */

async function postCreate(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    if (!dbConnected) {
      req.session.expensesFlash = { type: 'error', message: 'Base de données indisponible.' };
      return res.redirect('/admin/charges/nouvelle');
    }

    const category = getTrimmedString(req.body && req.body.category);
    const amountCents = parsePriceToCents(req.body && req.body.amount);
    const date = parseDateInput(req.body && req.body.date);
    const description = getTrimmedString(req.body && req.body.description).slice(0, 500);
    const recurring = req.body && (req.body.recurring === 'on' || req.body.recurring === 'true');
    const recurringEndDate = recurring ? parseDateInput(req.body && req.body.recurringEndDate) : null;

    if (!expenseService.EXPENSE_CATEGORIES.includes(category)) {
      req.session.expensesFlash = { type: 'error', message: 'Catégorie invalide.' };
      return res.redirect('/admin/charges/nouvelle');
    }
    if (!amountCents || amountCents <= 0) {
      req.session.expensesFlash = { type: 'error', message: 'Montant invalide (doit être supérieur à 0).' };
      return res.redirect('/admin/charges/nouvelle');
    }
    if (!date) {
      req.session.expensesFlash = { type: 'error', message: 'Date invalide.' };
      return res.redirect('/admin/charges/nouvelle');
    }

    const created = await Expense.create({
      category,
      amountCents,
      date,
      description,
      recurring,
      recurringEndDate,
      source: 'manual',
      createdBy: getCurrentAdminEmail(req),
    });

    try {
      await auditLogger.log({
        req,
        action: 'admin.expense.create',
        entityType: 'expense',
        entityId: String(created._id),
        after: { category, amountCents, recurring },
      });
    } catch (_) {}

    req.session.expensesFlash = { type: 'success', message: 'Charge ajoutée.' };
    return res.redirect('/admin/charges');
  } catch (err) {
    return next(err);
  }
}

/* ════════════════════════════════════════════════════════════════
 * EDIT — GET /admin/charges/:id
 * ════════════════════════════════════════════════════════════════ */

async function getEditForm(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    if (!dbConnected) return res.redirect('/admin/charges');

    const id = getTrimmedString(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) return res.redirect('/admin/charges');

    const expense = await Expense.findById(id).lean();
    if (!expense) {
      req.session.expensesFlash = { type: 'error', message: 'Charge introuvable.' };
      return res.redirect('/admin/charges');
    }
    if (expense.source !== 'manual') {
      req.session.expensesFlash = { type: 'error', message: 'Les charges automatiques (frais Mollie/Scalapay) ne sont pas modifiables.' };
      return res.redirect('/admin/charges');
    }

    const flash = req.session.expensesFlash || null;
    delete req.session.expensesFlash;

    return res.render('admin/expenses-form', {
      title: 'Admin - Modifier charge',
      isEdit: true,
      expense,
      form: {
        category: expense.category,
        amount: formatPriceForInput(expense.amountCents),
        date: formatDateForInput(expense.date),
        description: expense.description || '',
        recurring: !!expense.recurring,
        recurringEndDate: formatDateForInput(expense.recurringEndDate),
        attachmentUrl: expense.attachmentUrl || '',
      },
      categories: expenseService.EXPENSE_CATEGORIES,
      categoryLabels: expenseService.CATEGORY_LABELS,
      flash,
    });
  } catch (err) {
    return next(err);
  }
}

/* ════════════════════════════════════════════════════════════════
 * UPDATE — POST /admin/charges/:id
 * ════════════════════════════════════════════════════════════════ */

async function postUpdate(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    if (!dbConnected) return res.redirect('/admin/charges');

    const id = getTrimmedString(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) return res.redirect('/admin/charges');

    const existing = await Expense.findById(id);
    if (!existing) {
      req.session.expensesFlash = { type: 'error', message: 'Charge introuvable.' };
      return res.redirect('/admin/charges');
    }
    if (existing.source !== 'manual') {
      req.session.expensesFlash = { type: 'error', message: 'Charge auto non modifiable.' };
      return res.redirect('/admin/charges');
    }

    const category = getTrimmedString(req.body && req.body.category);
    const amountCents = parsePriceToCents(req.body && req.body.amount);
    const date = parseDateInput(req.body && req.body.date);
    const description = getTrimmedString(req.body && req.body.description).slice(0, 500);
    const recurring = req.body && (req.body.recurring === 'on' || req.body.recurring === 'true');
    const recurringEndDate = recurring ? parseDateInput(req.body && req.body.recurringEndDate) : null;

    if (!expenseService.EXPENSE_CATEGORIES.includes(category) || !amountCents || !date) {
      req.session.expensesFlash = { type: 'error', message: 'Champs invalides.' };
      return res.redirect(`/admin/charges/${id}`);
    }

    const before = { category: existing.category, amountCents: existing.amountCents, recurring: existing.recurring };

    existing.category = category;
    existing.amountCents = amountCents;
    existing.date = date;
    existing.description = description;
    existing.recurring = recurring;
    existing.recurringEndDate = recurringEndDate;
    await existing.save();

    try {
      await auditLogger.log({
        req,
        action: 'admin.expense.update',
        entityType: 'expense',
        entityId: String(existing._id),
        before,
        after: { category, amountCents, recurring },
      });
    } catch (_) {}

    req.session.expensesFlash = { type: 'success', message: 'Charge mise à jour.' };
    return res.redirect('/admin/charges');
  } catch (err) {
    return next(err);
  }
}

/* ════════════════════════════════════════════════════════════════
 * DELETE — POST /admin/charges/:id/supprimer
 * ════════════════════════════════════════════════════════════════ */

async function postDelete(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    if (!dbConnected) return res.redirect('/admin/charges');

    const id = getTrimmedString(req.params.id);
    if (!mongoose.Types.ObjectId.isValid(id)) return res.redirect('/admin/charges');

    const existing = await Expense.findById(id);
    if (!existing) return res.redirect('/admin/charges');
    if (existing.source !== 'manual') {
      req.session.expensesFlash = { type: 'error', message: 'Charge auto non supprimable.' };
      return res.redirect('/admin/charges');
    }

    await Expense.deleteOne({ _id: id });

    try {
      await auditLogger.log({
        req,
        action: 'admin.expense.delete',
        entityType: 'expense',
        entityId: id,
        before: { category: existing.category, amountCents: existing.amountCents },
      });
    } catch (_) {}

    req.session.expensesFlash = { type: 'success', message: 'Charge supprimée.' };
    return res.redirect('/admin/charges');
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getListPage,
  getNewForm,
  postCreate,
  getEditForm,
  postUpdate,
  postDelete,
};
