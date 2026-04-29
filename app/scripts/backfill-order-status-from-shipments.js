// ---------------------------------------------------------------------------
// backfill-order-status-from-shipments.js
//
// Met à jour le statut des commandes qui ont au moins un shipments[].trackingNumber
// mais dont le statut est encore 'paid' ou 'processing'. Les passe en 'shipped'.
//
// Usage :
//   node scripts/backfill-order-status-from-shipments.js          # dry-run (lecture seule)
//   node scripts/backfill-order-status-from-shipments.js --apply  # applique les changements
//
// Les commandes clonage (orderType='exchange_cloning') ne sont basculées que si
// cloningStatus === 'cloning_done', pour respecter la logique métier.
// ---------------------------------------------------------------------------

require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');

(async () => {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI manquant.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  const Order = require('../src/models/Order');

  const candidates = await Order.find({
    status: { $in: ['paid', 'processing'] },
    'shipments.0': { $exists: true },
  }).select('_id number status orderType cloningStatus shipments');

  console.log(`[backfill] ${candidates.length} commande(s) candidate(s)`);
  console.log(`[backfill] mode : ${APPLY ? 'APPLY (écriture)' : 'DRY-RUN (lecture seule)'}\n`);

  let toUpdate = 0;
  let skipped = 0;
  const updated = [];

  for (const order of candidates) {
    const hasTracking = (order.shipments || []).some((s) => s && s.trackingNumber && String(s.trackingNumber).trim());
    if (!hasTracking) {
      skipped++;
      continue;
    }

    const isClonage = order.orderType === 'exchange_cloning';
    if (isClonage && order.cloningStatus !== 'cloning_done') {
      console.log(`  SKIP ${order.number} — clonage en cours (cloningStatus=${order.cloningStatus || 'null'})`);
      skipped++;
      continue;
    }

    toUpdate++;
    const trackingNumbers = order.shipments.map((s) => s.trackingNumber).filter(Boolean);
    console.log(`  ${APPLY ? 'UPDATE' : 'WOULD UPDATE'} ${order.number} : ${order.status} → shipped (suivis: ${trackingNumbers.join(', ')})`);

    if (APPLY) {
      order.status = 'shipped';
      order._statusChangedBy = 'system:backfill';
      order._statusChangeNote = 'Backfill : shipment(s) avec tracking présents, statut aligné sur expédié';
      try {
        await order.save();
        updated.push(order.number);
      } catch (err) {
        console.error(`    ERREUR save ${order.number} :`, err && err.message ? err.message : err);
      }
    }
  }

  console.log(`\n[backfill] résumé :`);
  console.log(`  candidates analysées : ${candidates.length}`);
  console.log(`  à mettre à jour      : ${toUpdate}`);
  console.log(`  ignorées             : ${skipped}`);
  if (APPLY) {
    console.log(`  effectivement mises à jour : ${updated.length}`);
  } else {
    console.log(`\n  Pour appliquer : node scripts/backfill-order-status-from-shipments.js --apply`);
  }

  await mongoose.disconnect();
})().catch((err) => {
  console.error('[backfill] erreur fatale :', err);
  process.exit(1);
});
