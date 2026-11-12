/**
 * Consolide les catégories PONT en 2, par POSITION :
 *   « Pont / Différentiel avant »  et  « Pont / Différentiel arrière ».
 *
 * SEO-safe : on réutilise les fiches Category qui rankent (slugs `ponts-arriere`
 * / `ponts-avant` CONSERVÉS) en changeant juste leur `name`. Les autres cat. pont
 * (transmission-pont-differentiel, ponts-neufs, ponts-occasions) sont désactivées
 * (→ prévoir un 301 vers les 2 gardées).
 *
 * Position déterminée par : catégorie actuelle (avant/arrière) > nom/description
 * (regex) > défaut ARRIÈRE (+ listés pour revue manuelle).
 *
 * SÉCURITÉ : dry-run par défaut (n'écrit RIEN). --apply pour exécuter.
 *   node scripts/migrate-ponts.js            # plan, lecture seule
 *   node scripts/migrate-ponts.js --apply    # exécute
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('../src/models/Product');
const Category = require('../src/models/Category');

const APPLY = process.argv.includes('--apply');
const NAME_AR = 'Pont / Différentiel arrière';
const NAME_AV = 'Pont / Différentiel avant';
const KEEP_AR_SLUG = 'ponts-arriere';   // slug conservé (SEO)
const KEEP_AV_SLUG = 'ponts-avant';
const DEACTIVATE_SLUGS = ['transmission-pont-differentiel', 'ponts-neufs', 'ponts-occasions'];

const isPont = (c) => /pont|diff[ée]rentiel/i.test(String(c || ''));

function positionOf(p) {
  const cat = String(p.category || '').toLowerCase();
  if (/avant/.test(cat)) return 'avant';
  if (/arri[èe]re/.test(cat)) return 'arriere';
  const hay = `${p.name || ''} ${p.shortDescription || ''} ${p.description || ''}`.toLowerCase();
  if (/\bavant\b|\bfront\b/.test(hay)) return 'avant';
  if (/arri[èe]re|\brear\b/.test(hay)) return 'arriere';
  return null; // ambigu -> défaut arrière
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI manquant (.env)');
  await mongoose.connect(uri);
  console.log('MongoDB :', uri.replace(/\/\/[^@]*@/, '//***@').slice(0, 50), '…');
  console.log(`Mode ${APPLY ? '🔴 APPLY' : '🟢 DRY-RUN (lecture seule)'}\n`);

  // 1) produits pont (toutes cat. confondues)
  const prods = await Product.find({ category: { $regex: /pont|diff[ée]rentiel/i } })
    .select('name category shortDescription description sku').lean();
  console.log(`Produits pont trouvés : ${prods.length}`);

  const plan = { avant: [], arriere: [], ambigu: [] };
  for (const p of prods) {
    const pos = positionOf(p);
    if (pos === 'avant') plan.avant.push(p);
    else if (pos === 'arriere') plan.arriere.push(p);
    else { plan.ambigu.push(p); plan.arriere.push(p); } // défaut arrière
  }
  console.log(`\n→ « ${NAME_AV} » : ${plan.avant.length}`);
  console.log(`→ « ${NAME_AR} » : ${plan.arriere.length}  (dont ${plan.ambigu.length} ambigus mis en arrière par défaut)`);

  // répartition par catégorie d'origine
  const byCat = {};
  for (const p of prods) byCat[p.category] = (byCat[p.category] || 0) + 1;
  console.log('\nRépartition catégories d’origine :');
  for (const [c, n] of Object.entries(byCat).sort((a, b) => b[1] - a[1])) console.log(`   ${n.toString().padStart(4)}  ${c}`);

  console.log(`\n⚠ ${plan.ambigu.length} AMBIGUS (position non déductible → arrière par défaut, À VÉRIFIER) :`);
  plan.ambigu.slice(0, 40).forEach((p) => console.log(`   [${p.sku || '—'}] ${String(p.name).slice(0, 60)}`));
  if (plan.ambigu.length > 40) console.log(`   … +${plan.ambigu.length - 40} autres`);

  // 2) fiches Category
  const cats = await Category.find({ slug: { $in: [KEEP_AR_SLUG, KEEP_AV_SLUG, ...DEACTIVATE_SLUGS] } }).lean();
  const bySlug = Object.fromEntries(cats.map((c) => [c.slug, c]));
  console.log('\nCatégories concernées :');
  cats.forEach((c) => console.log(`   ${c.slug}  ("${c.name}")  active=${c.isActive}`));

  if (!APPLY) {
    console.log('\n🟢 DRY-RUN — rien modifié. Relance avec --apply.');
    console.log('   (Pense au 301 : /categorie/{transmission-pont-differentiel,ponts-neufs,ponts-occasions} → ponts-arriere/avant)');
    await mongoose.disconnect();
    return;
  }

  // 3) APPLY : renommer les 2 gardées (slug conservé), retag produits, désactiver les autres
  if (bySlug[KEEP_AR_SLUG]) await Category.updateOne({ slug: KEEP_AR_SLUG }, { $set: { name: NAME_AR } });
  if (bySlug[KEEP_AV_SLUG]) await Category.updateOne({ slug: KEEP_AV_SLUG }, { $set: { name: NAME_AV } });

  let nAv = 0, nAr = 0;
  for (const p of plan.avant) { await Product.updateOne({ _id: p._id }, { $set: { category: NAME_AV } }); nAv++; }
  for (const p of plan.arriere) { await Product.updateOne({ _id: p._id }, { $set: { category: NAME_AR } }); nAr++; }

  await Category.updateMany({ slug: { $in: DEACTIVATE_SLUGS } }, { $set: { isActive: false } });

  console.log(`\n🔴 APPLIQUÉ : ${nAv} → avant, ${nAr} → arrière. Catégories ${DEACTIVATE_SLUGS.join(', ')} désactivées.`);
  console.log('   ⚠ Ajoute les redirections 301 des slugs désactivés vers ponts-arriere/ponts-avant.');
  await mongoose.disconnect();
}
main().catch((e) => { console.error('ERREUR:', e.message); process.exit(1); });
