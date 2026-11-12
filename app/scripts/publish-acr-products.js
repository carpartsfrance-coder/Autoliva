/**
 * Publication des moteurs d'occasion ACR importés (passe isPublished=true).
 *
 * Cible STRICTE : sku commençant par "AUTO-" ET category "Moteurs d'occasion"
 * (ne touche donc qu'aux fiches issues de l'import ACR, jamais au reste du catalogue).
 *
 * RÉVERSIBLE : `--unpublish` repasse ces mêmes fiches en brouillon (isPublished=false).
 *
 * Usage :
 *   node scripts/publish-acr-products.js --dry-run          # compte seulement
 *   node scripts/publish-acr-products.js --limit 150        # pilote : publie 150 fiches
 *   node scripts/publish-acr-products.js                    # publie TOUTES les fiches restantes
 *   node scripts/publish-acr-products.js --unpublish        # ROLLBACK : tout repasser en brouillon
 *   node scripts/publish-acr-products.js --unpublish --limit 150
 */
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const Product = require('../src/models/Product');

const DRY = process.argv.includes('--dry-run');
const UNPUB = process.argv.includes('--unpublish');
const li = process.argv.indexOf('--limit');
const LIMIT = li !== -1 ? parseInt(process.argv[li + 1], 10) : 0;
const KEEP_FILE = process.env.KEEP_FILE || '';

// MODE DÉDUP : KEEP_FILE = JSON {keepers:[sku,…]} (ou liste de sku). Publie SEULEMENT
// les gardiennes (1 par code moteur) et dépublie tout doublon déjà en ligne. Idempotent.
async function dedupMode(uri) {
  const raw = fs.readFileSync(KEEP_FILE, 'utf8');
  let keepers;
  try { const j = JSON.parse(raw); keepers = Array.isArray(j) ? j : j.keepers; }
  catch (_) { keepers = raw.split(/[\s,]+/).filter(Boolean); }
  const keepSet = new Set(keepers.map((s) => String(s).trim()).filter(Boolean));
  console.log('MODE DÉDUP — gardiennes à publier :', keepSet.size, DRY ? '· DRY-RUN' : '');

  await mongoose.connect(uri);
  console.log('MongoDB :', uri.replace(/\/\/[^@]*@/, '//***@').slice(0, 55), '…');

  const all = await Product.find({ sku: /^AUTO-/, category: "Moteurs d'occasion" }).select('_id sku isPublished').lean();
  const toPublish = all.filter((p) => keepSet.has(p.sku) && p.isPublished === false).map((p) => p._id);
  const toDraft = all.filter((p) => !keepSet.has(p.sku) && p.isPublished !== false).map((p) => p._id);
  console.log(`Fiches ACR: ${all.length} · à publier: ${toPublish.length} · doublons à repasser brouillon: ${toDraft.length}`);

  if (DRY) { await mongoose.disconnect(); return; }
  if (toPublish.length) await Product.updateMany({ _id: { $in: toPublish } }, { $set: { isPublished: true } });
  if (toDraft.length) await Product.updateMany({ _id: { $in: toDraft } }, { $set: { isPublished: false } });

  const pub = await Product.countDocuments({ sku: /^AUTO-/, category: "Moteurs d'occasion", isPublished: true });
  console.log(`OK · total moteurs d'occasion publiés maintenant : ${pub} (attendu ${keepSet.size})`);
  await mongoose.disconnect();
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI manquant (.env)');
  if (KEEP_FILE) return dedupMode(uri);

  // On ne sélectionne que les fiches qui ne sont PAS déjà dans l'état voulu :
  // - publication  -> on cherche isPublished:false (brouillons)
  // - dépublication -> on cherche isPublished:true (publiées)
  const filter = {
    sku: /^AUTO-/,
    category: "Moteurs d'occasion",
    isPublished: UNPUB ? true : false,
  };

  await mongoose.connect(uri);
  console.log('MongoDB :', uri.replace(/\/\/[^@]*@/, '//***@').slice(0, 55), '…');

  const candidats = await Product.countDocuments(filter);
  const action = UNPUB ? 'DÉPUBLICATION (→ brouillon)' : 'PUBLICATION (→ en ligne)';
  console.log(`${action} — candidats : ${candidats}`, LIMIT ? `(limité à ${LIMIT})` : '(tous)', DRY ? '· DRY-RUN' : '');

  if (DRY || candidats === 0) {
    if (candidats === 0) console.log('Rien à faire.');
    await mongoose.disconnect();
    return;
  }

  // Sélection des _id (avec limite éventuelle pour un pilote), puis update groupé.
  let ids = await Product.find(filter).select('_id').limit(LIMIT > 0 ? LIMIT : 0).lean();
  ids = ids.map((d) => d._id);
  const res = await Product.updateMany({ _id: { $in: ids } }, { $set: { isPublished: !UNPUB } });

  const restant = await Product.countDocuments(filter);
  console.log(`${UNPUB ? 'Dépubliés' : 'Publiés'} : ${res.modifiedCount} · restants en ${UNPUB ? 'ligne' : 'brouillon'} : ${restant}`);
  await mongoose.disconnect();
}

main().catch((e) => { console.error('ERREUR:', e.message); process.exit(1); });
