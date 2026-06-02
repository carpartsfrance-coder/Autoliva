const { buildCarrierTrackingUrl } = require('./trackingLinks');
const { getSiteUrlFromEnv } = require('./siteUrl');
const Order = require('../models/Order');
const brand = require('../config/brand');
const { resolveSms } = require('./smsSettings');

// ─── Helpers ────────────────────────────────────────────────────────────────

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : value ? String(value).trim() : '';
}

function getBaseUrl() {
  return getSiteUrlFromEnv();
}

/**
 * Normalise un numéro FR vers E.164 (+33…).
 * Accepte : 06…, +336…, 0033…, 336…
 * Retourne '' si le numéro n'est pas exploitable.
 */
function normalizePhoneFR(phone) {
  const raw = getTrimmedString(phone).replace(/[\s.\-()]/g, '');
  if (!raw) return '';

  // Déjà au format +33…
  if (/^\+33[1-9]\d{8}$/.test(raw)) return raw;

  // 0033…
  if (/^0033[1-9]\d{8}$/.test(raw)) return `+${raw.slice(2)}`;

  // 33… sans +
  if (/^33[1-9]\d{8}$/.test(raw)) return `+${raw}`;

  // 0X XX XX XX XX (format FR classique)
  if (/^0[1-9]\d{8}$/.test(raw)) return `+33${raw.slice(1)}`;

  return '';
}

/**
 * Résout le numéro destinataire depuis une commande.
 * Priorité : shippingAddress.phone > billingAddress.phone
 */
function resolvePhoneFromOrder(order) {
  if (!order) return '';
  const shipping = order.shippingAddress && order.shippingAddress.phone;
  const billing = order.billingAddress && order.billingAddress.phone;
  return normalizePhoneFR(shipping) || normalizePhoneFR(billing) || '';
}

function formatCents(cents) {
  const n = Number(cents) || 0;
  return (n / 100).toFixed(2).replace('.', ',');
}

function formatDate(date) {
  if (!date) return '';
  const d = new Date(date);
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function orderUrl(order) {
  const base = getBaseUrl();
  const id = order && order._id ? order._id : '';
  return `${base}/compte/commandes/${id}`;
}

const STATUS_LABELS = {
  draft: 'Brouillon',
  pending_payment: 'En attente de paiement',
  paid: 'Payée',
  processing: 'En préparation',
  shipped: 'Expédiée',
  delivered: 'Livrée',
  completed: 'Terminée',
  cancelled: 'Annulée',
  refunded: 'Remboursée',
};

// ─── MailerSend SMS API ─────────────────────────────────────────────────────

/**
 * Envoie un SMS via Brevo (ex-Sendinblue).
 * Doc: https://developers.brevo.com/reference/send-async-transactional-sms
 */
async function sendSms({ to, text } = {}) {
  const apiKey = getTrimmedString(process.env.BREVO_API_KEY);
  if (!apiKey) {
    console.error('[SMS] BREVO_API_KEY manquant : SMS non envoyé');
    return { ok: false, reason: 'missing_api_key' };
  }

  const phone = normalizePhoneFR(to);
  if (!phone) {
    console.error('[SMS] Numéro invalide ou absent :', to);
    return { ok: false, reason: 'invalid_phone' };
  }

  const sender = getTrimmedString(process.env.SMS_SENDER_ID) || 'CarParts';
  const content = getTrimmedString(text);
  if (!content) {
    return { ok: false, reason: 'empty_body' };
  }

  // En dev, rediriger vers un numéro de test
  const forcePhone = getTrimmedString(process.env.SMS_FORCE_TO);
  const isProd = process.env.NODE_ENV === 'production';
  const testPhone = getTrimmedString(process.env.SMS_TEST_TO);

  let finalPhone = phone;
  if (forcePhone) {
    finalPhone = normalizePhoneFR(forcePhone);
  } else if (!isProd && testPhone) {
    finalPhone = normalizePhoneFR(testPhone);
  }

  if (!finalPhone) {
    console.error('[SMS] Numéro final invalide après résolution dev/prod');
    return { ok: false, reason: 'invalid_final_phone' };
  }

  // Brevo attend le numéro sans le '+' (ex: 33612345678)
  const recipient = finalPhone.replace(/^\+/, '');

  try {
    const res = await fetch('https://api.brevo.com/v3/transactionalSMS/sms', {
      method: 'POST',
      headers: {
        'api-key': apiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sender,
        recipient,
        content,
        type: 'transactional',
        tag: 'carpartsfrance',
      }),
    });

    if (res.status === 201) {
      console.log(`[SMS] Envoyé à ${finalPhone}${forcePhone || (!isProd && testPhone) ? ` (redirigé depuis ${phone})` : ''}`);
      return { ok: true };
    }

    const errorBody = await res.text();
    console.error('[SMS] Brevo refusé :', res.status, res.statusText, errorBody ? errorBody.slice(0, 500) : '');
    return { ok: false, reason: 'brevo_error', status: res.status };
  } catch (err) {
    console.error('[SMS] Erreur envoi :', err && err.message ? err.message : err);
    return { ok: false, reason: 'network_error' };
  }
}

// ─── Variables des SMS (le texte vient désormais du catalogue paramétrable) ──
// Chaque fonction renvoie l'objet de variables, ou null si données manquantes.

function varsOrderConfirmation({ order }) {
  if (!order || !order.number) return null;
  return { brand: brand.NAME, orderNumber: order.number, total: formatCents(order.totalCents), orderUrl: orderUrl(order), phone: brand.PHONE };
}

function varsShipmentTracking({ order, shipment }) {
  if (!order || !shipment) return null;
  const carrier = getTrimmedString(shipment.carrier) || 'transporteur';
  const trackingUrl = buildCarrierTrackingUrl(shipment.carrier, shipment.trackingNumber);
  const trackingPart = trackingUrl ? `Suivi ${carrier} : ${trackingUrl}` : `N° suivi ${carrier} : ${shipment.trackingNumber}`;
  return { brand: brand.NAME, orderNumber: order.number, trackingPart, phone: brand.PHONE };
}

function varsDeliveryConfirmed({ order }) {
  if (!order) return null;
  return { brand: brand.NAME, orderNumber: order.number, phone: brand.PHONE };
}

function varsConsigneReminderSoon({ order }) {
  if (!order || !order.consigne || !order.consigne.lines) return null;
  const line = order.consigne.lines.find((l) => l.dueAt && !l.receivedAt);
  if (!line) return null;
  return { brand: brand.NAME, orderNumber: order.number, dueDate: formatDate(line.dueAt), orderUrl: orderUrl(order), phone: brand.PHONE };
}

function varsConsigneOverdue({ order }) {
  if (!order || !order.consigne || !order.consigne.lines) return null;
  const overdue = order.consigne.lines.filter((l) => l.dueAt && !l.receivedAt && new Date(l.dueAt) < new Date());
  if (!overdue.length) return null;
  const totalCents = overdue.reduce((sum, l) => sum + (l.amountCents || 0), 0);
  return { brand: brand.NAME, orderNumber: order.number, amount: formatCents(totalCents), phone: brand.PHONE };
}

function varsConsigneReceived({ order }) {
  if (!order) return null;
  return { brand: brand.NAME, orderNumber: order.number, orderUrl: orderUrl(order) };
}

// Les 4 étapes de clonage partagent les mêmes variables.
function varsCloning({ order }) {
  if (!order) return null;
  return { brand: brand.NAME, orderNumber: order.number, orderUrl: orderUrl(order), phone: brand.PHONE };
}

function varsAbandonedCart({ cart }) {
  if (!cart) return null;
  const base = getBaseUrl();
  const recoveryUrl = cart.recoveryToken ? `${base}/panier/recuperer/${cart.recoveryToken}` : base;
  return { brand: brand.NAME, recoveryUrl, phone: brand.PHONE };
}

function varsOrderStatusChange({ order, newStatus }) {
  if (!order) return null;
  return { brand: brand.NAME, orderNumber: order.number, statusLabel: STATUS_LABELS[newStatus] || newStatus || '', orderUrl: orderUrl(order), phone: brand.PHONE };
}

// ─── Public send functions ──────────────────────────────────────────────────

/**
 * Helper: sends SMS + auto-logs to order.smsSent if orderId is available.
 */
async function sendAndLog({ order, phone, text, smsType }) {
  const result = await sendSms({ to: phone, text });
  if (order && order._id) {
    logSmsSent({ orderId: order._id, smsType, recipientPhone: phone, result }).catch(() => {});
  }
  return result;
}

// Branche un envoi sur le resolver (activé/désactivé + texte paramétrable).
async function sendResolved({ key, vars, order, phone, smsType, logToOrder = true }) {
  if (!vars) return { ok: false, reason: 'template_failed' };
  const { enabled, text } = await resolveSms(key, vars);
  if (!enabled) return { ok: false, reason: 'disabled' };
  if (!text) return { ok: false, reason: 'template_failed' };
  return logToOrder ? sendAndLog({ order, phone, text, smsType }) : sendSms({ to: phone, text });
}

async function sendOrderConfirmationSms({ order, user } = {}) {
  const phone = resolvePhoneFromOrder(order);
  if (!phone) return { ok: false, reason: 'no_phone' };
  if (user && !user.smsOptIn) return { ok: false, reason: 'no_optin' };
  return sendResolved({ key: 'order_confirmation', vars: varsOrderConfirmation({ order }), order, phone, smsType: 'order_confirmation' });
}

async function sendShipmentTrackingSms({ order, user, shipment } = {}) {
  const phone = resolvePhoneFromOrder(order);
  if (!phone) return { ok: false, reason: 'no_phone' };
  if (user && !user.smsOptIn) return { ok: false, reason: 'no_optin' };
  return sendResolved({ key: 'shipment_tracking', vars: varsShipmentTracking({ order, shipment }), order, phone, smsType: 'shipment_tracking' });
}

async function sendDeliveryConfirmedSms({ order, user } = {}) {
  const phone = resolvePhoneFromOrder(order);
  if (!phone) return { ok: false, reason: 'no_phone' };
  if (user && !user.smsOptIn) return { ok: false, reason: 'no_optin' };
  return sendResolved({ key: 'delivery_confirmed', vars: varsDeliveryConfirmed({ order }), order, phone, smsType: 'delivery_confirmed' });
}

async function sendConsigneReminderSoonSms({ order, user } = {}) {
  const phone = resolvePhoneFromOrder(order);
  if (!phone) return { ok: false, reason: 'no_phone' };
  if (user && !user.smsOptIn) return { ok: false, reason: 'no_optin' };
  return sendResolved({ key: 'consigne_reminder_soon', vars: varsConsigneReminderSoon({ order }), order, phone, smsType: 'consigne_reminder_soon' });
}

async function sendConsigneOverdueSms({ order, user } = {}) {
  const phone = resolvePhoneFromOrder(order);
  if (!phone) return { ok: false, reason: 'no_phone' };
  if (user && !user.smsOptIn) return { ok: false, reason: 'no_optin' };
  return sendResolved({ key: 'consigne_overdue', vars: varsConsigneOverdue({ order }), order, phone, smsType: 'consigne_overdue' });
}

async function sendConsigneReceivedSms({ order, user } = {}) {
  const phone = resolvePhoneFromOrder(order);
  if (!phone) return { ok: false, reason: 'no_phone' };
  if (user && !user.smsOptIn) return { ok: false, reason: 'no_optin' };
  return sendResolved({ key: 'consigne_received', vars: varsConsigneReceived({ order }), order, phone, smsType: 'consigne_received' });
}

async function sendCloningStepSms({ order, user, step } = {}) {
  const phone = resolvePhoneFromOrder(order);
  if (!phone) return { ok: false, reason: 'no_phone' };
  if (user && !user.smsOptIn) return { ok: false, reason: 'no_optin' };
  const keyByStep = {
    label_sent: 'cloning_label_sent',
    piece_received: 'cloning_piece_received',
    cloning_done: 'cloning_done',
    cloning_failed: 'cloning_failed',
  };
  const key = keyByStep[step];
  if (!key) return { ok: false, reason: 'unknown_step' };
  return sendResolved({ key, vars: varsCloning({ order }), order, phone, smsType: `cloning_${step}` });
}

async function sendAbandonedCartSms({ cart, user } = {}) {
  if (!cart) return { ok: false, reason: 'missing_data' };

  let phone = '';
  if (user && user.addresses && user.addresses.length) {
    const defaultAddr = user.addresses.find((a) => a.isDefault) || user.addresses[0];
    phone = normalizePhoneFR(defaultAddr.phone);
  }
  if (!phone) return { ok: false, reason: 'no_phone' };
  if (user && !user.smsOptIn) return { ok: false, reason: 'no_optin' };
  return sendResolved({ key: 'abandoned_cart', vars: varsAbandonedCart({ cart }), phone, smsType: 'abandoned_cart', logToOrder: false });
}

async function sendOrderStatusChangeSms({ order, user, newStatus } = {}) {
  const phone = resolvePhoneFromOrder(order);
  if (!phone) return { ok: false, reason: 'no_phone' };
  if (user && !user.smsOptIn) return { ok: false, reason: 'no_optin' };
  return sendResolved({ key: 'status_change', vars: varsOrderStatusChange({ order, newStatus }), order, phone, smsType: 'status_change' });
}

/**
 * Logs an SMS send event to the Order.smsSent array.
 * Non-blocking — errors are swallowed so they never break the caller.
 */
async function logSmsSent({ orderId, smsType, recipientPhone, result } = {}) {
  if (!orderId || !smsType) return;
  try {
    const entry = {
      type: smsType,
      sentAt: new Date(),
      recipientPhone: getTrimmedString(recipientPhone),
      status: result && result.ok ? 'sent' : 'failed',
      reason: result && !result.ok && result.reason ? String(result.reason) : '',
    };
    await Order.updateOne(
      { _id: orderId },
      { $push: { smsSent: entry } }
    );
  } catch (err) {
    console.error('[sms-log] Erreur logging SMS:', err && err.message ? err.message : err);
  }
}

module.exports = {
  normalizePhoneFR,
  sendSms,
  logSmsSent,
  sendOrderConfirmationSms,
  sendShipmentTrackingSms,
  sendDeliveryConfirmedSms,
  sendConsigneReminderSoonSms,
  sendConsigneOverdueSms,
  sendConsigneReceivedSms,
  sendCloningStepSms,
  sendAbandonedCartSms,
  sendOrderStatusChangeSms,
};
