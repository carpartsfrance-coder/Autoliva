/**
 * SUPPRESSION DÉFINITIVE des doublons de moteurs d'occasion ACR (1 fiche gardée par code moteur).
 *
 * SÉCURITÉ :
 *  - Supprime UNIQUEMENT les SKU listés dans KEEP_FILE.losers (les 786 doublons).
 *  - Ne touche JAMAIS aux gardiennes (KEEP_FILE.keepers) — double garde explicite.
 *  - Ne touche qu'aux produits sku ^AUTO- + category "Moteurs d'occasion".
 *  - DRY-RUN PAR DÉFAUT : ne supprime rien tant que `--confirm` n'est pas passé.
 *
 * Usage :
 *   KEEP_FILE=/Users/killianbelabbes/Documents/Moteur/_dedup.json node scripts/delete-acr-dupes.js            # dry-run
 *   KEEP_FILE=/Users/killianbelabbes/Documents/Moteur/_dedup.json node scripts/delete-acr-dupes.js --confirm  # supprime
 */
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const Product = require('../src/models/Product');

const CONFIRM = process.argv.includes('--confirm');
const KEEP_FILE = process.env.KEEP_FILE;

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI manquant (.env)');
  if (!KEEP_FILE) throw new Error('KEEP_FILE manquant (chemin vers _dedup.json)');

  const j = JSON.parse(fs.readFileSync(KEEP_FILE, 'utf8'));
  const losers = (j.losers || []).map((s) => String(s).trim()).filter(Boolean);
  const keepers = new Set((j.keepers || []).map((s) => String(s).trim()).filter(Boolean));
  if (!losers.length) throw new Error('Aucun "losers" dans KEEP_FILE');
  // Double garde : on retire de la liste à supprimer tout SKU qui serait aussi gardien.
  const toDelete = losers.filter((s) => !keepers.has(s));

  await mongoose.connect(uri);
  console.log('MongoDB :', uri.replace(/\/\/[^@]*@/, '//***@').slice(0, 55), '…');

  const filter = { sku: { $in: toDelete }, category: "Moteurs d'occasion" };
  const found = await Product.countDocuments(filter);
  const publishedAmong = await Product.countDocuments({ ...filter, isPublished: true });
  console.log(`Doublons ciblés (losers, hors gardiennes) : ${toDelete.length}`);
  console.log(`Trouvés en base : ${found} · dont publiés : ${publishedAmong}`);
  console.log(`Gardiennes protégées : ${keepers.size} (jamais supprimées)`);

  if (!CONFIRM) {
    console.log('\n🔒 DRY-RUN — rien supprimé. Relance avec --confirm pour supprimer définitivement.');
    await mongoose.disconnect();
    return;
  }
  const res = await Product.deleteMany(filter);
  const restAcr = await Product.countDocuments({ sku: /^AUTO-/, category: "Moteurs d'occasion" });
  console.log(`\n🗑️  Supprimés : ${res.deletedCount} · fiches ACR restantes : ${restAcr} (attendu ${keepers.size})`);
  console.log('Note : les photos GridFS des fiches supprimées deviennent orphelines (nettoyage possible plus tard).');
  await mongoose.disconnect();
}

main().catch((e) => { console.error('ERREUR:', e.message); process.exit(1); });
