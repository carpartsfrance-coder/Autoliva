'use strict';

/**
 * Recherche d'un lead dans /admin/activite-panier.
 *
 * Avant : la recherche ne regardait que email / prénom / nom / téléphone,
 * en texte brut. Chercher un client par le numéro de sa commande, par la
 * pièce qu'il voulait, ou par un téléphone noté dans une autre graphie
 * (06… alors que la base contient +336…) ne donnait rien.
 *
 * Ce module construit les conditions Mongo d'une recherche. Il est appelé
 * par le contrôleur, qui, quand une recherche est en cours, lève aussi le
 * filtre de période et affiche tous les leads (voir getAdminLeadsPage).
 */

const mongoose = require('mongoose');

const Order = require('../models/Order');
const User = require('../models/User');

/** Au-delà, on ne remonte pas les commandes homonymes : la saisie est trop vague. */
const MAX_MATCHED_ORDERS = 25;

function escapeRegExp(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Numéro de téléphone saisi dans une graphie différente de celle stockée.
 * On réduit la saisie au numéro national (sans 0, sans +33) puis on tolère
 * n'importe quel séparateur entre les chiffres : « 06 12 34 56 78 »,
 * « +33612345678 » et « 0612-345678 » se retrouvent mutuellement.
 */
function buildPhoneRegExp(raw) {
  let digits = String(raw || '').replace(/\D/g, '');
  if (!digits) return null;

  if (digits.startsWith('0033')) digits = digits.slice(4);
  else if (digits.startsWith('33') && digits.length > 9) digits = digits.slice(2);
  if (digits.startsWith('0')) digits = digits.slice(1);

  if (digits.length < 6) return null;
  return new RegExp(digits.split('').join('[\\s.\\-()+]*'));
}

/**
 * Conditions `$or` correspondant à la saisie, ou null si la saisie est vide.
 * Asynchrone : un numéro de commande ou de facture est résolu en client,
 * pour retrouver ses leads même s'ils ne portent pas ce numéro.
 */
async function buildLeadSearchConditions(rawQuery) {
  const q = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  if (!q) return null;

  const rx = new RegExp(escapeRegExp(q), 'i');

  const conditions = [
    { email: rx },
    { firstName: rx },
    { lastName: rx },
    { phone: rx },
    { 'items.name': rx },
    { 'items.sku': rx },
    { 'requested.vehicle': rx },
    { 'requested.plate': rx },
    { 'requested.vin': rx },
    { 'requested.ref': rx },
    { 'requested.message': rx },
    { contextMessage: rx },
    { 'recoveredOrder.number': rx },
  ];

  // « Prénom Nom » saisi en entier : chaque mot peut tomber dans l'un ou l'autre champ.
  const words = q.split(/\s+/).filter((w) => w.length >= 2);
  if (words.length >= 2) {
    conditions.push({
      $and: words.map((word) => {
        const wordRx = new RegExp(escapeRegExp(word), 'i');
        return { $or: [{ firstName: wordRx }, { lastName: wordRx }] };
      }),
    });
  }

  const phoneRx = buildPhoneRegExp(q);
  if (phoneRx) conditions.push({ phone: phoneRx });

  // Numéro de commande (CP2026-000673) ou de facture (F2026-000277) :
  // on remonte au client, puis à tous ses leads.
  if (/\d{3}/.test(q) && mongoose.connection.readyState === 1) {
    try {
      const orders = await Order.find({ $or: [{ number: rx }, { 'invoice.number': rx }] })
        .select('_id userId')
        .limit(MAX_MATCHED_ORDERS)
        .lean();

      if (orders.length) {
        const orderIds = orders.map((o) => o._id);
        const userIds = [];
        for (const order of orders) {
          if (order.userId && !userIds.some((id) => String(id) === String(order.userId))) {
            userIds.push(order.userId);
          }
        }

        conditions.push({ 'recoveredOrder.orderId': { $in: orderIds } });

        if (userIds.length) {
          conditions.push({ userId: { $in: userIds } });

          const users = await User.find({ _id: { $in: userIds } }).select('email').lean();
          const emails = users
            .map((u) => (u.email || '').trim().toLowerCase())
            .filter(Boolean);
          if (emails.length) conditions.push({ email: { $in: emails } });
        }
      }
    } catch (err) {
      console.error('[lead-search] Erreur résolution commande :', err && err.message ? err.message : err);
    }
  }

  return conditions;
}

module.exports = {
  escapeRegExp,
  buildPhoneRegExp,
  buildLeadSearchConditions,
};
