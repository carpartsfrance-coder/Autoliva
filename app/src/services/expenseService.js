/*
 * expenseService — agrégations de charges pour le pilotage financier.
 *
 * Gère la projection des charges récurrentes (loyer = 800 €/mois pendant
 * 2 ans → on stocke 1 entrée Expense récurrente, et on la projette à la
 * volée sur chacun des 24 mois lors du calcul). Pas de cron, pas de
 * dupes en base.
 */

const Expense = require('../models/Expense');
const { EXPENSE_CATEGORIES } = require('../models/Expense');

const CATEGORY_LABELS = {
  payment_fees: 'Frais paiement (Mollie, Scalapay…)',
  marketing:    'Marketing & pub',
  personnel:    'Salaires & charges sociales',
  premises:     'Loyer & locaux',
  saas:         'Outils SaaS',
  purchases:    'Achats divers (outillage, fournitures)',
  logistics:    'Logistique & expédition',
  sav:          'Coûts SAV',
  taxes:        'Impôts & taxes',
  bank:         'Frais bancaires',
  other:        'Autre',
};

function categoryLabel(key) {
  return CATEGORY_LABELS[key] || key;
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

/**
 * Récupère les charges qui s'appliquent à un mois donné.
 *
 * Une charge s'applique si :
 *  - charge ponctuelle (recurring=false) ET `date` dans le mois
 *  - charge récurrente (recurring=true) ET `date <= fin du mois`
 *    ET (recurringEndDate null OU recurringEndDate >= début du mois)
 *
 * Les charges récurrentes sont retournées plusieurs fois (1 fois par mois
 * où elles s'appliquent) — chaque retour porte un champ virtuel
 * `_projectedMonthDate` pour identifier le mois projeté.
 */
async function listForMonth(year, month) {
  const { from, to } = getMonthRange(year, month);
  const endOfMonth = new Date(to.getTime() - 1);

  /* Une seule query qui matche :
   *   - one-shot avec date in [from, to[
   *   - récurrent dont la période chevauche [from, to[
   */
  const docs = await Expense.find({
    $or: [
      /* One-shot dans le mois */
      { recurring: { $ne: true }, date: { $gte: from, $lt: to } },
      /* Récurrent actif sur ce mois */
      {
        recurring: true,
        date: { $lte: endOfMonth },
        $or: [
          { recurringEndDate: null },
          { recurringEndDate: { $gte: from } },
        ],
      },
    ],
  })
    .sort({ date: -1 })
    .lean();

  return docs.map((d) => ({ ...d, _projectedMonthDate: from }));
}

/**
 * Synthèse mensuelle par catégorie. Retourne :
 *   {
 *     totalCents: 1234,
 *     byCategory: { marketing: 500, premises: 800, ... },
 *     items: [...]  // les charges détaillées (one-shot + récurrentes appliquées)
 *   }
 */
async function getMonthlyTotals(year, month) {
  const items = await listForMonth(year, month);

  const byCategory = {};
  let totalCents = 0;
  for (const e of items) {
    const amt = Number(e.amountCents) || 0;
    totalCents += amt;
    byCategory[e.category] = (byCategory[e.category] || 0) + amt;
  }

  return { totalCents, byCategory, items };
}

/**
 * Liste paginée des charges pour l'écran admin (vue plate, sans projection).
 *
 * Filtres :
 *   - category : string ou array
 *   - from / to : période (sur le champ `date`)
 *   - includeRecurring : booléen (par défaut true)
 */
async function listExpenses({ category, from, to, includeRecurring = true, page = 1, limit = 50 } = {}) {
  const query = {};
  if (category) {
    if (Array.isArray(category)) query.category = { $in: category };
    else query.category = category;
  }
  if (from instanceof Date || to instanceof Date) {
    query.date = {};
    if (from instanceof Date) query.date.$gte = from;
    if (to instanceof Date) query.date.$lt = to;
  }
  if (!includeRecurring) query.recurring = { $ne: true };

  const safePage = Math.max(1, Number(page) || 1);
  const safeLimit = Math.min(200, Math.max(10, Number(limit) || 50));
  const skip = (safePage - 1) * safeLimit;

  const [docs, total] = await Promise.all([
    Expense.find(query).sort({ date: -1, createdAt: -1 }).skip(skip).limit(safeLimit).lean(),
    Expense.countDocuments(query),
  ]);

  return {
    rows: docs,
    total,
    page: safePage,
    limit: safeLimit,
    pageCount: Math.max(1, Math.ceil(total / safeLimit)),
  };
}

/**
 * Upsert idempotent pour les charges auto (frais paiement Mollie/Scalapay
 * notamment). Évite les doublons via { source, externalRef }.
 *
 * Si l'entrée existe déjà : on met à jour amountCents/description, on touche
 * pas le reste. Si elle n'existe pas : on crée.
 */
async function upsertAutoExpense({ source, externalRef, category, amountCents, date, description, relatedOrderId } = {}) {
  if (!source || !externalRef) {
    throw new Error('upsertAutoExpense: source + externalRef obligatoires');
  }
  if (!Number.isFinite(amountCents) || amountCents <= 0) {
    throw new Error('upsertAutoExpense: amountCents invalide');
  }

  const filter = { source, externalRef };
  const update = {
    $set: {
      category,
      amountCents,
      date: date || new Date(),
      description: description || '',
      relatedOrderId: relatedOrderId || null,
    },
    $setOnInsert: {
      recurring: false,
      recurringEndDate: null,
      createdBy: 'webhook',
    },
  };
  return Expense.findOneAndUpdate(filter, update, { upsert: true, new: true });
}

module.exports = {
  EXPENSE_CATEGORIES,
  CATEGORY_LABELS,
  categoryLabel,
  getMonthRange,
  listForMonth,
  getMonthlyTotals,
  listExpenses,
  upsertAutoExpense,
};
