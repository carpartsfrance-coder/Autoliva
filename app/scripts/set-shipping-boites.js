/**
 * Affecte la classe de transport « Boîte de vitesses Échange standard » (89€)
 * à TOUTES les boîtes de vitesses reconditionnées (nouvelles ALV-BX + existantes).
 * Exclut occasion / neuf / transfert / ponts / moteurs.
 *
 * DRY-RUN par défaut. --apply pour écrire.
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('../src/models/Product');
const ShippingClass = require('../src/models/ShippingClass');

const APPLY = process.argv.includes('--apply');

function clsPrice(c) {
  const z = c.zonePricesCents && c.zonePricesCents.metropole;
  return Math.round(((z != null ? z : c.domicilePriceCents) || 0) / 100);
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI manquant (.env)');
  await mongoose.connect(uri);

  // 1) trouver la classe transport
  let cls = await ShippingClass.findOne({ name: 'Boîte de vitesses Échange standard' }).lean();
  if (!cls) cls = await ShippingClass.findOne({ name: { $regex: /bo[iî]te.*(é|e)change\s*standard/i } }).lean();
  if (!cls) {
    console.log('❌ Classe « Boîte de vitesses Échange standard » introuvable. Classes existantes :');
    (await ShippingClass.find({}).lean()).forEach((c) => console.log(`   - "${c.name}" (${clsPrice(c)}€)`));
    await mongoose.disconnect();
    return;
  }
  console.log(`Classe transport : « ${cls.name} » = ${clsPrice(cls)}€  (id ${cls._id})`);
  if (clsPrice(cls) !== 89) console.log(`   ⚠ prix ${clsPrice(cls)}€ (attendu 89€) — vérifie que c'est la bonne classe.`);

  // 2) cible : boîtes de vitesses reconditionnées (pas occasion/neuf/transfert/pont/moteur)
  const filter = {
    category: { $regex: /bo[iî]te de vitesses/i },
    $nor: [
      { category: { $regex: /transfert|pont|moteur|occasion|neuf/i } },
      { 'badges.condition': { $regex: /occasion|neuf/i } },
      { name: { $regex: /occasion/i } },
    ],
  };
  const total = await Product.countDocuments(filter);
  const already = await Product.countDocuments({ ...filter, shippingClassId: cls._id });
  console.log(`\nBoîtes reconditionnées ciblées : ${total} | déjà sur cette classe : ${already} | à changer : ${total - already}`);

  // répartition par catégorie (contrôle)
  const byCat = await Product.aggregate([{ $match: filter }, { $group: { _id: '$category', n: { $sum: 1 } } }, { $sort: { n: -1 } }]);
  byCat.forEach((r) => console.log(`   ${String(r.n).padStart(5)}  ${r._id}`));

  if (!APPLY) { console.log('\n🟢 DRY-RUN — rien modifié. Relance avec --apply.'); await mongoose.disconnect(); return; }
  const res = await Product.updateMany(filter, { $set: { shippingClassId: cls._id } });
  console.log(`\n✅ shippingClassId affecté à ${res.modifiedCount} boîtes.`);
  await mongoose.disconnect();
}
main().catch((e) => { console.error('ERREUR:', e.message); process.exit(1); });
