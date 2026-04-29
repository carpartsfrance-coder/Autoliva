const fs = require('fs');
const Order = require('../models/Order');

/**
 * Purge les commandes dans la corbeille depuis plus de 30 jours.
 *
 * Garde-fou légal : on NE purge PAS les commandes payées (statut
 * paid/processing/shipped/delivered/completed/refunded) pour respecter
 * l'obligation de conservation 10 ans des factures (Code de commerce
 * art. L123-22). Ces commandes restent dans la corbeille tant qu'un
 * admin ne clique pas explicitement sur "Supprimer définitivement".
 */
const PURGEABLE_STATUSES = ['draft', 'pending_payment', 'cancelled'];

async function purgeTrashedOrders() {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const toPurge = await Order.find({
    deletedAt: { $ne: null, $lt: thirtyDaysAgo },
    status: { $in: PURGEABLE_STATUSES },
  })
    .select('_id number documents status')
    .lean();

  // Compte les commandes bloquées pour observabilité
  const blockedCount = await Order.countDocuments({
    deletedAt: { $ne: null, $lt: thirtyDaysAgo },
    status: { $nin: PURGEABLE_STATUSES },
  });

  if (blockedCount > 0) {
    console.warn(`[purgeTrashedOrders] ${blockedCount} commande(s) payée(s) dans la corbeille > 30j non purgées (obligation comptable). Action manuelle requise.`);
  }

  if (!toPurge.length) {
    return { purged: 0, blocked: blockedCount };
  }

  let purged = 0;
  for (const order of toPurge) {
    try {
      // Nettoyer les documents attachés sur le disque
      if (Array.isArray(order.documents)) {
        for (const doc of order.documents) {
          if (doc && doc.storedPath && fs.existsSync(doc.storedPath)) {
            try {
              fs.unlinkSync(doc.storedPath);
            } catch (unlinkErr) {
              console.warn(`[purgeTrashedOrders] Erreur suppression fichier ${doc.storedPath}:`, unlinkErr.message || unlinkErr);
            }
          }
        }
      }

      await Order.deleteOne({ _id: order._id });
      purged += 1;
      console.log(`[purgeTrashedOrders] Purgée : ${order.number || order._id} (statut ${order.status})`);
    } catch (err) {
      console.error(`[purgeTrashedOrders] Erreur purge ${order.number || order._id}:`, err.message || err);
    }
  }

  if (purged > 0) {
    console.log(`[purgeTrashedOrders] ${purged} commande(s) supprimée(s) définitivement après J+30.`);
  }

  return { purged, blocked: blockedCount };
}

module.exports = { purgeTrashedOrders };
