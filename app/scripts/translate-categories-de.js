'use strict';
/* Traduction DE des catégories (name + seoText) → Category.localizations.de.
 * Réutilise l'infra OpenAI du traducteur produits (même glossaire/prompt).
 *
 * Usage (depuis le dossier app) :
 *   OPENAI_API_KEY="sk-..." MONGODB_URI="mongodb+srv://..." \
 *     node scripts/translate-categories-de.js [--limit N] [--dry-run] [--retranslate] [--model gpt-4o]
 */
const fs = require('fs');
const mongoose = require('mongoose');
const translator = require('../src/services/productTranslator');

const flag = (n) => process.argv.includes(n);
const opt = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };

(async () => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY manquante');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI manquante');
  const model = opt('--model', 'gpt-4o-mini');
  const limit = parseInt(opt('--limit', '0'), 10) || 0;
  const dryRun = flag('--dry-run');
  const retranslate = flag('--retranslate');

  await mongoose.connect(process.env.MONGODB_URI);
  const Category = require('../src/models/Category');

  const filter = retranslate ? {} : { 'localizations.de.translatedAt': { $in: [null, undefined] } };
  let query = Category.find(filter).select('name slug seoText');
  if (limit) query = query.limit(limit);
  const cats = await query.lean();

  console.log(`${cats.length} catégorie(s) à traduire — modèle ${model}${dryRun ? ' — DRY-RUN' : ''}\n`);
  if (!cats.length) { await mongoose.disconnect(); return; }

  let ok = 0, err = 0; const dry = [];
  for (const c of cats) {
    try {
      const fields = {};
      if (c.name) fields.name = c.name;
      if (typeof c.seoText === 'string' && c.seoText.trim()) fields.seoText = c.seoText;
      const de = await translator.callOpenAI(fields, { apiKey, model });
      const out = {
        name: (typeof de.name === 'string' && de.name.trim()) ? de.name : c.name,
        seoText: (typeof de.seoText === 'string') ? de.seoText : (c.seoText || ''),
        slug: translator.germanSlug(de.name || c.name),
        translatedAt: new Date(),
        translatedBy: 'openai:' + model,
      };
      if (dryRun) dry.push({ slug: c.slug, fr: c.name, de: out.name, deSlug: out.slug });
      else await Category.updateOne({ _id: c._id }, { $set: { 'localizations.de': out } });
      ok++;
      process.stdout.write(`\r… ${ok + err}/${cats.length} (ok ${ok}, err ${err})   `);
    } catch (e) {
      err++; console.log(`\n✗ ${String(c.name || c.slug).slice(0, 50)} → ${e.message}`);
    }
  }
  console.log(`\n\nTerminé : ${ok} traduites, ${err} erreur(s).`);
  if (dryRun) {
    const p = require('os').homedir() + '/Downloads/translate-categories-de-dryrun.json';
    fs.writeFileSync(p, JSON.stringify(dry, null, 2), 'utf8');
    console.log('DRY-RUN → ' + p);
  }
  await mongoose.disconnect();
})().catch((e) => { console.error('\n❌', e && e.message ? e.message : e); process.exit(1); });
