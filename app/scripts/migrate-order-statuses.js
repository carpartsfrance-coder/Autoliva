#!/usr/bin/env node
// ---------------------------------------------------------------------------
// migrate-order-statuses.js
// Migre les commandes des anciens statuts (en_attente, validee, expediee,
// livree, annulee) vers les nouveaux (pending_payment, paid, processing,
// shipped, delivered, completed, cancelled, refunded).
//
// Par défaut la plupart des commandes CPF sont des échanges standard,
// donc orderType est initialisé à 'exchange'.
// Les commandes avec consigne.lines renseignées gardent 'exchange'.
// Les commandes sans consigne sont marquées 'standard'.
//
// Usage :  node scripts/migrate-order-statuses.js [--dry-run] [--apply]
//
// --dry-run : affiche ce qui serait fait, sans modifier la base
// --apply   : exécute réellement les modifications
// Sans argument : dry-run par défaut
// ---------------------------------------------------------------------------

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const DRY_RUN = !process.argv.includes('--apply');

// Map ancien statut → nouveau statut
const STATUS_MAP = {
  en_attente: 'pending_payment',
  validee: 'processing',    // validee = payée et en préparation → processing
  expediee: 'shipped',
  livree: 'delivered',
  annulee: 'cancelled',
  draft: 'draft',           // inchangé
  // New statuses that may already exist but miss orderType
  paid: 'paid',
  pending_payment: 'pending_payment',
  processing: 'processing',
  shipped: 'shipped',
  delivered: 'delivered',
  completed: 'completed',
  cancelled: 'cancelled',
  refunded: 'refunded',
};

// Map ancien statusHistory entry → nouveau
const HISTORY_STATUS_MAP = {
  en_attente: 'pending_payment',
  validee: 'paid',          // dans l'historique, validee = paiement OK
  expediee: 'shipped',
  livree: 'delivered',
  annulee: 'cancelled',
  draft: 'draft',
};

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
const stats = {
  total: 0,
  alreadyMigrated: 0,
  migrated: 0,
  skipped: 0,
  errors: 0,
  byOldStatus: {},
  byNewOrderType: { standard: 0, exchange: 0, exchange_cloning: 0 },
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI non défini.');
    process.exit(1);
  }

  await mongoose.connect(mongoUri);
  console.log('MongoDB connectée.');
  console.log(DRY_RUN ? '🔍 MODE DRY-RUN (aucune modification)\n' : '🚀 MODE APPLY (modifications réelles)\n');

  // Use raw collection to bypass Mongoose enum validation on old values
  const collection = mongoose.connection.db.collection('orders');
  const cursor = collection.find({});

  while (await cursor.hasNext()) {
    const doc = await cursor.next();
    stats.total++;

    const oldStatus = doc.status;
    const newStatuses = ['draft', 'pending_payment', 'paid', 'processing', 'shipped', 'delivered', 'completed', 'cancelled', 'refunded'];

    // Skip already-migrated orders
    if (newStatuses.includes(oldStatus) && doc.orderType) {
      stats.alreadyMigrated++;
      continue;
    }

    // Determine new status
    const newStatus = STATUS_MAP[oldStatus];
    if (!newStatus) {
      console.warn(`  ⚠ Commande ${doc.number || doc._id}: statut inconnu "${oldStatus}" — skip`);
      stats.skipped++;
      continue;
    }

    stats.byOldStatus[oldStatus] = (stats.byOldStatus[oldStatus] || 0) + 1;

    // Determine orderType
    // If order has consigne lines → exchange standard
    // If no consigne → standard
    const hasConsigne = doc.consigne
      && Array.isArray(doc.consigne.lines)
      && doc.consigne.lines.length > 0;
    const orderType = hasConsigne ? 'exchange' : 'standard';
    stats.byNewOrderType[orderType]++;

    // Determine returnStatus for exchange orders
    let returnStatus = 'not_applicable';
    if (orderType === 'exchange') {
      if (oldStatus === 'livree' || oldStatus === 'expediee') {
        // Check if consigne lines have been received
        const allReceived = hasConsigne && doc.consigne.lines.every(l => l && l.receivedAt);
        if (allReceived) {
          returnStatus = 'received';
        } else {
          // Check if overdue
          const hasOverdue = hasConsigne && doc.consigne.lines.some(l => {
            if (!l || l.receivedAt) return false;
            if (!l.dueAt) return false;
            return new Date(l.dueAt) < new Date();
          });
          returnStatus = hasOverdue ? 'overdue' : 'pending';
        }
      }
    }

    // Migrate statusHistory entries
    const oldHistory = Array.isArray(doc.statusHistory) ? doc.statusHistory : [];
    const newHistory = oldHistory.map(h => {
      if (!h) return h;
      const mappedStatus = HISTORY_STATUS_MAP[h.status] || h.status;
      return {
        ...h,
        status: mappedStatus,
      };
    });

    // If no history exists, create one entry for the current status
    if (newHistory.length === 0) {
      newHistory.push({
        status: newStatus,
        changedAt: doc.createdAt || new Date(),
        changedBy: 'migration',
        note: `Migration automatique depuis "${oldStatus}"`,
      });
    }

    // Compute returnDates for exchange orders that are shipped/delivered
    let returnDates = {};
    if (orderType === 'exchange' && (oldStatus === 'expediee' || oldStatus === 'livree')) {
      // Find the earliest consigne dueAt as returnDueDate
      if (hasConsigne) {
        const dueDates = doc.consigne.lines
          .filter(l => l && l.dueAt)
          .map(l => new Date(l.dueAt));
        if (dueDates.length > 0) {
          returnDates.returnDueDate = new Date(Math.min(...dueDates));
        }
        // If any consigne received, record that
        const receivedDates = doc.consigne.lines
          .filter(l => l && l.receivedAt)
          .map(l => new Date(l.receivedAt));
        if (receivedDates.length > 0) {
          returnDates.returnReceivedAt = new Date(Math.max(...receivedDates));
        }
      }
    }

    if (DRY_RUN) {
      console.log(`  ${doc.number || doc._id}: "${oldStatus}" → "${newStatus}" | type=${orderType} | return=${returnStatus} | history=${newHistory.length} entries`);
    } else {
      try {
        const updateSet = {
          status: newStatus,
          orderType,
          returnStatus,
          cloningStatus: null,
          statusHistory: newHistory,
        };

        if (Object.keys(returnDates).length > 0) {
          updateSet.returnDates = returnDates;
        }

        await collection.updateOne(
          { _id: doc._id },
          { $set: updateSet }
        );

        stats.migrated++;
      } catch (err) {
        console.error(`  ✗ Erreur migration ${doc.number || doc._id}:`, err.message);
        stats.errors++;
      }
    }
  }

  // Print summary
  console.log('\n═══════════════════════════════════════');
  console.log('RÉSUMÉ DE LA MIGRATION');
  console.log('═══════════════════════════════════════');
  console.log(`Total commandes scannées : ${stats.total}`);
  console.log(`Déjà migrées (skip)      : ${stats.alreadyMigrated}`);

  if (DRY_RUN) {
    console.log(`À migrer                 : ${Object.values(stats.byOldStatus).reduce((a, b) => a + b, 0)}`);
  } else {
    console.log(`Migrées avec succès      : ${stats.migrated}`);
    console.log(`Erreurs                  : ${stats.errors}`);
  }

  console.log(`Skipped (statut inconnu) : ${stats.skipped}`);
  console.log('\nPar ancien statut :');
  for (const [old, count] of Object.entries(stats.byOldStatus)) {
    console.log(`  ${old} → ${STATUS_MAP[old]} : ${count}`);
  }
  console.log('\nPar type de commande :');
  for (const [type, count] of Object.entries(stats.byNewOrderType)) {
    if (count > 0) console.log(`  ${type} : ${count}`);
  }

  if (DRY_RUN) {
    console.log('\n💡 Pour appliquer : node scripts/migrate-order-statuses.js --apply');
  }

  await mongoose.disconnect();
  process.exit(stats.errors > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('Erreur fatale :', err);
  process.exit(1);
});
