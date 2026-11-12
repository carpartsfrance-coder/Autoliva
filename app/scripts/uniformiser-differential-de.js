'use strict';

/* Une notion, un mot : « …differenzial » -> « …differential » partout.
 *
 * Les deux glossaires se contredisaient — l'un disait « Differenzial » dans
 * les composés, l'autre « Differential ». Le catalogue avait tranché tout
 * seul (361 fiches en « t », zéro en « z »), mais le blog et les categories
 * gardaient les deux formes. Deux orthographes pour la meme piece, c'est deux
 * fois moins de poids sur chacune cote recherche, et un catalogue qui a l'air
 * ecrit par deux personnes qui ne se parlent pas.
 *
 * Remplacement TEXTUEL, aucun appel au modele : « ifferenzial » -> «
 * ifferential » couvre tous les composes et toutes les flexions
 * (Differenziale, Achsdifferenzials, Hinterachsdifferenzial...) en preservant
 * la casse initiale, puisque seule la fin du mot change.
 *
 *   node scripts/uniformiser-differential-de.js              # compte
 *   node scripts/uniformiser-differential-de.js --appliquer
 */

require('dotenv').config();
const mongoose = require('mongoose');

const AVANT = /ifferenzial/g;
const APRES = 'ifferential';

function corriger(v) {
  return typeof v === 'string' && AVANT.test(v) ? v.replace(AVANT, APRES) : null;
}

/* Champs susceptibles de porter le terme, par collection. On ne touche PAS
   aux slugs ici : ils sont recalcules depuis le nom par corriger-slugs-de.js,
   apres ce script. */
const CHAMPS = {
  products: ['localizations.de.name', 'localizations.de.shortDescription', 'localizations.de.description',
    'localizations.de.seo.metaTitle', 'localizations.de.seo.metaDescription'],
  categories: ['localizations.de.name', 'localizations.de.seoText'],
  blogposts: ['localizations.de.title', 'localizations.de.excerpt', 'localizations.de.contentHtml',
    'localizations.de.seo.metaTitle', 'localizations.de.seo.metaDescription'],
};

function lire(doc, chemin) {
  return chemin.split('.').reduce((o, k) => (o == null ? undefined : o[k]), doc);
}

async function main() {
  const appliquer = process.argv.includes('--appliquer');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });

  let total = 0;
  for (const [col, champs] of Object.entries(CHAMPS)) {
    const C = mongoose.connection.collection(col);
    const docs = await C.find({ $or: champs.map((c) => ({ [c]: /ifferenzial/ })) }).toArray();
    const ops = [];
    for (const d of docs) {
      const set = {};
      for (const champ of champs) {
        const v = corriger(lire(d, champ));
        if (v !== null) set[champ] = v;
      }
      if (Object.keys(set).length) ops.push({ updateOne: { filter: { _id: d._id }, update: { $set: set } } });
    }
    console.log('  ' + col.padEnd(12) + ops.length + ' document(s) a corriger');
    total += ops.length;
    if (appliquer && ops.length) {
      for (let i = 0; i < ops.length; i += 500) await C.bulkWrite(ops.slice(i, i + 500), { ordered: false });
    }
  }

  if (!appliquer) {
    console.log('\n' + total + ' au total. Rien ecrit — relance avec --appliquer.');
    await mongoose.disconnect();
    return;
  }

  /* Controle : on relit. */
  let restant = 0;
  for (const [col, champs] of Object.entries(CHAMPS)) {
    restant += await mongoose.connection.collection(col)
      .countDocuments({ $or: champs.map((c) => ({ [c]: /ifferenzial/ })) });
  }
  console.log('\nOK - ' + total + ' document(s) corrige(s). Controle : ' + restant + ' occurrence(s) restante(s).');
  await mongoose.disconnect();
}

if (require.main === module) main().catch((e) => { console.error('\nECHEC', e.message); process.exit(1); });
