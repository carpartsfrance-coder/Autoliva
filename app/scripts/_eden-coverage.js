/** Couverture Eden : ai-je AU MOINS toutes les références Eden dans mon catalogue ?
 *  Lecture seule. Compare les codes Eden (CSV tarifs) à TOUTES les boîtes en base. */
require('dotenv').config();
const fs = require('fs'); const path = require('path');
const mongoose = require('mongoose');
const Product = require('../src/models/Product');

const norm = (c) => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const EDEN = process.env.EDEN_CSV || path.join(process.env.HOME || '', 'Scrape/output/eden_boites_tarifs.csv');

(async () => {
  // Codes Eden (+ type), on exclut les codes poubelle (pur-chiffres)
  const eden = new Map();
  const rows = fs.readFileSync(EDEN, 'utf8').trim().split('\n').slice(1);
  for (const l of rows) {
    const f = l.split(',');
    const c = norm((f[0] || '').split('-').pop());
    if (c.length >= 3 && !/^\d+$/.test(c)) eden.set(c, f[2] || '');
  }
  await mongoose.connect(process.env.MONGODB_URI);
  const CAT = { category: { $regex: /bo[iî]te de vitesses/i } };
  const prods = await Product.find(CAT).select('engineCode isPublished sku').lean();
  const pub = new Set(), all = new Set(), pubBy = {};
  const pref = (s) => (['DEK-', 'ALV-BX-', 'ASY-', 'EDEN-BX-'].find((p) => String(s).startsWith(p)) || 'autre');
  for (const p of prods) {
    const c = norm(p.engineCode);
    if (c.length < 3) continue;
    all.add(c);
    if (p.isPublished) { pub.add(c); (pubBy[c] ||= new Set()).add(pref(p.sku)); }
  }
  const codes = [...eden.keys()];
  const published = codes.filter((c) => pub.has(c));
  const draft = codes.filter((c) => all.has(c) && !pub.has(c));
  const missing = codes.filter((c) => !all.has(c));
  const pc = (n) => Math.round((100 * n) / eden.size);
  const byType = (arr) => { const o = {}; arr.forEach((c) => { const t = eden.get(c) || '?'; o[t] = (o[t] || 0) + 1; }); return o; };

  console.log(`\n═══ COUVERTURE EDEN (${eden.size} codes réels) ═══`);
  console.log(`  ✅ chez toi ET PUBLIÉS   : ${published.length} (${pc(published.length)}%)   ${JSON.stringify(byType(published))}`);
  console.log(`  🟡 chez toi en BROUILLON : ${draft.length} (${pc(draft.length)}%)   ${JSON.stringify(byType(draft))}`);
  console.log(`  ❌ ABSENTS du catalogue  : ${missing.length} (${pc(missing.length)}%)   ${JSON.stringify(byType(missing))}`);
  // quelle source publie les codes Eden couverts
  const srcCount = {};
  published.forEach((c) => (pubBy[c] || new Set()).forEach((s) => (srcCount[s] = (srcCount[s] || 0) + 1)));
  console.log(`  sources des Eden publiés :`, srcCount);
  console.log(`  ex. ABSENTS :`, missing.slice(0, 25).join(', '));
  await mongoose.disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
