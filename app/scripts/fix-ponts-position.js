/**
 * CORRECTIF : re-classe les produits pont en avant/arrière avec une logique
 * POSITIONNELLE STRICTE (slug + nom uniquement, jamais la description — car
 * « avant » y signifie souvent « before », ce qui avait tout envoyé en avant).
 *
 * Position :
 *   - slug contient un token « avant/front » ou « arriere/rear »  → priorité (slug = propre)
 *   - sinon nom : « pont/différentiel/essieu/train + avant|arrière » (proximité)
 *   - sinon AMBIGU → arrière par défaut (les différentiels sont majoritairement arrière) + listé
 *
 * SÉCURITÉ : dry-run par défaut. --apply pour écrire.
 *   node scripts/fix-ponts-position.js
 *   node scripts/fix-ponts-position.js --apply
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('../src/models/Product');
const Category = require('../src/models/Category');

const APPLY = process.argv.includes('--apply');
const NAME_AR = 'Pont / Différentiel arrière';
const NAME_AV = 'Pont / Différentiel avant';

// Intrus : boîtes de transfert / renvoi d'angle mal rangées en pont
const isTransfert = (p) => /transfert|renvoi\s*d?[' ]?angle/i.test(`${p.name || ''} ${p.slug || ''}`);

function positionOf(p) {
  const slug = String(p.slug || '').toLowerCase();
  const name = String(p.name || '').toLowerCase();
  // 1) slug (propre, tokens séparés par tirets)
  const sav = /(^|[-\s])(avant|front)([-\s]|$)/.test(slug);
  const sar = /(^|[-\s])(arri[èe]re|rear)([-\s]|$)/.test(slug);
  if (sar && !sav) return 'arriere';
  if (sav && !sar) return 'avant';
  // 2) nom : avant/arrière EN PROXIMITÉ de pont/différentiel/essieu/train
  const nav = /(pont|diff[ée]rentiel|essieu|train)[^.]{0,12}(avant|front)|(avant|front)[^.]{0,12}(pont|diff[ée]rentiel|essieu)/.test(name);
  const nar = /(pont|diff[ée]rentiel|essieu|train)[^.]{0,12}(arri[èe]re|rear)|(arri[èe]re|rear)[^.]{0,12}(pont|diff[ée]rentiel|essieu)/.test(name);
  if (nar && !nav) return 'arriere';
  if (nav && !nar) return 'avant';
  return null; // ambigu
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI manquant (.env)');
  await mongoose.connect(uri);
  console.log('MongoDB :', uri.replace(/\/\/[^@]*@/, '//***@').slice(0, 50), '…');
  console.log(`Mode ${APPLY ? '🔴 APPLY' : '🟢 DRY-RUN'}\n`);

  const all = await Product.find({ category: { $regex: /pont|diff[ée]rentiel/i } })
    .select('name slug category sku').lean();
  // sortir les boîtes de transfert (intrus)
  const transfert = all.filter(isTransfert);
  const prods = all.filter((p) => !isTransfert(p));
  console.log(`Produits matchés : ${all.length}  (dont ${transfert.length} boîtes de transfert à sortir)`);

  // catégorie transfert cible (top-level, sans « > » : préserve le slug SEO)
  const transfertCat = (await Category.find({ name: { $regex: /bo[iî]te.*transfert/i } }).lean())
    .filter((c) => !String(c.name).includes('>')).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0))[0];
  const NAME_TR = transfertCat ? transfertCat.name : null;

  const res = { avant: [], arriere: [], ambigu: [] };
  for (const p of prods) {
    const pos = positionOf(p);
    if (pos === 'avant') res.avant.push(p);
    else if (pos === 'arriere') res.arriere.push(p);
    else { res.ambigu.push(p); res.arriere.push(p); }
  }
  console.log(`\nAprès correctif :`);
  console.log(`  → « ${NAME_AV} » : ${res.avant.length}`);
  console.log(`  → « ${NAME_AR} » : ${res.arriere.length}  (dont ${res.ambigu.length} ambigus → arrière par défaut)`);
  console.log(`  → « ${NAME_TR || '⚠ catégorie transfert INTROUVABLE'} » : ${transfert.length} (intrus sortis du pont)`);
  transfert.forEach((p) => console.log(`       [${p.sku || '—'}] ${String(p.name).slice(0, 60)}`));

  // ce qui CHANGE vs l'état actuel
  const willChange = prods.filter((p) => {
    const target = res.avant.includes(p) ? NAME_AV : NAME_AR;
    return p.category !== target;
  });
  console.log(`\nProduits qui CHANGENT de catégorie vs état actuel : ${willChange.length}`);

  console.log(`\n⚠ ${res.ambigu.length} AMBIGUS (→ arrière par défaut, À VÉRIFIER manuellement) :`);
  res.ambigu.slice(0, 50).forEach((p) => console.log(`   [${p.sku || '—'}] ${String(p.name).slice(0, 62)}  | slug=${String(p.slug).slice(0, 30)}`));
  if (res.ambigu.length > 50) console.log(`   … +${res.ambigu.length - 50} autres`);

  console.log(`\n=== échantillon classés AVANT (à contrôler) ===`);
  res.avant.slice(0, 20).forEach((p) => console.log(`   ${String(p.name).slice(0, 60)}  | slug=${String(p.slug).slice(0, 30)}`));

  if (!APPLY) { console.log('\n🟢 DRY-RUN — rien modifié. Relance avec --apply.'); await mongoose.disconnect(); return; }

  let nAv = 0, nAr = 0, nTr = 0;
  for (const p of res.avant) { await Product.updateOne({ _id: p._id }, { $set: { category: NAME_AV } }); nAv++; }
  for (const p of res.arriere) { await Product.updateOne({ _id: p._id }, { $set: { category: NAME_AR } }); nAr++; }
  if (NAME_TR) { for (const p of transfert) { await Product.updateOne({ _id: p._id }, { $set: { category: NAME_TR } }); nTr++; } }
  console.log(`\n🔴 CORRIGÉ : ${nAv} → avant, ${nAr} → arrière, ${nTr} → transfert.`);
  await mongoose.disconnect();
}
main().catch((e) => { console.error('ERREUR:', e.message); process.exit(1); });
