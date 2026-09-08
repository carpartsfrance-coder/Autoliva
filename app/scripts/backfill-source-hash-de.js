'use strict';

/* Pose l'empreinte du texte source sur tout ce qui est DÉJÀ traduit.
 *
 * À lancer UNE FOIS, avant d'activer le cron. Sans ça, le cron voit 13 346
 * fiches sans empreinte, les croit périmées et retraduit tout le catalogue.
 *
 * Aucun appel au modèle : on relit le français et on calcule un sha1.
 *
 *   node scripts/backfill-source-hash-de.js              # compte, n'écrit pas
 *   node scripts/backfill-source-hash-de.js --appliquer
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { sourceHash } = require('../src/services/productTranslator');
const { blogSourceHash } = require('../src/jobs/traduireNouveautesDe');

async function main() {
  const appliquer = process.argv.includes('--appliquer');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  const Product = require('../src/models/Product');
  const BlogPost = require('../src/models/BlogPost');

  const fiches = await Product.find({ 'localizations.de.translatedAt': { $ne: null } }).lean();
  const opsP = fiches
    .filter((p) => !(p.localizations.de.sourceHash))
    .map((p) => ({ updateOne: { filter: { _id: p._id }, update: { $set: { 'localizations.de.sourceHash': sourceHash(p) } } } }));

  const posts = await BlogPost.find({ 'localizations.de.translatedAt': { $ne: null } }).lean();
  const opsB = posts
    .filter((b) => !(b.localizations.de.sourceHash))
    .map((b) => ({ updateOne: { filter: { _id: b._id }, update: { $set: { 'localizations.de.sourceHash': blogSourceHash(b) } } } }));

  console.log(fiches.length + ' fiche(s) traduite(s) -> ' + opsP.length + ' a empreindre');
  console.log(posts.length + ' article(s) traduit(s) -> ' + opsB.length + ' a empreindre');

  if (!appliquer) {
    console.log('\nRien ecrit. Relance avec --appliquer.');
    await mongoose.disconnect();
    return;
  }

  for (const [modele, ops, nom] of [[Product, opsP, 'fiches'], [BlogPost, opsB, 'articles']]) {
    for (let i = 0; i < ops.length; i += 500) {
      await modele.bulkWrite(ops.slice(i, i + 500), { ordered: false });
      console.log('   ' + nom + ' ' + Math.min(i + 500, ops.length) + '/' + ops.length);
    }
  }
  console.log('OK - empreintes posees, le cron ne verra plus que le NOUVEAU.');
  await mongoose.disconnect();
}

if (require.main === module) main().catch((e) => { console.error('\nECHEC', e.message); process.exit(1); });
