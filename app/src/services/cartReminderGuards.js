'use strict';

/**
 * Garde-fous communs aux relances de panier abandonné.
 *
 * Problème corrigé : quand un client paie via Mollie sans revenir sur le
 * site, son panier reste dans sa session. Le CRON de détection le revoit
 * une heure plus tard, crée un nouveau lead et relance 3 fois (1 h, +24 h,
 * +72 h) une pièce DÉJÀ ACHETÉE ET PAYÉE. Le garde-fou historique ne
 * couvrait que les comptes clients (userId) et les paniers détectés avant
 * la commande.
 *
 * On considère donc qu'il ne faut pas relancer si :
 *   1. le client a payé une commande depuis l'abandon du panier, ou
 *   2. le client a payé, récemment, une commande contenant au moins un des
 *      produits du panier (le panier est un résidu de session).
 *
 * Le rattachement au client se fait par userId ET par email, pour couvrir
 * les commandes passées en invité.
 */

const mongoose = require('mongoose');

const Order = require('../models/Order');
const User = require('../models/User');

/** Fenêtre pendant laquelle un achat rend la relance non pertinente. */
const RECENT_PURCHASE_WINDOW_DAYS = 60;

const IGNORED_ORDER_STATUSES = ['cancelled', 'refunded', 'draft'];

function toObjectId(value) {
  if (!value) return null;
  if (value instanceof mongoose.Types.ObjectId) return value;
  const str = String(value);
  return mongoose.Types.ObjectId.isValid(str) ? new mongoose.Types.ObjectId(str) : null;
}

function normalizeEmail(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

/**
 * Tous les comptes susceptibles de porter les commandes de ce client :
 * le compte lié au panier + le compte (éventuellement invité) créé avec
 * la même adresse email.
 */
async function resolveCustomerUserIds({ userId, email } = {}) {
  const ids = [];
  const direct = toObjectId(userId);
  if (direct) ids.push(direct);

  const normalizedEmail = normalizeEmail(email);
  if (normalizedEmail) {
    try {
      const users = await User.find({ email: normalizedEmail }).select('_id').lean();
      for (const user of users) {
        const id = toObjectId(user && user._id);
        if (id && !ids.some((existing) => String(existing) === String(id))) ids.push(id);
      }
    } catch (err) {
      console.error('[cart-guards] Erreur résolution client :', err && err.message ? err.message : err);
    }
  }

  return ids;
}

function extractProductIds(items) {
  const list = Array.isArray(items) ? items : [];
  const ids = [];
  for (const item of list) {
    const id = toObjectId(item && item.productId);
    if (id && !ids.some((existing) => String(existing) === String(id))) ids.push(id);
  }
  return ids;
}

/**
 * Cherche une commande payée qui rend la relance inutile.
 * Renvoie la commande trouvée, ou null.
 */
async function findPaidOrderBlockingReminder({ userId, email, items, abandonedAt } = {}) {
  if (mongoose.connection.readyState !== 1) return null;

  const userIds = await resolveCustomerUserIds({ userId, email });
  if (!userIds.length) return null;

  const baseQuery = {
    userId: { $in: userIds },
    paymentStatus: 'paid',
    status: { $nin: IGNORED_ORDER_STATUSES },
  };

  try {
    // 1. Commande payée passée depuis l'abandon : le client a fini par acheter.
    if (abandonedAt) {
      const since = abandonedAt instanceof Date ? abandonedAt : new Date(abandonedAt);
      if (!Number.isNaN(since.getTime())) {
        const after = await Order.findOne({ ...baseQuery, createdAt: { $gte: since } })
          .select('_id number createdAt')
          .lean();
        if (after) return after;
      }
    }

    // 2. Achat récent d'un des produits du panier : panier résiduel de session.
    const productIds = extractProductIds(items);
    if (productIds.length) {
      const windowStart = new Date(Date.now() - RECENT_PURCHASE_WINDOW_DAYS * 24 * 60 * 60 * 1000);
      const samePart = await Order.findOne({
        ...baseQuery,
        createdAt: { $gte: windowStart },
        'items.productId': { $in: productIds },
      })
        .select('_id number createdAt')
        .lean();
      if (samePart) return samePart;
    }
  } catch (err) {
    console.error('[cart-guards] Erreur recherche commande payée :', err && err.message ? err.message : err);
    return null;
  }

  return null;
}

module.exports = {
  RECENT_PURCHASE_WINDOW_DAYS,
  resolveCustomerUserIds,
  extractProductIds,
  findPaidOrderBlockingReminder,
};
