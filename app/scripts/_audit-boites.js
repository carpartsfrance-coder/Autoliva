/** AUDIT lecture seule du catalogue COMPLET de boîtes de vitesses. N'écrit RIEN.
 *  Cohérence : sources, doublons de code entre sources, formats de titres, prix, images. */
require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('../src/models/Product');

const norm = (c) => String(c || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const prefixOf = (sku) => {
  const s = String(sku || '');
  for (const p of ['DEK-', 'ALV-BX-', 'EDEN-BX-', 'ASY-', 'AUTO-', 'ACR-']) if (s.startsWith(p)) return p;
  return 'autre';
};
const pct = (a, b) => (b ? Math.round((100 * a) / b) : 0);

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  // Tout ce qui est une boîte de vitesses (par catégorie), moteurs/ponts exclus
  const q = { category: { $regex: /bo[iî]te de vitesses|transmission.*bo[iî]te/i } };
  const all = await Product.find(q)
    .select('sku name slug category engineCode priceCents imageUrl isPublished badges warranty stockQty')
    .lean();
  const pub = all.filter((p) => p.isPublished);
  console.log(`\n═══ CATALOGUE BOÎTES DE VITESSES ═══`);
  console.log(`Total : ${all.length}  ·  publiées : ${pub.length}  ·  brouillon : ${all.length - pub.length}`);

  // 1) par source × statut
  console.log(`\n① SOURCES (sku) × statut`);
  const by = {};
  for (const p of all) { const k = prefixOf(p.sku); (by[k] ||= { pub: 0, dr: 0 }); p.isPublished ? by[k].pub++ : by[k].dr++; }
  for (const [k, v] of Object.entries(by).sort((a, b) => (b[1].pub + b[1].dr) - (a[1].pub + a[1].dr)))
    console.log(`   ${k.padEnd(9)} publiées ${String(v.pub).padStart(5)}  brouillon ${String(v.dr).padStart(5)}`);

  // 2) DOUBLONS DE CODE entre produits PUBLIÉS (même boîte listée plusieurs fois = incohérent)
  console.log(`\n② DOUBLONS DE CODE (produits PUBLIÉS, même engineCode)`);
  const byCode = {};
  for (const p of pub) { const c = norm(p.engineCode); if (c.length >= 3) (byCode[c] ||= []).push(p); }
  const dupCode = Object.entries(byCode).filter(([, g]) => g.length > 1);
  console.log(`   codes publiés en double : ${dupCode.length} (couvrant ${dupCode.reduce((s, [, g]) => s + g.length, 0)} fiches)`);
  const crossSource = dupCode.filter(([, g]) => new Set(g.map((p) => prefixOf(p.sku))).size > 1);
  console.log(`   dont MULTI-SOURCES (ex. DEK- + ALV-BX- même code) : ${crossSource.length}  ← le vrai problème`);
  for (const [c, g] of dupCode.sort((a, b) => b[1].length - a[1].length).slice(0, 8)) {
    const prices = g.map((p) => Math.round(p.priceCents / 100));
    console.log(`     ${c.toUpperCase().padEnd(9)} ×${g.length}  [${[...new Set(g.map((p) => prefixOf(p.sku)))].join('+')}]  prix ${Math.min(...prices)}–${Math.max(...prices)}€`);
  }

  // 3) FORMAT DE TITRE (cohérence "reconditionnée")
  console.log(`\n③ FORMAT DES TITRES (publiés)`);
  for (const k of Object.keys(by)) {
    const g = pub.filter((p) => prefixOf(p.sku) === k);
    if (!g.length) continue;
    const rec = g.filter((p) => /reconditionn/i.test(p.name)).length;
    console.log(`   ${k.padEnd(9)} ${g.length} publiées · contiennent « reconditionnée » : ${rec} (${pct(rec, g.length)}%)`);
  }

  // 4) PRIX & IMAGES (publiés)
  console.log(`\n④ QUALITÉ (publiés)`);
  const noPrice = pub.filter((p) => !p.priceCents || p.priceCents <= 0);
  const noImg = pub.filter((p) => !p.imageUrl);
  const noCode = pub.filter((p) => !norm(p.engineCode));
  const noWar = pub.filter((p) => !(p.warranty && p.warranty.months));
  const prices = pub.map((p) => p.priceCents / 100).filter((x) => x > 0).sort((a, b) => a - b);
  console.log(`   sans prix : ${noPrice.length}  ·  sans image : ${noImg.length}  ·  sans code : ${noCode.length}  ·  sans garantie : ${noWar.length}`);
  if (prices.length) console.log(`   prix publiés : min ${Math.round(prices[0])}€ · médiane ${Math.round(prices[Math.floor(prices.length / 2)])}€ · max ${Math.round(prices[prices.length - 1])}€`);
  const cheap = pub.filter((p) => p.priceCents > 0 && p.priceCents < 40000);
  if (cheap.length) console.log(`   ⚠ < 400€ (suspect pour une boîte) : ${cheap.length}  ex. ${cheap.slice(0, 3).map((p) => p.sku + ' ' + Math.round(p.priceCents / 100) + '€').join(' · ')}`);

  // 5) doublons de nom / slug
  console.log(`\n⑤ DOUBLONS NOM / SLUG (publiés)`);
  const byName = {}, bySlug = {};
  for (const p of pub) { (byName[p.name] ||= 0), byName[p.name]++; (bySlug[p.slug] ||= 0), bySlug[p.slug]++; }
  const dupN = Object.entries(byName).filter(([, n]) => n > 1);
  const dupS = Object.entries(bySlug).filter(([, n]) => n > 1);
  console.log(`   noms dupliqués : ${dupN.length}  ·  slugs dupliqués : ${dupS.length}`);
  dupN.sort((a, b) => b[1] - a[1]).slice(0, 5).forEach(([n, c]) => console.log(`     ×${c}  ${n.slice(0, 60)}`));

  // 6) catégories utilisées
  console.log(`\n⑥ CATÉGORIES utilisées`);
  const byCat = {};
  for (const p of all) (byCat[p.category] ||= 0), byCat[p.category]++;
  Object.entries(byCat).sort((a, b) => b[1] - a[1]).forEach(([c, n]) => console.log(`   ${String(n).padStart(5)}  ${c}`));

  await mongoose.disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
