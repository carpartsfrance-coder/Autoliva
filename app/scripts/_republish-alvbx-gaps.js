/** Publie les ALV-BX (Eden) UNIQUEMENT pour les codes qu'aucune source qualité (DEK/ASY)
 *  ne publie déjà → comble la largeur Eden sans créer de doublon. --apply pour écrire. */
require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('../src/models/Product');

const norm = (c) => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const APPLY = process.argv.includes('--apply');
const CAT = { category: { $regex: /bo[iî]te de vitesses/i } };

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const covDocs = await Product.find({ ...CAT, isPublished: true, sku: { $regex: /^(DEK-|ASY-)/ } }).select('engineCode').lean();
  const covered = new Set(covDocs.map((p) => norm(p.engineCode)).filter((c) => c.length >= 3));
  const alv = await Product.find({ ...CAT, sku: { $regex: /^ALV-BX-/ }, isPublished: false }).select('sku engineCode name').lean();
  const seen = new Set();
  const toPub = alv.filter((p) => {
    const c = norm(p.engineCode);
    if (c.length < 3 || covered.has(c) || seen.has(c)) return false;
    seen.add(c); return true;                       // 1 seule fiche par code, jamais un code déjà couvert
  });
  console.log(`Codes déjà publiés (DEK+ASY) : ${covered.size}`);
  console.log(`ALV-BX en brouillon : ${alv.length} · à publier (comblent un trou Eden) : ${toPub.length}`);
  toPub.slice(0, 8).forEach((p) => console.log('  +', p.sku, norm(p.engineCode).toUpperCase(), (p.name || '').slice(0, 46)));
  if (APPLY && toPub.length) {
    const r = await Product.updateMany({ _id: { $in: toPub.map((p) => p._id) } }, { $set: { isPublished: true } });
    console.log(`\n✅ publiées : ${r.modifiedCount} ALV-BX`);
  } else if (!APPLY) console.log('\n🟢 DRY-RUN (--apply pour publier). Rien écrit.');
  await mongoose.disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
