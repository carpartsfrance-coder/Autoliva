const Order = require('../models/Order');
const { reconcileScalapayOrder } = require('../controllers/checkoutController');

/**
 * Job de réconciliation Scalapay.
 *
 * Scanne toutes les commandes Scalapay qui ne sont pas encore capturées
 * (pas de scalapayCapturedAt) et qui pourraient avoir été autorisées sans
 * que la capture ne soit déclenchée (typiquement quand le client n'est pas
 * revenu sur le site après avoir validé son paiement).
 *
 * Pour chaque commande :
 *  - on interroge l'API Scalapay pour le statut courant
 *  - si la commande est 'approved'/'charged', on déclenche la capture
 *  - on met à jour la commande en BDD
 *
 * On ignore les commandes trop vieilles (>30 jours) car les autorisations
 * Scalapay expirent au bout d'environ 28 jours et toute tentative de
 * capture échouera.
 *
 * On ignore aussi les commandes trop récentes (<2 minutes) pour laisser le
 * temps au flux normal de retour client de capturer.
 */
async function reconcileScalapayOrders() {
  const now = new Date();
  const minAge = new Date(now.getTime() - 2 * 60 * 1000); // au moins 2 min
  const maxAge = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000); // au plus 30 jours

  // Cibles : commandes Scalapay non capturées, créées entre maxAge et minAge
  const candidates = await Order.find({
    paymentProvider: 'scalapay',
    scalapayOrderToken: { $exists: true, $ne: '' },
    scalapayCapturedAt: null,
    paymentStatus: { $in: ['pending', 'paid'] },
    status: { $nin: ['cancelled', 'refunded', 'completed'] },
    createdAt: { $gte: maxAge, $lte: minAge },
  })
    .sort({ createdAt: 1 })
    .limit(50)
    .lean();

  if (candidates.length === 0) {
    return { scanned: 0, captured: 0, errors: 0, stillPending: 0 };
  }

  console.log(`[reconcileScalapayOrders] ${candidates.length} commande(s) Scalapay à vérifier.`);

  let captured = 0;
  let errors = 0;
  let stillPending = 0;

  for (const order of candidates) {
    try {
      const result = await reconcileScalapayOrder(order, { wasCancelled: false });
      if (!result.ok) {
        errors++;
        console.error(
          `[reconcileScalapayOrders] Commande ${order.number || order._id} : ${result.error} ${result.errorMessage || ''}`
        );
        continue;
      }
      if (result.captured) {
        captured++;
        console.log(`[reconcileScalapayOrders] Commande ${order.number || order._id} : capturée avec succès.`);
      } else {
        stillPending++;
      }
    } catch (err) {
      errors++;
      console.error(
        `[reconcileScalapayOrders] Exception sur commande ${order.number || order._id} :`,
        err && err.message ? err.message : err
      );
    }

    // petit délai pour ne pas saturer l'API Scalapay
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  console.log(
    `[reconcileScalapayOrders] Terminé : ${candidates.length} scannée(s), ${captured} capturée(s), ${stillPending} encore en attente, ${errors} erreur(s).`
  );

  return { scanned: candidates.length, captured, errors, stillPending };
}

module.exports = { reconcileScalapayOrders };
