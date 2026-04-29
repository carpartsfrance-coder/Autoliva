#!/usr/bin/env node
/**
 * Supprime le champ `options` de tous les produits
 * dont la catégorie fait partie des transmissions.
 *
 * Usage :
 *   MONGODB_URI="mongodb+srv://..." node app/src/seed/removeTransmissionOptions.js
 *
 * Ajoutez --dry-run pour voir les produits concernés sans modifier la BDD.
 */

const mongoose = require('mongoose');

const TRANSMISSION_CATEGORIES = [
  'Boîte de vitesses',
  'Boîte de transfert',
  'Pont / Différentiel',
  'Mécatronique',
  'Convertisseur',
  'Embrayage',
  'Cardans',
  'Transmission',
];

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI manquant');
    process.exit(1);
  }

  const dryRun = process.argv.includes('--dry-run');

  await mongoose.connect(mongoUri);
  console.log('Connecté à MongoDB');

  const db = mongoose.connection.db;
  const col = db.collection('products');

  const filter = {
    category: { $in: TRANSMISSION_CATEGORIES },
    'options.0': { $exists: true },
  };

  const affected = await col.find(filter, { projection: { name: 1, category: 1, options: 1 } }).toArray();

  console.log(`\n${affected.length} produit(s) transmission avec des options :\n`);
  for (const p of affected) {
    const optLabels = (p.options || []).map((o) => o.label || o.key || '?').join(', ');
    console.log(`  - [${p.category}] ${p.name}  →  options: ${optLabels}`);
  }

  if (dryRun) {
    console.log('\n--dry-run : aucune modification effectuée.');
  } else {
    const result = await col.updateMany(filter, { $set: { options: [] } });
    console.log(`\n${result.modifiedCount} produit(s) mis à jour (options vidées).`);
  }

  await mongoose.disconnect();
  console.log('Déconnecté.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
