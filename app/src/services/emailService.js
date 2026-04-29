const {
  buildOrderConfirmationEmail,
  buildConsigneStartEmail,
  buildConsigneReceivedEmail,
  buildShipmentTrackingEmail,
  buildConsigneReminderSoonEmail,
  buildConsigneOverdueEmail,
  buildWelcomeEmail,
  buildGuestAccountCreatedEmail,
  buildResetPasswordEmail,
  buildNewBlogPostEmail,
  buildAbandonedCartReminder1,
  buildAbandonedCartReminder2,
  buildAbandonedCartReminder3,
  buildDeliveryConfirmedEmail,
  buildOrderStatusChangeEmail,
  buildCloningLabelEmail,
  buildCloningPieceReceivedEmail,
  buildCloningDoneEmail,
  buildCloningFailedEmail,
} = require('./emailTemplates');

const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

const Product = require('../models/Product');
const Order = require('../models/Order');
const User = require('../models/User');

const { buildOrderInvoicePdfBuffer } = require('./invoicePdf');
const { buildLegalPdfBuffer } = require('./legalPdf');
const { getLegalPageBySlug } = require('./legalPages');
const { getSiteUrlFromEnv } = require('./siteUrl');
const brand = require('../config/brand');

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : value ? String(value).trim() : '';
}

function resolvePublicUrl(baseUrl, rawUrl) {
  const input = getTrimmedString(rawUrl);
  if (!input) return '';
  if (/^https?:\/\//i.test(input)) return input;
  if (!baseUrl) return '';
  const base = String(baseUrl).replace(/\/$/, '');
  if (input.startsWith('/')) return `${base}${input}`;
  return `${base}/${input}`;
}

function readFileIfExists(filePath) {
  try {
    if (!filePath) return null;
    if (!fs.existsSync(filePath)) return null;
    return fs.readFileSync(filePath);
  } catch (err) {
    return null;
  }
}

async function getCgvPdfBuffer({ dbConnected } = {}) {
  const custom = getTrimmedString(process.env.CGV_PDF_PATH);
  if (!custom) {
    try {
      const page = await getLegalPageBySlug({ slug: 'cgv', dbConnected, includeUnpublished: false });
      if (!page) return null;

      const pdf = await buildLegalPdfBuffer({ title: page.title || 'CGV', content: page.content || '' });
      if (pdf && Buffer.isBuffer(pdf) && pdf.length) return pdf;
    } catch (err) {
      // ignore
    }
  }

  if (custom) {
    const abs = path.isAbsolute(custom)
      ? custom
      : path.join(__dirname, '..', '..', custom);
    const buf = readFileIfExists(abs);
    if (buf && Buffer.isBuffer(buf) && buf.length) return buf;
  }

  const fallback = path.join(__dirname, '..', '..', 'public', 'cgv.pdf');
  const fallbackBuf = readFileIfExists(fallback);
  if (fallbackBuf && Buffer.isBuffer(fallbackBuf) && fallbackBuf.length) return fallbackBuf;

  return null;
}

function getDbConnected() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

async function hydrateUserForEmail(user) {
  if (!user || !user._id) return user;
  if (user.firstName && user.lastName && user.email) return user;
  try {
    const full = await User.findById(user._id)
      .select('_id email firstName lastName companyName siret accountType')
      .lean();
    return full || user;
  } catch (err) {
    return user;
  }
}

async function hydrateOrderForEmail(order) {
  if (!order || !order._id) return order;
  const hasItems = Array.isArray(order.items) && order.items.length;
  const hasTotals = Number.isFinite(order.totalCents);
  if (hasItems && hasTotals) return order;

  try {
    const full = await Order.findById(order._id).lean();
    return full || order;
  } catch (err) {
    return order;
  }
}

async function addProductImagesToOrder({ order, baseUrl } = {}) {
  if (!order || !Array.isArray(order.items) || !order.items.length) return order;

  const ids = order.items
    .map((it) => (it && it.productId ? String(it.productId) : ''))
    .filter(Boolean);

  if (!ids.length) return order;

  try {
    const products = await Product.find({ _id: { $in: ids } })
      .select('_id imageUrl')
      .lean();

    const byId = new Map();
    for (const p of products) {
      byId.set(String(p._id), p);
    }

    const nextItems = order.items.map((it) => {
      if (!it || !it.productId) return it;
      const p = byId.get(String(it.productId));
      const resolved = p && p.imageUrl ? resolvePublicUrl(baseUrl, p.imageUrl) : '';
      return { ...it, imageUrl: resolved };
    });

    return { ...order, items: nextItems };
  } catch (err) {
    return order;
  }
}

function getMailerSendApiKey() {
  return getTrimmedString(process.env.MAILERSEND_API_KEY);
}

function getBaseUrl() {
  return getSiteUrlFromEnv() || brand.SITE_URL;
}

function commercialReplyTo() {
  return brand.EMAIL_CONTACT ? { email: brand.EMAIL_CONTACT, name: brand.NAME } : null;
}

function resolveToEmail(toEmail) {
  const original = getTrimmedString(toEmail);
  const forced = getTrimmedString(process.env.MAIL_FORCE_TO);
  if (forced) return { toEmail: forced, forcedFrom: original || null };

  const isProd = process.env.NODE_ENV === 'production';
  const testTo = getTrimmedString(process.env.MAIL_TEST_TO);
  if (!isProd && testTo) return { toEmail: testTo, forcedFrom: original || null };

  return { toEmail: original, forcedFrom: null };
}

function getFrom() {
  return {
    email: getTrimmedString(process.env.MAIL_FROM_EMAIL),
    name: getTrimmedString(process.env.MAIL_FROM_NAME) || brand.NAME,
  };
}

async function sendEmail({ toEmail, subject, html, text, attachments, replyTo } = {}) {
  const apiKey = getMailerSendApiKey();
  const from = getFrom();

  if (!apiKey) {
    console.error('MAILERSEND_API_KEY manquant : email non envoyé');
    return { ok: false, reason: 'missing_api_key' };
  }
  if (!from.email) {
    console.error('MAIL_FROM_EMAIL manquant : email non envoyé');
    return { ok: false, reason: 'missing_from_email' };
  }

  const resolved = resolveToEmail(toEmail);
  if (!resolved.toEmail) {
    console.error('Destinataire manquant : email non envoyé');
    return { ok: false, reason: 'missing_to_email' };
  }

  const safeSubject = getTrimmedString(subject) || 'Message';
  const finalSubject = resolved.forcedFrom ? `[DEV] ${safeSubject}` : safeSubject;

  const payload = {
    from: { email: from.email, name: from.name },
    to: [{ email: resolved.toEmail }],
    subject: finalSubject,
    html: typeof html === 'string' && html.trim() ? html : undefined,
    text: typeof text === 'string' && text.trim() ? text : undefined,
  };

  // Reply-To header (MailerSend accepts an array of { email, name })
  if (replyTo) {
    if (Array.isArray(replyTo) && replyTo.length) {
      payload.reply_to = replyTo.filter((r) => r && r.email).map((r) => ({
        email: r.email,
        ...(r.name ? { name: r.name } : {}),
      }));
    } else if (typeof replyTo === 'object' && replyTo.email) {
      payload.reply_to = [{ email: replyTo.email, ...(replyTo.name ? { name: replyTo.name } : {}) }];
    } else if (typeof replyTo === 'string' && replyTo.trim()) {
      payload.reply_to = [{ email: replyTo.trim() }];
    }
    if (payload.reply_to && !payload.reply_to.length) delete payload.reply_to;
  }

  if (Array.isArray(attachments) && attachments.length) {
    payload.attachments = attachments
      .filter((a) => a && typeof a.filename === 'string' && a.filename.trim() && typeof a.content === 'string' && a.content.trim())
      .map((a) => ({
        filename: a.filename.trim(),
        content: a.content.trim(),
        disposition: a.disposition === 'inline' ? 'inline' : 'attachment',
      }));

    if (!payload.attachments.length) {
      delete payload.attachments;
    }
  }

  try {
    const res = await fetch('https://api.mailersend.com/v1/email', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (res.status === 202) {
      return { ok: true, forcedFrom: resolved.forcedFrom };
    }

    const bodyText = await res.text();
    console.error('MailerSend email refusé :', res.status, res.statusText, bodyText ? bodyText.slice(0, 1200) : '');
    return { ok: false, reason: 'mailersend_error', status: res.status };
  } catch (err) {
    console.error('MailerSend erreur envoi email :', err && err.message ? err.message : err);
    return { ok: false, reason: 'network_error' };
  }
}

async function sendOrderConfirmationEmail({ order, user } = {}) {
  if (!order || !user || !user.email) return { ok: false, reason: 'missing_data' };
  const baseUrl = getBaseUrl();

  const fullUser = await hydrateUserForEmail(user);
  const fullOrder = await hydrateOrderForEmail(order);
  const orderWithImages = await addProductImagesToOrder({ order: fullOrder, baseUrl });

  const attachments = [];
  let hasInvoice = false;
  let hasCgv = false;

  try {
    const invoiceBuffer = await buildOrderInvoicePdfBuffer({ order: orderWithImages, user: fullUser });
    if (invoiceBuffer && Buffer.isBuffer(invoiceBuffer) && invoiceBuffer.length) {
      const number = orderWithImages && orderWithImages.number ? String(orderWithImages.number).trim() : '';
      const filename = number ? `Facture-${number}.pdf` : 'Facture.pdf';
      attachments.push({ filename, content: invoiceBuffer.toString('base64'), disposition: 'attachment' });
      hasInvoice = true;
    }
  } catch (err) {
    console.warn('Facture PDF: génération impossible');
  }

  const cgvBuffer = await getCgvPdfBuffer({ dbConnected: getDbConnected() });
  if (cgvBuffer && Buffer.isBuffer(cgvBuffer) && cgvBuffer.length) {
    attachments.push({ filename: `CGV-${brand.NAME_SHORT}.pdf`, content: cgvBuffer.toString('base64'), disposition: 'attachment' });
    hasCgv = true;
  }

  const built = buildOrderConfirmationEmail({
    order: orderWithImages,
    user: fullUser,
    baseUrl,
    meta: { hasInvoice, hasCgv },
  });
  return sendEmail({
    toEmail: fullUser.email,
    subject: built.subject,
    html: built.html,
    text: built.text,
    attachments,
    replyTo: commercialReplyTo(),
  });
}

async function sendConsigneStartEmail({ order, user } = {}) {
  if (!order || !user || !user.email) return { ok: false, reason: 'missing_data' };
  const baseUrl = getBaseUrl();
  const built = buildConsigneStartEmail({ order, user, baseUrl });
  if (!built) return { ok: false, reason: 'no_consigne' };
  return sendEmail({ toEmail: user.email, subject: built.subject, html: built.html, text: built.text, replyTo: commercialReplyTo() });
}

async function sendConsigneReceivedEmail({ order, user } = {}) {
  if (!order || !user || !user.email) return { ok: false, reason: 'missing_data' };
  const baseUrl = getBaseUrl();
  const built = buildConsigneReceivedEmail({ order, user, baseUrl });
  return sendEmail({ toEmail: user.email, subject: built.subject, html: built.html, text: built.text, replyTo: commercialReplyTo() });
}

async function sendShipmentTrackingEmail({ order, user, shipment } = {}) {
  if (!order || !user || !user.email || !shipment) return { ok: false, reason: 'missing_data' };
  const baseUrl = getBaseUrl();

  const fullUser = await hydrateUserForEmail(user);
  const fullOrder = await hydrateOrderForEmail(order);
  const orderWithImages = await addProductImagesToOrder({ order: fullOrder, baseUrl });

  const attachments = [];
  let hasInvoice = false;
  let hasCgv = false;

  try {
    const invoiceBuffer = await buildOrderInvoicePdfBuffer({ order: orderWithImages, user: fullUser });
    if (invoiceBuffer && Buffer.isBuffer(invoiceBuffer) && invoiceBuffer.length) {
      const number = orderWithImages && orderWithImages.number ? String(orderWithImages.number).trim() : '';
      const filename = number ? `Facture-${number}.pdf` : 'Facture.pdf';
      attachments.push({ filename, content: invoiceBuffer.toString('base64'), disposition: 'attachment' });
      hasInvoice = true;
    }
  } catch (err) {
    console.warn('Facture PDF: génération impossible (expédition)');
  }

  const cgvBuffer = await getCgvPdfBuffer({ dbConnected: getDbConnected() });
  if (cgvBuffer && Buffer.isBuffer(cgvBuffer) && cgvBuffer.length) {
    attachments.push({ filename: `CGV-${brand.NAME_SHORT}.pdf`, content: cgvBuffer.toString('base64'), disposition: 'attachment' });
    hasCgv = true;
  }

  const built = buildShipmentTrackingEmail({
    order: orderWithImages,
    user: fullUser,
    shipment,
    baseUrl,
    meta: { hasInvoice, hasCgv },
  });
  return sendEmail({
    toEmail: fullUser.email,
    subject: built.subject,
    html: built.html,
    text: built.text,
    attachments,
    replyTo: commercialReplyTo(),
  });
}

async function sendConsigneReminderSoonEmail({ order, user } = {}) {
  if (!order || !user || !user.email) return { ok: false, reason: 'missing_data' };
  const baseUrl = getBaseUrl();
  const built = buildConsigneReminderSoonEmail({ order, user, baseUrl });
  if (!built) return { ok: false, reason: 'no_consigne' };
  return sendEmail({ toEmail: user.email, subject: built.subject, html: built.html, text: built.text, replyTo: commercialReplyTo() });
}

async function sendConsigneOverdueEmail({ order, user } = {}) {
  if (!order || !user || !user.email) return { ok: false, reason: 'missing_data' };
  const baseUrl = getBaseUrl();
  const built = buildConsigneOverdueEmail({ order, user, baseUrl });
  if (!built) return { ok: false, reason: 'no_consigne' };
  return sendEmail({ toEmail: user.email, subject: built.subject, html: built.html, text: built.text, replyTo: commercialReplyTo() });
}

async function sendWelcomeEmail({ user } = {}) {
  if (!user || !user.email) return { ok: false, reason: 'missing_data' };
  const baseUrl = getBaseUrl();
  const built = buildWelcomeEmail({ user, baseUrl });
  return sendEmail({ toEmail: user.email, subject: built.subject, html: built.html, text: built.text });
}

async function sendGuestAccountCreatedEmail({ user, resetUrl } = {}) {
  if (!user || !user.email) return { ok: false, reason: 'missing_data' };
  const url = getTrimmedString(resetUrl);
  if (!url) return { ok: false, reason: 'missing_reset_url' };
  const baseUrl = getBaseUrl();
  const built = buildGuestAccountCreatedEmail({ user, resetUrl: url, baseUrl });
  return sendEmail({ toEmail: user.email, subject: built.subject, html: built.html, text: built.text });
}

async function sendResetPasswordEmail({ user, resetUrl } = {}) {
  if (!user || !user.email) return { ok: false, reason: 'missing_data' };
  const url = getTrimmedString(resetUrl);
  if (!url) return { ok: false, reason: 'missing_reset_url' };
  const baseUrl = getBaseUrl();
  const built = buildResetPasswordEmail({ user, resetUrl: url, baseUrl });
  return sendEmail({ toEmail: user.email, subject: built.subject, html: built.html, text: built.text });
}

async function sendNewBlogPostToSubscribers({ post, baseUrl } = {}) {
  const NewsletterSubscriber = require('../models/NewsletterSubscriber');
  const resolvedBaseUrl = getTrimmedString(baseUrl) || getSiteUrlFromEnv() || '';
  const email = buildNewBlogPostEmail({ post, baseUrl: resolvedBaseUrl });
  if (!email || !email.subject) return { sent: 0, errors: 0 };

  let subscribers = [];
  try {
    subscribers = await NewsletterSubscriber.find({ status: 'active' }).select('email').limit(500).lean();
  } catch (err) {
    console.error('[Newsletter] Erreur lecture abonnés :', err.message);
    return { sent: 0, errors: 1 };
  }

  if (!subscribers.length) {
    console.log('[Newsletter] Aucun abonné actif — email non envoyé');
    return { sent: 0, errors: 0 };
  }

  let sent = 0;
  let errors = 0;

  for (const sub of subscribers) {
    try {
      const result = await sendEmail({ toEmail: sub.email, subject: email.subject, html: email.html, text: email.text });
      if (result && result.ok) {
        sent++;
      } else {
        errors++;
        console.error('[Newsletter] Échec envoi à', sub.email, result && result.reason ? result.reason : '');
      }
    } catch (err) {
      errors++;
      console.error('[Newsletter] Erreur envoi à', sub.email, err.message);
    }

    // Rate limiting — 100ms entre chaque envoi
    if (subscribers.indexOf(sub) < subscribers.length - 1) {
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  console.log(`[Newsletter] Envoi terminé : ${sent} envoyés, ${errors} erreurs sur ${subscribers.length} abonnés`);
  return { sent, errors };
}

async function sendAbandonedCartReminder({ cart, reminderNumber, promoCode } = {}) {
  if (!cart || !cart.email) return { ok: false, reason: 'missing_data' };

  const baseUrl = getBaseUrl();
  const num = Number(reminderNumber) || 1;

  let built;
  if (num === 1) {
    built = buildAbandonedCartReminder1({ cart, baseUrl });
  } else if (num === 2) {
    built = buildAbandonedCartReminder2({ cart, baseUrl });
  } else {
    built = buildAbandonedCartReminder3({ cart, baseUrl, promoCode });
  }

  if (!built) return { ok: false, reason: 'build_failed' };

  return sendEmail({
    toEmail: cart.email,
    subject: built.subject,
    html: built.html,
    text: built.text,
  });
}

async function sendDeliveryConfirmedEmail({ order, user } = {}) {
  if (!order || !user || !user.email) return { ok: false, reason: 'missing_data' };
  const baseUrl = getBaseUrl();

  const fullUser = await hydrateUserForEmail(user);
  const fullOrder = await hydrateOrderForEmail(order);
  const orderWithImages = await addProductImagesToOrder({ order: fullOrder, baseUrl });

  const built = buildDeliveryConfirmedEmail({ order: orderWithImages, user: fullUser, baseUrl });
  return sendEmail({ toEmail: fullUser.email, subject: built.subject, html: built.html, text: built.text, replyTo: commercialReplyTo() });
}

async function sendOrderStatusChangeEmail({ order, user, newStatus, message } = {}) {
  if (!order || !user || !user.email) return { ok: false, reason: 'missing_data' };
  const baseUrl = getBaseUrl();

  const fullUser = await hydrateUserForEmail(user);

  const built = buildOrderStatusChangeEmail({ order, user: fullUser, newStatus, message, baseUrl });
  return sendEmail({ toEmail: fullUser.email, subject: built.subject, html: built.html, text: built.text, replyTo: commercialReplyTo() });
}

/**
 * Logs an email send event to the Order.emailsSent array.
 * Non-blocking — errors are swallowed so they never break the caller.
 *
 * @param {Object} params
 * @param {string|ObjectId} params.orderId  - Mongo Order _id
 * @param {string} params.emailType         - e.g. 'order_confirmation', 'shipment_tracking', etc.
 * @param {string} params.recipientEmail    - recipient email address
 * @param {Object} params.result            - the return value of sendEmail()
 */
async function logEmailSent({ orderId, emailType, recipientEmail, result } = {}) {
  if (!orderId || !emailType) return;
  try {
    const entry = {
      type: emailType,
      sentAt: new Date(),
      recipientEmail: getTrimmedString(recipientEmail),
      status: result && result.ok ? 'sent' : 'failed',
      reason: result && !result.ok && result.reason ? String(result.reason) : '',
    };

    await Order.updateOne(
      { _id: orderId },
      { $push: { emailsSent: entry } }
    );
  } catch (err) {
    console.error('[email-log] Erreur logging email:', err && err.message ? err.message : err);
  }
}

async function sendCloningLabelEmail({ order, user, labelPdfBuffer } = {}) {
  if (!order || !user || !user.email) return { ok: false, reason: 'missing_data' };
  const baseUrl = getBaseUrl();

  const fullUser = await hydrateUserForEmail(user);
  const fullOrder = await hydrateOrderForEmail(order);

  const attachments = [];
  if (labelPdfBuffer && Buffer.isBuffer(labelPdfBuffer) && labelPdfBuffer.length) {
    const number = fullOrder && fullOrder.number ? String(fullOrder.number).trim() : '';
    const filename = number ? `Etiquette-recuperation-${number}.pdf` : 'Etiquette-recuperation.pdf';
    attachments.push({ filename, content: labelPdfBuffer.toString('base64'), disposition: 'attachment' });
  }

  const built = buildCloningLabelEmail({ order: fullOrder, user: fullUser, baseUrl });
  if (!built) return { ok: false, reason: 'template_failed' };

  const result = await sendEmail({
    toEmail: fullUser.email,
    subject: built.subject,
    html: built.html,
    text: built.text,
    attachments,
    replyTo: commercialReplyTo(),
  });

  await logEmailSent({
    orderId: fullOrder._id,
    emailType: 'cloning_label',
    recipientEmail: fullUser.email,
    result,
  });

  return result;
}

async function sendCloningStepEmail({ order, user, step } = {}) {
  if (!order || !user || !user.email || !step) return { ok: false, reason: 'missing_data' };
  const baseUrl = getBaseUrl();

  const fullUser = await hydrateUserForEmail(user);
  const fullOrder = await hydrateOrderForEmail(order);

  const builders = {
    piece_received: buildCloningPieceReceivedEmail,
    cloning_done: buildCloningDoneEmail,
    cloning_failed: buildCloningFailedEmail,
  };

  const builder = builders[step];
  if (!builder) return { ok: false, reason: 'unknown_step' };

  const built = builder({ order: fullOrder, user: fullUser, baseUrl });
  if (!built) return { ok: false, reason: 'template_failed' };

  const result = await sendEmail({
    toEmail: fullUser.email,
    subject: built.subject,
    html: built.html,
    text: built.text,
    replyTo: commercialReplyTo(),
  });

  await logEmailSent({
    orderId: fullOrder._id,
    emailType: `cloning_${step}`,
    recipientEmail: fullUser.email,
    result,
  });

  return result;
}

module.exports = {
  sendEmail,
  sendOrderConfirmationEmail,
  sendConsigneStartEmail,
  sendConsigneReceivedEmail,
  sendShipmentTrackingEmail,
  sendConsigneReminderSoonEmail,
  sendConsigneOverdueEmail,
  sendWelcomeEmail,
  sendGuestAccountCreatedEmail,
  sendResetPasswordEmail,
  sendNewBlogPostToSubscribers,
  sendAbandonedCartReminder,
  sendDeliveryConfirmedEmail,
  sendOrderStatusChangeEmail,
  sendCloningLabelEmail,
  sendCloningStepEmail,
  logEmailSent,
};
