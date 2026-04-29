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

function computePricing({ itemsSubtotalCents, shippingCostCents, clientDiscountPercent = 0, promo = null } = {}) {
  const itemsSubtotal = clampCents(itemsSubtotalCents);
  const shipping = clampCents(shippingCostCents);

  const clientDiscountCents = computeClientDiscountCents(itemsSubtotal, clientDiscountPercent);
  const afterClient = Math.max(0, itemsSubtotal - clientDiscountCents);

  const promoDiscountCents = computePromoDiscountCents(afterClient, promo);
  const afterPromo = Math.max(0, afterClient - promoDiscountCents);

  const totalCents = clampCents(afterPromo + shipping);

  return {
    itemsSubtotalCents: itemsSubtotal,
    shippingCostCents: shipping,
    clientDiscountPercent: clampPercent(clientDiscountPercent),
    clientDiscountCents,
    promoCode: promo && promo.code ? String(promo.code) : '',
    promoDiscountCents,
    itemsTotalAfterDiscountCents: afterPromo,
    totalCents,
  };
}

module.exports = {
  computePricing,
  computeClientDiscountCents,
  computePromoDiscountCents,
  clampCents,
  clampPercent,
};
