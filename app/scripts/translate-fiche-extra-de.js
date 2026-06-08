'use strict';
/* Traduction DE CIBLÉE des champs fiche ajoutés au calque en Phase B :
 *   - shippingDelayText  (ex. « Expédition sous 2 semaines »)
 *   - badges.topLeft / badges.condition / badges.cards (badges libres admin)
 * → Product.localizations.de.{shippingDelayText,badges}
 *
 * Ne touche PAS aux traductions existantes (name/description/specs/faqs…) :
 * on ne remplit QUE les nouveaux champs. Idempotent (skip si déjà rempli,
 * sauf --force).
 *
 * Usage (depuis le dossier app) :
 *   OPENAI_API_KEY="sk-..." MONGODB_URI="mongodb+srv://..." \
 *     node scripts/translate-fiche-extra-de.js [--limit N] [--dry-run] [--force] [--model gpt-4o]
 */
const fs = require('fs');
const mongoose = require('mongoose');
const translator = require('../src/services/productTranslator');

const flag = (n) => process.argv.includes(n);
const opt = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : d; };
const nstr = (v) => typeof v === 'string' && v.trim();
const narr = (v) => Array.isArray(v) && v.length > 0;

(async () => {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY manquante');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI manquante');
  const model = opt('--model', 'gpt-4o-mini');
  const limit = parseInt(opt('--limit', '0'), 10) || 0;
  const dryRun = flag('--dry-run');
  const force = flag('--force');

  await mongoose.connect(process.env.MONGODB_URI);
  const Product = require('../src/models/Product');

  // Produits déjà traduits qui ont un délai ou des badges à localiser.
  const filter = {
    'localizations.de.translatedAt': { $ne: null },
    $or: [
      { shippingDelayText: { $nin: [null, ''] } },
      { 'badges.topLeft': { $nin: [null, ''] } },
      { 'badges.condition': { $nin: [null, ''] } },
      { 'badges.cards.0': { $exists: true } },
    ],
  };
  let query = Product.find(filter).select('name shippingDelayText badges localizations.de.shippingDelayText localizations.de.badges');
  if (limit) query = query.limit(limit);
  const docs = await query.lean();

  console.log(`${docs.length} fiche(s) avec délai/badges à localiser — ${model}${dryRun ? ' — DRY-RUN' : ''}${force ? ' — FORCE' : ''}\n`);
  if (!docs.length) { await mongoose.disconnect(); return; }

  let ok = 0, skip = 0, err = 0; const dry = [];
  for (const d of docs) {
    const deExisting = (d.localizations && d.localizations.de) || {};
    if (!force && (nstr(deExisting.shippingDelayText) || (deExisting.badges && (nstr(deExisting.badges.topLeft) || narr(deExisting.badges.cards))))) { skip++; continue; }
    const badges = d.badges || {};
    const fields = {};
    if (nstr(d.shippingDelayText)) fields.shippingDelayText = d.shippingDelayText.trim();
    if (nstr(badges.topLeft)) fields.badgeTopLeft = badges.topLeft.trim();
    if (nstr(badges.condition)) fields.badgeCondition = badges.condition.trim();
    if (narr(badges.cards)) fields.badgeCards = badges.cards.map((s) => String(s || '').trim()).filter(Boolean);
    if (!Object.keys(fields).length) { skip++; continue; }
    try {
      const de = await translator.callOpenAI(fields, { apiKey, model });
      const set = {};
      if (fields.shippingDelayText && nstr(de.shippingDelayText)) set['localizations.de.shippingDelayText'] = de.shippingDelayText.trim();
      const deBadges = {};
      if (fields.badgeTopLeft && nstr(de.badgeTopLeft)) deBadges.topLeft = de.badgeTopLeft.trim();
      if (fields.badgeCondition && nstr(de.badgeCondition)) deBadges.condition = de.badgeCondition.trim();
      if (narr(fields.badgeCards) && Array.isArray(de.badgeCards) && de.badgeCards.length === fields.badgeCards.length) {
        deBadges.cards = de.badgeCards.map((v, i) => (nstr(v) ? v.trim() : fields.badgeCards[i]));
      }
      if (Object.keys(deBadges).length) set['localizations.de.badges'] = deBadges;
      if (!Object.keys(set).length) { skip++; continue; }
      if (dryRun) dry.push({ name: String(d.name).slice(0, 40), set });
      else await Product.updateOne({ _id: d._id }, { $set: set });
      ok++;
      process.stdout.write(`\r… ${ok + err + skip}/${docs.length} (ok ${ok}, skip ${skip}, err ${err})   `);
    } catch (e) {
      err++; console.log(`\n✗ ${String(d.name || '').slice(0, 45)} → ${e.message}`);
    }
  }
  console.log(`\n\nTerminé : ${ok} localisées, ${skip} ignorées, ${err} erreur(s).`);
  if (dryRun) {
    const p = require('os').homedir() + '/Downloads/translate-fiche-extra-de-dryrun.json';
    fs.writeFileSync(p, JSON.stringify(dry, null, 2), 'utf8');
    console.log('DRY-RUN → ' + p);
  }
  await mongoose.disconnect();
})().catch((e) => { console.error('\n❌', e && e.message ? e.message : e); process.exit(1); });
