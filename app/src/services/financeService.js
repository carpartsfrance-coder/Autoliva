/*
 * financeService — KPI de pilotage financier pour l'owner.
 *
 * À distinguer de accountingService (qui sert le comptable, pour la
 * saisie comptable et la conformité). Ici on raisonne en termes de
 * gestion : marge, COGS, ticket moyen, taux de remboursement, top
 * produits. Calculs sur Orders considérés comme "réalisés" (statut
 * paid/processing/shipped/delivered/completed/partially_refunded).
 *
 * Marge brute = sum( (item.lineTotalCents - item.quantity * product.costCents) )
 * pour les items dont le produit a un costCents > 0. Si costCents
 * absent → la ligne est exclue du calcul marge (mais reste dans le
 * CA). L'UI distingue "ratio de couverture" (% du CA avec marge connue).
 *
 * Statuts comptés comme "vente effective" :
 *   paid, processing, shipped, delivered, completed, partially_refunded
 * Exclus : draft, pending_payment, cancelled, refunded (refunded =
 * remboursé intégralement, donc CA net = 0).
 */

const mongoose = require('mongoose');

const Order = require('../models/Order');
const Product = require('../models/Product');
const expenseService = require('./expenseService');

const TVA_RATE = 0.20;

const SOLD_STATUSES = ['paid', 'processing', 'shipped', 'delivered', 'completed', 'partially_refunded'];

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

function splitVat(ttcCents) {
  const ttc = Number(ttcCents) || 0;
  if (ttc <= 0) return { ht: 0, vat: 0, ttc: 0 };
  const vat = Math.round(ttc - ttc / (1 + TVA_RATE));
  const ht = ttc - vat;
  return { ht, vat, ttc };
}

function sumRefunds(order) {
  if (!order || !Array.isArray(order.refunds)) return 0;
  return order.refunds.reduce((s, r) => s + (Number(r && r.amountCents) || 0), 0);
}

/**
 * KPI financier complet pour le mois donné.
 *
 * Stratégie :
 *   1. Fetch tous les orders réalisés du mois (anchor sur molliePaidAt
 *      / scalapayCapturedAt, fallback createdAt). Limite à ~10k/mois
 *      raisonnable.
 *   2. Fetch tous les coûts produits référencés dans ces orders en 1
 *      query find { _id: $in } pour rester rapide.
 *   3. Itère et agrège : CA, marge, ticket moyen, refunds.
 *   4. Sépare par produit pour les top N.
 */
async function getMonthlySummary(year, month) {
  const { from, to, year: y, month: m } = getMonthRange(year, month);

  /* On utilise createdAt comme date de référence ici (au lieu de
   * molliePaidAt) parce que c'est plus simple et que la majorité des
   * paiements sont quasi-instantanés. */
  const orders = await Order.find({
    status: { $in: SOLD_STATUSES },
    createdAt: { $gte: from, $lt: to },
    archived: { $ne: true },
    deletedAt: null,
  })
    .select('_id number totalCents items refunds status createdAt accountType molliePaymentFeeCents')
    .lean();

  /* Collecte tous les productId pour fetcher les costCents en batch */
  const productIds = new Set();
  for (const o of orders) {
    if (Array.isArray(o.items)) {
      for (const it of o.items) {
        if (it && it.productId && mongoose.Types.ObjectId.isValid(it.productId)) {
          productIds.add(String(it.productId));
        }
      }
    }
  }

  const products = productIds.size
    ? await Product.find({ _id: { $in: Array.from(productIds) } })
        .select('_id name sku priceCents costCents')
        .lean()
    : [];

  const productsById = new Map(products.map((p) => [String(p._id), p]));

  /* Agrégations */
  let revenueTtc = 0;       // CA TTC brut (avant remboursements)
  let refundsTotal = 0;     // total remboursé
  let cogsKnown = 0;        // coût d'achat connu (sum quantité × costCents)
  let marginGrossKnown = 0; // marge brute calculée (uniquement items avec cost)
  let revenueTtcWithCost = 0; // CA TTC dont on connaît le cost (pour le %)
  let itemsCountWithCost = 0;
  let itemsCountTotal = 0;
  let ordersWithSoldItems = 0;
  let molliePaymentFeesTotal = 0;  // somme des frais Mollie capturés (settlementAmount - amount)
  let ordersWithFeeKnown = 0;

  /* Top produits par CA et par marge */
  const productAggs = new Map(); // key: productId

  for (const o of orders) {
    revenueTtc += Number(o.totalCents) || 0;
    refundsTotal += sumRefunds(o);
    if (Array.isArray(o.items) && o.items.length > 0) ordersWithSoldItems++;
    if (Number.isFinite(o.molliePaymentFeeCents) && o.molliePaymentFeeCents > 0) {
      molliePaymentFeesTotal += o.molliePaymentFeeCents;
      ordersWithFeeKnown++;
    }

    if (!Array.isArray(o.items)) continue;
    for (const it of o.items) {
      if (!it) continue;
      itemsCountTotal++;
      const productId = it.productId ? String(it.productId) : null;
      const product = productId ? productsById.get(productId) : null;
      const lineTtc = Number(it.lineTotalCents) || 0;
      const qty = Number(it.quantity) || 0;
      const costPerUnit = product && Number.isFinite(product.costCents) && product.costCents != null
        ? Number(product.costCents)
        : null;

      /* Aggregation par produit */
      let agg = productId ? productAggs.get(productId) : null;
      if (!agg && productId) {
        agg = {
          productId,
          name: (product && product.name) || it.name || '—',
          sku: (product && product.sku) || it.sku || '',
          qtySold: 0,
          revenueTtc: 0,
          revenueHt: 0,
          cogs: 0,
          margin: 0,
          marginPct: null,
          costKnown: costPerUnit != null,
        };
        productAggs.set(productId, agg);
      }
      if (agg) {
        agg.qtySold += qty;
        agg.revenueTtc += lineTtc;
        const ht = Math.round(lineTtc / (1 + TVA_RATE));
        agg.revenueHt += ht;
        if (costPerUnit != null) {
          const lineCogs = qty * costPerUnit;
          agg.cogs += lineCogs;
          agg.margin = agg.revenueHt - agg.cogs;
          agg.marginPct = agg.revenueHt > 0 ? Math.round((agg.margin / agg.revenueHt) * 10000) / 100 : null;
          agg.costKnown = true;
        }
      }

      if (costPerUnit != null) {
        const lineHt = Math.round(lineTtc / (1 + TVA_RATE));
        const lineCogs = qty * costPerUnit;
        cogsKnown += lineCogs;
        marginGrossKnown += lineHt - lineCogs;
        revenueTtcWithCost += lineTtc;
        itemsCountWithCost++;
      }
    }
  }

  const revenueNet = revenueTtc - refundsTotal;
  const revenueNetSplit = splitVat(revenueNet);
  const refundRate = revenueTtc > 0 ? refundsTotal / revenueTtc : 0;
  const avgBasketCents = ordersWithSoldItems > 0 ? Math.round(revenueTtc / ordersWithSoldItems) : 0;
  const costCoveragePct = revenueTtc > 0 ? (revenueTtcWithCost / revenueTtc) : 0;
  const marginPctKnown = revenueTtcWithCost > 0
    ? marginGrossKnown / Math.round(revenueTtcWithCost / (1 + TVA_RATE))
    : 0;

  /* Tri top produits */
  const productList = Array.from(productAggs.values());
  const topByRevenue = [...productList].sort((a, b) => b.revenueTtc - a.revenueTtc).slice(0, 10);
  const topByMargin = productList
    .filter((p) => p.costKnown)
    .sort((a, b) => b.margin - a.margin)
    .slice(0, 10);
  /* Liste exhaustive de TOUS les produits vendus dans le mois, triée par
   * CA décroissant. Sert au tableau "Tous les produits vendus" de la page
   * /admin/finance, avec recherche + tri client-side côté JS. */
  const allProductsSold = [...productList].sort((a, b) => b.revenueTtc - a.revenueTtc);

  /* ── Charges & bénéfice net ───────────────────────────────────
   * Frais paiement = somme des molliePaymentFeeCents capturés via
   *                  webhook Mollie (et idéalement Scalapay un jour)
   * Charges manuelles = saisies dans /admin/charges (loyer, marketing,
   *                     salaires, SaaS, etc.) — projection des récurrentes
   * Bénéfice net = Marge brute − Frais paiement − Charges manuelles */
  const expensesMonthly = await expenseService.getMonthlyTotals(y, m);
  const manualExpensesTotal = expensesMonthly.totalCents;
  const expensesByCategory = expensesMonthly.byCategory;

  /* On ajoute le bucket "payment_fees" si non saisi manuellement et qu'on a
   * capturé via Mollie. Évite la double comptabilisation : si une charge
   * payment_fees manuelle existe ce mois-ci, l'owner a probablement saisi
   * lui-même les frais (ex : Scalapay), donc on additionne les deux. */
  const totalChargesCents = manualExpensesTotal + molliePaymentFeesTotal;

  /* Bénéfice net : on prend la marge brute "connue" (sur produits au cost
   * renseigné) et on soustrait toutes les charges. Si la couverture cost
   * n'est pas 100 %, on prévient l'UI via `incompleteMargin: true`. */
  const netProfitCents = marginGrossKnown - totalChargesCents;
  const netProfitPct = revenueNet > 0 ? netProfitCents / Math.round(revenueNet / (1 + TVA_RATE)) : 0;

  return {
    year: y,
    month: m,
    from,
    to,
    orderCount: orders.length,
    ordersWithSoldItems,
    revenue: {
      ttc: revenueTtc,
      ...splitVat(revenueTtc),
    },
    refunds: {
      total: refundsTotal,
      rate: refundRate,
    },
    net: {
      ttc: revenueNet,
      ...revenueNetSplit,
    },
    avgBasket: avgBasketCents,
    margin: {
      cogsKnown,
      gross: marginGrossKnown,
      pct: marginPctKnown,
      coveragePct: costCoveragePct,
      itemsCountWithCost,
      itemsCountTotal,
    },
    expenses: {
      manualTotal: manualExpensesTotal,
      paymentFeesAuto: molliePaymentFeesTotal,
      ordersWithFeeKnown,
      total: totalChargesCents,
      byCategory: expensesByCategory,
    },
    profit: {
      netCents: netProfitCents,
      netPct: netProfitPct,
      incompleteMargin: costCoveragePct < 1,
    },
    topByRevenue,
    topByMargin,
    allProductsSold,
    products: { totalCountWithCost: products.filter((p) => Number.isFinite(p.costCents) && p.costCents > 0).length, totalCount: products.length },
  };
}

/**
 * Tendance 12 mois pour le graphique.
 */
async function getTwelveMonthTrend(referenceDate) {
  const ref = referenceDate instanceof Date ? referenceDate : new Date();
  const months = [];
  for (let i = 11; i >= 0; i--) {
    const d = new Date(ref.getFullYear(), ref.getMonth() - i, 1);
    months.push({ year: d.getFullYear(), month: d.getMonth() + 1 });
  }
  const summaries = await Promise.all(months.map((m) => getMonthlySummary(m.year, m.month)));
  return summaries.map((s) => ({
    year: s.year,
    month: s.month,
    label: new Date(s.year, s.month - 1, 1).toLocaleString('fr-FR', { month: 'short', year: '2-digit' }),
    revenueTtc: s.revenue.ttc,
    netTtc: s.net.ttc,
    marginGross: s.margin.gross,
    profit: s.profit.netCents,
    chargesTotal: s.expenses.total,
  }));
}

module.exports = {
  TVA_RATE,
  SOLD_STATUSES,
  getMonthRange,
  splitVat,
  getMonthlySummary,
  getTwelveMonthTrend,
};
