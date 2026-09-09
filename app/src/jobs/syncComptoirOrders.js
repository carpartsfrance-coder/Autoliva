'use strict';
const Order = require('../models/Order');
const comptoir = require('../services/comptoir');

/**
 * Rattrapage du connecteur Comptoir (getcomptoir.fr).
 *
 * L'envoi immédiat au paiement (checkoutController) part en arrière-plan : une
 * coupure réseau, un redémarrage Render au mauvais moment ou une commande
 * encaissée par un chemin qu'on n'a pas instrumenté la ferait disparaître du
 * tableau de bord — sans que personne ne le remarque. Ce passage horaire
 * reprend TOUTE commande encaissée qui n'a pas encore été poussée.
 *
 * Sûr par construction : Comptoir ignore un `externalId` déjà connu, donc un
 * doublon d'envoi ne crée pas de doublon de vente.
 *
 * On laisse volontairement de côté :
 *   - les commandes déjà envoyées (`comptoir.sentAt` posé) ;
 *   - celles en erreur DÉFINITIVE (400 montant invalide, 401 clé morte) — les
 *     réessayer chaque heure ne ferait que bruiter les logs ;
 *   - celles ayant épuisé MAX_ATTEMPTS tentatives ;
 *   - l'historique antérieur à la fenêtre (voir scripts/comptoir-backfill.js
 *     pour reprendre l'existant en une fois, à la mise en service).
 */

const DEFAULT_WINDOW_DAYS = 30;

async function syncComptoirOrders({ limit = 100, windowDays = DEFAULT_WINDOW_DAYS } = {}) {
  if (!comptoir.isConfigured()) return { skipped: true, reason: 'COMPTOIR_API_KEY absente' };

  const since = new Date(Date.now() - windowDays * 86400000);

  const orders = await Order.find({
    createdAt: { $gte: since },
    paymentStatus: { $in: ['paid', 'captured', 'completed'] },
    deletedAt: null,
    $or: [
      { 'comptoir.sentAt': null },
      { 'comptoir.sentAt': { $exists: false } },
    ],
    'comptoir.permanentError': { $ne: true },
    $and: [{
      $or: [
        { 'comptoir.attempts': { $lt: comptoir.MAX_ATTEMPTS } },
        { 'comptoir.attempts': { $exists: false } },
      ],
    }],
  })
    .select('_id number')
    .sort({ createdAt: 1 })
    .limit(Math.max(1, limit))
    .lean();

  const out = { candidates: orders.length, sent: 0, duplicates: 0, skipped: 0, errors: 0 };
  if (!orders.length) return out;

  for (const o of orders) {
    try {
      const r = await comptoir.syncOrder(o._id);
      if (r.ok && !r.skipped) {
        out.sent++;
        if (r.duplicate) out.duplicates++;
      } else if (r.skipped) out.skipped++;
      else out.errors++;
    } catch (e) {
      out.errors++;
      console.error('[comptoir-sync] commande', o.number || String(o._id), '→', e && e.message ? e.message : e);
    }
  }

  console.log('[comptoir-sync]', JSON.stringify(out));
  return out;
}

module.exports = { syncComptoirOrders, DEFAULT_WINDOW_DAYS };
