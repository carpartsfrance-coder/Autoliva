'use strict';

/**
 * Notifications client au passage « Livrée » — factorisées pour être
 * déclenchées PAR L'ADMIN (changement de statut manuel) ET PAR LE ROBOT
 * (jobs/syncShipmentTracking : livraison détectée automatiquement via le
 * suivi Jumingo). Sans cette factorisation, une livraison détectée
 * automatiquement n'envoyait ni les instructions de consigne (retour de
 * l'ancienne pièce) ni la confirmation de livraison au client.
 *
 * Idempotent : anti-doublon via notifications.consigneStartSentAt /
 * notifications.deliveryConfirmedSentAt (updateOne conditionnel) — peut être
 * appelé plusieurs fois sans double envoi.
 */

const Order = require('../models/Order');
const User = require('../models/User');
const emailService = require('./emailService');
const smsService = require('./smsService');

async function sendDeliveredNotifications(orderId) {
  try {
    const refreshed = await Order.findById(orderId)
      .select('_id number userId consigne notifications')
      .lean();
    if (!refreshed) return;

    /* ── Consigne : instructions de retour de l'ancienne pièce ── */
    const alreadySent = refreshed.notifications && refreshed.notifications.consigneStartSentAt;
    const linesAfter = refreshed.consigne && Array.isArray(refreshed.consigne.lines)
      ? refreshed.consigne.lines
      : [];

    if (!alreadySent && linesAfter.length) {
      const user = refreshed.userId
        ? await User.findById(refreshed.userId).select('_id email firstName').lean()
        : null;

      if (user && user.email) {
        const sent = await emailService.sendConsigneStartEmail({ order: refreshed, user });
        emailService.logEmailSent({ orderId: refreshed._id, emailType: 'consigne_start', recipientEmail: user.email, result: sent });
        smsService.sendConsigneReminderSoonSms({ order: refreshed, user }).catch(() => {});
        if (sent && sent.ok) {
          await Order.updateOne(
            {
              _id: refreshed._id,
              $or: [
                { 'notifications.consigneStartSentAt': { $exists: false } },
                { 'notifications.consigneStartSentAt': null },
              ],
            },
            { $set: { 'notifications.consigneStartSentAt': new Date() } }
          );
        }
      }
    }

    /* ── Confirmation de livraison ── */
    const deliveryAlreadySent = refreshed.notifications && refreshed.notifications.deliveryConfirmedSentAt;

    if (!deliveryAlreadySent) {
      const user = refreshed.userId
        ? await User.findById(refreshed.userId).select('_id email firstName').lean()
        : null;

      if (user && user.email) {
        const sent = await emailService.sendDeliveryConfirmedEmail({ order: refreshed, user });
        emailService.logEmailSent({ orderId: refreshed._id, emailType: 'delivery_confirmed', recipientEmail: user.email, result: sent });
        smsService.sendDeliveryConfirmedSms({ order: refreshed, user }).catch(() => {});
        if (sent && sent.ok) {
          await Order.updateOne(
            {
              _id: refreshed._id,
              $or: [
                { 'notifications.deliveryConfirmedSentAt': { $exists: false } },
                { 'notifications.deliveryConfirmedSentAt': null },
              ],
            },
            { $set: { 'notifications.deliveryConfirmedSentAt': new Date() } }
          );
        }
      }
    }
  } catch (err) {
    console.error('Erreur notifications livraison :', err && err.message ? err.message : err);
  }
}

module.exports = { sendDeliveredNotifications };
