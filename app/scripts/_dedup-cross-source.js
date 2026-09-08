/** Dé-doublonnage INTER-SOURCES : pour chaque code publié par la source GAGNANTE,
 *  dé-publie les fiches de la source PERDANTE qui portent le même code.
 *  Lecture seule tant qu'on ne passe pas --apply.
 *  Ex. Dekram gagne sur ASY :  WINNER=DEK-  LOSER=ASY-  node scripts/_dedup-cross-source.js [--apply]
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('../src/models/Product');

const norm = (c) => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const APPLY = process.argv.includes('--apply');
const WINNER = process.env.WINNER_PREFIX || 'DEK-';
const LOSER = process.env.LOSER_PREFIX || 'ASY-';

// SÉCURITÉ : on ne compare QUE des boîtes de vitesses (un code 3-lettres type "DHE" existe aussi
// comme code MOTEUR → sans ce filtre on dé-publierait de vrais moteurs par collision de code).
const CAT = { category: { $regex: /bo[iî]te de vitesses/i } };

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const win = await Product.find({ sku: new RegExp('^' + WINNER), isPublished: true, ...CAT }).select('engineCode').lean();
  const winCodes = new Set(win.map((p) => norm(p.engineCode)).filter((c) => c.length >= 3));
  const losers = await Product.find({ sku: new RegExp('^' + LOSER), isPublished: true, ...CAT }).select('sku engineCode name priceCents category').lean();
  const hit = losers.filter((p) => winCodes.has(norm(p.engineCode)));
  console.log(`GAGNANT ${WINNER} : ${winCodes.size} codes publiés`);
  console.log(`PERDANT ${LOSER} : ${losers.length} publiés · à dé-publier (code déjà couvert par ${WINNER}) : ${hit.length}`);
  hit.slice(0, 12).forEach((p) => console.log(`   - ${p.sku}  ${norm(p.engineCode).toUpperCase()}  ${Math.round(p.priceCents / 100)}€  ${(p.name || '').slice(0, 45)}`));
  // garde-fou : aucune fiche "Moteur" ne doit être ici (collision de code moteur/boîte)
  const suspicious = hit.filter((p) => /moteur/i.test(p.name || ''));
  if (suspicious.length) {
    console.error(`\n⛔ ABANDON : ${suspicious.length} fiche(s) avec « Moteur » dans le nom — collision de code, on ne touche à rien.`);
    suspicious.slice(0, 5).forEach((p) => console.error('   ', p.sku, p.name));
    await mongoose.disconnect(); process.exit(2);
  }
  if (!APPLY) { console.log('\n🟢 DRY-RUN (ajoute --apply pour dé-publier). Rien écrit.'); }
  else if (hit.length) {
    const r = await Product.updateMany({ _id: { $in: hit.map((p) => p._id) } }, { $set: { isPublished: false } });
    console.log(`\n✅ dé-publiées : ${r.modifiedCount} fiches ${LOSER}`);
  }
  await mongoose.disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
