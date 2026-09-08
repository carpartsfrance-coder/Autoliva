'use strict';

/* Reecrit les meta titles et descriptions allemands qui depassent la limite.
 *
 * L'allemand est 7 a 12 % plus long que le francais. Les metas francaises
 * avaient ete taillees pour tenir : 79 titres sur 9 931 depassaient 60
 * caracteres. Traduites sans consigne de longueur, elles sont 3 558 a
 * depasser — et 7 273 descriptions a depasser 160.
 *
 * Google COUPE la fin. Or la fin, sur ce catalogue, c'est la reference OEM :
 * la seule chose qui distingue deux fiches de la meme gamme. « Turbo
 * generalueberholt im Austausch » revient a l'identique sur 54 fiches ; ce qui
 * les separe, c'est ce qu'on perd.
 *
 * On ne retraduit PAS la fiche : on ne renvoie que les deux champs SEO, avec
 * le titre allemand pour contexte. Charge utile minuscule.
 *
 *   node scripts/recadrer-metas-de.js              # compte et estime
 *   node scripts/recadrer-metas-de.js --appliquer
 *   --limit N   pour un essai sur un echantillon
 */

require('dotenv').config();
const mongoose = require('mongoose');
const translator = require('../src/services/productTranslator');

const MAX_TITRE = 60;
const MAX_DESC = 160;
const MODELE = 'gpt-4o-mini';

function opt(n, d) {
  const i = process.argv.indexOf(n);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
}

const SYSTEME = [
  'Tu es specialiste du referencement pour un vendeur allemand de pieces automobiles.',
  'On te donne le titre allemand d\'une fiche produit et ses metadonnees actuelles, trop longues.',
  '',
  'Reecris-les en allemand en respectant STRICTEMENT :',
  '  • metaTitle : ' + MAX_TITRE + ' caracteres MAXIMUM ;',
  '  • metaDescription : ' + MAX_DESC + ' caracteres MAXIMUM.',
  '',
  'Regles :',
  '  1. La REFERENCE (OEM, code moteur, code boite) et le VEHICULE passent en PREMIER.',
  '     C\'est ce que le client tape dans Google, et c\'est ce que la coupure faisait perdre.',
  '  2. Ne alterez JAMAIS une reference : chiffres et lettres a l\'identique.',
  '  3. Coupe les mots de remplissage, pas l\'information.',
  '  4. Garde le vocabulaire du metier : generaluberholt, im Austausch, Getriebe, Motor.',
  '  5. N\'invente aucune garantie ni aucun delai qui ne soit pas deja dans le texte.',
  '',
  'Reponds UNIQUEMENT par un JSON : {"metaTitle": "...", "metaDescription": "..."}',
].join('\n');

async function reecrire(fiche, apiKey) {
  const de = fiche.localizations.de;
  const entree = JSON.stringify({
    produit: de.name || '',
    metaTitle: (de.seo && de.seo.metaTitle) || '',
    metaDescription: (de.seo && de.seo.metaDescription) || '',
  });
  const out = await translator._impl.callOpenAI({ __raw: entree }, { apiKey, model: MODELE, systemPrompt: SYSTEME });
  return out;
}

async function main() {
  const appliquer = process.argv.includes('--appliquer');
  const limite = Number(opt('--limit', 0)) || 0;
  const apiKey = process.env.OPENAI_API_KEY;
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  const Product = require('../src/models/Product');

  const tous = await Product.find({
    isPublished: true,
    'localizations.de.translatedAt': { $ne: null },
  }).select('localizations.de.name localizations.de.seo').lean();

  const aFaire = tous.filter((p) => {
    const seo = (p.localizations.de.seo) || {};
    return String(seo.metaTitle || '').length > MAX_TITRE
      || String(seo.metaDescription || '').length > MAX_DESC;
  });
  const lot = limite ? aFaire.slice(0, limite) : aFaire;

  console.log(aFaire.length + ' fiche(s) hors limite sur ' + tous.length + '.');
  console.log('Estimation : ~' + Math.round(aFaire.length * 0.00011 * 100) / 100 + ' $ (' + MODELE + ').');
  if (!appliquer) {
    console.log('\nRien appele, rien ecrit. Relance avec --appliquer.');
    await mongoose.disconnect();
    return;
  }

  let ok = 0; let refus = 0; let ko = 0; let curseur = 0;
  const CONCURRENCE = Number(process.env.CONCURRENCY || 12);

  async function ouvrier() {
    while (curseur < lot.length) {
    const i = curseur++;
    const p = lot[i];
    try {
      const r = await reecrire(p, apiKey);
      let t = translator.clampSeo(String((r && r.metaTitle) || ''), MAX_TITRE);
      let d = translator.clampSeo(String((r && r.metaDescription) || ''), MAX_DESC);
      if (!t || !d) { ko++; continue; }

      /* Garde-fou : une reference perdue est pire qu'une meta trop longue.
         Si le modele a laisse tomber un code present dans le titre produit,
         on garde l'ancienne meta plutot que d'en publier une amputee. */
      const codes = String(p.localizations.de.name || '').match(/\b[A-Z0-9]{4,}\b/g) || [];
      const ancienTitre = (p.localizations.de.seo || {}).metaTitle || '';
      const codesAncien = codes.filter((c) => ancienTitre.includes(c));
      if (codesAncien.length && !codesAncien.some((c) => t.includes(c))) {
        refus++;
        continue;
      }

      await Product.updateOne({ _id: p._id }, {
        $set: { 'localizations.de.seo.metaTitle': t, 'localizations.de.seo.metaDescription': d },
      });
      ok++;
    } catch (e) {
      ko++;
    }
    if ((i + 1) % 250 === 0) console.log('   ' + (i + 1) + '/' + lot.length + ' — ' + ok + ' ok, ' + refus + ' refus, ' + ko + ' echecs');
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCE, lot.length) }, ouvrier));
  console.log('\nOK - ' + ok + ' recadree(s), ' + refus + ' refusee(s) (reference perdue), ' + ko + ' echec(s).');
  await mongoose.disconnect();
}

if (require.main === module) main().catch((e) => { console.error('\nECHEC', e.message); process.exit(1); });
