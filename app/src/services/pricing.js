function clampCents(value) {
  const n = Number(value) || 0;
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.round(n));
}

function clampPercent(value) {
  const n = Number(value) || 0;
  if (!Number.isFinite(n)) return 0;
  return Math.min(100, Math.max(0, n));
}

function computeClientDiscountCents(itemsSubtotalCents, clientDiscountPercent) {
  const subtotal = clampCents(itemsSubtotalCents);
  const pct = clampPercent(clientDiscountPercent);
  if (!subtotal || !pct) return 0;
  return Math.min(subtotal, Math.round((subtotal * pct) / 100));
}

function computePromoDiscountCents(itemsSubtotalCentsAfterClient, promo) {
  const subtotal = clampCents(itemsSubtotalCentsAfterClient);
  if (!promo || !promo.code) return 0;

  const type = promo.discountType === 'fixed' ? 'fixed' : 'percent';

  if (type === 'fixed') {
    const amount = clampCents(promo.discountAmountCents);
    if (!amount) return 0;
    return Math.min(subtotal, amount);
  }

  const pct = clampPercent(promo.discountPercent);
  if (!pct) return 0;
  return Math.min(subtotal, Math.round((subtotal * pct) / 100));
}

function computePricing({ itemsSubtotalCents, shippingCostCents, clientDiscountPercent = 0, promo = null, consigneChargeCents = 0 } = {}) {
  const itemsSubtotal = clampCents(itemsSubtotalCents);
  const shipping = clampCents(shippingCostCents);
  // Consigne encaissée (caution) : ajoutée au total APRÈS remises — une caution
  // ne se remise pas et n'est jamais réduite par un code promo.
  const consigne = clampCents(consigneChargeCents);

  const clientDiscountCents = computeClientDiscountCents(itemsSubtotal, clientDiscountPercent);
  const afterClient = Math.max(0, itemsSubtotal - clientDiscountCents);

  const promoDiscountCents = computePromoDiscountCents(afterClient, promo);
  const afterPromo = Math.max(0, afterClient - promoDiscountCents);

  const totalCents = clampCents(afterPromo + shipping + consigne);

  return {
    itemsSubtotalCents: itemsSubtotal,
    shippingCostCents: shipping,
    clientDiscountPercent: clampPercent(clientDiscountPercent),
    clientDiscountCents,
    promoCode: promo && promo.code ? String(promo.code) : '',
    promoDiscountCents,
    itemsTotalAfterDiscountCents: afterPromo,
    consigneChargeCents: consigne,
    totalCents,
  };
}

/**
 * Consignes NON encaissées à la commande (échange standard « sans caution ») :
 * rien n'est ajouté au total, mais l'acheteur s'engage à renvoyer l'ancienne
 * pièce, faute de quoi le montant lui est facturé. C'est un coût conditionnel :
 * le panier, la livraison et le paiement doivent le rappeler juste avant la
 * commande (§ 312j Abs. 2 BGB), alors qu'ils n'affichaient que la consigne
 * encaissée. Mêmes conditions que la ligne `consigne.lines` créée au paiement
 * (checkoutController.postPayment, `charged: false`).
 *
 * @param {Array<{product: object, quantity: number}>} items lignes du panier
 * @returns {Array<{name: string, quantity: number, amountCents: number, delayDays: number}>}
 */
function listConditionalConsigneLines(items) {
  const out = [];
  for (const it of Array.isArray(items) ? items : []) {
    const p = it && it.product;
    const c = p && p.consigne;
    if (!c || !c.enabled || c.chargeUpfront === true) continue;
    if (!Number.isFinite(c.amountCents) || c.amountCents <= 0) continue;
    const quantity = Math.max(1, Number(it.quantity) || 1);
    out.push({
      name: p.name || '',
      quantity,
      amountCents: Math.floor(c.amountCents) * quantity,
      delayDays: Number.isFinite(c.delayDays) && c.delayDays > 0 ? Math.floor(c.delayDays) : 30,
    });
  }
  return out;
}

module.exports = {
  listConditionalConsigneLines,
  computePricing,
  computeClientDiscountCents,
  computePromoDiscountCents,
  clampCents,
  clampPercent,
};
