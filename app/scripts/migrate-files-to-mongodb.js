#!/usr/bin/env node
// ---------------------------------------------------------------------------
// migrate-files-to-mongodb.js
// Migre les fichiers PDF stockés sur disque (uploads/shipping-docs/ et
// uploads/order-docs/) vers MongoDB (champ fileData Buffer).
//
// Cela permet de survivre aux redéploiements sur Render (filesystem éphémère).
//
// Usage :  node scripts/migrate-files-to-mongodb.js [--dry-run] [--apply]
//
// --dry-run : affiche ce qui serait fait, sans modifier la base (défaut)
// --apply   : exécute réellement les modifications
// ---------------------------------------------------------------------------

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const mongoose = require('mongoose');

const DRY_RUN = !process.argv.includes('--apply');

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI non défini dans .env');
    process.exit(1);
  }

  console.log(DRY_RUN ? '=== MODE DRY-RUN (aucune modification) ===' : '=== MODE APPLY ===');
  console.log('');

  await mongoose.connect(mongoUri);
  console.log('MongoDB connectée.');

  const Order = require('../src/models/Order');
  const db = mongoose.connection.db;
  const ordersCollection = db.collection('orders');

  let shipmentsMigrated = 0;
  let shipmentsSkipped = 0;
  let shipmentsAlreadyDone = 0;
  let shipmentsFailed = 0;

  let docsMigrated = 0;
  let docsSkipped = 0;
  let docsAlreadyDone = 0;
  let docsFailed = 0;

  // ─── 1. Migrate shipment documents ───
  console.log('--- Shipment documents (uploads/shipping-docs/) ---');

  const ordersWithShipments = await ordersCollection.find(
    { 'shipments.document.storedPath': { $exists: true, $ne: '' } },
    { projection: { _id: 1, number: 1, shipments: 1 } }
  ).toArray();

  console.log(`Commandes avec shipments à vérifier : ${ordersWithShipments.length}`);

  for (const order of ordersWithShipments) {
    if (!Array.isArray(order.shipments)) continue;

    for (const shipment of order.shipments) {
      if (!shipment.document || !shipment.document.storedPath) continue;

      const filePath = shipment.document.storedPath;

      // Already migrated?
      if (shipment.document.fileData) {
        shipmentsAlreadyDone++;
        continue;
      }

      if (!fs.existsSync(filePath)) {
        console.log(`  [SKIP] Commande ${order.number || order._id} - shipment ${shipment._id} : fichier introuvable (${filePath})`);
        shipmentsSkipped++;
        continue;
      }

      try {
        const fileBuffer = fs.readFileSync(filePath);
        console.log(`  [OK] Commande ${order.number || order._id} - shipment ${shipment._id} : ${filePath} (${(fileBuffer.length / 1024).toFixed(1)} KB)`);

        if (!DRY_RUN) {
          await ordersCollection.updateOne(
            { _id: order._id, 'shipments._id': shipment._id },
            { $set: { 'shipments.$.document.fileData': fileBuffer } }
          );
        }
        shipmentsMigrated++;
      } catch (err) {
        console.error(`  [ERR] Commande ${order.number || order._id} - shipment ${shipment._id} : ${err.message}`);
        shipmentsFailed++;
      }
    }
  }

  console.log('');
  console.log(`Shipments : ${shipmentsMigrated} migrés, ${shipmentsAlreadyDone} déjà faits, ${shipmentsSkipped} fichiers manquants, ${shipmentsFailed} erreurs`);

  // ─── 2. Migrate order documents ───
  console.log('');
  console.log('--- Order documents (uploads/order-docs/) ---');

  const ordersWithDocs = await ordersCollection.find(
    { 'documents.storedPath': { $exists: true, $ne: '' } },
    { projection: { _id: 1, number: 1, documents: 1 } }
  ).toArray();

  console.log(`Commandes avec documents à vérifier : ${ordersWithDocs.length}`);

  for (const order of ordersWithDocs) {
    if (!Array.isArray(order.documents)) continue;

    for (const doc of order.documents) {
      if (!doc.storedPath) continue;

      const filePath = doc.storedPath;

      // Already migrated?
      if (doc.fileData) {
        docsAlreadyDone++;
        continue;
      }

      if (!fs.existsSync(filePath)) {
        console.log(`  [SKIP] Commande ${order.number || order._id} - doc ${doc._id} (${doc.docType || 'autre'}) : fichier introuvable (${filePath})`);
        docsSkipped++;
        continue;
      }

      try {
        const fileBuffer = fs.readFileSync(filePath);
        console.log(`  [OK] Commande ${order.number || order._id} - doc ${doc._id} (${doc.docType || 'autre'}) : ${filePath} (${(fileBuffer.length / 1024).toFixed(1)} KB)`);

        if (!DRY_RUN) {
          await ordersCollection.updateOne(
            { _id: order._id, 'documents._id': doc._id },
            { $set: { 'documents.$.fileData': fileBuffer } }
          );
        }
        docsMigrated++;
      } catch (err) {
        console.error(`  [ERR] Commande ${order.number || order._id} - doc ${doc._id} : ${err.message}`);
        docsFailed++;
      }
    }
  }

  console.log('');
  console.log(`Documents : ${docsMigrated} migrés, ${docsAlreadyDone} déjà faits, ${docsSkipped} fichiers manquants, ${docsFailed} erreurs`);

  // ─── Résumé ───
  console.log('');
  console.log('=== RÉSUMÉ ===');
  console.log(`Total migrés     : ${shipmentsMigrated + docsMigrated}`);
  console.log(`Déjà en base     : ${shipmentsAlreadyDone + docsAlreadyDone}`);
  console.log(`Fichiers absents : ${shipmentsSkipped + docsSkipped}`);
  console.log(`Erreurs          : ${shipmentsFailed + docsFailed}`);

  if (DRY_RUN && (shipmentsMigrated + docsMigrated) > 0) {
    console.log('');
    console.log('>>> Relancez avec --apply pour effectuer la migration.');
  }

  await mongoose.disconnect();
  console.log('');
  console.log('Terminé.');
}

main().catch((err) => {
  console.error('Erreur fatale :', err);
  process.exit(1);
});
