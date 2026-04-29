const mongoose = require('mongoose');

const Product = require('../models/Product');
const User = require('../models/User');
const Order = require('../models/Order');
const AbandonedCart = require('../models/AbandonedCart');
const demoProducts = require('../demoProducts');

const mollie = require('../services/mollie');
const scalapay = require('../services/scalapay');
const promoCodes = require('../services/promoCodes');
const pricing = require('../services/pricing');
const emailService = require('../services/emailService');
const smsService = require('../services/smsService');
const productOptions = require('../services/productOptions');
const { getShippingMethods } = require('../services/shippingPricing');
const { getLegalPageBySlug } = require('../services/legalPages');
const { ensureInvoiceIssuedForPaidOrder } = require('../services/orderInvoices');
const { getNextOrderNumber } = require('../services/orderNumber');
const { getSiteUrlFromReq } = require('../services/siteUrl');

const crypto = require('crypto');
const brand = require('../config/brand');

function getCart(req) {
  if (!req.session.cart) {
    req.session.cart = { items: {} };
  }

  return req.session.cart;
}

function computeCartItemCount(cart) {
  return Object.values(cart.items).reduce((sum, item) => sum + (Number(item && item.quantity) || 0), 0);
}

function parseNumberFromLooseString(value) {
  if (typeof value !== 'string') return null;

  const cleaned = value.replace(/[\s\u00A0]/g, '').replace(/[^\d,.-]/g, '');

  if (!cleaned) return null;

  const hasComma = cleaned.includes(',');
  const hasDot = cleaned.includes('.');

  let normalized = cleaned;

  if (hasComma && hasDot) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      normalized = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = cleaned.replace(/,/g, '');
    }
  } else if (hasComma) {
    normalized = cleaned.replace(',', '.');
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function parseLegacyPriceCents(product) {
  if (Number.isFinite(product.priceCents)) return product.priceCents;

  if (typeof product.priceCents === 'string') {
    const parsed = parseNumberFromLooseString(product.priceCents);
    if (parsed !== null) {
      if (parsed >= 50000) return Math.round(parsed);
      return Math.round(parsed * 100);
    }
  }

  const legacy =
    product.price ??
    product.priceEuro ??
    product.priceEuros ??
    product.prix ??
    null;

  if (typeof legacy === 'number' && Number.isFinite(legacy)) {
    if (legacy >= 50000) return Math.round(legacy);
    return Math.round(legacy * 100);
  }

  if (typeof legacy === 'string') {
    const parsed = parseNumberFromLooseString(legacy);
    if (parsed === null) return 0;
    if (parsed >= 50000) return Math.round(parsed);
    return Math.round(parsed * 100);
  }

  return 0;
}

function normalizeProduct(product) {
  if (!product) return product;

  let stockQty = null;
  if (Number.isFinite(product.stockQty)) {
    stockQty = product.stockQty;
  } else if (typeof product.stockQty === 'string') {
    const trimmed = product.stockQty.trim();
    if (trimmed) {
      const n = Number(trimmed);
      if (Number.isFinite(n) && n >= 0) {
        stockQty = Math.floor(n);
      }
    }
  }

  const inStock =
    stockQty !== null
      ? stockQty > 0
      :
    product.inStock === false ||
    product.inStock === 'false' ||
    product.inStock === 0 ||
    product.inStock === '0'
      ? false
      : true;

  const rawConsigne = product.consigne && typeof product.consigne === 'object'
    ? product.consigne
    : {};
  const consigneEnabled = rawConsigne.enabled === true;
  const consigneAmountCents = Number.isFinite(rawConsigne.amountCents) && rawConsigne.amountCents >= 0
    ? Math.floor(rawConsigne.amountCents)
    : 0;
  const consigneDelayDays = Number.isFinite(rawConsigne.delayDays) && rawConsigne.delayDays >= 0
    ? Math.floor(rawConsigne.delayDays)
    : 30;

  return {
    ...product,
    inStock,
    stockQty,
    priceCents: parseLegacyPriceCents(product),
    consigne: {
      enabled: consigneEnabled,
      amountCents: consigneAmountCents,
      delayDays: consigneDelayDays,
    },
  };
}

function formatEuro(totalCents) {
  return `${(totalCents / 100).toFixed(2).replace('.', ',')} €`;
}

async function buildCartView(dbConnected, cart) {
  const items = Object.entries(cart.items).map(([key, it]) => {
    const safe = it && typeof it === 'object' ? it : {};
    return {
      ...safe,
      lineId: safe.lineId || key,
    };
  });
  const productById = new Map();

  if (dbConnected && items.length) {
    const productIds = items.map((i) => i.productId);
    const products = await Product.find({ _id: { $in: productIds } }).lean();
    for (const p of products) {
      productById.set(String(p._id), p);
    }
  }

  for (const p of demoProducts) {
    if (!productById.has(String(p._id))) {
      productById.set(String(p._id), p);
    }
  }

  const viewItems = [];
  let itemsTotalCents = 0;

  for (const item of items) {
    const product = normalizeProduct(productById.get(String(item.productId)));
    if (!product) continue;

    const unitPriceCents = productOptions.computeUnitPriceCents(product, item.optionsSelection);
    const lineTotalCents = unitPriceCents * item.quantity;
    itemsTotalCents += lineTotalCents;

    const fallbackSummary = productOptions.buildOptionsDisplay(product.options, item.optionsSelection).optionsSummary;
    const optionsSummary = typeof item.optionsSummary === 'string' && item.optionsSummary.trim() ? item.optionsSummary.trim() : fallbackSummary;

    viewItems.push({
      lineId: item.lineId || '',
      product,
      quantity: item.quantity,
      unitPriceCents,
      lineTotalCents,
      optionsSummary,
    });
  }

  return { viewItems, itemsTotalCents };
}

function getDefaultAddress(addresses) {
  if (!Array.isArray(addresses) || addresses.length === 0) return null;
  return addresses.find((a) => a && a.isDefault) || addresses[0] || null;
}

function getCheckoutState(req) {
  if (!req.session.checkout) {
    req.session.checkout = {};
  }

  return req.session.checkout;
}

function isTruthyFormValue(value) {
  return value === 'on' || value === 'true' || value === true;
}

function normalizeVehicleIdentifier(value) {
  if (typeof value !== 'string') return '';
  return value
    .trim()
    .toUpperCase()
    .replace(/\s+/g, '')
    .replace(/[^A-Z0-9]/g, '');
}

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseScalapayProductFromPaymentMethod(paymentMethod) {
  const pm = getTrimmedString(paymentMethod).toLowerCase();
  if (pm === 'scalapay_pay_in_3') return 'pay-in-3';
  if (pm === 'scalapay_pay_in_4') return 'pay-in-4';
  return '';
}

function getCountryCodeFromAddressCountry(country) {
  const raw = getTrimmedString(country);
  if (!raw) return 'FR';
  const upper = raw.toUpperCase();
  if (upper === 'FR' || upper === 'FRANCE') return 'FR';
  if (/^[A-Z]{2}$/.test(upper)) return upper;
  return 'FR';
}

function normalizePhoneForScalapay(phone, countryCode = 'FR') {
  const raw = getTrimmedString(phone);
  if (!raw) return '+33000000000';

  const cleaned = raw.replace(/[\s.()-]/g, '');
  if (cleaned.startsWith('+')) return cleaned;

  const cc = getTrimmedString(countryCode).toUpperCase();
  if (cc === 'FR') {
    if (cleaned.startsWith('0')) return `+33${cleaned.slice(1)}`;
    return `+33${cleaned}`;
  }

  return `+${cleaned}`;
}

function splitNameParts(fullName) {
  const raw = getTrimmedString(fullName);
  if (!raw) return { givenNames: '', surname: '' };
  const parts = raw.split(/\s+/g).filter(Boolean);
  if (parts.length === 1) return { givenNames: parts[0], surname: parts[0] };
  return { givenNames: parts[0], surname: parts.slice(1).join(' ') };
}

function getPublicBaseUrl(req) {
  return getSiteUrlFromReq(req);
}

function getMollieProfileId() {
  return getTrimmedString(process.env.MOLLIE_PROFILE_ID);
}

function getMollieWebhookToken() {
  return getTrimmedString(process.env.MOLLIE_WEBHOOK_TOKEN);
}

function getScalapayWebhookToken() {
  return getTrimmedString(process.env.SCALAPAY_WEBHOOK_TOKEN);
}

function getMollieWebhookBaseUrl() {
  return getTrimmedString(process.env.MOLLIE_WEBHOOK_URL);
}

function isLocalPaymentSimulationEnabled() {
  return process.env.NODE_ENV !== 'production';
}

function shouldSimulateMolliePayment() {
  return isLocalPaymentSimulationEnabled() && !getTrimmedString(process.env.MOLLIE_API_KEY);
}

function shouldSimulateScalapayPayment() {
  return isLocalPaymentSimulationEnabled() && !getTrimmedString(process.env.SCALAPAY_API_KEY);
}

function isLocalBaseUrl(url) {
  const u = getTrimmedString(url).toLowerCase();
  return (
    u.includes('://localhost') ||
    u.includes('://127.0.0.1') ||
    u.includes('://0.0.0.0')
  );
}

function mapMollieStatusToPaymentStatus(mollieStatus) {
  const s = getTrimmedString(mollieStatus).toLowerCase();
  if (s === 'paid') return 'paid';
  if (s === 'open' || s === 'pending' || s === 'authorized') return 'pending';
  return 'failed';
}

function mapScalapayStatusToPaymentStatus(scalapayStatus) {
  const s = getTrimmedString(scalapayStatus).toLowerCase();
  if (s === 'charged' || s === 'captured') return 'paid';
  if (s === 'approved' || s === 'authorized' || s === 'authorised') return 'paid';
  if (s === 'pending' || s === 'created' || s === 'processing') return 'pending';
  if (s === 'declined' || s === 'canceled' || s === 'cancelled' || s === 'expired' || s === 'void') return 'failed';
  return s ? 'pending' : 'pending';
}

/**
 * Marque comme 'recovered' tous les paniers abandonnés actifs liés à cet
 * utilisateur ou à cet email. Appelée quand une commande devient `paid` :
 * sans ça, un client qui revient sur le site (sans cliquer le lien
 * /panier/recuperer/<token>) et passe sa commande continue à recevoir
 * les relances suivantes (J+24h, J+72h) jusqu'à expiration. Match sur
 * userId ET email pour couvrir les invités.
 */
async function markAbandonedCartsAsRecoveredForOrder(order, user) {
  try {
    if (!order || !order._id) return;
    const conditions = [];
    if (order.userId) {
      conditions.push({ userId: order.userId });
    }
    const email = user && user.email ? String(user.email).trim().toLowerCase() : '';
    if (email) {
      conditions.push({ email });
    }
    if (!conditions.length) return;

    const result = await AbandonedCart.updateMany(
      {
        $or: conditions,
        status: { $nin: ['recovered', 'expired'] },
      },
      {
        $set: {
          status: 'recovered',
          recoveredAt: new Date(),
        },
      }
    );

    if (result && result.modifiedCount) {
      console.log(`[abandoned-cart] ${result.modifiedCount} panier(s) marqué(s) recovered suite à la commande ${order.number || order._id}`);
    }
  } catch (err) {
    console.error('[abandoned-cart] Erreur marquage recovered:', err && err.message ? err.message : err);
  }
}

function applyDiscountToOrderItems(orderItems, discountedItemsTotalCents) {
  const items = Array.isArray(orderItems) ? orderItems.filter(Boolean) : [];

  const originalSubtotal = items.reduce((sum, it) => sum + (Number(it && it.lineTotalCents) || 0), 0);
  const target = Math.max(0, Number(discountedItemsTotalCents) || 0);

  if (!items.length) return [];
  if (originalSubtotal <= 0) return items;
  if (target >= originalSubtotal) return items;

  const ratio = target / originalSubtotal;

  const units = [];
  for (const it of items) {
    const qty = Number(it.quantity) || 1;
    const unitPriceCents = Number(it.unitPriceCents) || 0;
    const optionsSummary = typeof it.optionsSummary === 'string' ? it.optionsSummary : '';
    const optionsSelection = it && it.optionsSelection && typeof it.optionsSelection === 'object' ? it.optionsSelection : {};
    for (let i = 0; i < qty; i += 1) {
      const raw = unitPriceCents * ratio;
      const floored = Math.floor(raw);
      units.push({
        productId: it.productId,
        name: it.name,
        sku: it.sku || '',
        optionsSummary,
        optionsSelection,
        raw,
        unitPriceCents: floored,
        frac: raw - floored,
      });
    }
  }

  let sumUnits = units.reduce((sum, u) => sum + (Number(u.unitPriceCents) || 0), 0);
  let diff = target - sumUnits;

  if (diff > 0) {
    units.sort((a, b) => (b.frac || 0) - (a.frac || 0));
    for (let i = 0; i < units.length && diff > 0; i += 1) {
      units[i].unitPriceCents += 1;
      diff -= 1;
    }
    sumUnits = units.reduce((sum, u) => sum + (Number(u.unitPriceCents) || 0), 0);
  }

  if (diff < 0) {
    units.sort((a, b) => (a.frac || 0) - (b.frac || 0));
    for (let i = 0; i < units.length && diff < 0; i += 1) {
      if (units[i].unitPriceCents > 0) {
        units[i].unitPriceCents -= 1;
        diff += 1;
      }
    }
  }

  const grouped = new Map();

  for (const u of units) {
    const pid = u.productId ? String(u.productId) : '';
    const sku = u.sku || '';
    const name = u.name || '';
    const price = Number(u.unitPriceCents) || 0;
    const optionsSummary = u.optionsSummary || '';
    const key = `${pid}__${sku}__${price}__${name}__${optionsSummary}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.quantity += 1;
      existing.lineTotalCents += price;
    } else {
      grouped.set(key, {
        productId: itOrNullObjectId(pid) || u.productId,
        name,
        sku,
        optionsSummary,
        optionsSelection: u.optionsSelection && typeof u.optionsSelection === 'object' ? u.optionsSelection : {},
        unitPriceCents: price,
        quantity: 1,
        lineTotalCents: price,
      });
    }
  }

  return Array.from(grouped.values());
}

function itOrNullObjectId(value) {
  if (!value) return null;
  const s = String(value);
  if (!mongoose.Types.ObjectId.isValid(s)) return null;
  return new mongoose.Types.ObjectId(s);
}

async function reserveOrderStockIfNeeded(order, productById) {
  if (!order || !order._id) return;

  const state = await Order.findById(order._id).select('_id stockReservedAt stockReleasedAt').lean();
  if (!state) return;
  if (state.stockReservedAt) return;

  const items = Array.isArray(order.items) ? order.items : [];
  for (const item of items) {
    if (!item || !item.productId) continue;
    const product = productById.get(String(item.productId));
    if (!product) continue;
    if (!mongoose.Types.ObjectId.isValid(String(product._id))) continue;
    if (!Number.isFinite(product.stockQty)) continue;

    const newQty = Math.max(0, product.stockQty - item.quantity);
    await Product.findByIdAndUpdate(product._id, {
      $set: { stockQty: newQty, inStock: newQty > 0 },
    });

    product.stockQty = newQty;
    product.inStock = newQty > 0;
  }

  await Order.findByIdAndUpdate(order._id, { $set: { stockReservedAt: new Date() } });
}

async function releaseOrderStockIfNeeded(order) {
  if (!order || !order._id) return;

  const state = await Order.findById(order._id).select('_id stockReservedAt stockReleasedAt items').lean();
  if (!state) return;
  if (!state.stockReservedAt) return;
  if (state.stockReleasedAt) return;

  const items = Array.isArray(state.items) ? state.items : [];

  for (const item of items) {
    if (!item || !item.productId) continue;

    const product = await Product.findById(item.productId).select('_id stockQty').lean();
    if (!product) continue;
    if (!Number.isFinite(product.stockQty)) continue;

    await Product.findByIdAndUpdate(product._id, {
      $inc: { stockQty: item.quantity },
      $set: { inStock: true },
    });
  }

  await Order.findByIdAndUpdate(order._id, { $set: { stockReleasedAt: new Date() } });
}

async function applyMolliePaymentToOrder(order, payment) {
  if (!order || !order._id || !payment) return order;

  const wasPaid = getTrimmedString(order.paymentStatus).toLowerCase() === 'paid';

  const mollieStatus = getTrimmedString(payment.status);
  const paymentStatus = mapMollieStatusToPaymentStatus(mollieStatus);

  const update = {
    paymentProvider: 'mollie',
    paymentStatus,
    molliePaymentStatus: mollieStatus,
    mollieLastCheckedAt: new Date(),
  };

  if (paymentStatus === 'paid') {
    update.molliePaidAt = new Date();

    if (order.status !== 'paid' && order.status !== 'processing' && order.status !== 'shipped' && order.status !== 'delivered' && order.status !== 'completed') {
      update.status = 'processing';
      update.$push = {
        statusHistory: {
          $each: [
            { status: 'paid', changedAt: new Date(), changedBy: 'mollie' },
            { status: 'processing', changedAt: new Date(), changedBy: 'system', note: 'Passage automatique en préparation après paiement' },
          ],
        },
      };
    }
  }

  if (paymentStatus === 'failed') {
    if (order.status !== 'cancelled' && order.status !== 'delivered' && order.status !== 'completed') {
      update.status = 'cancelled';
      update.$push = {
        statusHistory: {
          status: 'cancelled',
          changedAt: new Date(),
          changedBy: 'mollie',
        },
      };
    }
  }

  await Order.findByIdAndUpdate(order._id, update);
  let refreshed = await Order.findById(order._id).lean();

  if (paymentStatus === 'paid' && !wasPaid) {
    try {
      await ensureInvoiceIssuedForPaidOrder(refreshed._id);
      refreshed = await Order.findById(refreshed._id).lean();
    } catch (err) {
      console.error('Erreur attribution numéro facture (Mollie) :', err && err.message ? err.message : err);
    }
  }

  if (paymentStatus === 'failed') {
    await releaseOrderStockIfNeeded(refreshed);
    await promoCodes.releaseReservedForOrder(order._id);
  }

  if (paymentStatus === 'paid') {
    await promoCodes.redeemReservedForOrder(order._id);
  }

  if (paymentStatus === 'paid' && !wasPaid) {
    try {
      const alreadySent = refreshed
        && refreshed.notifications
        && refreshed.notifications.orderConfirmationSentAt;

      if (!alreadySent) {
        const user = await User.findById(refreshed.userId).select('_id email firstName smsOptIn').lean();
        if (user && user.email) {
          const sent = await emailService.sendOrderConfirmationEmail({ order: refreshed, user });
          emailService.logEmailSent({ orderId: refreshed._id, emailType: 'order_confirmation', recipientEmail: user.email, result: sent });
          smsService.sendOrderConfirmationSms({ order: refreshed, user }).catch(() => {});
          if (sent && sent.ok) {
            await Order.updateOne(
              {
                _id: refreshed._id,
                $or: [
                  { 'notifications.orderConfirmationSentAt': { $exists: false } },
                  { 'notifications.orderConfirmationSentAt': null },
                ],
              },
              { $set: { 'notifications.orderConfirmationSentAt': new Date() } }
            );
          }
        }
      }
    } catch (err) {
      console.error('Erreur email confirmation commande (Mollie) :', err && err.message ? err.message : err);
    }

    // Marque les paniers abandonnés comme récupérés pour ce client/email
    // (évite que le client reçoive des relances après avoir commandé sans
    // avoir cliqué le lien /panier/recuperer)
    try {
      const userForCleanup = refreshed && refreshed.userId
        ? await User.findById(refreshed.userId).select('email').lean()
        : null;
      await markAbandonedCartsAsRecoveredForOrder(refreshed, userForCleanup);
    } catch (_) { /* helper handles its own errors */ }
  }

  return refreshed;
}

/**
 * Réconcilie une commande Scalapay : interroge l'API pour le statut courant,
 * tente la capture si nécessaire, et met à jour la commande en BDD.
 *
 * Utilisée par :
 *  - getPaymentReturn (retour client)
 *  - postScalapayWebhook (notification Scalapay)
 *  - reconcilePendingScalapayOrders (job CRON de retry)
 *  - postAdminRecaptureScalapayOrder (action admin manuelle)
 *
 * Renvoie : { ok, order, captured, paymentStatus, scalapayStatus, error? }
 */
async function reconcileScalapayOrder(order, { wasCancelled = false } = {}) {
  if (!order || !order._id) {
    return { ok: false, error: 'order_missing' };
  }
  if (!order.scalapayOrderToken) {
    return { ok: false, error: 'no_scalapay_token' };
  }

  const orderRef = `${order.number || order._id}`;

  let details = null;
  try {
    details = await scalapay.getPayment(order.scalapayOrderToken);
  } catch (err) {
    console.error(
      `[scalapay] getPayment échec pour commande ${orderRef} (token=${order.scalapayOrderToken}) :`,
      err && err.message ? err.message : err
    );
    return { ok: false, error: 'getPayment_failed', errorMessage: err && err.message ? err.message : String(err) };
  }

  const status = details && details.status ? String(details.status) : '';
  let paymentStatus = mapScalapayStatusToPaymentStatus(status);

  if (wasCancelled && paymentStatus !== 'paid') {
    paymentStatus = 'failed';
  }

  let captured = Boolean(order.scalapayCapturedAt);
  let captureError = null;
  let captureResponse = null;

  // Si Scalapay a approuvé/chargé la commande mais qu'on n'a pas encore capturé
  // côté serveur, on capture maintenant. C'est l'étape qui déclenche le
  // prélèvement réel sur la carte du client.
  if (paymentStatus === 'paid' && !captured) {
    try {
      captureResponse = await scalapay.capturePayment({
        token: order.scalapayOrderToken,
        merchantReference: order.number,
        amountCents: order.totalCents,
        currency: order.currency || 'EUR',
      });
      captured = true;
      console.log(`[scalapay] Capture réussie pour commande ${orderRef} (token=${order.scalapayOrderToken})`);
    } catch (err) {
      captureError = err && err.message ? err.message : String(err);
      console.error(
        `[scalapay] Capture ÉCHOUÉE pour commande ${orderRef} (token=${order.scalapayOrderToken}) :`,
        captureError
      );
      // On garde paymentStatus en 'pending' pour que le job de retry puisse retenter
      paymentStatus = 'pending';
    }
  }

  let updated = null;
  try {
    updated = await applyScalapayPaymentToOrder(order, {
      scalapayStatus: status,
      paymentStatus,
      captured,
    });
  } catch (err) {
    console.error(
      `[scalapay] applyScalapayPaymentToOrder échec pour commande ${orderRef} :`,
      err && err.message ? err.message : err
    );
    return {
      ok: false,
      error: 'apply_failed',
      errorMessage: err && err.message ? err.message : String(err),
      scalapayStatus: status,
      paymentStatus,
      captured,
    };
  }

  return {
    ok: true,
    order: updated,
    scalapayStatus: status,
    paymentStatus,
    captured,
    captureError,
    captureResponse,
  };
}

async function applyScalapayPaymentToOrder(order, { scalapayStatus, paymentStatus, captured } = {}) {
  if (!order || !order._id) return order;

  const wasPaid = getTrimmedString(order.paymentStatus).toLowerCase() === 'paid';

  const safeScalapayStatus = getTrimmedString(scalapayStatus);
  const safePaymentStatus = getTrimmedString(paymentStatus) || 'pending';

  const update = {
    paymentProvider: 'scalapay',
    paymentStatus: safePaymentStatus,
    scalapayStatus: safeScalapayStatus,
    scalapayLastCheckedAt: new Date(),
  };

  if (safePaymentStatus === 'paid') {
    if (captured) update.scalapayCapturedAt = new Date();

    if (order.status !== 'paid' && order.status !== 'processing' && order.status !== 'shipped' && order.status !== 'delivered' && order.status !== 'completed') {
      update.status = 'processing';
      update.$push = {
        statusHistory: {
          $each: [
            { status: 'paid', changedAt: new Date(), changedBy: 'scalapay' },
            { status: 'processing', changedAt: new Date(), changedBy: 'system', note: 'Passage automatique en préparation après paiement' },
          ],
        },
      };
    }
  }

  if (safePaymentStatus === 'failed') {
    if (order.status !== 'cancelled' && order.status !== 'delivered' && order.status !== 'completed') {
      update.status = 'cancelled';
      update.$push = {
        statusHistory: {
          status: 'cancelled',
          changedAt: new Date(),
          changedBy: 'scalapay',
        },
      };
    }
  }

  await Order.findByIdAndUpdate(order._id, update);
  let refreshed = await Order.findById(order._id).lean();

  if (safePaymentStatus === 'paid' && !wasPaid) {
    try {
      await ensureInvoiceIssuedForPaidOrder(refreshed._id);
      refreshed = await Order.findById(refreshed._id).lean();
    } catch (err) {
      console.error('Erreur attribution numéro facture (Scalapay) :', err && err.message ? err.message : err);
    }
  }

  if (safePaymentStatus === 'failed') {
    await releaseOrderStockIfNeeded(refreshed);
    await promoCodes.releaseReservedForOrder(order._id);
  }

  if (safePaymentStatus === 'paid') {
    await promoCodes.redeemReservedForOrder(order._id);
  }

  if (safePaymentStatus === 'paid' && !wasPaid) {
    try {
      const alreadySent = refreshed
        && refreshed.notifications
        && refreshed.notifications.orderConfirmationSentAt;

      if (!alreadySent) {
        const user = await User.findById(refreshed.userId).select('_id email firstName smsOptIn').lean();
        if (user && user.email) {
          const sent = await emailService.sendOrderConfirmationEmail({ order: refreshed, user });
          emailService.logEmailSent({ orderId: refreshed._id, emailType: 'order_confirmation', recipientEmail: user.email, result: sent });
          smsService.sendOrderConfirmationSms({ order: refreshed, user }).catch(() => {});
          if (sent && sent.ok) {
            await Order.updateOne(
              {
                _id: refreshed._id,
                $or: [
                  { 'notifications.orderConfirmationSentAt': { $exists: false } },
                  { 'notifications.orderConfirmationSentAt': null },
                ],
              },
              { $set: { 'notifications.orderConfirmationSentAt': new Date() } }
            );
          }
        }
      }
    } catch (err) {
      console.error('Erreur email confirmation commande (Scalapay) :', err && err.message ? err.message : err);
    }

    // Marque les paniers abandonnés comme récupérés pour ce client/email
    // (évite que le client reçoive des relances après avoir commandé sans
    // avoir cliqué le lien /panier/recuperer)
    try {
      const userForCleanup = refreshed && refreshed.userId
        ? await User.findById(refreshed.userId).select('email').lean()
        : null;
      await markAbandonedCartsAsRecoveredForOrder(refreshed, userForCleanup);
    } catch (_) { /* helper handles its own errors */ }
  }

  return refreshed;
}

async function getShipping(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const cart = getCart(req);
    const cartItemCount = computeCartItemCount(cart);

    const errorMessage = req.session.checkoutError || null;
    delete req.session.checkoutError;

    const checkout = getCheckoutState(req);
    const sessionUser = req.session.user;

    if (
      sessionUser
      && sessionUser._id
      && isGuestCheckout(checkout)
      && getTrimmedString(req.query && req.query.guest) !== '1'
      && !getTrimmedString(checkout.pendingOrderId)
    ) {
      checkout.mode = '';
      delete checkout.guest;
    }

    const guestCheckout = isGuestCheckout(checkout);
    let addresses = [];
    let userDiscountPercent = 0;
    let selectedAddressId = '';
    let selectedBillingAddressId = '';
    let billingSameAsShipping = true;

    if (!guestCheckout && dbConnected && sessionUser && sessionUser._id) {
      const user = await User.findById(sessionUser._id).select('_id addresses discountPercent').lean();
      addresses = user && Array.isArray(user.addresses) ? user.addresses : [];
      userDiscountPercent = user && Number.isFinite(user.discountPercent) ? user.discountPercent : 0;

      const defaultAddress = getDefaultAddress(addresses);
      selectedAddressId =
        typeof checkout.addressId === 'string' && addresses.some((a) => String(a._id) === checkout.addressId)
          ? checkout.addressId
          : defaultAddress
            ? String(defaultAddress._id)
            : '';

      billingSameAsShipping =
        typeof checkout.billingSameAsShipping === 'boolean'
          ? checkout.billingSameAsShipping
          : true;

      if (billingSameAsShipping) {
        selectedBillingAddressId = selectedAddressId;
      } else {
        selectedBillingAddressId =
          typeof checkout.billingAddressId === 'string' && addresses.some((a) => String(a._id) === checkout.billingAddressId)
            ? checkout.billingAddressId
            : selectedAddressId;
      }
    }

    checkout.addressId = selectedAddressId;
    checkout.billingSameAsShipping = guestCheckout ? true : billingSameAsShipping;
    checkout.billingAddressId = guestCheckout ? '' : selectedBillingAddressId;

    const { viewItems, itemsTotalCents } = await buildCartView(dbConnected, cart);

    if (viewItems.length === 0) {
      return res.redirect('/panier');
    }

    const shippingMethods = await getShippingMethods(
      dbConnected,
      viewItems.map((it) => it.product)
    );

    const selectedMethod =
      shippingMethods.find((m) => m.id === checkout.shippingMethod) ||
      shippingMethods[0];

    checkout.shippingMethod = selectedMethod.id;

    const promoCodeFromSession = typeof req.session.promoCode === 'string' ? req.session.promoCode : '';
    let promo = null;
    let appliedPromoCode = '';

    if (dbConnected && promoCodeFromSession) {
      const result = await promoCodes.getApplicablePromo({
        code: promoCodeFromSession,
        userId: !guestCheckout && sessionUser && sessionUser._id ? sessionUser._id : null,
        itemsSubtotalCents: itemsTotalCents,
      });

      if (!result.ok) {
        delete req.session.promoCode;
        req.session.checkoutError = result.reason || 'Code promo invalide.';
        return res.redirect('/commande/livraison');
      }

      promo = result.promo;
      appliedPromoCode = result.code;
    }

    const computed = pricing.computePricing({
      itemsSubtotalCents: itemsTotalCents,
      shippingCostCents: selectedMethod.priceCents,
      clientDiscountPercent: userDiscountPercent,
      promo,
    });

    return res.render('checkout/shipping', {
      title: `Livraison - ${brand.NAME}`,
      dbConnected,
      cartItemCount,
      errorMessage,
      guestCheckout,
      guestForm: getGuestCheckoutData(checkout),
      shippingMethods,
      selectedShippingMethod: selectedMethod.id,
      addresses,
      selectedAddressId,
      billingSameAsShipping: guestCheckout ? true : billingSameAsShipping,
      selectedBillingAddressId,
      form: {
        label: '',
        fullName: '',
        phone: '',
        line1: '',
        line2: '',
        postalCode: '',
        city: '',
        country: 'France',
        isDefault: addresses.length === 0,
      },
      items: viewItems,
      itemsTotalCents,
      shippingCostCents: computed.shippingCostCents,
      totalCents: computed.totalCents,
      itemsSubtotalCents: computed.itemsSubtotalCents,
      clientDiscountPercent: computed.clientDiscountPercent,
      clientDiscountCents: computed.clientDiscountCents,
      promoCode: appliedPromoCode,
      promoDiscountCents: computed.promoDiscountCents,
      itemsTotalAfterDiscountCents: computed.itemsTotalAfterDiscountCents,
    });
  } catch (err) {
   return next(err);
 }
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function hashPassword(password, salt) {
  if (typeof password !== 'string' || password.length === 0) return '';
  if (typeof salt !== 'string' || salt.length === 0) return '';
  return crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function getResetPasswordTtlMinutes() {
  const raw = typeof process.env.RESET_PASSWORD_TOKEN_TTL_MINUTES === 'string'
    ? process.env.RESET_PASSWORD_TOKEN_TTL_MINUTES.trim()
    : '';
  const n = Number.parseInt(raw || '60', 10);
  if (!Number.isFinite(n) || n < 10) return 60;
  return Math.min(24 * 60, n);
}

function isGuestCheckout(checkout) {
  return Boolean(checkout && checkout.mode === 'guest');
}

function getGuestCheckoutData(checkout) {
  const guest = checkout && checkout.guest && typeof checkout.guest === 'object'
    ? checkout.guest
    : {};

  return {
    email: normalizeEmail(guest.email),
    firstName: getTrimmedString(guest.firstName),
    lastName: getTrimmedString(guest.lastName),
    phone: getTrimmedString(guest.phone),
    line1: getTrimmedString(guest.line1),
    line2: getTrimmedString(guest.line2),
    postalCode: getTrimmedString(guest.postalCode),
    city: getTrimmedString(guest.city),
    country: getTrimmedString(guest.country) || 'France',
  };
}

function hasCompleteGuestCheckoutData(guest) {
  return Boolean(
    guest
    && guest.email
    && guest.firstName
    && guest.lastName
    && guest.phone
    && guest.line1
    && guest.postalCode
    && guest.city
  );
}

function buildGuestAddressSnapshot(guest) {
  const firstName = getTrimmedString(guest && guest.firstName);
  const lastName = getTrimmedString(guest && guest.lastName);
  return {
    label: 'Livraison',
    fullName: [firstName, lastName].filter(Boolean).join(' ').trim(),
    phone: getTrimmedString(guest && guest.phone),
    line1: getTrimmedString(guest && guest.line1),
    line2: getTrimmedString(guest && guest.line2),
    postalCode: getTrimmedString(guest && guest.postalCode),
    city: getTrimmedString(guest && guest.city),
    country: getTrimmedString(guest && guest.country) || 'France',
  };
}

function buildSessionUser(user) {
  return {
    _id: String(user._id),
    accountType: user.accountType,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    companyName: user.companyName || '',
    discountPercent: typeof user.discountPercent === 'number' ? user.discountPercent : 0,
  };
}

function buildGuestAccountResetUrl(req, token) {
  const base = getPublicBaseUrl(req);
  if (!base || !token) return '';
  return `${base.replace(/\/$/, '')}/compte/reinitialiser-mot-de-passe?token=${encodeURIComponent(String(token))}`;
}

async function issueGuestAccountSetup(req, user) {
  const token = crypto.randomBytes(32).toString('hex');
  const tokenHash = sha256Hex(token);
  const ttlMinutes = getResetPasswordTtlMinutes();
  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

  await User.updateOne(
    { _id: user._id },
    {
      $set: {
        resetPasswordTokenHash: tokenHash,
        resetPasswordExpiresAt: expiresAt,
      },
    }
  );

  const resetUrl = buildGuestAccountResetUrl(req, token);
  if (!resetUrl) {
    console.error('[GuestAccount] Impossible de construire l\'URL de réinitialisation — email non envoyé', {
      userId: String(user._id),
      email: user.email,
    });
    return { ok: false, reason: 'missing_reset_url' };
  }
  const emailResult = await emailService.sendGuestAccountCreatedEmail({ user, resetUrl });
  if (!emailResult || !emailResult.ok) {
    console.error('[GuestAccount] Échec envoi email création compte', {
      userId: String(user._id),
      email: user.email,
      reason: emailResult && emailResult.reason ? emailResult.reason : 'unknown',
    });
  }
  return emailResult || { ok: false, reason: 'no_result' };
}

async function syncGuestCheckoutUser(user, guest) {
  user.accountType = 'particulier';
  user.firstName = guest.firstName;
  user.lastName = guest.lastName;
  user.email = guest.email;

  const guestAddress = buildGuestAddressSnapshot(guest);

  if (!Array.isArray(user.addresses)) {
    user.addresses = [];
  }

  if (!user.addresses.length) {
    user.addresses.push({
      ...guestAddress,
      isDefault: true,
    });
  } else {
    user.addresses.forEach((address, index) => {
      address.isDefault = index === 0;
    });
    user.addresses[0].label = guestAddress.label;
    user.addresses[0].fullName = guestAddress.fullName;
    user.addresses[0].phone = guestAddress.phone;
    user.addresses[0].line1 = guestAddress.line1;
    user.addresses[0].line2 = guestAddress.line2;
    user.addresses[0].postalCode = guestAddress.postalCode;
    user.addresses[0].city = guestAddress.city;
    user.addresses[0].country = guestAddress.country;
    user.addresses[0].isDefault = true;
  }

  await user.save();
  return user;
}

async function ensureGuestCheckoutUser({ req, checkout } = {}) {
  const guest = getGuestCheckoutData(checkout);
  if (!hasCompleteGuestCheckoutData(guest)) {
    return { ok: false, reason: 'Merci de renseigner email, prénom, nom, téléphone et adresse de livraison.' };
  }

  if (req.session && req.session.user && req.session.user._id) {
    const existingSessionUser = await User.findById(req.session.user._id);
    if (existingSessionUser) {
      try {
        const synced = await syncGuestCheckoutUser(existingSessionUser, guest);
        req.session.user = buildSessionUser(synced);
        return { ok: true, user: synced };
      } catch (err) {
        if (err && err.code === 11000) {
          return { ok: false, reason: 'Un compte existe déjà avec cet email. Connectez-vous pour finaliser la commande.' };
        }
        throw err;
      }
    }
  }

  const existing = await User.findOne({ email: guest.email }).select('_id').lean();
  if (existing) {
    return { ok: false, reason: 'Un compte existe déjà avec cet email. Connectez-vous pour finaliser la commande.' };
  }

  const salt = crypto.randomBytes(16).toString('hex');
  const randomPassword = crypto.randomBytes(24).toString('hex');
  const guestAddress = buildGuestAddressSnapshot(guest);
  const created = await User.create({
    accountType: 'particulier',
    firstName: guest.firstName,
    lastName: guest.lastName,
    email: guest.email,
    passwordSalt: salt,
    passwordHash: hashPassword(randomPassword, salt),
    addresses: [
      {
        ...guestAddress,
        isDefault: true,
      },
    ],
  });

  req.session.user = buildSessionUser(created);
  req.session.accountType = created.accountType;

  try {
    const setupResult = await issueGuestAccountSetup(req, created);
    if (!setupResult || !setupResult.ok) {
      console.error('[GuestAccount] Email de bienvenue non envoyé pour', created.email,
        '— raison :', setupResult && setupResult.reason ? setupResult.reason : 'unknown');
    }
  } catch (err) {
    console.error('[GuestAccount] Erreur email création compte invité :', err && err.message ? err.message : err);
  }

  return { ok: true, user: created };
}

async function postShipping(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    if (!dbConnected) {
      req.session.checkoutError = "La base de données n'est pas disponible. Impossible de continuer.";
      return res.redirect('/commande/livraison');
    }

    const cart = getCart(req);
    const { viewItems } = await buildCartView(dbConnected, cart);

    if (!viewItems.length) {
      return res.redirect('/panier');
    }

    const shippingMethods = await getShippingMethods(
      dbConnected,
      viewItems.map((it) => it.product)
    );
    const shippingMethodRaw = typeof req.body.shippingMethod === 'string' ? req.body.shippingMethod : '';
    const selectedMethod = shippingMethods.find((m) => m.id === shippingMethodRaw);

    if (!selectedMethod) {
      req.session.checkoutError = 'Merci de choisir un mode de livraison.';
      return res.redirect('/commande/livraison');
    }

    const checkout = getCheckoutState(req);
    const guestCheckout = isGuestCheckout(checkout);

    if (guestCheckout) {
      const guest = {
        email: normalizeEmail(req.body.email),
        firstName: getTrimmedString(req.body.firstName),
        lastName: getTrimmedString(req.body.lastName),
        phone: getTrimmedString(req.body.phone),
        line1: getTrimmedString(req.body.line1),
        line2: getTrimmedString(req.body.line2),
        postalCode: getTrimmedString(req.body.postalCode),
        city: getTrimmedString(req.body.city),
        country: getTrimmedString(req.body.country) || 'France',
      };

      checkout.guest = guest;
      checkout.shippingMethod = selectedMethod.id;
      checkout.addressId = 'guest';
      checkout.billingSameAsShipping = true;
      checkout.billingAddressId = 'guest';

      if (!hasCompleteGuestCheckoutData(guest)) {
        req.session.checkoutError = 'Merci de renseigner email, prénom, nom, téléphone et adresse de livraison.';
        return res.redirect('/commande/livraison');
      }

      return res.redirect('/commande/paiement');
    }

    const sessionUser = req.session.user;
    if (!sessionUser || !sessionUser._id) {
      return res.redirect('/compte/connexion?returnTo=%2Fcommande%2Flivraison');
    }

    const addressIdRaw = typeof req.body.addressId === 'string' ? req.body.addressId : '';
    const billingSameAsShipping = isTruthyFormValue(req.body.billingSameAsShipping);
    const billingAddressIdRaw = typeof req.body.billingAddressId === 'string' ? req.body.billingAddressId : '';

    const user = await User.findById(sessionUser._id).select('_id addresses').lean();
    const addresses = user && Array.isArray(user.addresses) ? user.addresses : [];

    const addressExists = addresses.some((a) => String(a._id) === addressIdRaw);
    if (!addressExists) {
      req.session.checkoutError = 'Merci de choisir une adresse de livraison.';
      return res.redirect('/commande/livraison');
    }

    if (!billingSameAsShipping) {
      const billingExists = addresses.some((a) => String(a._id) === billingAddressIdRaw);
      if (!billingExists) {
        req.session.checkoutError = 'Merci de choisir une adresse de facturation.';
        return res.redirect('/commande/livraison');
      }
    }

    checkout.shippingMethod = selectedMethod.id;
    checkout.addressId = addressIdRaw;
    checkout.billingSameAsShipping = billingSameAsShipping;
    checkout.billingAddressId = billingSameAsShipping ? addressIdRaw : billingAddressIdRaw;

    return res.redirect('/commande/paiement');
  } catch (err) {
    return next(err);
  }
}

async function postAddAddress(req, res, next) {
  try {
    const checkout = getCheckoutState(req);
    if (isGuestCheckout(checkout)) {
      return res.redirect('/commande/livraison');
    }

    const dbConnected = mongoose.connection.readyState === 1;
    const sessionUser = req.session.user;

    if (!sessionUser || !sessionUser._id) {
      return res.redirect('/compte/connexion?returnTo=%2Fcommande%2Flivraison');
    }

    if (!dbConnected) {
      req.session.checkoutError = "La base de données n'est pas disponible. Impossible d'ajouter une adresse.";
      return res.redirect('/commande/livraison');
    }

    const label = typeof req.body.label === 'string' ? req.body.label.trim() : '';
    const fullName = typeof req.body.fullName === 'string' ? req.body.fullName.trim() : '';
    const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() : '';
    const line1 = typeof req.body.line1 === 'string' ? req.body.line1.trim() : '';
    const line2 = typeof req.body.line2 === 'string' ? req.body.line2.trim() : '';
    const postalCode = typeof req.body.postalCode === 'string' ? req.body.postalCode.trim() : '';
    const city = typeof req.body.city === 'string' ? req.body.city.trim() : '';
    const country = typeof req.body.country === 'string' ? req.body.country.trim() : 'France';
    const isDefault = isTruthyFormValue(req.body.isDefault);

    if (!line1 || !postalCode || !city) {
      req.session.checkoutError = 'Merci de renseigner au minimum : adresse, code postal et ville.';
      return res.redirect('/commande/livraison');
    }

    const user = await User.findById(sessionUser._id);
    if (!user) {
      delete req.session.user;
      return res.redirect('/compte');
    }

    if (!Array.isArray(user.addresses)) {
      user.addresses = [];
    }

    const shouldBeDefault = user.addresses.length === 0 || isDefault;
    if (shouldBeDefault) {
      user.addresses.forEach((address) => {
        address.isDefault = false;
      });
    }

    user.addresses.push({
      label,
      fullName,
      phone,
      line1,
      line2,
      postalCode,
      city,
      country: country || 'France',
      isDefault: shouldBeDefault,
    });

    await user.save();

    const created = user.addresses[user.addresses.length - 1];
    const createdId = created ? String(created._id) : '';
    if (createdId) {
      checkout.addressId = createdId;
      if (checkout.billingSameAsShipping === true) {
        checkout.billingAddressId = createdId;
      } else if (!checkout.billingAddressId) {
        checkout.billingAddressId = createdId;
      }
    }

    return res.redirect('/commande/livraison');
  } catch (err) {
    return next(err);
  }
}

async function getPayment(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const cart = getCart(req);
    const cartItemCount = computeCartItemCount(cart);

    const errorMessage = req.session.checkoutError || null;
    delete req.session.checkoutError;

    const checkout = getCheckoutState(req);
    const guestCheckout = isGuestCheckout(checkout);
    const shippingMethodKey = typeof checkout.shippingMethod === 'string' ? checkout.shippingMethod : '';

    const { viewItems, itemsTotalCents } = await buildCartView(dbConnected, cart);

    if (viewItems.length === 0) {
      return res.redirect('/panier');
    }

    const shippingMethods = await getShippingMethods(
      dbConnected,
      viewItems.map((it) => it.product)
    );

    const localMolliePaymentSimulation = shouldSimulateMolliePayment();
    const localScalapayPaymentSimulation = shouldSimulateScalapayPayment();

    const selectedMethod = shippingMethods.find((m) => m.id === shippingMethodKey) || null;
    if (!selectedMethod) {
      req.session.checkoutError = 'Merci de choisir une livraison et une adresse.';
      return res.redirect('/commande/livraison');
    }

    let address = null;
    let billingAddress = null;
    let billingSameAsShipping = true;
    let clientDiscountPercent = 0;

    if (guestCheckout) {
      const guest = getGuestCheckoutData(checkout);
      if (!hasCompleteGuestCheckoutData(guest)) {
        req.session.checkoutError = 'Merci de renseigner email, prénom, nom, téléphone et adresse de livraison.';
        return res.redirect('/commande/livraison');
      }
      address = buildGuestAddressSnapshot(guest);
      billingAddress = address;
    } else {
      if (!dbConnected) {
        req.session.checkoutError = "La base de données n'est pas disponible. Impossible de continuer.";
        return res.redirect('/commande/livraison');
      }

      const sessionUser = req.session.user;
      if (!sessionUser || !sessionUser._id) {
        return res.redirect('/compte/connexion?returnTo=%2Fcommande%2Flivraison');
      }

      const user = await User.findById(sessionUser._id).lean();
      const addresses = user && Array.isArray(user.addresses) ? user.addresses : [];
      billingSameAsShipping = typeof checkout.billingSameAsShipping === 'boolean' ? checkout.billingSameAsShipping : true;
      address = addresses.find((a) => String(a._id) === checkout.addressId) || null;
      billingAddress = billingSameAsShipping
        ? address
        : addresses.find((a) => String(a._id) === checkout.billingAddressId) || null;

      if (!address) {
        req.session.checkoutError = 'Adresse de livraison introuvable.';
        return res.redirect('/commande/livraison');
      }

      if (!billingAddress) {
        req.session.checkoutError = 'Adresse de facturation introuvable.';
        return res.redirect('/commande/livraison');
      }

      const shippingLine1 = getTrimmedString(address.line1);
      const shippingPostal = getTrimmedString(address.postalCode);
      const shippingCity = getTrimmedString(address.city);
      if (!shippingLine1 || !shippingPostal || !shippingCity) {
        req.session.checkoutError =
          "Votre adresse de livraison est incomplète (adresse / code postal / ville). " +
          "Merci de la corriger dans \"Gérer mes adresses\" puis de réessayer.";
        return res.redirect('/commande/livraison');
      }

      const billingLine1 = getTrimmedString(billingAddress.line1);
      const billingPostal = getTrimmedString(billingAddress.postalCode);
      const billingCity = getTrimmedString(billingAddress.city);
      if (!billingLine1 || !billingPostal || !billingCity) {
        req.session.checkoutError =
          "Votre adresse de facturation est incomplète (adresse / code postal / ville). " +
          "Merci de la corriger dans \"Gérer mes adresses\" puis de réessayer.";
        return res.redirect('/commande/livraison');
      }

      clientDiscountPercent = user && Number.isFinite(user.discountPercent) ? user.discountPercent : 0;
    }

    const promoCodeFromSession = typeof req.session.promoCode === 'string' ? req.session.promoCode : '';
    let promo = null;
    let appliedPromoCode = '';

    if (dbConnected && promoCodeFromSession) {
      const sessionUser = req.session.user;
      const result = await promoCodes.getApplicablePromo({
        code: promoCodeFromSession,
        userId: guestCheckout ? null : (sessionUser && sessionUser._id ? sessionUser._id : null),
        itemsSubtotalCents: itemsTotalCents,
      });

      if (!result.ok) {
        delete req.session.promoCode;
        req.session.checkoutError = result.reason || 'Code promo invalide.';
        return res.redirect('/commande/paiement');
      }

      promo = result.promo;
      appliedPromoCode = result.code;
    }

    const computed = pricing.computePricing({
      itemsSubtotalCents: itemsTotalCents,
      shippingCostCents: selectedMethod.priceCents,
      clientDiscountPercent,
      promo,
    });

    return res.render('checkout/payment', {
      title: `Paiement - ${brand.NAME}`,
      dbConnected,
      cartItemCount,
      errorMessage,
      guestCheckout,
      localMolliePaymentSimulation,
      localScalapayPaymentSimulation,
      shippingMethod: selectedMethod,
      address,
      billingSameAsShipping,
      billingAddress,
      vehicle: checkout && typeof checkout.vehicle === 'object' && checkout.vehicle ? checkout.vehicle : null,
      items: viewItems,
      itemsTotalCents,
      itemsSubtotalCents: computed.itemsSubtotalCents,
      clientDiscountPercent: computed.clientDiscountPercent,
      clientDiscountCents: computed.clientDiscountCents,
      promoCode: appliedPromoCode,
      promoDiscountCents: computed.promoDiscountCents,
      itemsTotalAfterDiscountCents: computed.itemsTotalAfterDiscountCents,
      shippingCostCents: computed.shippingCostCents,
      totalCents: computed.totalCents,
    });
  } catch (err) {
    return next(err);
  }
}

async function postPayment(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const checkout = getCheckoutState(req);
    const guestCheckout = isGuestCheckout(checkout);
    let sessionUser = req.session.user;

    if (!dbConnected) {
      req.session.checkoutError = "La base de données n'est pas disponible. Impossible de valider la commande.";
      return res.redirect('/commande/livraison');
    }

    const shippingMethodKey = checkout.shippingMethod;

    if (!shippingMethodKey || (!guestCheckout && !checkout.addressId)) {
      req.session.checkoutError = 'Merci de choisir une livraison et une adresse.';
      return res.redirect('/commande/livraison');
    }

    const cart = getCart(req);
    const rawItems = Object.entries(cart.items).map(([key, it]) => {
      const safe = it && typeof it === 'object' ? it : {};
      return {
        ...safe,
        lineId: safe.lineId || key,
      };
    });

    if (rawItems.length === 0) {
      return res.redirect('/panier');
    }

    const selectedPaymentMethod = getTrimmedString(req.body && req.body.paymentMethod);
    const acceptCgv = isTruthyFormValue(req.body && req.body.acceptCgv);
    const smsOptIn = isTruthyFormValue(req.body && req.body.smsOptIn);

    const vehicleIdentifierTypeRaw = getTrimmedString(req.body && req.body.vehicleIdentifierType);
    const vehicleIdentifierType = vehicleIdentifierTypeRaw === 'vin' ? 'vin' : 'plate';
    const rawPlate = getTrimmedString(req.body && req.body.vehiclePlate);
    const rawVin = getTrimmedString(req.body && req.body.vehicleVin);
    const vehiclePlate = vehicleIdentifierType === 'plate' ? normalizeVehicleIdentifier(rawPlate) : '';
    const vehicleVin = vehicleIdentifierType === 'vin' ? normalizeVehicleIdentifier(rawVin) : '';
    const vehicleProvided = Boolean(vehiclePlate || vehicleVin);
    const vehicleConsent = isTruthyFormValue(req.body && req.body.vehicleConsent);

    checkout.vehicle = {
      identifierType: vehicleIdentifierType,
      plate: vehiclePlate,
      vin: vehicleVin,
      consentAt: vehicleProvided && vehicleConsent ? new Date() : null,
      providedAt: vehicleProvided ? new Date() : null,
    };

    if (vehicleProvided && !vehicleConsent) {
      req.session.checkoutError =
        "Merci de cocher l'accord pour utiliser la plaque/VIN afin de vérifier la compatibilité et/ou programmer la pièce.";
      return res.redirect('/commande/paiement');
    }

    if (vehiclePlate && vehiclePlate.length < 5) {
      req.session.checkoutError = 'La plaque semble trop courte. Merci de vérifier.';
      return res.redirect('/commande/paiement');
    }

    if (vehicleVin && vehicleVin.length < 11) {
      req.session.checkoutError = 'Le VIN semble trop court. Merci de vérifier.';
      return res.redirect('/commande/paiement');
    }

    if (!acceptCgv) {
      req.session.checkoutError = 'Merci d’accepter les CGV pour continuer.';
      return res.redirect('/commande/paiement');
    }
    const scalapayProduct = parseScalapayProductFromPaymentMethod(selectedPaymentMethod);
    const paymentProvider = scalapayProduct ? 'scalapay' : 'mollie';
    const simulateLocalPayment = paymentProvider === 'scalapay'
      ? shouldSimulateScalapayPayment()
      : shouldSimulateMolliePayment();

    const cgvPage = await getLegalPageBySlug({ slug: 'cgv', dbConnected });
    if (!cgvPage) {
      req.session.checkoutError = 'Les CGV sont indisponibles pour le moment. Réessayez plus tard.';
      return res.redirect('/commande/paiement');
    }

    if (paymentProvider === 'mollie' && !getTrimmedString(process.env.MOLLIE_API_KEY) && !simulateLocalPayment) {
      req.session.checkoutError =
        "Le paiement est temporairement indisponible. Merci de réessayer dans quelques minutes.";
      return res.redirect('/commande/paiement');
    }

    if (paymentProvider === 'scalapay' && !getTrimmedString(process.env.SCALAPAY_API_KEY) && !simulateLocalPayment) {
      req.session.checkoutError =
        "Le paiement en plusieurs fois est temporairement indisponible. Merci de réessayer dans quelques minutes.";
      return res.redirect('/commande/paiement');
    }

    if (guestCheckout && (!sessionUser || !sessionUser._id)) {
      const guestUserResult = await ensureGuestCheckoutUser({ req, checkout });
      if (!guestUserResult.ok) {
        req.session.checkoutError = guestUserResult.reason || 'Impossible de préparer le compte invité.';
        return res.redirect('/commande/livraison');
      }
      sessionUser = req.session.user;
    }

    if (!sessionUser || !sessionUser._id) {
      return res.redirect('/compte/connexion?returnTo=%2Fcommande%2Flivraison');
    }

    if (checkout.pendingOrderId && mongoose.Types.ObjectId.isValid(String(checkout.pendingOrderId))) {
      const existingPending = await Order.findOne({
        _id: checkout.pendingOrderId,
        userId: sessionUser._id,
      }).lean();

      if (existingPending) {
        if (existingPending.paymentStatus === 'paid') {
          req.session.cart = { items: {} };
          delete req.session.checkout;
          delete req.session.promoCode;
          return res.redirect(`/compte/commandes/${encodeURIComponent(String(existingPending._id))}`);
        }

        const pendingProvider = existingPending.paymentProvider || '';
        if (existingPending.paymentStatus === 'pending' && pendingProvider === paymentProvider) {
          if (paymentProvider === 'scalapay' && existingPending.scalapayCheckoutUrl) {
            return res.redirect(existingPending.scalapayCheckoutUrl);
          }
          if (paymentProvider === 'mollie' && existingPending.mollieCheckoutUrl) {
            return res.redirect(existingPending.mollieCheckoutUrl);
          }
        }

        checkout.pendingOrderId = '';
      }
    }

    const user = await User.findById(sessionUser._id);
    if (!user) {
      delete req.session.user;
      return res.redirect('/compte');
    }

    let selectedAddress = null;
    let selectedBillingAddress = null;
    let shippingLine1 = '';
    let shippingPostal = '';
    let shippingCity = '';
    let billingLine1 = '';
    let billingPostal = '';
    let billingCity = '';
    const billingSameAsShipping = guestCheckout
      ? true
      : (typeof checkout.billingSameAsShipping === 'boolean' ? checkout.billingSameAsShipping : true);

    if (guestCheckout) {
      const guest = getGuestCheckoutData(checkout);
      if (!hasCompleteGuestCheckoutData(guest)) {
        req.session.checkoutError = 'Merci de renseigner email, prénom, nom, téléphone et adresse de livraison.';
        return res.redirect('/commande/livraison');
      }

      await syncGuestCheckoutUser(user, guest);
      req.session.user = buildSessionUser(user);
      sessionUser = req.session.user;

      selectedAddress = buildGuestAddressSnapshot(guest);
      selectedBillingAddress = selectedAddress;
      shippingLine1 = getTrimmedString(selectedAddress.line1);
      shippingPostal = getTrimmedString(selectedAddress.postalCode);
      shippingCity = getTrimmedString(selectedAddress.city);
      billingLine1 = shippingLine1;
      billingPostal = shippingPostal;
      billingCity = shippingCity;
    } else {
      selectedAddress =
        Array.isArray(user.addresses)
          ? user.addresses.find((a) => String(a._id) === checkout.addressId)
          : null;

      selectedBillingAddress = billingSameAsShipping
        ? selectedAddress
        : Array.isArray(user.addresses)
          ? user.addresses.find((a) => String(a._id) === checkout.billingAddressId)
          : null;

      if (!selectedAddress) {
        req.session.checkoutError = 'Adresse de livraison introuvable.';
        return res.redirect('/commande/livraison');
      }

      if (!selectedBillingAddress) {
        req.session.checkoutError = 'Adresse de facturation introuvable.';
        return res.redirect('/commande/livraison');
      }

      shippingLine1 = getTrimmedString(selectedAddress.line1);
      shippingPostal = getTrimmedString(selectedAddress.postalCode);
      shippingCity = getTrimmedString(selectedAddress.city);

      if (!shippingLine1 || !shippingPostal || !shippingCity) {
        req.session.checkoutError =
          "Votre adresse de livraison est incomplète (adresse / code postal / ville). " +
          "Merci de la corriger dans \"Gérer mes adresses\" puis de réessayer.";
        return res.redirect('/commande/livraison');
      }

      billingLine1 = getTrimmedString(selectedBillingAddress.line1);
      billingPostal = getTrimmedString(selectedBillingAddress.postalCode);
      billingCity = getTrimmedString(selectedBillingAddress.city);

      if (!billingLine1 || !billingPostal || !billingCity) {
        req.session.checkoutError =
          "Votre adresse de facturation est incomplète (adresse / code postal / ville). " +
          "Merci de la corriger dans \"Gérer mes adresses\" puis de réessayer.";
        return res.redirect('/commande/livraison');
      }
    }

    const productById = new Map();
    const productIds = rawItems.map((i) => i.productId);

    const products = await Product.find({ _id: { $in: productIds } }).lean();
    for (const p of products) {
      productById.set(String(p._id), p);
    }

    for (const p of demoProducts) {
      if (!productById.has(String(p._id))) {
        productById.set(String(p._id), p);
      }
    }

    // Vérification des quantités disponibles avant de créer la commande
    for (const item of rawItems) {
      const product = normalizeProduct(productById.get(String(item.productId)));
      if (!product) continue;

      if (Number.isFinite(product.stockQty) && item.quantity > product.stockQty) {
        req.session.checkoutError = 'Stock insuffisant pour un ou plusieurs articles. Merci de mettre à jour votre panier.';
        return res.redirect('/panier');
      }
    }

    const orderItems = [];
    const consigneLines = [];
    const shippingProducts = [];
    const cloningCheckItems = [];
    let itemsTotalCents = 0;
    let hasConsigne = false;

    for (const item of rawItems) {
      const product = normalizeProduct(productById.get(String(item.productId)));
      if (!product) continue;
      if (product.inStock === false) continue;

      const unitPriceCents = productOptions.computeUnitPriceCents(product, item.optionsSelection);
      const display = productOptions.buildOptionsDisplay(product.options, item.optionsSelection);
      const optionsSummary = typeof item.optionsSummary === 'string' && item.optionsSummary.trim() ? item.optionsSummary.trim() : display.optionsSummary;

      const lineTotalCents = unitPriceCents * item.quantity;
      itemsTotalCents += lineTotalCents;

      if (!mongoose.Types.ObjectId.isValid(String(product._id))) continue;

      // Determine per-item type: clonage > exchange (consigne) > standard
      let detectedItemType = 'standard';
      if (productOptions.itemHasCloning(product.options, item.optionsSelection)) {
        detectedItemType = 'exchange_cloning';
      } else if (product.consigne && product.consigne.enabled && Number.isFinite(product.consigne.amountCents) && product.consigne.amountCents > 0) {
        detectedItemType = 'exchange';
      }

      orderItems.push({
        productId: new mongoose.Types.ObjectId(String(product._id)),
        name: product.name,
        sku: product.sku || '',
        optionsSelection: display && display.lines ? (item.optionsSelection || {}) : (item.optionsSelection || {}),
        optionsSummary,
        unitPriceCents,
        quantity: item.quantity,
        lineTotalCents,
        itemType: detectedItemType,
      });

      cloningCheckItems.push({ product, optionsSelection: item.optionsSelection });

      if (product.consigne && product.consigne.enabled && Number.isFinite(product.consigne.amountCents) && product.consigne.amountCents > 0) {
        hasConsigne = true;
        consigneLines.push({
          productId: new mongoose.Types.ObjectId(String(product._id)),
          name: product.name,
          sku: product.sku || '',
          quantity: item.quantity,
          amountCents: product.consigne.amountCents,
          delayDays: product.consigne.delayDays,
          startAt: null,
          dueAt: null,
          receivedAt: null,
        });
      }

      shippingProducts.push(product);
    }

    if (orderItems.length === 0) {
      req.session.checkoutError = 'Votre panier ne contient aucun article commandable.';
      return res.redirect('/panier');
    }

    const addressSnapshot = {
      label: selectedAddress.label || '',
      fullName: selectedAddress.fullName || '',
      phone: selectedAddress.phone || '',
      line1: shippingLine1,
      line2: selectedAddress.line2 || '',
      postalCode: shippingPostal,
      city: shippingCity,
      country: selectedAddress.country || 'France',
    };

    const billingAddressSnapshot = {
      label: selectedBillingAddress.label || '',
      fullName: selectedBillingAddress.fullName || '',
      phone: selectedBillingAddress.phone || '',
      line1: billingLine1,
      line2: selectedBillingAddress.line2 || '',
      postalCode: billingPostal,
      city: billingCity,
      country: selectedBillingAddress.country || 'France',
    };

    const shippingMethods = await getShippingMethods(dbConnected, shippingProducts);
    const selectedMethod = shippingMethods.find((m) => m.id === shippingMethodKey) || null;
    if (!selectedMethod) {
      req.session.checkoutError = 'Merci de choisir un mode de livraison.';
      return res.redirect('/commande/livraison');
    }

    const promoCodeFromSession = typeof req.session.promoCode === 'string' ? req.session.promoCode : '';
    let promo = null;
    let appliedPromoCode = '';

    if (dbConnected && promoCodeFromSession) {
      const result = await promoCodes.getApplicablePromo({
        code: promoCodeFromSession,
        userId: user._id,
        itemsSubtotalCents: itemsTotalCents,
      });

      if (!result.ok) {
        delete req.session.promoCode;
        req.session.checkoutError = result.reason || 'Code promo invalide.';
        return res.redirect('/commande/paiement');
      }

      promo = result.promo;
      appliedPromoCode = result.code;
    }

    const computed = pricing.computePricing({
      itemsSubtotalCents: itemsTotalCents,
      shippingCostCents: selectedMethod.priceCents,
      clientDiscountPercent: Number.isFinite(user.discountPercent) ? user.discountPercent : 0,
      promo,
    });

    const shippingCostCents = computed.shippingCostCents;
    const totalCents = computed.totalCents;

    const discountedOrderItems = applyDiscountToOrderItems(orderItems, computed.itemsTotalAfterDiscountCents);

    let created = null;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        const nextNumber = await getNextOrderNumber({ date: new Date() });
        created = await Order.create({
          userId: user._id,
          number: nextNumber.orderNumber,
          orderType: productOptions.hasCloningSelection(cloningCheckItems) ? 'exchange_cloning' : hasConsigne ? 'exchange' : 'standard',
          status: 'pending_payment',
          statusHistory: [
            {
              status: 'pending_payment',
              changedAt: new Date(),
              changedBy: 'client',
            },
          ],
          accountType: user.accountType,
          source: { channel: 'website' },
          paymentProvider,
          paymentStatus: 'pending',
          mollieProfileId: paymentProvider === 'mollie' ? getMollieProfileId() : '',
          totalCents,
          items: orderItems,
          consigne: { lines: consigneLines },
          shippingAddress: addressSnapshot,
          billingAddress: billingAddressSnapshot,
          shippingMethod: selectedMethod.id,
          shippingCostCents,
          itemsSubtotalCents: computed.itemsSubtotalCents,
          clientDiscountPercent: computed.clientDiscountPercent,
          clientDiscountCents: computed.clientDiscountCents,
          promoCode: appliedPromoCode,
          promoDiscountCents: computed.promoDiscountCents,
          itemsTotalAfterDiscountCents: computed.itemsTotalAfterDiscountCents,
          vehicle: vehicleProvided
            ? {
                identifierType: vehicleIdentifierType,
                plate: vehiclePlate,
                vin: vehicleVin,
                consentAt: vehicleConsent ? new Date() : null,
                providedAt: new Date(),
              }
            : undefined,
          legal: {
            cgvAcceptedAt: new Date(),
            cgvSlug: 'cgv',
            cgvUpdatedAt: cgvPage && cgvPage.updatedAt ? new Date(cgvPage.updatedAt) : null,
          },
        });
        break;
      } catch (err) {
        if (err && err.code === 11000 && attempt < 2) {
          continue;
        }
        throw err;
      }
    }

    if (!created) {
      req.session.checkoutError = 'Une erreur est survenue lors de la création de votre commande.';
      return res.redirect('/commande/livraison');
    }

    await reserveOrderStockIfNeeded(created, productById);

    // Persist SMS opt-in preference on user (with RGPD consent date)
    if (user && user._id) {
      try {
        const smsUpdate = { smsOptIn };
        if (smsOptIn) {
          smsUpdate.smsOptInAt = new Date();
        } else {
          smsUpdate.smsOptOutAt = new Date();
        }
        await User.updateOne({ _id: user._id }, { $set: smsUpdate });
      } catch (_) { /* non-blocking */ }
    }

    if (promo && promo._id) {
      try {
        await promoCodes.reservePromo({ promoId: promo._id, userId: user._id, orderId: created._id });
      } catch (err) {
        await Order.findByIdAndUpdate(created._id, {
          $set: {
            promoCode: '',
            promoDiscountCents: 0,
            paymentStatus: 'failed',
            status: 'cancelled',
          },
          $push: {
            statusHistory: {
              status: 'cancelled',
              changedAt: new Date(),
              changedBy: 'promo',
            },
          },
        });

        await releaseOrderStockIfNeeded(created);
        await promoCodes.releaseReservedForOrder(created._id);
        checkout.pendingOrderId = '';
        delete req.session.promoCode;
        req.session.checkoutError =
          'Le code promo ne peut pas être réservé pour le moment (il vient peut-être d’être utilisé). Merci de réessayer.';
        return res.redirect('/commande/paiement');
      }
    }

    if (simulateLocalPayment) {
      const updated = paymentProvider === 'scalapay'
        ? await applyScalapayPaymentToOrder(created, {
            scalapayStatus: 'approved',
            paymentStatus: 'paid',
            captured: true,
          })
        : await applyMolliePaymentToOrder(created, { status: 'paid' });

      req.session.cart = { items: {} };
      delete req.session.checkout;
      delete req.session.promoCode;
      return res.redirect(`/compte/commandes/${encodeURIComponent(String(updated && updated._id ? updated._id : created._id))}`);
    }

    const baseUrl = getPublicBaseUrl(req);

    if (paymentProvider === 'mollie') {
      const redirectUrl = `${baseUrl}/commande/paiement/retour?orderId=${encodeURIComponent(String(created._id))}`;
      const webhookToken = getMollieWebhookToken();

      const webhookBaseUrl = getMollieWebhookBaseUrl() || baseUrl;
      const webhookUrl = isLocalBaseUrl(webhookBaseUrl)
        ? ''
        : webhookToken
          ? `${webhookBaseUrl}/commande/paiement/webhook?token=${encodeURIComponent(webhookToken)}`
          : `${webhookBaseUrl}/commande/paiement/webhook`;

      let payment;
      try {
        payment = await mollie.createPayment({
          amountCents: totalCents,
          currency: 'EUR',
          description: `Commande ${created.number}`,
          redirectUrl,
          webhookUrl,
          metadata: {
            orderId: String(created._id),
            orderNumber: created.number,
            userId: String(user._id),
          },
          locale: 'fr_FR',
        });
      } catch (err) {
        console.error('[Mollie] Erreur création paiement', {
          orderId: String(created._id),
          orderNumber: created.number,
          message: err && err.message ? err.message : String(err),
        });
        await Order.findByIdAndUpdate(created._id, {
          $set: {
            paymentProvider: 'mollie',
            paymentStatus: 'failed',
            molliePaymentStatus: 'failed',
            mollieLastCheckedAt: new Date(),
            status: 'cancelled',
          },
          $push: {
            statusHistory: {
              status: 'cancelled',
              changedAt: new Date(),
              changedBy: 'mollie',
            },
          },
        });
        await releaseOrderStockIfNeeded(created);
        await promoCodes.releaseReservedForOrder(created._id);
        req.session.checkoutError = 'Impossible de démarrer le paiement. Merci de réessayer.';
        return res.redirect('/commande/paiement');
      }

      const checkoutUrl =
        payment && payment._links && payment._links.checkout && payment._links.checkout.href
          ? String(payment._links.checkout.href)
          : '';

      if (!checkoutUrl || !payment.id) {
        console.error('[Mollie] Réponse paiement incomplète', {
          orderId: String(created._id),
          orderNumber: created.number,
          hasPaymentId: Boolean(payment && payment.id),
          hasCheckoutUrl: Boolean(checkoutUrl),
        });
        req.session.checkoutError = 'Impossible de démarrer le paiement. Merci de réessayer.';
        await releaseOrderStockIfNeeded(created);
        await promoCodes.releaseReservedForOrder(created._id);
        return res.redirect('/commande/paiement');
      }

      await Order.findByIdAndUpdate(created._id, {
        $set: {
          molliePaymentId: String(payment.id),
          molliePaymentStatus: getTrimmedString(payment.status),
          mollieCheckoutUrl: checkoutUrl,
          mollieLastCheckedAt: new Date(),
        },
      });

      checkout.pendingOrderId = String(created._id);
      return res.redirect(checkoutUrl);
    }

    const redirectConfirmUrl = `${baseUrl}/commande/paiement/retour?orderId=${encodeURIComponent(String(created._id))}`;
    const redirectCancelUrl = `${baseUrl}/commande/paiement/retour?orderId=${encodeURIComponent(String(created._id))}&cancel=1`;

    const countryCode = getCountryCodeFromAddressCountry(addressSnapshot.country);
    const consumerPhone = normalizePhoneForScalapay(addressSnapshot.phone || billingAddressSnapshot.phone, countryCode);
    const nameParts = splitNameParts(user.firstName && user.lastName ? `${user.firstName} ${user.lastName}` : addressSnapshot.fullName);
    const givenNames = nameParts.givenNames || 'Client';
    const surname = nameParts.surname || 'CarParts';

    const scalapayItems = discountedOrderItems.map((it) => {
      const sku = getTrimmedString(it.sku) || String(it.productId);
      return {
        sku,
        name: getTrimmedString(it.name) || 'Article',
        quantity: Number(it.quantity) || 1,
        price: {
          amount: scalapay.formatAmountFromCents(it.unitPriceCents),
          currency: 'EUR',
        },
        category: 'car-parts',
      };
    });

    const scalapayBody = {
      totalAmount: {
        amount: scalapay.formatAmountFromCents(totalCents),
        currency: 'EUR',
      },
      consumer: {
        phoneNumber: consumerPhone,
        givenNames,
        surname,
        email: getTrimmedString(user.email),
      },
      shipping: {
        phoneNumber: consumerPhone,
        countryCode,
        name: getTrimmedString(addressSnapshot.fullName) || `${givenNames} ${surname}`,
        postcode: getTrimmedString(addressSnapshot.postalCode),
        suburb: getTrimmedString(addressSnapshot.city),
        line1: getTrimmedString(addressSnapshot.line1),
      },
      billing: {
        phoneNumber: consumerPhone,
        countryCode: getCountryCodeFromAddressCountry(billingAddressSnapshot.country),
        name: getTrimmedString(billingAddressSnapshot.fullName) || `${givenNames} ${surname}`,
        postcode: getTrimmedString(billingAddressSnapshot.postalCode),
        suburb: getTrimmedString(billingAddressSnapshot.city),
        line1: getTrimmedString(billingAddressSnapshot.line1),
      },
      items: scalapayItems,
      merchant: {
        redirectCancelUrl,
        redirectConfirmUrl,
      },
      merchantReference: created.number,
      shippingAmount: {
        amount: scalapay.formatAmountFromCents(shippingCostCents),
        currency: 'EUR',
      },
      taxAmount: {
        amount: '0.00',
        currency: 'EUR',
      },
      type: 'online',
      product: scalapayProduct,
    };

    let spOrder;
    try {
      spOrder = await scalapay.createOrder({ body: scalapayBody });
    } catch (err) {
      const rawMessage = err && err.message ? String(err.message) : String(err);
      console.error('[Scalapay] Erreur création commande', {
        orderId: String(created._id),
        orderNumber: created.number,
        message: rawMessage,
      });
      await Order.findByIdAndUpdate(created._id, {
        $set: {
          paymentProvider: 'scalapay',
          paymentStatus: 'failed',
          scalapayStatus: 'failed',
          scalapayLastCheckedAt: new Date(),
          status: 'cancelled',
        },
        $push: {
          statusHistory: {
            status: 'cancelled',
            changedAt: new Date(),
            changedBy: 'scalapay',
          },
        },
      });
      await releaseOrderStockIfNeeded(created);
      await promoCodes.releaseReservedForOrder(created._id);

      if (rawMessage.toLowerCase().includes('http 401') || rawMessage.toLowerCase().includes('unauthorized')) {
        req.session.checkoutError =
          "Scalapay refuse la connexion (401) : la clé API ne correspond pas à l'environnement de test. " +
          "Il te faut une clé Scalapay SANDBOX (test) pour https://integration.api.scalapay.com.";
      } else {
        req.session.checkoutError = 'Impossible de démarrer le paiement. Merci de réessayer.';
      }
      return res.redirect('/commande/paiement');
    }

    const scalapayCheckoutUrl = spOrder && spOrder.checkoutUrl ? String(spOrder.checkoutUrl) : '';
    const scalapayToken = spOrder && spOrder.token ? String(spOrder.token) : '';

    if (!scalapayCheckoutUrl || !scalapayToken) {
      req.session.checkoutError = 'Impossible de démarrer le paiement. Merci de réessayer.';
      await releaseOrderStockIfNeeded(created);
      await promoCodes.releaseReservedForOrder(created._id);
      return res.redirect('/commande/paiement');
    }

    await Order.findByIdAndUpdate(created._id, {
      $set: {
        scalapayOrderToken: scalapayToken,
        scalapayCheckoutUrl: scalapayCheckoutUrl,
        scalapayStatus: 'created',
        scalapayLastCheckedAt: new Date(),
      },
    });

    checkout.pendingOrderId = String(created._id);
    return res.redirect(scalapayCheckoutUrl);
  } catch (err) {
    return next(err);
  }
}

async function getPaymentReturn(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const sessionUser = req.session.user;

    if (!sessionUser || !sessionUser._id) {
      return res.redirect('/compte');
    }

    const orderId = getTrimmedString(req.query.orderId);
    if (!dbConnected || !mongoose.Types.ObjectId.isValid(orderId)) {
      return res.redirect('/compte/commandes');
    }

    const order = await Order.findOne({ _id: orderId, userId: sessionUser._id }).lean();
    if (!order) return res.redirect('/compte/commandes');

    const checkout = getCheckoutState(req);

    if (order.paymentStatus === 'paid') {
      req.session.cart = { items: {} };
      delete req.session.checkout;
      delete req.session.promoCode;
      return res.redirect(`/compte/commandes/${encodeURIComponent(String(order._id))}`);
    }

    const wasCancelled = getTrimmedString(req.query && req.query.cancel) === '1';

    if (order.scalapayOrderToken) {
      const result = await reconcileScalapayOrder(order, { wasCancelled });

      if (!result.ok) {
        console.error(
          `[scalapay] Réconciliation échouée pour commande ${order.number || order._id} (retour client) :`,
          result.error,
          result.errorMessage || ''
        );
        checkout.pendingOrderId = String(order._id);
        req.session.checkoutError = 'Impossible de vérifier le paiement pour le moment. Réessayez.';
        return res.redirect('/commande/paiement');
      }

      const updated = result.order;

      if (updated && updated.paymentStatus === 'paid') {
        req.session.cart = { items: {} };
        delete req.session.checkout;
        delete req.session.promoCode;
        return res.redirect(`/compte/commandes/${encodeURIComponent(String(order._id))}`);
      }

      if (updated && updated.paymentStatus === 'pending') {
        checkout.pendingOrderId = String(order._id);
        req.session.checkoutError = wasCancelled
          ? 'Le paiement a été annulé. Vous pouvez réessayer.'
          : "Le paiement n'a pas été finalisé. Vous pouvez réessayer.";
        return res.redirect('/commande/paiement');
      }

      checkout.pendingOrderId = '';
      req.session.checkoutError = wasCancelled
        ? 'Le paiement a été annulé. Vous pouvez réessayer.'
        : 'Le paiement a échoué ou a été annulé. Vous pouvez réessayer.';
      return res.redirect('/commande/paiement');
    }

    if (order.molliePaymentId) {
      try {
        const payment = await mollie.getPayment(order.molliePaymentId);
        const updated = await applyMolliePaymentToOrder(order, payment);

        if (updated && updated.paymentStatus === 'paid') {
          req.session.cart = { items: {} };
          delete req.session.checkout;
          delete req.session.promoCode;
          return res.redirect(`/compte/commandes/${encodeURIComponent(String(order._id))}`);
        }

        if (updated && updated.paymentStatus === 'pending') {
          checkout.pendingOrderId = String(order._id);
          req.session.checkoutError = "Le paiement n'a pas été finalisé. Vous pouvez réessayer.";
          return res.redirect('/commande/paiement');
        }

        checkout.pendingOrderId = '';
        req.session.checkoutError = 'Le paiement a échoué ou a été annulé. Vous pouvez réessayer.';
        return res.redirect('/commande/paiement');
      } catch (err) {
        checkout.pendingOrderId = String(order._id);
        req.session.checkoutError = 'Impossible de vérifier le paiement pour le moment. Réessayez.';
        return res.redirect('/commande/paiement');
      }
    }

    checkout.pendingOrderId = '';
    req.session.checkoutError = 'Paiement introuvable. Merci de réessayer.';
    return res.redirect('/commande/paiement');
  } catch (err) {
    return next(err);
  }
}

async function postPaymentWebhook(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    if (!dbConnected) return res.status(200).send('OK');

    const expectedToken = getMollieWebhookToken();
    if (expectedToken) {
      const providedToken = getTrimmedString(req.query && req.query.token);
      if (!providedToken || providedToken !== expectedToken) {
        return res.status(200).send('OK');
      }
    }

    const paymentId = getTrimmedString(req.body && (req.body.id || req.body.paymentId));
    if (!paymentId) return res.status(200).send('OK');

    const order = await Order.findOne({ molliePaymentId: paymentId }).lean();
    if (!order) return res.status(200).send('OK');

    try {
      const payment = await mollie.getPayment(paymentId);
      await applyMolliePaymentToOrder(order, payment);
    } catch (err) {
      return res.status(200).send('OK');
    }

    return res.status(200).send('OK');
  } catch (err) {
    return next(err);
  }
}

/**
 * Webhook Scalapay : reçu quand Scalapay nous notifie d'un changement de
 * statut sur une commande (typiquement quand le client valide le paiement).
 *
 * Format Scalapay : POST avec body JSON contenant au minimum un identifiant
 * de l'ordre. Selon la version, ce peut être : token, orderToken, merchantReference.
 *
 * Sécurité : on vérifie un token partagé via query string (?token=xxx) — à
 * configurer côté Scalapay. Si SCALAPAY_WEBHOOK_TOKEN est vide, le webhook
 * n'est pas protégé (déconseillé en prod).
 *
 * On répond TOUJOURS 200 pour éviter que Scalapay retente en boucle, sauf
 * si le token de sécurité est invalide (401).
 */
async function postScalapayWebhook(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    if (!dbConnected) return res.status(200).send('OK');

    const expectedToken = getScalapayWebhookToken();
    if (expectedToken) {
      const providedToken = getTrimmedString(req.query && req.query.token);
      if (!providedToken || providedToken !== expectedToken) {
        console.warn('[scalapay-webhook] Token invalide ou manquant — refus.');
        return res.status(401).send('Unauthorized');
      }
    }

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const token = getTrimmedString(body.token || body.orderToken || body.payment_token || (body.payment && body.payment.token));
    const merchantReference = getTrimmedString(body.merchantReference || body.merchant_reference || (body.payment && body.payment.merchantReference));

    console.log('[scalapay-webhook] Reçu :', JSON.stringify({
      token: token || '(absent)',
      merchantReference: merchantReference || '(absent)',
      status: body.status || (body.payment && body.payment.status) || '(absent)',
    }));

    let order = null;
    if (token) {
      order = await Order.findOne({ scalapayOrderToken: token }).lean();
    }
    if (!order && merchantReference) {
      order = await Order.findOne({ number: merchantReference, paymentProvider: 'scalapay' }).lean();
    }

    if (!order) {
      console.warn('[scalapay-webhook] Commande introuvable pour token/ref :', token || merchantReference);
      return res.status(200).send('OK');
    }

    const result = await reconcileScalapayOrder(order, { wasCancelled: false });
    if (!result.ok) {
      console.error(
        `[scalapay-webhook] Réconciliation échouée pour commande ${order.number || order._id} :`,
        result.error,
        result.errorMessage || ''
      );
    } else {
      console.log(
        `[scalapay-webhook] Commande ${order.number || order._id} réconciliée — paymentStatus=${result.paymentStatus}, captured=${result.captured}, scalapayStatus=${result.scalapayStatus}`
      );
    }

    return res.status(200).send('OK');
  } catch (err) {
    console.error('[scalapay-webhook] Exception :', err && err.message ? err.message : err);
    return res.status(200).send('OK');
  }
}

module.exports = {
  getShipping,
  postShipping,
  postAddAddress,
  getPayment,
  postPayment,
  getPaymentReturn,
  postPaymentWebhook,
  postScalapayWebhook,
  reconcileScalapayOrder,
};
