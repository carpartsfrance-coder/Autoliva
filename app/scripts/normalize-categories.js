/**
 * Normalisation des catégories produits vers une taxonomie propre et professionnelle.
 *
 *  - Découvre toutes les valeurs de `category` des produits (texte libre hérité).
 *  - Les mappe vers une catégorie canonique par mots-clés (ordre important).
 *  - MODE SIMULATION par défaut : affiche ce qui serait changé, N'ÉCRIT RIEN.
 *  - Avec l'option --apply : réaffecte les produits, crée/normalise les catégories
 *    canoniques (slug, ordre, icône), supprime les catégories fusionnées orphelines.
 *
 * Utilisation :
 *   node scripts/normalize-categories.js            # simulation (aperçu)
 *   node scripts/normalize-categories.js --apply    # applique réellement
 *
 * La connexion utilise MONGODB_URI (ton .env pointe déjà sur la base de prod).
 */
try { require('dotenv').config(); } catch (_) {}
const mongoose = require('mongoose');
const APPLY = process.argv.includes('--apply');

// ── Taxonomie canonique (ordre d'affichage + icône Material Symbol) ──────────
const CANON = [
  { name: 'Boîtes de vitesses',           slug: 'boites-de-vitesses',        icon: 'settings',                sortOrder: 1 },
  { name: 'Moteurs',                      slug: 'moteurs',                   icon: 'settings_suggest',        sortOrder: 2 },
  { name: 'Boîtes de transfert',          slug: 'boites-de-transfert',       icon: 'sync_alt',                sortOrder: 3 },
  { name: 'Ponts & différentiels',        slug: 'ponts-differentiels',       icon: 'linear_scale',            sortOrder: 4 },
  { name: 'Culasses',                     slug: 'culasses',                  icon: 'view_in_ar',              sortOrder: 5 },
  { name: 'Turbos',                       slug: 'turbos',                    icon: 'cyclone',                 sortOrder: 6 },
  { name: 'Mécatroniques & calculateurs', slug: 'mecatroniques',             icon: 'memory',                  sortOrder: 7 },
  { name: 'Injection & pompes',           slug: 'injection-pompes',          icon: 'valve',                   sortOrder: 8 },
  { name: 'Embrayages',                   slug: 'embrayages',                icon: 'trip_origin',             sortOrder: 9 },
  { name: 'Démarreurs & alternateurs',    slug: 'demarreurs-alternateurs',   icon: 'battery_charging_full',   sortOrder: 10 },
  { name: 'Accessoires',                  slug: 'accessoires',               icon: 'build',                   sortOrder: 20 },
];
const byName = Object.fromEntries(CANON.map((c) => [c.name, c]));

// ── Règles de mapping (ordre = priorité ; 1re qui matche gagne) ──────────────
// Attention à l'ordre : « boîte de transfert » AVANT « boîte de vitesses ».
const RULES = [
  [/transfert/i,                                              'Boîtes de transfert'],
  [/\bpont\b|diff[ée]rentiel|cardan/i,                        'Ponts & différentiels'],
  [/culasse/i,                                                'Culasses'],
  [/turbo|compresseur/i,                                      'Turbos'],
  [/m[ée]catronique|calculateur|\btcu\b|\becu\b|\bdsg\b.*m[ée]ca/i, 'Mécatroniques & calculateurs'],
  [/injecteur|injection|common ?rail|pompe (?:hp|haute pression|injection|gasoil|carburant|inject)/i, 'Injection & pompes'],
  [/embrayage|volant moteur/i,                                'Embrayages'],
  [/d[ée]marreur|alternateur/i,                               'Démarreurs & alternateurs'],
  [/bo[iî]te|vitesse|\bbv[am]?\b|transmission|s-?tronic|\bdsg\b|\bdq\d/i, 'Boîtes de vitesses'],
  [/moteur|\bbloc\b|culbuteur/i,                              'Moteurs'],
  [/accessoire|huile|visserie|joint|kit|butée|butee|embout/i, 'Accessoires'],
];

function mapCategory(raw) {
  const s = String(raw || '').trim();
  if (!s) return null;
  // déjà canonique ?
  if (byName[s]) return s;
  for (const [re, target] of RULES) { if (re.test(s)) return target; }
  return null; // non reconnu → on ne touche pas
}

function slugify(str) {
  return String(str).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI manquant.'); process.exit(1); }
  await mongoose.connect(uri);
  const Product = require('../src/models/Product');
  const Category = require('../src/models/Category');

  const agg = await Product.aggregate([
    { $match: { category: { $type: 'string', $ne: '' } } },
    { $group: { _id: '$category', total: { $sum: 1 } } },
    { $sort: { total: -1 } },
  ]);

  const moves = [];   // { from, to, count }
  const unmapped = []; // { value, count }
  for (const a of agg) {
    const from = String(a._id).trim();
    const to = mapCategory(from);
    if (!to) { unmapped.push({ value: from, count: a.total }); continue; }
    if (to !== from) moves.push({ from, to, count: a.total });
  }

  console.log('\n=== NORMALISATION DES CATÉGORIES ' + (APPLY ? '(APPLICATION RÉELLE)' : '(SIMULATION — rien n\'est modifié)') + ' ===\n');
  console.log('Base :', uri.replace(/\/\/[^@]*@/, '//***@'));
  console.log('\nRegroupements prévus :');
  const targets = {};
  for (const mv of moves) { targets[mv.to] = (targets[mv.to] || 0) + mv.count; console.log(`  « ${mv.from} » (${mv.count}) → « ${mv.to} »`); }
  if (!moves.length) console.log('  (rien à regrouper)');
  console.log('\nTotal produits reclassés par cible :');
  for (const [t, n] of Object.entries(targets).sort((a, b) => b[1] - a[1])) console.log(`  ${t} : +${n}`);
  if (unmapped.length) {
    console.log('\n⚠ Non reconnues (laissées telles quelles — dis-le-moi si besoin) :');
    for (const u of unmapped) console.log(`  « ${u.value} » (${u.count})`);
  }

  if (!APPLY) {
    console.log('\n→ Simulation terminée. Pour appliquer : node scripts/normalize-categories.js --apply\n');
    await mongoose.disconnect();
    return;
  }

  // Application
  let reclassed = 0;
  for (const mv of moves) {
    const r = await Product.updateMany({ category: mv.from }, { $set: { category: mv.to } });
    reclassed += (r.modifiedCount || 0);
  }
  // Crée / normalise les catégories canoniques UTILISÉES (celles qui ont des produits)
  const usedTargets = new Set([...moves.map((m) => m.to), ...agg.map((a) => mapCategory(String(a._id).trim())).filter(Boolean)]);
  for (const name of usedTargets) {
    const c = byName[name];
    if (!c) continue;
    await Category.findOneAndUpdate(
      { slug: c.slug },
      { $set: { name: c.name, slug: c.slug, isActive: true, menuIcon: c.icon, sortOrder: c.sortOrder } },
      { upsert: true }
    );
  }
  // Supprime les catégories orphelines fusionnées (celles qu'on a déplacées, != cible)
  const removed = [...new Set(moves.map((m) => m.from))].filter((f) => !byName[f]);
  if (removed.length) await Category.deleteMany({ name: { $in: removed } });

  console.log(`\n✓ Appliqué : ${reclassed} produit(s) reclassé(s), ${usedTargets.size} catégorie(s) canonique(s) normalisée(s), ${removed.length} orpheline(s) supprimée(s).\n`);
  await mongoose.disconnect();
})().catch((e) => { console.error('ERR', e && e.message ? e.message : e); process.exit(1); });
