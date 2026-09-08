/** Exporte les références Eden ABSENTES de ton catalogue (aucun produit, tout statut).
 *  Sortie : ~/Scrape/output/eden_missing.csv  (code, type, prix_eur, url, slug).
 *  Lecture seule côté base. */
require('dotenv').config();
const fs = require('fs'); const path = require('path');
const mongoose = require('mongoose');
const Product = require('../src/models/Product');

const norm = (c) => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const EDEN = process.env.EDEN_CSV || path.join(process.env.HOME || '', 'Scrape/output/eden_boites_tarifs.csv');
const OUT = path.join(process.env.HOME || '', 'Scrape/output/eden_missing.csv');

(async () => {
  // Eden : code -> {type, prix, url, slug}
  const eden = new Map();
  const rows = fs.readFileSync(EDEN, 'utf8').trim().split('\n').slice(1);
  for (const l of rows) {
    const f = l.split(',');
    const slug = f[0] || '';
    const c = norm(slug.split('-').pop());
    if (c.length >= 3 && !/^\d+$/.test(c)) eden.set(c, { type: f[2] || '', prix: f[1] || '', url: (f[3] || '').trim(), slug });
  }
  await mongoose.connect(process.env.MONGODB_URI);
  const CAT = { category: { $regex: /bo[iî]te de vitesses/i } };
  const prods = await Product.find(CAT).select('engineCode').lean();
  const have = new Set(prods.map((p) => norm(p.engineCode)).filter((c) => c.length >= 3));
  const missing = [...eden.entries()].filter(([c]) => !have.has(c));
  const byType = {}; missing.forEach(([, m]) => (byType[m.type] = (byType[m.type] || 0) + 1));
  const lines = ['code,type,prix_eur,url,slug'];
  for (const [c, m] of missing) lines.push([c.toUpperCase(), m.type, m.prix, m.url, m.slug].join(','));
  fs.writeFileSync(OUT, lines.join('\n'));
  console.log(`Eden : ${eden.size} codes · dans ton catalogue : ${eden.size - missing.length} · MANQUANTS : ${missing.length}`);
  console.log(`  par type :`, byType);
  console.log(`→ export : ${OUT}`);
  console.log(`  ex.:`, missing.slice(0, 5).map(([c, m]) => `${c.toUpperCase()} (${m.type})`).join(', '));
  await mongoose.disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
