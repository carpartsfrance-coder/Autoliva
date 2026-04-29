const Order = require('../models/Order');

/**
 * Expire draft orders older than 30 days.
 * Drafts that haven't been validated within 30 days are automatically cancelled.
 */
async function expireDraftOrders() {
  const thirtyDaysAgo = new Date();
  thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

  const result = await Order.updateMany(
    {
      status: 'draft',
      createdAt: { $lt: thirtyDaysAgo },
    },
    {
      $set: { status: 'cancelled' },
      $push: {
        statusHistory: {
          status: 'cancelled',
          changedAt: new Date(),
          changedBy: 'system (draft expired)',
        },
      },
    }
  );

  if (result.modifiedCount > 0) {
    console.log(`[expireDraftOrders] ${result.modifiedCount} brouillon(s) expiré(s) et annulé(s).`);
  }

  // Also expire pending_payment orders older than 48 hours
  const fortyEightHoursAgo = new Date();
  fortyEightHoursAgo.setHours(fortyEightHoursAgo.getHours() - 48);

  const pendingResult = await Order.updateMany(
    {
      status: 'pending_payment',
      createdAt: { $lt: fortyEightHoursAgo },
    },
    {
      $set: { status: 'cancelled' },
      $push: {
        statusHistory: {
          status: 'cancelled',
          changedAt: new Date(),
          changedBy: 'system',
          note: 'Paiement non reçu sous 48h — commande annulée automatiquement',
        },
      },
    }
  );

  if (pendingResult.modifiedCount > 0) {
    console.log(`[expireDraftOrders] ${pendingResult.modifiedCount} commande(s) en attente de paiement expirée(s) (> 48h).`);
  }

  return (result.modifiedCount || 0) + (pendingResult.modifiedCount || 0);
}

module.exports = { expireDraftOrders };
