'use strict';

/* Traduction DE des pages légales (mentions, CGV, CGU, confidentialité…).
 *
 * Ces textes engagent l'entreprise : on prend gpt-4o plutôt que mini, et on
 * refuse d'écrire une traduction qui aurait perdu une donnée vérifiable —
 * SIREN, numéro de TVA, adresse, e-mail. Une clause mal traduite se répare ;
 * un numéro de TVA faux dans un Impressum, non.
 *
 * ⚠️ Une traduction n'est pas une mise en conformité. Le droit allemand a ses
 * propres exigences (Impressum § 5 TMG, Widerrufsbelehrung § 312d BGB) que le
 * texte français ne couvre pas forcément. Faire relire.
 *
 * Usage :
 *   node scripts/translate-legal-de.js              # essai à blanc
 *   node scripts/translate-legal-de.js --appliquer
 */

require('dotenv').config();
const mongoose = require('mongoose');
const translator = require('../src/services/productTranslator');

const MODELE = 'gpt-4o';

/* Ce qui doit se retrouver À L'IDENTIQUE dans la version allemande. */
const INVARIANTS = [
  /\b\d{3}\s?\d{3}\s?\d{3}\b/g,          // SIREN
  /\bFR\d{11}\b/g,                        // TVA intracommunautaire
  /[\w.+-]+@[\w.-]+\.\w+/g,               // e-mails
  /\b0\d[\s.]?(?:\d{2}[\s.]?){4}\b/g,     // téléphones FR
  /\b\d{5}\b/g,                           // codes postaux
];

function donneesVerifiables(texte) {
  const out = new Set();
  for (const re of INVARIANTS) {
    for (const m of String(texte || '').matchAll(re)) out.add(m[0].replace(/\s/g, ''));
  }
  return out;
}

async function main() {
  const appliquer = process.argv.includes('--appliquer');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI manquante');
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY manquante');

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  const LegalPage = require('../src/models/LegalPage');

  const pages = await LegalPage.find({}).lean();
  console.log(pages.length + ' page(s)' + (appliquer ? '' : ' — ESSAI À BLANC') + ', modèle ' + MODELE + '\n');

  let ok = 0; let refus = 0;
  for (const page of pages) {
    const source = { title: page.title || '', content: page.content || '' };
    if (!source.content.trim()) { console.log('  — ' + page.slug + ' : vide, ignorée'); continue; }

    let de;
    try {
      de = await translator._impl.callOpenAI(source, { apiKey, model: MODELE });
    } catch (e) {
      console.log('  ✗ ' + page.slug + ' : ' + e.message);
      continue;
    }

    const attendues = donneesVerifiables(source.content);
    const obtenues = donneesVerifiables(de && de.content);
    const perdues = [...attendues].filter((v) => !obtenues.has(v));
    if (perdues.length) {
      refus++;
      console.log('  ⚠ ' + page.slug + ' : données perdues → ' + perdues.slice(0, 5).join(', ') + ' — NON écrite');
      continue;
    }

    console.log('  ✓ ' + page.slug + ' → « ' + String(de.title || '').slice(0, 55) + ' » ('
      + String(de.content || '').length + ' car., ' + attendues.size + ' donnée(s) préservée(s))');
    ok++;

    if (appliquer) {
      await LegalPage.updateOne({ _id: page._id }, {
        $set: {
          'localizations.de.title': de.title || page.title,
          'localizations.de.content': de.content,
          'localizations.de.translatedAt': new Date(),
          'localizations.de.translatedBy': MODELE,
          'localizations.de.reviewedAt': null,
        },
      });
    }
  }

  console.log('\n' + ok + ' traduite(s), ' + refus + ' refusée(s) pour perte de donnée.');
  if (!appliquer) console.log('Rien écrit. Relance avec --appliquer.');
  else console.log('⚠️ Traduction ≠ conformité : faire relire l’Impressum et la Widerrufsbelehrung.');
  await mongoose.disconnect();
}

if (require.main === module) {
  main().catch((e) => { console.error('\n❌', e && e.message ? e.message : e); process.exit(1); });
}
