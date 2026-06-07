'use strict';
/* Job de traduction DE des fiches produit — remplit Product.localizations.de
 * via TA clé OpenAI. Reprend automatiquement (saute les fiches déjà traduites).
 *
 * Usage (depuis le dossier app, avec mongoose installé) :
 *   OPENAI_API_KEY="sk-..." MONGODB_URI="mongodb+srv://..." \
 *     node scripts/translate-products-de.js [options]
 *
 * Options :
 *   --limit N       ne traite que N fiches (ex. --limit 10 pour un lot)
 *   --dry-run       n'écrit RIEN en base ; sort un JSON local à relire
 *   --retranslate   retraduit aussi les fiches déjà traduites
 *   --model NAME    modèle OpenAI (défaut gpt-4o-mini ; gpt-4o pour +qualité)
 *   --ids a,b,c     ne traite que ces ObjectId
 * Env : CONCURRENCY (défaut 5).
 */
const fs = require('fs');
const mongoose = require('mongoose');
const translator = require('../src/services/productTranslator');

function flag(name) { return process.argv.includes(name); }
function opt(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}

(async () => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY manquante');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI manquante');

  const model = opt('--model', 'gpt-4o-mini');
  const limit = parseInt(opt('--limit', '0'), 10) || 0;
  const dryRun = flag('--dry-run');
  const retranslate = flag('--retranslate');
  const idsArg = opt('--ids', '');
  const concurrency = Math.max(1, parseInt(process.env.CONCURRENCY || '5', 10));

  await mongoose.connect(process.env.MONGODB_URI);
  const Product = require('../src/models/Product');

  const filter = {};
  if (idsArg) filter._id = { $in: idsArg.split(',').map((s) => s.trim()).filter(Boolean) };
  else if (!retranslate) filter['localizations.de.translatedAt'] = { $in: [null, undefined] };

  let query = Product.find(filter).select(
    'name shortDescription description keyPoints inclusions exclusions specs reconditioningSteps faqs seo'
  );
  if (limit) query = query.limit(limit);
  const products = await query.lean();

  console.log(`${products.length} fiche(s) à traduire — modèle ${model}${dryRun ? ' — DRY-RUN (aucune écriture)' : ''} — concurrence ${concurrency}\n`);
  if (!products.length) { await mongoose.disconnect(); return; }

  let done = 0, okCount = 0, errCount = 0;
  const dryOut = [];
  let cursor = 0;

  async function worker() {
    while (cursor < products.length) {
      const p = products[cursor++];
      try {
        const de = await translator.translateProduct(p, { apiKey, model });
        if (dryRun) dryOut.push({ id: String(p._id), nameFr: p.name, de });
        else await Product.updateOne({ _id: p._id }, { $set: { 'localizations.de': de } });
        okCount++;
      } catch (e) {
        errCount++;
        console.log(`✗ ${String(p.name || p._id).slice(0, 55)} → ${e.message}`);
      }
      done++;
      if (done % 10 === 0 || done === products.length) process.stdout.write(`\r… ${done}/${products.length} (ok ${okCount}, erreurs ${errCount})   `);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, products.length) }, worker));

  console.log(`\n\nTerminé : ${okCount} traduites, ${errCount} erreur(s).`);
  if (dryRun) {
    const out = require('os').homedir() + '/Downloads/translate-products-de-dryrun.json';
    fs.writeFileSync(out, JSON.stringify(dryOut, null, 2), 'utf8');
    console.log(`DRY-RUN → ${out} (rien modifié en base). Relis-le, puis relance SANS --dry-run.`);
  }
  await mongoose.disconnect();
})().catch((e) => { console.error('\n❌', e && e.message ? e.message : e); process.exit(1); });
