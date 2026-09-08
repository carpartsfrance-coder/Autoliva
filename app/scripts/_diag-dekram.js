/** Lecture seule : état des fiches DEK- en prod vs le JSON courant. N'écrit RIEN. */
require('dotenv').config();
const fs = require('fs'); const path = require('path');
const mongoose = require('mongoose');
const Product = require('../src/models/Product');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const jsonSkus = new Set(JSON.parse(fs.readFileSync(path.join(__dirname, 'boites_dekram.json'), 'utf8')).map((x) => x.sku));
  const prod = await Product.find({ sku: /^DEK-/ }).select('sku isPublished imageUrl name priceCents').lean();
  const prodSkus = new Set(prod.map((p) => p.sku));
  const pub = prod.filter((p) => p.isPublished).length;
  const withImg = prod.filter((p) => p.imageUrl && p.imageUrl.length).length;
  const orphans = prod.filter((p) => !jsonSkus.has(p.sku)); // en prod mais plus dans le JSON (dédup)
  const missing = [...jsonSkus].filter((s) => !prodSkus.has(s)); // dans le JSON mais pas en prod
  console.log(`DEK- en PROD : ${prod.length}`);
  console.log(`  publiés : ${pub}  ·  brouillon : ${prod.length - pub}`);
  console.log(`  avec image : ${withImg}  ·  sans image : ${prod.length - withImg}`);
  console.log(`JSON courant : ${jsonSkus.size} réfs`);
  console.log(`  → ORPHELINS (en prod, absents du JSON dédupliqué) : ${orphans.length}`);
  console.log(`  → à créer (dans le JSON, absents de prod) : ${missing.length}`);
  console.log(`  orphelins publiés : ${orphans.filter((p) => p.isPublished).length}`);
  console.log('  ex. orphelins :', orphans.slice(0, 4).map((p) => p.sku + ' ' + (p.name || '').slice(0, 40)));
  await mongoose.disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
