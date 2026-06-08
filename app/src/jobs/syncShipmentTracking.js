'use strict';
const Order = require('../models/Order');
const jumingo = require('../services/jumingo');

/**
 * Synchronisation des statuts d'expédition depuis JUMiNGO.
 *
 * Pour chaque commande « Étiquette créée » (et les « Expédiée » récentes, pour
 * corriger le backlog), on interroge le suivi Jumingo via le numéro de tracking
 * et on fait avancer le statut au DÉPART RÉEL (scan transporteur) :
 *   - Jumingo pickup/transit  → la commande passe « Étiquette créée » → « Expédiée »
 *     (c'est CE moment qui démarre le délai de retour 30 j, cf. hook Order).
 *   - Jumingo delivered       → « Livrée ».
 *   - Jumingo « new » (étiquette créée, pas prise en charge) sur une commande
 *     marquée « Expédiée » à tort (backlog) → on rétablit « Étiquette créée »
 *     et on réinitialise le délai de retour.
 *
 * Sécurités :
 *   - ne tourne QUE si JUMINGO_API_KEY est définie ET JUMINGO_SYNC_ENABLED=true
 *     (permet de valider via scripts/jumingo-probe.js avant d'activer) ;
 *   - ne rétablit « Expédiée → Étiquette créée » que sur un statut brut EXACT
 *     « new » (jamais « notfound », ambigu = suivi expiré) et sur des commandes
 *     récentes → on n'inverse pas par erreur de vieilles commandes livrées.
 */
function isSyncEnabled() {
  return jumingo.isEnabled() && String(process.env.JUMINGO_SYNC_ENABLED || '').trim().toLowerCase() === 'true';
}

/** Dernier numéro de suivi (envoi le plus récent) d'une commande. */
function latestTrackingNumber(order) {
  const shipments = Array.isArray(order.shipments) ? order.shipments : [];
  const withTn = shipments
    .filter((s) => s && s.trackingNumber && String(s.trackingNumber).trim()
      && s.label !== 'Récupération clonage')
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
  return withTn.length ? String(withTn[0].trackingNumber).trim() : '';
}

async function syncShipmentTracking({ limit = 80, force = false } = {}) {
  if (!jumingo.isEnabled()) return { skipped: true, reason: 'JUMINGO_API_KEY absente' };
  if (!force && !isSyncEnabled()) return { skipped: true, reason: 'JUMINGO_SYNC_ENABLED != true' };

  // Garde-fou backlog : on se base sur la date de l'ÉTIQUETTE (dernier suivi),
  // PAS sur la date de commande — une vieille commande peut être étiquetée
  // aujourd'hui (étiquette récente = candidate légitime).
  const recentCutoff = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000); // 60 j sur la date d'étiquette
  const candidates = await Order.find({
    $or: [
      { status: 'label_created' },
      { status: 'shipped', 'shipments.createdAt': { $gte: recentCutoff } },
    ],
    'shipments.0': { $exists: true },
    orderType: { $ne: 'exchange_cloning' }, // le clonage garde son flux propre
    archived: { $ne: true },
    deletedAt: null,
  })
    .sort({ updatedAt: 1 })
    .limit(limit);

  const out = { scanned: candidates.length, toShipped: 0, toDelivered: 0, revertedToLabel: 0, unchanged: 0, errors: 0 };

  for (const order of candidates) {
    const tn = latestTrackingNumber(order);
    if (!tn) { out.unchanged++; continue; }
    try {
      const r = await jumingo.getTrackingStatus(tn);
      if (!r.ok || !r.found) { out.unchanged++; continue; }
      const raw = String(r.rawStatus || '').toLowerCase();
      const cur = order.status;
      let next = null;

      if (r.status === 'shipped' && cur === 'label_created') {
        next = 'shipped';
      } else if (r.status === 'delivered' && (cur === 'label_created' || cur === 'shipped')) {
        next = 'delivered';
      } else if (raw === 'new' && cur === 'shipped') {
        // Backlog : « Expédiée » alors que l'étiquette n'a pas encore été scannée.
        next = 'label_created';
        if (order.returnDates) order.returnDates.returnDueDate = null; // repart au vrai départ
      }

      if (!next || next === cur) { out.unchanged++; continue; }

      order.status = next;
      order._statusChangedBy = 'jumingo-sync';
      order._statusChangeNote = `Suivi Jumingo synchronisé (statut transporteur : ${r.rawStatus || '—'})`;
      await order.save();

      if (next === 'shipped') out.toShipped++;
      else if (next === 'delivered') out.toDelivered++;
      else if (next === 'label_created') out.revertedToLabel++;
    } catch (e) {
      out.errors++;
      console.error('[jumingo-sync] commande', String(order._id), '→', e && e.message ? e.message : e);
    }
  }

  console.log('[jumingo-sync]', JSON.stringify(out));
  return out;
}

module.exports = { syncShipmentTracking, latestTrackingNumber, isSyncEnabled };
