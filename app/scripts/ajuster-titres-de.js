'use strict';

/* Ramene les metaTitle allemands au budget REEL : 49 caracteres.
 *
 * Le gabarit ajoute « | Autoliva » APRES coup, puis coupe a 60 avec des points
 * de suspension. Viser 60 dans la meta, c'est donc se faire tronquer par son
 * propre gabarit : 5 564 fiches allemandes affichaient « …generalueberhol… |
 * Autoliva » en resultat de recherche.
 *
 * Aucun appel au modele. Le recadrage precedent a place la REFERENCE en tete
 * de titre : couper la fin ne lui fait plus perdre ce qui la distingue, ce qui
 * n'aurait pas ete vrai avant. On coupe au dernier mot entier.
 *
 *   node scripts/ajuster-titres-de.js              # compte
 *   node scripts/ajuster-titres-de.js --appliquer
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { clampSeo, MAX_META_TITRE } = require('../src/services/productTranslator');

async function main() {
  const appliquer = process.argv.includes('--appliquer');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  const Product = require('../src/models/Product');

  const docs = await Product.find({
    isPublished: true,
    'localizations.de.translatedAt': { $ne: null },
  }).select('localizations.de.name localizations.de.seo').lean();

  const ops = [];
  let refDisparue = 0;
  for (const p of docs) {
    const titre = ((p.localizations.de.seo) || {}).metaTitle || '';
    if (!titre || titre.length <= MAX_META_TITRE) continue;
    const court = clampSeo(titre, MAX_META_TITRE);
    if (!court) continue;

    /* Filet : si la reference tenait dans l'ancien titre et pas dans le
       nouveau, on ne coupe pas — une meta un peu longue vaut mieux qu'une meta
       qui ne dit plus de quelle piece il s'agit. */
    const codes = String(p.localizations.de.name || '').match(/\b[A-Z0-9]{5,}\b/g) || [];
    const dansAncien = codes.filter((c) => titre.includes(c));
    if (dansAncien.length && !dansAncien.some((c) => court.includes(c))) { refDisparue++; continue; }

    ops.push({ updateOne: { filter: { _id: p._id }, update: { $set: { 'localizations.de.seo.metaTitle': court } } } });
  }

  console.log(ops.length + ' titre(s) a raccourcir a ' + MAX_META_TITRE + ' car., ' + refDisparue + ' laisse(s) tel(s) quel(s) (reference).');
  if (!appliquer) { console.log('Rien ecrit. Relance avec --appliquer.'); await mongoose.disconnect(); return; }

  for (let i = 0; i < ops.length; i += 500) {
    await Product.bulkWrite(ops.slice(i, i + 500), { ordered: false });
    console.log('   ' + Math.min(i + 500, ops.length) + '/' + ops.length);
  }

  const restant = (await Product.find({ isPublished: true, 'localizations.de.translatedAt': { $ne: null } })
    .select('localizations.de.seo.metaTitle').lean())
    .filter((p) => (((p.localizations.de.seo) || {}).metaTitle || '').length > MAX_META_TITRE).length;
  console.log('OK - ' + ops.length + ' ajuste(s). Controle : ' + restant + ' encore au-dessus (dont ' + refDisparue + ' volontaires).');
  await mongoose.disconnect();
}

if (require.main === module) main().catch((e) => { console.error('\nECHEC', e.message); process.exit(1); });
