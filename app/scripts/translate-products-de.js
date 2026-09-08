'use strict';

/* Charge .env comme les autres scripts du projet : sans ça il fallait
   repasser OPENAI_API_KEY et MONGODB_URI à la main sur chaque appel. */
require('dotenv').config();
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
 *   --ids-file F    idem, mais lit les ObjectId dans un fichier (un par ligne).
 *                   Sert à ne repasser QUE les fiches abîmées plutôt que de
 *                   refacturer le catalogue entier.
 * Env : CONCURRENCY (défaut 5).
 */
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const translator = require('../src/services/productTranslator');
/* Les tables de vocabulaire priment sur le modèle : elles sont relues et
   stables, lui ne l'est pas. Sans ça, `$set: localizations.de` écrasait des
   pastilles déjà correctes par ce que le modèle avait bien voulu produire. */
const { etatFr, etatDe } = require('./fix-badges-de');
const TABLE_BADGES = JSON.parse(fs.readFileSync(path.join(__dirname, 'badges-de.json'), 'utf8'));
const TABLE_DELAIS = JSON.parse(fs.readFileSync(path.join(__dirname, 'delais-de.json'), 'utf8'));

/* Réapplique le vocabulaire validé par-dessus la sortie du modèle. */
function appliquerTables(de, fr) {
  const t = (s) => (s && TABLE_BADGES[String(s).trim()]) || '';
  const b = fr.badges || {};
  if (b.topLeft || b.condition || (Array.isArray(b.cards) && b.cards.length)) {
    de.badges = de.badges && typeof de.badges === 'object' ? de.badges : {};
    if (b.topLeft) de.badges.topLeft = t(b.topLeft) || de.badges.topLeft || b.topLeft;
    if (b.condition) de.badges.condition = t(b.condition) || de.badges.condition || b.condition;
    if (Array.isArray(b.cards) && b.cards.length) de.badges.cards = b.cards.map((c) => t(c) || c);
  }
  const d = TABLE_DELAIS[String(fr.shippingDelayText || '').trim()];
  if (d) de.shippingDelayText = d;
  return de;
}

/* Garde-fou d'état.
 *
 * La règle n'est pas « les deux langues doivent dire la même chose » mais
 * « l'allemand ne doit jamais promettre PLUS que le français ». La nuance
 * compte : une partie du catalogue français est déjà incohérente avec
 * elle-même — des pièces titrées « neuf » dont la description dit « en
 * échange standard, reconditionné ». Exiger l'égalité bloquait ces fiches
 * sur une faute qui n'est pas celle du traducteur, et les laissait avec
 * leur ANCIENNE traduction, elle vraiment fausse.
 *
 * On compare donc sur le TITRE, là où la promesse est faite et où la
 * pastille s'affiche, et on ne refuse que la surenchère. */
const RANG = { occasion: 1, 'reconditionné': 2, neuf: 3 };

function etatIncoherent(de, fr) {
  const ref = etatFr((fr.badges && fr.badges.condition) || '') || etatFr(fr.name || '');
  if (!ref) return '';
  const titre = etatDe(de.name || '');
  if (!titre) return '';
  if (RANG[titre] > RANG[ref]) return `titre DE « ${titre} » > état réel « ${ref} »`;
  return '';
}

function flag(name) { return process.argv.includes(name); }
function opt(name, def) {
  const i = process.argv.indexOf(name);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[i + 1] : def;
}

/* Nommée et appelée seulement en exécution directe : en IIFE anonyme, un
   simple `require` de ce fichier lançait une traduction — et sa facture. */
async function main() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY manquante');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI manquante');

  const model = opt('--model', 'gpt-4o-mini');
  const limit = parseInt(opt('--limit', '0'), 10) || 0;
  const dryRun = flag('--dry-run');
  const retranslate = flag('--retranslate');
  let idsArg = opt('--ids', '');
  const idsFile = opt('--ids-file', '');
  if (idsFile) {
    idsArg = fs.readFileSync(idsFile, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean).join(',');
  }
  const concurrency = Math.max(1, parseInt(process.env.CONCURRENCY || '5', 10));

  await mongoose.connect(process.env.MONGODB_URI);
  const Product = require('../src/models/Product');

  const filter = {};
  if (idsArg) filter._id = { $in: idsArg.split(',').map((s) => s.trim()).filter(Boolean) };
  else if (!retranslate) filter['localizations.de.translatedAt'] = { $in: [null, undefined] };

  let query = Product.find(filter).select(
    /* `badges` et `shippingDelayText` étaient absents de cette projection : le
       traducteur ne pouvait donc PAS les traduire, et la fiche allemande
       gardait une pastille « Reconditionné » en français sous un titre
       traduit. Le schéma et la surcouche les prévoyaient pourtant tous les
       deux — la chaîne était coupée ici, au chargement. */
    'name shortDescription description keyPoints inclusions exclusions specs '
    + 'reconditioningSteps faqs seo badges shippingDelayText'
  );
  if (limit) query = query.limit(limit);
  const products = await query.lean();

  console.log(`${products.length} fiche(s) à traduire — modèle ${model}${dryRun ? ' — DRY-RUN (aucune écriture)' : ''} — concurrence ${concurrency}\n`);
  if (!products.length) { await mongoose.disconnect(); return; }

  let done = 0, okCount = 0, errCount = 0, refusCount = 0;
  const dryOut = [];
  let cursor = 0;

  async function worker() {
    while (cursor < products.length) {
      const p = products[cursor++];
      try {
        const de = appliquerTables(await translator.translateProduct(p, { apiKey, model }), p);
        const conflit = etatIncoherent(de, p);
        if (conflit) {
          refusCount++;
          console.log(`⚠ état refusé — ${conflit} — ${String(p.name || p._id).slice(0, 50)}`);
          done++;
          continue;
        }
        if (dryRun) dryOut.push({ id: String(p._id), nameFr: p.name, de });
        else await Product.updateOne({ _id: p._id }, { $set: { 'localizations.de': de } });
        okCount++;
      } catch (e) {
        errCount++;
        console.log(`✗ ${String(p.name || p._id).slice(0, 55)} → ${e.message}`);
      }
      done++;
      if (done % 10 === 0 || done === products.length) process.stdout.write(`\r… ${done}/${products.length} (ok ${okCount}, refus ${refusCount}, erreurs ${errCount})   `);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, products.length) }, worker));

  console.log(`\n\nTerminé : ${okCount} traduites, ${refusCount} refusée(s) pour incohérence d'état, ${errCount} erreur(s).`);
  if (dryRun) {
    const out = require('os').homedir() + '/Downloads/translate-products-de-dryrun.json';
    fs.writeFileSync(out, JSON.stringify(dryOut, null, 2), 'utf8');
    console.log(`DRY-RUN → ${out} (rien modifié en base). Relis-le, puis relance SANS --dry-run.`);
  }
  await mongoose.disconnect();
}

module.exports = { main };

if (require.main === module) {
  main().catch((e) => { console.error('\n❌', e && e.message ? e.message : e); process.exit(1); });
}
