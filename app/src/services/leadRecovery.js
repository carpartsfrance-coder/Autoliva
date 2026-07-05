'use strict';

/**
 * Rapprochement commande → leads (/admin/activite-panier).
 *
 * Quand une commande est payée — en ligne (Mollie/Scalapay) OU encaissée à la
 * main (virement, commande téléphone, commande créée dans l'admin) — on marque
 * « recovered » tous les leads actifs du même client pour :
 *   - le sortir de la file « À traiter » (il a acheté : on ne le relance plus) ;
 *   - couper les relances automatiques panier ;
 *   - afficher sur sa carte « A commandé — n°X · montant · date » (lien commande).
 *
 * On ne SUPPRIME rien : le lead reste visible dans « Tous » (historique client
 * + vivier réachat).
 *
 * Match par userId, email (compte/commande) ET téléphone normalisé : le
 * téléphone rattrape les clients qui commandent avec un autre email que celui
 * laissé dans le lead (cas fréquent).
 */

const mongoose = require('mongoose');

async function markLeadsRecoveredForOrder(order, opts = {}) {
  try {
    if (!order || !order._id) return { modified: 0 };
    if (mongoose.connection.readyState !== 1) return { modified: 0 };

    const AbandonedCart = require('../models/AbandonedCart');
    const { phoneLooseRegex } = require('./leadCapture');

    const conditions = [];
    if (order.userId) conditions.push({ userId: order.userId });

    /* Email : fourni par l'appelant, sinon celui du compte lié à la commande
       (toute commande — même invitée — est rattachée à un User). */
    let email = String(opts.email || '').trim().toLowerCase();
    if (!email && order.userId) {
      try {
        const User = require('../models/User');
        const u = await User.findById(order.userId).select('email').lean();
        if (u && u.email) email = String(u.email).trim().toLowerCase();
      } catch (_) { /* non-bloquant */ }
    }
    if (email) conditions.push({ email });

    /* Téléphones : adresses de la commande + éventuel téléphone fourni.
       Regex tolérante aux séparateurs : les leads historiques stockent parfois
       le numéro avec espaces (« 06 88 89 99 00 ») — un $in de chaînes exactes
       les raterait. */
    [
      opts.phone,
      order.shippingAddress && order.shippingAddress.phone,
      order.billingAddress && order.billingAddress.phone,
    ].filter(Boolean).forEach((p) => {
      const rx = phoneLooseRegex(p);
      if (rx) conditions.push({ phone: rx });
    });

    if (!conditions.length) return { modified: 0 };

    const now = new Date();
    const result = await AbandonedCart.updateMany(
      { $or: conditions, status: { $nin: ['recovered', 'expired'] } },
      {
        $set: {
          status: 'recovered',
          recoveredAt: now,
          recoveredOrder: {
            orderId: order._id,
            number: order.number || '',
            totalCents: Number(order.totalCents) || 0,
            at: now,
          },
        },
      }
    );

    const modified = (result && result.modifiedCount) || 0;
    if (modified) {
      console.log(`[lead-recovery] ${modified} lead(s) marqué(s) « a commandé » (commande ${order.number || order._id})`);
    }
    return { modified };
  } catch (err) {
    console.error('[lead-recovery] erreur:', err && err.message ? err.message : err);
    return { modified: 0 };
  }
}

module.exports = { markLeadsRecoveredForOrder };
