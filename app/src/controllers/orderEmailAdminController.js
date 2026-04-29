const mongoose = require('mongoose');

const Order = require('../models/Order');
const User = require('../models/User');
const emailService = require('../services/emailService');

const {
  buildOrderConfirmationEmail,
  buildShipmentTrackingEmail,
  buildDeliveryConfirmedEmail,
  buildOrderStatusChangeEmail,
  buildConsigneStartEmail,
  buildConsigneReceivedEmail,
} = require('../services/emailTemplates');

const { getSiteUrlFromEnv } = require('../services/siteUrl');

const EMAIL_TYPES = {
  order_confirmation: { label: 'Confirmation de commande', icon: 'receipt_long' },
  shipment_tracking: { label: "Suivi d'expédition", icon: 'local_shipping' },
  delivery_confirmed: { label: 'Livraison confirmée', icon: 'done_all' },
  status_change: { label: 'Changement de statut', icon: 'check_circle' },
  consigne_start: { label: 'Consigne : retour pièce', icon: 'assignment_return' },
  consigne_received: { label: 'Consigne reçue', icon: 'inventory' },
};

function getBaseUrl() {
  // Fallback to brand.SITE_URL if no SITE_URL env (post-rebrand multi-domain)
  const brand = require('../config/brand');
  return getSiteUrlFromEnv() || brand.SITE_URL;
}

/**
 * Build an email preview HTML for a given order and email type.
 * Returns null if the type is unknown or data is insufficient.
 */
async function buildPreviewForType({ order, user, emailType, baseUrl }) {
  switch (emailType) {
    case 'order_confirmation':
      return buildOrderConfirmationEmail({ order, user, baseUrl, meta: {} });

    case 'shipment_tracking': {
      const shipments = Array.isArray(order.shipments) ? order.shipments : [];
      const lastShipment = shipments[shipments.length - 1] || { carrier: 'Transporteur', trackingNumber: 'XXXXXXXXX' };
      return buildShipmentTrackingEmail({ order, user, shipment: lastShipment, baseUrl, meta: {} });
    }

    case 'delivery_confirmed':
      return buildDeliveryConfirmedEmail({ order, user, baseUrl });

    case 'status_change':
      return buildOrderStatusChangeEmail({
        order,
        user,
        newStatus: order.status || 'paid',
        message: 'Le statut de votre commande a été mis à jour.',
        baseUrl,
      });

    case 'consigne_start':
      return buildConsigneStartEmail({ order, user, baseUrl });

    case 'consigne_received':
      return buildConsigneReceivedEmail({ order, user, baseUrl });

    default:
      return null;
  }
}

/**
 * GET /admin/commandes/:orderId/email/preview/:type
 * Returns the rendered HTML email preview.
 */
async function getEmailPreview(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    if (!dbConnected) return res.status(503).json({ ok: false, error: 'Base de données indisponible.' });

    const { orderId, type } = req.params;
    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(400).json({ ok: false, error: 'ID commande invalide.' });
    }

    if (!EMAIL_TYPES[type]) {
      return res.status(400).json({ ok: false, error: 'Type d\'email inconnu.' });
    }

    const order = await Order.findById(orderId).lean();
    if (!order) return res.status(404).json({ ok: false, error: 'Commande introuvable.' });

    const user = order.userId
      ? await User.findById(order.userId).select('_id email firstName lastName companyName accountType').lean()
      : null;

    const baseUrl = getBaseUrl();
    const built = await buildPreviewForType({ order, user: user || {}, emailType: type, baseUrl });

    if (!built || !built.html) {
      return res.status(400).json({ ok: false, error: 'Impossible de générer l\'aperçu pour ce type d\'email.' });
    }

    // Override the global X-Frame-Options: DENY so the admin can preview
    // this HTML inside the iframe modal of /admin/commandes/:id (same-origin).
    res.set('X-Frame-Options', 'SAMEORIGIN');
    res.set('Content-Security-Policy', "frame-ancestors 'self'");
    res.set('Content-Type', 'text/html; charset=utf-8');
    // Return raw HTML so it can be displayed in an iframe
    return res.send(built.html);
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /admin/commandes/:orderId/email/resend
 * Resends a specific email type for the order.
 * Body: { type: 'order_confirmation' | 'shipment_tracking' | ... }
 */
async function postResendEmail(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    if (!dbConnected) {
      req.session.adminOrderError = 'Base de données indisponible.';
      return res.redirect(`/admin/commandes/${encodeURIComponent(req.params.orderId)}`);
    }

    const { orderId } = req.params;
    const emailType = typeof req.body.type === 'string' ? req.body.type.trim() : '';

    if (!orderId || !mongoose.Types.ObjectId.isValid(orderId)) {
      req.session.adminOrderError = 'ID commande invalide.';
      return res.redirect('/admin/commandes');
    }

    if (!EMAIL_TYPES[emailType]) {
      req.session.adminOrderError = 'Type d\'email inconnu.';
      return res.redirect(`/admin/commandes/${encodeURIComponent(orderId)}`);
    }

    const order = await Order.findById(orderId).lean();
    if (!order) {
      req.session.adminOrderError = 'Commande introuvable.';
      return res.redirect('/admin/commandes');
    }

    const user = order.userId
      ? await User.findById(order.userId).select('_id email firstName lastName companyName accountType').lean()
      : null;

    if (!user || !user.email) {
      req.session.adminOrderError = 'Aucun email client associé à cette commande.';
      return res.redirect(`/admin/commandes/${encodeURIComponent(orderId)}`);
    }

    let result;

    switch (emailType) {
      case 'order_confirmation':
        result = await emailService.sendOrderConfirmationEmail({ order, user });
        break;

      case 'shipment_tracking': {
        const shipments = Array.isArray(order.shipments) ? order.shipments : [];
        const lastShipment = shipments[shipments.length - 1];
        if (!lastShipment) {
          req.session.adminOrderError = 'Aucune expédition enregistrée pour cette commande.';
          return res.redirect(`/admin/commandes/${encodeURIComponent(orderId)}`);
        }
        result = await emailService.sendShipmentTrackingEmail({ order, user, shipment: lastShipment });
        break;
      }

      case 'delivery_confirmed':
        result = await emailService.sendDeliveryConfirmedEmail({ order, user });
        break;

      case 'status_change':
        result = await emailService.sendOrderStatusChangeEmail({
          order,
          user,
          newStatus: order.status || 'paid',
          message: 'Le statut de votre commande a été mis à jour.',
        });
        break;

      case 'consigne_start':
        result = await emailService.sendConsigneStartEmail({ order, user });
        break;

      case 'consigne_received':
        result = await emailService.sendConsigneReceivedEmail({ order, user });
        break;

      default:
        req.session.adminOrderError = 'Type d\'email non supporté.';
        return res.redirect(`/admin/commandes/${encodeURIComponent(orderId)}`);
    }

    // Log the send
    emailService.logEmailSent({
      orderId: order._id,
      emailType: emailType,
      recipientEmail: user.email,
      result,
    });

    if (result && result.ok) {
      req.session.adminOrderSuccess = `Email "${EMAIL_TYPES[emailType].label}" envoyé à ${user.email}.`;
    } else {
      req.session.adminOrderError = `Échec envoi email : ${result && result.reason ? result.reason : 'erreur inconnue'}.`;
    }

    return res.redirect(`/admin/commandes/${encodeURIComponent(orderId)}`);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getEmailPreview,
  postResendEmail,
  EMAIL_TYPES,
};
