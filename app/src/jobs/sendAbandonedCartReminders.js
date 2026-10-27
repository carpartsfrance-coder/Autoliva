const mongoose = require('mongoose');

const AbandonedCart = require('../models/AbandonedCart');
const User = require('../models/User');
const { sendAbandonedCartReminder } = require('../services/emailService');
const { findPaidOrderBlockingReminder } = require('../services/cartReminderGuards');
const marketingOptOut = require('../services/marketingOptOut');
const smsService = require('../services/smsService');
const { journaliser } = require('../services/leadCommunications');

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
    return { sent: 0, expired: 0, optedOut: 0, errors: 0 };
  }

  const now = new Date();
  const report = { sent: 0, expired: 0, optedOut: 0, errors: 0 };

  // Interrupteur d'urgence : ABANDONED_CART_REMINDERS_ENABLED=false coupe le cron
  // instantanément via une variable d'environnement (Render), sans redéploiement —
  // utile pour stopper un envoi en masse erroné le temps de corriger.
  if (String(process.env.ABANDONED_CART_REMINDERS_ENABLED || 'true').toLowerCase() === 'false') {
    console.log('[cart-reminders] Désactivé via ABANDONED_CART_REMINDERS_ENABLED=false — aucun envoi.');
    return report;
  }

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
      // Skip leads with manual status (admin a déjà pris la main)
      manualStatus: null,
      // Ne relancer QUE de vrais paniers abandonnés. Les leads "non panier"
      // (demande de devis moteur/boîte, formulaire contact/devis, CTA article
      // de blog) sont stockés comme AbandonedCart avec status 'abandoned' par
      // défaut, mais ne représentent PAS un panier : sans cette exclusion, un
      // client qui demande un devis recevait des relances "votre panier vous
      // attend" EN PLUS des relances devis (double-relance). On exige aussi
      // au moins un article (un rappel de panier vide n'a aucun sens).
      captureSource: { $nin: ['landing_moteurs', 'landing_boites', 'landing_ponts', 'contact', 'devis', 'blog_cta'] },
      'items.0': { $exists: true },
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

        // Double-check the cart hasn't been recovered or manually handled in the meantime
        const freshCart = await AbandonedCart.findById(cart._id).select('status manualStatus').lean();
        if (!freshCart || freshCart.status === 'recovered' || freshCart.status === 'expired') {
          continue;
        }
        if (freshCart.manualStatus) {
          // Admin a marqué ce lead manuellement → ne pas envoyer de relance auto
          continue;
        }

        // Le client s'est désinscrit des emails commerciaux : on arrête ce
        // lead définitivement plutôt que de le repasser en revue chaque heure.
        if (await marketingOptOut.isOptedOut(cart.email)) {
          await AbandonedCart.updateOne(
            { _id: cart._id },
            { $set: { status: 'expired' } }
          );
          report.optedOut += 1;
          console.log(`[cart-reminders] Panier ${cart._id} stoppé (${cart.email} désinscrit des emails commerciaux)`);
          continue;
        }

        // Défense en profondeur : si le client a déjà payé (quel que soit le
        // moyen de paiement, et sans avoir cliqué le lien recovery), on marque
        // le panier recovered et on n'envoie PAS de relance.
        //
        // Deux cas couverts, par userId ET par email (les commandes invité sont
        // rattachées à un User créé avec l'email du client) :
        //   – une commande payée depuis l'abandon ;
        //   – une commande payée récemment contenant l'une des pièces du
        //     panier. Ce second cas rattrape les paniers restés en session
        //     après un paiement : le CRON de détection les revoit plus tard,
        //     avec un `abandonedAt` postérieur à la commande, et relançait
        //     alors une pièce déjà achetée.
        const blockingOrder = await findPaidOrderBlockingReminder({
          userId: cart.userId,
          email: cart.email,
          items: cart.items,
          abandonedAt: cart.abandonedAt,
        });

        if (blockingOrder) {
          await AbandonedCart.updateOne(
            { _id: cart._id },
            { $set: { status: 'recovered', recoveredAt: now } }
          );
          console.log(`[cart-reminders] Panier ${cart._id} marqué recovered (commande payée ${blockingOrder.number || blockingOrder._id})`);
          continue;
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
          await journaliser(cart._id, {
            canal: 'email', auto: true,
            objet: `Relance panier abandonné n°${reminderNumber}`,
            gabarit: `relance_panier_${reminderNumber}`,
            meta: reminderNumber === 3 && promoCode ? { promoCode } : {},
            at: now,
          });

          // Send SMS only on first reminder (avoid spam)
          if (reminderNumber === 1 && cart.userId) {
            try {
              const smsUser = await User.findById(cart.userId).select('_id smsOptIn addresses').lean();
              if (smsUser) {
                /* Ce SMS partait en `.catch(() => {})` : ni son succès ni son
                   échec n'étaient écrits nulle part. On le journalise sans
                   pour autant le rendre bloquant — une relance email réussie
                   ne doit pas être comptée en échec parce que le SMS a raté. */
                smsService.sendAbandonedCartSms({ cart, user: smsUser })
                  .then((r) => journaliser(cart._id, {
                    canal: 'sms', auto: true, gabarit: 'relance_panier_1',
                    ok: !!(r && r.ok),
                    motif: (r && !r.ok) ? (r.reason || 'inconnu') : '',
                  }))
                  .catch((e) => journaliser(cart._id, {
                    canal: 'sms', auto: true, gabarit: 'relance_panier_1',
                    ok: false, motif: (e && e.message) ? e.message : 'erreur',
                  }));
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
          await journaliser(cart._id, {
            canal: 'email', auto: true,
            objet: `Relance panier abandonné n°${reminderNumber}`,
            gabarit: `relance_panier_${reminderNumber}`,
            ok: false, motif: (result && result.reason) || 'inconnu', at: now,
          });
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
