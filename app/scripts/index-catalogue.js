'use strict';

/* Index du catalogue — création immédiate et contrôle.
 *
 * Les index sont déclarés dans les modèles (Product.js, BlogPost.js) :
 * Mongoose les crée au démarrage de chaque instance. Ce script sert à trois
 * choses sans attendre un redéploiement :
 *
 *   1. poser les index tout de suite (14 700 fiches : une seconde) ;
 *   2. normaliser `isPublished` : treize fiches n'avaient pas le champ. Elles
 *      étaient listées (le filtre acceptait l'absence) ; elles le restent,
 *      mais avec la valeur écrite, comme les 13 348 autres ;
 *   3. vérifier par un explain() que la requête de listing utilise bien
 *      l'index et n'examine plus que ce qu'elle renvoie.
 *
 *   node scripts/index-catalogue.js              # contrôle seul
 *   node scripts/index-catalogue.js --appliquer
 */

require('dotenv').config();
const mongoose = require('mongoose');

function resumerPlan(explain) {
  const stages = [];
  let n = explain.queryPlanner && explain.queryPlanner.winningPlan;
  while (n) {
    stages.push(n.stage + (n.indexName ? '(' + n.indexName + ')' : ''));
    n = n.inputStage || (Array.isArray(n.inputStages) ? n.inputStages[0] : null) || (n.queryPlan);
  }
  const ex = explain.executionStats || {};
  return `${stages.join(' ← ')} — ${ex.totalDocsExamined} docs examinés, ${ex.totalKeysExamined} clés, ${ex.nReturned} renvoyés, ${ex.executionTimeMillis} ms`;
}

async function main() {
  const appliquer = process.argv.includes('--appliquer');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  const Product = require('../src/models/Product');
  const BlogPost = require('../src/models/BlogPost');

  const avant = (await Product.collection.indexes()).map((i) => i.name);
  const sansChamp = await Product.countDocuments({ isPublished: null });
  console.log('Index produits :', avant.join(', '));
  console.log('Fiches sans isPublished :', sansChamp);

  if (appliquer) {
    await Product.createIndexes();
    await BlogPost.createIndexes();
    const r = await Product.updateMany({ isPublished: null }, { $set: { isPublished: true } });
    console.log('Index créés. isPublished écrit sur', r.modifiedCount, 'fiche(s).');
  } else {
    console.log('(contrôle seul — relance avec --appliquer pour créer les index)');
  }

  const publie = { isPublished: { $in: [true, null] } };
  const tests = [
    ['listing par défaut', Product.find(publie).sort({ createdAt: -1 }).limit(24)],
    ['page catégorie', Product.find({ ...publie, category: { $regex: /^Boîtes de vitesses/i } }).sort({ createdAt: -1 }).limit(24)],
    ['articles de blog', BlogPost.find({ isPublished: true }).sort({ publishedAt: -1 }).limit(12)],
  ];
  for (const [nom, q] of tests) {
    const e = await q.explain('executionStats');
    console.log('  ' + nom.padEnd(20) + resumerPlan(e));
  }
  const c = await mongoose.connection.db.command({ explain: { count: 'products', query: publie }, verbosity: 'executionStats' });
  console.log('  ' + 'comptage'.padEnd(20) + resumerPlan(c));

  await mongoose.disconnect();
}

if (require.main === module) main().catch((e) => { console.error('\nÉCHEC', e.message); process.exit(1); });
