// ---------------------------------------------------------------------------
// migrate-brand-leak.js
//
// Nettoie les chaînes "Car Parts France" / "CarParts France" / domaine legacy
// résiduelles dans MongoDB après le rebranding vers Autoliva.
//
// Champs traités :
//   - SiteSettings.aboutText, promoBannerText, promoBannerCode
//   - Product.seo.metaTitle, seo.metaDescription, name, description,
//     shortDescription
//   - BlogPost.seo.metaTitle, seo.metaDescription, title, excerpt
//   - Category.seoText
//   - LegalPage.contentHtml, contentMarkdown
//
// Usage :
//   node scripts/migrate-brand-leak.js              # dry-run (lecture seule)
//   node scripts/migrate-brand-leak.js --apply      # applique les changements
//   node scripts/migrate-brand-leak.js --apply -v   # verbose : affiche les diffs
//
// Variables requises :
//   - MONGODB_URI                    (cible la base à nettoyer)
//   - BRAND=autoliva                 (utilisé pour déterminer la cible NAME)
//
// Ne touche pas la DB legacy (BRAND=carpartsfrance) — sortie 1.
// ---------------------------------------------------------------------------

require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const VERBOSE = process.argv.includes('-v') || process.argv.includes('--verbose');

(async () => {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI manquant.');
    process.exit(1);
  }

  const brand = require('../src/config/brand');
  if (brand.KEY !== 'autoliva') {
    console.error(`[migrate-brand-leak] BRAND=${brand.KEY} — ce script ne s'exécute que pour BRAND=autoliva.`);
    console.error('Définissez BRAND=autoliva dans l\'env avant de relancer.');
    process.exit(1);
  }

  const { sanitizeBrandLeak } = require('../src/services/brandSanitizer');

  await mongoose.connect(process.env.MONGODB_URI);

  console.log(`[migrate-brand-leak] BRAND=${brand.KEY} — cible : "${brand.NAME}"`);
  console.log(`[migrate-brand-leak] Mode : ${APPLY ? 'APPLY (écriture)' : 'DRY-RUN (lecture seule)'}\n`);

  let totalScanned = 0;
  let totalUpdated = 0;

  /* ─── helper générique ──────────────────────────────────────────────── */

  async function migrateCollection(label, Model, fieldsString, fieldsHtml = []) {
    const all = [...fieldsString, ...fieldsHtml];
    const filterOr = all.map((f) => ({
      [f]: { $regex: /Car ?Parts France|carpartsfrance\.fr/i },
    }));
    const docs = await Model.find({ $or: filterOr }).lean();
    totalScanned += docs.length;

    if (docs.length === 0) {
      console.log(`[${label}] 0 doc à nettoyer.`);
      return;
    }
    console.log(`[${label}] ${docs.length} doc(s) à nettoyer.`);

    for (const doc of docs) {
      const update = {};
      for (const f of all) {
        const before = getNested(doc, f);
        if (typeof before !== 'string' || !before) continue;
        const after = sanitizeBrandLeak(before);
        if (after !== before) {
          setNested(update, f, after);
          if (VERBOSE) {
            const idTxt = doc.slug || doc.numero || doc._id;
            console.log(`  · [${label}/${idTxt}] ${f} :`);
            console.log(`      AVANT : ${truncate(before, 90)}`);
            console.log(`      APRÈS : ${truncate(after, 90)}`);
          }
        }
      }
      if (Object.keys(update).length === 0) continue;

      if (APPLY) {
        await Model.updateOne({ _id: doc._id }, { $set: flattenForSet(update) });
      }
      totalUpdated += 1;
    }
  }

  function getNested(obj, path) {
    return path.split('.').reduce((o, k) => (o == null ? undefined : o[k]), obj);
  }

  function setNested(obj, path, value) {
    const keys = path.split('.');
    let cur = obj;
    for (let i = 0; i < keys.length - 1; i += 1) {
      const k = keys[i];
      if (typeof cur[k] !== 'object' || cur[k] === null) cur[k] = {};
      cur = cur[k];
    }
    cur[keys[keys.length - 1]] = value;
  }

  function flattenForSet(obj, prefix = '', acc = {}) {
    for (const k of Object.keys(obj)) {
      const val = obj[k];
      const key = prefix ? `${prefix}.${k}` : k;
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        flattenForSet(val, key, acc);
      } else {
        acc[key] = val;
      }
    }
    return acc;
  }

  function truncate(s, n) {
    if (s.length <= n) return s;
    return s.slice(0, n) + '…';
  }

  /* ─── 1) SiteSettings ──────────────────────────────────────────────── */
  try {
    const SiteSettings = require('../src/models/SiteSettings');
    await migrateCollection('SiteSettings', SiteSettings, [
      'aboutText',
      'aboutTitle',
      'promoBannerText',
      'promoBannerCode',
    ]);
  } catch (err) {
    console.error('[SiteSettings] erreur ignorée :', err.message);
  }

  /* ─── 2) Product ───────────────────────────────────────────────────── */
  try {
    const Product = require('../src/models/Product');
    await migrateCollection('Product', Product, [
      'name',
      'shortDescription',
      'seo.metaTitle',
      'seo.metaDescription',
    ], [
      'description',
    ]);
  } catch (err) {
    console.error('[Product] erreur ignorée :', err.message);
  }

  /* ─── 3) BlogPost ──────────────────────────────────────────────────── */
  try {
    const BlogPost = require('../src/models/BlogPost');
    await migrateCollection('BlogPost', BlogPost, [
      'title',
      'excerpt',
      'seo.metaTitle',
      'seo.metaDescription',
    ], [
      'contentHtml',
      'contentMarkdown',
    ]);
  } catch (err) {
    console.error('[BlogPost] erreur ignorée :', err.message);
  }

  /* ─── 4) Category ──────────────────────────────────────────────────── */
  try {
    const Category = require('../src/models/Category');
    await migrateCollection('Category', Category, [
      'name',
      'seoText',
    ]);
  } catch (err) {
    console.error('[Category] erreur ignorée :', err.message);
  }

  /* ─── 5) LegalPage ─────────────────────────────────────────────────── */
  try {
    const LegalPage = require('../src/models/LegalPage');
    await migrateCollection('LegalPage', LegalPage, [
      'title',
    ], [
      'contentHtml',
      'contentMarkdown',
    ]);
  } catch (err) {
    console.error('[LegalPage] erreur ignorée :', err.message);
  }

  console.log('\n──────────────────────────────────────');
  console.log(`Total scanné : ${totalScanned} doc(s)`);
  console.log(`Total ${APPLY ? 'mis à jour' : 'à mettre à jour'} : ${totalUpdated} doc(s)`);
  if (!APPLY && totalUpdated > 0) {
    console.log('\nRelancez avec --apply pour appliquer les changements.');
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('[migrate-brand-leak] erreur fatale :', err);
  process.exit(1);
});
