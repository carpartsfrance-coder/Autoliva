const mongoose = require('mongoose');

const AbandonedCart = require('../models/AbandonedCart');
const Order = require('../models/Order');
const User = require('../models/User');
const { sendAbandonedCartReminder } = require('../services/emailService');
const smsService = require('../services/smsService');

const MAX_EMAILS_PER_RUN = 50;
const RATE_LIMIT_MS = 200; // 200ms between each email

// Timing thresholds (in milliseconds)
const REMINDER_1_DELAY_MS = 1 * 60 * 60 * 1000;       // 1 hour after abandon
const REMINDER_2_DELAY_MS = 24 * 60 * 60 * 1000;      // 24h after reminder 1
const REMINDER_3_DELAY_MS = 72 * 60 * 60 * 1000;      // 72h after reminder 2
const EXPIRATION_DELAY_MS = 7 * 24 * 60 * 60 * 1000;  // 7 days after reminder 3

/**
 * Sends abandoned cart reminder emails and handles status transitions.
 *
 * For each AbandonedCart document:
 * - abandoned  → after 1h  → send Email 1, mark reminded_1
 * - reminded_1 → after 24h → send Email 2, mark reminded_2
 * - reminded_2 → after 72h → send Email 3, mark reminded_3
 * - reminded_3 → after 7d  → mark expired (no email)
 *
 * Never touches 'recovered' carts.
 * Max 50 emails per run to respect provider limits.
 */
async function sendAbandonedCartReminders() {
  if (mongoose.connection.readyState !== 1) {
    console.error('[cart-reminders] MongoDB non connectée, skip.');
    return { sent: 0, expired: 0, errors: 0 };
  }

  const now = new Date();
  const report = { sent: 0, expired: 0, errors: 0 };

  const promoCode = typeof process.env.ABANDONED_CART_PROMO_CODE === 'string'
    ? process.env.ABANDONED_CART_PROMO_CODE.trim()
    : '';

  try {
    // 1. Expire reminded_3 carts older than 7 days
    const expireCutoff = new Date(now.getTime() - EXPIRATION_DELAY_MS);
    const expireResult = await AbandonedCart.updateMany(
      {
        status: 'reminded_3',
        lastRemindedAt: { $lte: expireCutoff },
      },
      {
        $set: { status: 'expired' },
      }
    );
    report.expired = expireResult.modifiedCount || 0;

    if (report.expired > 0) {
      console.log(`[cart-reminders] ${report.expired} panier(s) expirés.`);
    }

    // 2. Find carts eligible for reminders (in priority order: oldest first)
    // Combine all eligible carts into one sorted list
    const reminder1Cutoff = new Date(now.getTime() - REMINDER_1_DELAY_MS);
    const reminder2Cutoff = new Date(now.getTime() - REMINDER_2_DELAY_MS);
    const reminder3Cutoff = new Date(now.getTime() - REMINDER_3_DELAY_MS);

    const eligibleCarts = await AbandonedCart.find({
      $or: [
        // Abandoned for > 1h but < 24h (eligible for reminder 1)
        {
          status: 'abandoned',
          abandonedAt: { $lte: reminder1Cutoff },
          email: { $ne: '', $exists: true },
        },
        // Reminded_1 for > 24h (eligible for reminder 2)
        {
          status: 'reminded_1',
          lastRemindedAt: { $lte: reminder2Cutoff },
        },
        // Reminded_2 for > 72h (eligible for reminder 3)
        {
          status: 'reminded_2',
          lastRemindedAt: { $lte: reminder3Cutoff },
        },
      ],
    })
      .sort({ abandonedAt: 1 }) // oldest first
      .limit(MAX_EMAILS_PER_RUN)
      .lean();

    if (!eligibleCarts.length) {
      console.log('[cart-reminders] Aucun panier éligible pour relance.');
      return report;
    }

    console.log(`[cart-reminders] ${eligibleCarts.length} panier(s) éligibles pour relance.`);

    for (const cart of eligibleCarts) {
      try {
        let reminderNumber;
        let nextStatus;

        if (cart.status === 'abandoned') {
          reminderNumber = 1;
          nextStatus = 'reminded_1';
        } else if (cart.status === 'reminded_1') {
          reminderNumber = 2;
          nextStatus = 'reminded_2';
        } else if (cart.status === 'reminded_2') {
          reminderNumber = 3;
          nextStatus = 'reminded_3';
        } else {
          continue;
        }

        // Double-check the cart hasn't been recovered in the meantime
        const freshCart = await AbandonedCart.findById(cart._id).select('status').lean();
        if (!freshCart || freshCart.status === 'recovered' || freshCart.status === 'expired') {
          continue;
        }

        // Défense en profondeur : si le client a passé une commande payée
        // depuis l'abandon (sans avoir cliqué le lien recovery), on skip et
        // on marque le panier comme recovered. Évite que le client reçoive
        // des relances après avoir commandé.
        if (cart.userId) {
          try {
            const subsequentPaidOrder = await Order.findOne({
              userId: cart.userId,
              paymentStatus: 'paid',
              createdAt: { $gte: cart.abandonedAt },
            }).select('_id number').lean();

            if (subsequentPaidOrder) {
              await AbandonedCart.updateOne(
                { _id: cart._id },
                { $set: { status: 'recovered', recoveredAt: now } }
              );
              console.log(`[cart-reminders] Panier ${cart._id} marqué recovered (commande ${subsequentPaidOrder.number || subsequentPaidOrder._id} passée depuis l'abandon)`);
              continue;
            }
          } catch (_) { /* non-bloquant, on continue avec l'envoi normal */ }
        }

        // Send the email
        const result = await sendAbandonedCartReminder({
          cart: {
            email: cart.email,
            firstName: cart.firstName || '',
            items: cart.items || [],
            totalAmountCents: cart.totalAmountCents || 0,
            recoveryToken: cart.recoveryToken,
          },
          reminderNumber,
          promoCode: reminderNumber === 3 ? promoCode : undefined,
        });

        if (result && result.ok) {
          // Send SMS only on first reminder (avoid spam)
          if (reminderNumber === 1 && cart.userId) {
            try {
              const smsUser = await User.findById(cart.userId).select('_id smsOptIn addresses').lean();
              if (smsUser) {
                smsService.sendAbandonedCartSms({ cart, user: smsUser }).catch(() => {});
              }
            } catch (_) { /* non-blocking */ }
          }
          // Update cart status
          await AbandonedCart.updateOne(
            { _id: cart._id },
            {
              $set: {
                status: nextStatus,
                lastRemindedAt: now,
              },
            }
          );
          report.sent += 1;
          console.log(`[cart-reminders] Relance ${reminderNumber} envoyée à ${cart.email} (panier ${cart._id})`);
        } else {
          report.errors += 1;
          console.error(
            `[cart-reminders] Échec envoi relance ${reminderNumber} à ${cart.email}:`,
            result && result.reason ? result.reason : 'unknown'
          );
        }

        // Rate limiting between sends
        if (report.sent + report.errors < eligibleCarts.length) {
          await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
        }
      } catch (err) {
        report.errors += 1;
        console.error('[cart-reminders] Erreur traitement panier:', err.message || err);
      }
    }
  } catch (err) {
    report.errors += 1;
    console.error('[cart-reminders] Erreur globale:', err.message || err);
  }

  console.log('[cart-reminders] Rapport:', JSON.stringify(report));
  return report;
}

module.exports = { sendAbandonedCartReminders };
