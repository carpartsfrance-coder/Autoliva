/**
 * Repricing moteurs depuis le benchmark (scripts/reprice_map.json : engineCode -> prix TTC €).
 * Matching EXACT sur le champ structuré `engineCode` (pas le slug → pas d'artefact OE).
 * Ne cible QUE les reconditionnés / échange standard (jamais occasion ni neuf).
 *
 * SÉCURITÉ : dry-run par défaut (n'écrit RIEN). Ajouter --apply pour écrire.
 *
 * Usage :
 *   node scripts/reprice-moteurs.js                 # dry-run, montre tout le diff
 *   node scripts/reprice-moteurs.js --max-delta 40  # ignore les écarts > ±40% (sécurité)
 *   node scripts/reprice-moteurs.js --apply --max-delta 40   # applique (≤ ±40%)
 *   node scripts/reprice-moteurs.js --include-occasion       # inclut aussi occasion (déconseillé)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Product = require('../src/models/Product');

const APPLY = process.argv.includes('--apply');
const INCLUDE_OCC = process.argv.includes('--include-occasion');
const mdi = process.argv.indexOf('--max-delta');
const MAX_DELTA = mdi >= 0 ? Number(process.argv[mdi + 1]) : null; // % ; null = pas de plafond

function conditionOf(p) {
  const hay = [
    p.badges && p.badges.condition,
    p.category,
    p.name,
  ].filter(Boolean).join(' ').toLowerCase();
  if (/occasion/.test(hay)) return 'occasion';
  if (/\bneuf\b/.test(hay)) return 'neuf';
  if (/reconditionn|échange standard|echange standard/.test(hay)) return 'reconditionné';
  return 'inconnu';
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI manquant (.env)');
  const map = JSON.parse(fs.readFileSync(path.join(__dirname, 'reprice_map.json'), 'utf8'));
  const codes = Object.keys(map); // déjà UPPER
  await mongoose.connect(uri);
  console.log('MongoDB :', uri.replace(/\/\/[^@]*@/, '//***@').slice(0, 50), '…');
  console.log(`Benchmark : ${codes.length} codes | mode ${APPLY ? '🔴 APPLY (écriture)' : '🟢 DRY-RUN (lecture seule)'}${MAX_DELTA != null ? ` | plafond ±${MAX_DELTA}%` : ''}`);

  // produits avec un engineCode renseigné présent dans la map
  const prods = await Product.find({ engineCode: { $type: 'string', $ne: '' } })
    .select('name engineCode category badges priceCents sku isPublished').lean();

  const targets = [];   // à repricer (recond/éch. std)
  const skippedCond = { occasion: 0, neuf: 0, inconnu: 0 };
  const skippedBig = [];
  for (const p of prods) {
    const ec = String(p.engineCode || '').trim().toUpperCase();
    const ref = map[ec];
    if (!ref) continue;
    const cond = conditionOf(p);
    const isRecond = cond === 'reconditionné';
    if (!isRecond && !(INCLUDE_OCC && cond === 'occasion')) {
      if (cond in skippedCond) skippedCond[cond]++;
      continue;
    }
    const cur = (p.priceCents || 0) / 100;
    const neu = ref.prix;
    const delta = cur ? Math.round(100 * (neu - cur) / cur) : null;
    const row = { code: ec, cond, name: p.name, sku: p.sku, cur, neu, delta, _id: p._id };
    if (MAX_DELTA != null && delta != null && Math.abs(delta) > MAX_DELTA) { skippedBig.push(row); continue; }
    targets.push(row);
  }

  targets.sort((a, b) => Math.abs((b.delta || 0)) - Math.abs((a.delta || 0)));
  console.log(`\nProduits reconditionnés matchés (engineCode exact) : ${targets.length}`);
  console.log(`Ignorés par condition : occasion ${skippedCond.occasion}, neuf ${skippedCond.neuf}, inconnu ${skippedCond.inconnu}`);
  if (MAX_DELTA != null) console.log(`Ignorés car écart > ±${MAX_DELTA}% : ${skippedBig.length}`);

  console.log(`\n${'CODE'.padEnd(11)}${'cond'.padEnd(14)}${'actuel'.padStart(9)}${'→ nouveau'.padStart(11)}${'écart'.padStart(8)}  nom`);
  for (const r of targets.slice(0, 60)) {
    const flag = r.delta != null && Math.abs(r.delta) > 40 ? ' ⚠' : '';
    console.log(`${r.code.padEnd(11)}${r.cond.padEnd(14)}${(r.cur.toFixed(0) + '€').padStart(9)}${(r.neu.toFixed(0) + '€').padStart(11)}${((r.delta >= 0 ? '+' : '') + r.delta + '%').padStart(8)}${flag}  ${String(r.name).slice(0, 40)}`);
  }
  if (targets.length > 60) console.log(`… +${targets.length - 60} autres (voir CSV si besoin)`);

  const big = targets.filter((r) => r.delta != null && Math.abs(r.delta) > 40).length;
  console.log(`\n⚠ Écarts > ±40% : ${big} produits — À VÉRIFIER avant apply.`);

  if (APPLY) {
    let n = 0;
    for (const r of targets) {
      await Product.updateOne({ _id: r._id }, { $set: { priceCents: Math.round(r.neu * 100) } });
      n++;
    }
    console.log(`\n🔴 APPLIQUÉ : ${n} prix mis à jour.`);
  } else {
    console.log('\n🟢 DRY-RUN — rien modifié. Relance avec --apply (et --max-delta 40 conseillé) pour écrire.');
  }
  await mongoose.disconnect();
}
main().catch((e) => { console.error('ERREUR:', e.message); process.exit(1); });
