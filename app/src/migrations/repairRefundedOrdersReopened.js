'use strict';

/**
 * Migration ONE-SHOT : remet le bon statut sur les commandes que le site avait
 * renvoyées « En préparation » par erreur (bug corrigé le 08/11/2026 dans
 * checkoutController : un rappel de Mollie après un remboursement repassait la
 * commande en préparation, car le paiement y reste « paid »).
 *
 * Ne touche QUE les commandes dont :
 *   - le statut actuel est « processing » ;
 *   - les deux DERNIÈRES entrées d'historique sont celles du bug : « paid » par
 *     mollie (ou scalapay), puis « processing » par system (« Passage
 *     automatique en préparation après paiement ») ;
 *   - l'entrée juste avant est « refunded » (remboursement total) ou
 *     « label_created » (étiquette créée, déplacée par la même règle).
 * Une commande que l'équipe a fait avancer depuis a une entrée d'historique
 * plus récente : elle n'est pas touchée. Les remboursements partiels non plus
 * (la pièce peut encore devoir partir) : à regarder à la main.
 *
 * La date de paiement (molliePaidAt), réécrite par le même bug, reprend celle
 * du premier paiement (première entrée « paid » par mollie).
 *
 * Idempotente + marqueur (une seule exécution). Non bloquante.
 * Appelée au démarrage (server.js) après la connexion MongoDB.
 */

const MARKER_KEY = 'repair-orders-reopened-by-payment-webhook-v1';
const NOTE_BUG = 'Passage automatique en préparation après paiement';
const STATUTS_A_RETABLIR = ['refunded', 'label_created'];

/* Le statut à rétablir si l'historique se termine par le bug, sinon null. */
function statutAvantLeBug(historique) {
  const h = Array.isArray(historique) ? historique : [];
  const n = h.length;
  if (n < 3) return null;
  const dernier = h[n - 1];
  const paye = h[n - 2];
  const avant = h[n - 3];
  const estBug = dernier && dernier.status === 'processing' && dernier.changedBy === 'system' && dernier.note === NOTE_BUG
    && paye && paye.status === 'paid' && (paye.changedBy === 'mollie' || paye.changedBy === 'scalapay');
  if (!estBug || !avant || !STATUTS_A_RETABLIR.includes(avant.status)) return null;
  return avant.status;
}

async function repairRefundedOrdersReopened(connection) {
  try {
    const db = connection && connection.db ? connection.db : null;
    if (!db) return;

    const markers = db.collection('migrationsapplied');
    const already = await markers.findOne({ key: MARKER_KEY });
    if (already) return;

    const orders = db.collection('orders');
    const candidates = await orders.find(
      { status: 'processing', 'statusHistory.status': { $in: STATUTS_A_RETABLIR } },
      { projection: { _id: 1, number: 1, statusHistory: 1, molliePaidAt: 1 } }
    ).toArray();

    const repaired = [];
    for (const o of candidates) {
      const statut = statutAvantLeBug(o.statusHistory);
      if (!statut) continue;

      const maintenant = new Date();
      const $set = { status: statut, updatedAt: maintenant };
      const premierPaiement = (o.statusHistory || []).find((e) => e && e.status === 'paid' && e.changedBy === 'mollie' && e.changedAt);
      if (premierPaiement && o.molliePaidAt && new Date(premierPaiement.changedAt) < new Date(o.molliePaidAt)) {
        $set.molliePaidAt = new Date(premierPaiement.changedAt);
      }
      const libelle = statut === 'refunded' ? 'Remboursée' : 'Étiquette créée';
      const res = await orders.updateOne(
        { _id: o._id, status: 'processing' },
        {
          $set,
          $push: {
            statusHistory: {
              status: statut,
              changedAt: maintenant,
              changedBy: 'system',
              note: `Statut « ${libelle} » rétabli : le site l'avait remise en préparation par erreur après un rappel de Mollie (correctif du 08/11/2026).`,
            },
          },
        }
      );
      const modified = (res && (res.modifiedCount != null ? res.modifiedCount : res.nModified)) || 0;
      if (modified) repaired.push({ number: o.number || String(o._id), status: statut });
    }

    await markers.insertOne({ key: MARKER_KEY, appliedAt: new Date(), candidates: candidates.length, repaired });
    console.log(`[migration ${MARKER_KEY}] ${repaired.length} commande(s) rétablie(s) : ${repaired.map((r) => `${r.number} → ${r.status}`).join(', ') || 'aucune'}.`);
  } catch (err) {
    console.error('[migration repair-orders-reopened] échec (non bloquant) :', err && err.message ? err.message : err);
  }
}

module.exports = { repairRefundedOrdersReopened, statutAvantLeBug, MARKER_KEY };
