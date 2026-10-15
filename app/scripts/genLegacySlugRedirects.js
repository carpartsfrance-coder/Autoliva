/* Génère un fichier de mapping LEGACY_SLUG_REDIRECTS à partir des produits
 * dont le slug canonique commence par `boite-transfert-` (sans "de").
 *
 * Pour chaque produit, ajoute en mapping les variantes legacy avec "de-"
 * et les suffixes communs ("a-neuf-garantie-2-ans", etc.) — pour intercepter
 * les URLs encore indexées par Google qui mèneraient sinon à /produits?q=...
 *
 * Output : app/src/middlewares/legacySlugRedirects.js (commit-friendly)
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Product = require('../src/models/Product');

const APP_ROOT = path.resolve(__dirname, '..');

const SUFFIXES = [
  '',                                  // juste le préfixe "de-"
  '-a-neuf-garantie-2-ans',
  '-reconditionnee-a-neuf-garantie-2-ans',
  '-garantie-2-ans',
  '-a-neuf',
];

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  const products = await Product.find({
    slug: /^boite-transfert-/i,
    isPublished: { $ne: false },
  }).select('slug').lean();

  console.log(`${products.length} fiches "boite-transfert-..." trouvées\n`);

  const mappings = {};
  for (const p of products) {
    const canonical = `/product/${p.slug}/`;
    // Slug "boite-de-transfert-..." (insertion du "de-" après "boite-")
    const legacyBase = '/product/' + p.slug.replace(/^boite-transfert-/, 'boite-de-transfert-');
    for (const sfx of SUFFIXES) {
      const noSlash = legacyBase + sfx;
      mappings[noSlash] = canonical;
      mappings[noSlash + '/'] = canonical;
    }
  }

  const totalEntries = Object.keys(mappings).length;
  console.log(`Mapping généré : ${totalEntries} entrées (${products.length} produits × ${SUFFIXES.length * 2} variantes)`);

  // Format : module CommonJS exportable
  const header = `'use strict';

/**
 * Mapping legacy → canonical pour les fiches "boîte de transfert".
 *
 * Contexte : un sous-ensemble du catalogue a un slug canonique sans "de"
 * (boite-transfert-X) tandis que Google a historiquement indexé des variantes
 * avec "de" et parfois des suffixes longs ("a-neuf-garantie-2-ans"). Sans ce
 * mapping, ces URLs étaient capturées par le pattern dynamique de wpRedirects
 * et renvoyées vers /produits?q=... (page de recherche), perte de conversion.
 *
 * Généré automatiquement par scripts/genLegacySlugRedirects.js depuis la
 * collection Product. À régénérer après ajout/renommage de produits.
 *
 * Total : ${totalEntries} mappings statiques (${products.length} produits × ${SUFFIXES.length * 2} variantes).
 *
 * Last generated: ${new Date().toISOString()}
 */

module.exports = `;

  const body = JSON.stringify(mappings, null, 2) + ';\n';
  const out = header + body;

  const outPath = path.join(APP_ROOT, 'src/middlewares/legacySlugRedirects.js');
  fs.writeFileSync(outPath, out);
  console.log(`\n✅ Écrit : ${outPath}`);
  console.log(`Taille : ${(out.length / 1024).toFixed(1)} KB`);

  await mongoose.disconnect();
}
main().catch(e => { console.error(e); process.exit(1); });
