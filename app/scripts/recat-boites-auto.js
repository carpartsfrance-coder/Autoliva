/**
 * Recatégorise les boîtes de vitesses AUTOMATIQUES vers la catégorie
 * « Boîte de vitesses automatique » (pour qu'elles soient filtrables au même
 * titre que les manuelles, qui sont déjà dans « Boîte de vitesses manuelle »).
 *
 * Cible : produits dont le NOM contient « boîte … automatique » (ou l'inverse),
 * et qui ne sont pas déjà dans la bonne catégorie. Idempotent.
 *
 * Usage :
 *   node scripts/recat-boites-auto.js --dry-run   # liste sans modifier
 *   node scripts/recat-boites-auto.js             # applique
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('../src/models/Product');

const TARGET = 'Boîte de vitesses automatique';
const DRY = process.argv.includes('--dry-run');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI manquant (.env)');
  await mongoose.connect(uri);
  console.log('MongoDB :', uri.replace(/\/\/[^@]*@/, '//***@').slice(0, 55), '…');

  // Boîtes automatiques : le nom contient « boîte » (ou « boite ») ET « automatique ».
  const filter = {
    $and: [
      { name: { $regex: /bo[iî]te/i } },
      { name: { $regex: /automatique/i } },
    ],
    category: { $ne: TARGET },
  };

  const matches = await Product.find(filter).select('name category sku isPublished').lean();
  console.log(`\nÀ recatégoriser vers « ${TARGET} » : ${matches.length}`);
  const byCat = {};
  for (const p of matches) byCat[p.category || '(vide)'] = (byCat[p.category || '(vide)'] || 0) + 1;
  console.log('Catégories actuelles :', byCat);
  matches.slice(0, 12).forEach((p) => console.log(`  · [${p.category}] ${String(p.name).slice(0, 64)}`));

  if (DRY) {
    console.log('\n🔒 DRY-RUN — rien modifié. Relance sans --dry-run pour appliquer.');
    await mongoose.disconnect();
    return;
  }
  const res = await Product.updateMany(filter, { $set: { category: TARGET } });
  console.log(`\n✅ Recatégorisés : ${res.modifiedCount} → « ${TARGET} »`);
  await mongoose.disconnect();
}

main().catch((e) => { console.error('ERREUR:', e.message); process.exit(1); });
