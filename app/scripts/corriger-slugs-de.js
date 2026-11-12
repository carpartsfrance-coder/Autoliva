'use strict';

/* Recalcule les slugs allemands dont la forme ne correspond plus au code.
 *
 * Deux causes, toutes deux historiques :
 *   — des slugs forgés avant la translittération des umlauts
 *     (« ruckleuchten » au lieu de « rueckleuchten ») ; en allemand ce n'est
 *     pas un détail : « Ruck » est un mot à part entière ;
 *   — des slugs figés sur un ancien terme du glossaire (« Differenzial »
 *     avant qu'on tranche pour « Differential »).
 *
 * L'ancien slug est CONSERVÉ comme alias : ces URL sont dans le sitemap et
 * servent de canonical depuis des mois, les perdre ferait des 404.
 *
 *   node scripts/corriger-slugs-de.js              # liste, n'écrit rien
 *   node scripts/corriger-slugs-de.js --appliquer
 */

require('dotenv').config();
const mongoose = require('mongoose');
const { germanSlug } = require('../src/services/productTranslator');

async function main() {
  const appliquer = process.argv.includes('--appliquer');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  const Category = require('../src/models/Category');
  const Product = require('../src/models/Product');

  /* ── Catégories : le slug EST l'URL, il faut un alias ─────────────────── */
  const cats = await Category.find({ 'localizations.de.slug': { $exists: true, $ne: '' } }).lean();
  const opsCat = [];
  for (const c of cats) {
    const de = c.localizations.de;
    const attendu = germanSlug(de.name || '');
    if (!attendu || attendu === de.slug) continue;
    const alias = Array.from(new Set([...(de.slugAliases || []), de.slug]));
    opsCat.push({
      updateOne: {
        filter: { _id: c._id },
        update: { $set: { 'localizations.de.slug': attendu, 'localizations.de.slugAliases': alias } },
      },
    });
    console.log('  CAT  ' + String(de.name).slice(0, 34).padEnd(36) + de.slug + '  ->  ' + attendu);
  }

  /* ── Fiches : l'URL porte l'_id, l'ancien slug reste résolvable ───────── */
  const prods = await Product.find({
    isPublished: true,
    'localizations.de.translatedAt': { $ne: null },
  }).select('localizations.de.slug localizations.de.name').lean();

  const opsProd = [];
  for (const p of prods) {
    const de = p.localizations.de;
    const attendu = germanSlug(de.name || '');
    if (!attendu || attendu === de.slug) continue;
    opsProd.push({
      updateOne: { filter: { _id: p._id }, update: { $set: { 'localizations.de.slug': attendu } } },
    });
  }

  console.log('\n' + opsCat.length + ' categorie(s) et ' + opsProd.length + ' fiche(s) a corriger.');
  if (!appliquer) {
    console.log('Rien ecrit. Relance avec --appliquer.');
    await mongoose.disconnect();
    return;
  }

  if (opsCat.length) await Category.bulkWrite(opsCat, { ordered: false });
  for (let i = 0; i < opsProd.length; i += 500) {
    await Product.bulkWrite(opsProd.slice(i, i + 500), { ordered: false });
    console.log('   fiches ' + Math.min(i + 500, opsProd.length) + '/' + opsProd.length);
  }

  /* Controle : on relit et on recompte. */
  const restant = (await Category.find({ 'localizations.de.slug': { $exists: true, $ne: '' } }).lean())
    .filter((c) => germanSlug(c.localizations.de.name || '') !== c.localizations.de.slug).length;
  console.log('OK - ' + (opsCat.length + opsProd.length) + ' slug(s) corrige(s). Controle categories : ' + restant + ' restant(s).');
  await mongoose.disconnect();
}

if (require.main === module) main().catch((e) => { console.error('\nECHEC', e.message); process.exit(1); });
