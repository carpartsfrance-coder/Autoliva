#!/usr/bin/env node
'use strict';

require('dotenv').config();

/**
 * Traduit les clés d'interface MANQUANTES d'un fichier de langue.
 *
 *   node scripts/translate-locale.js de --dry-run   → simulation
 *   node scripts/translate-locale.js de             → écrit dans src/locales/de.json
 *   node scripts/translate-locale.js en             → idem pour l'anglais
 *
 * ── Pourquoi cet outil ──────────────────────────────────────────────────────
 *
 * Les fiches produit étaient traduites, mais la page qui les entoure restait
 * en français : « Comment vos pièces sont reconditionnées », « Test sur banc
 * d'essai », « En stock »… Un visiteur allemand voyait un titre allemand dans
 * une page française. Ce n'était pas du texte en dur : 153 clés existaient
 * dans fr.json et manquaient simplement dans de.json.
 *
 * ── Le point important : le MÊME glossaire que les fiches ────────────────────
 *
 * On réutilise `GLOSSARY` de productTranslator. Sans ça, l'interface dirait
 * « instandgesetzt » pendant que les titres disent « generalüberholt » — la
 * même incohérence qu'on vient de corriger, mais entre le gabarit et le
 * contenu, donc encore plus visible.
 *
 * Les clés DÉJÀ traduites ne sont jamais touchées : on ne réécrit pas un
 * travail existant, et relancer le script est sans risque.
 */

const fs = require('fs');
const path = require('path');
const { GLOSSARY } = require('../src/services/productTranslator');

/* Appel direct : `callOpenAI` du traducteur de fiches impose sa propre
   consigne (celle des produits). Ici il nous faut celle de l'interface. */
async function appelOpenAI({ apiKey, system, user }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model: 'gpt-4o-mini',
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
    }),
  });
  if (!res.ok) throw new Error('OpenAI ' + res.status + ' ' + (await res.text()).slice(0, 300));
  return JSON.parse((await res.json()).choices[0].message.content);
}

const LANGUES = {
  de: { nom: 'allemand', marche: 'ALLEMAND' },
  en: { nom: 'anglais', marche: 'BRITANNIQUE / INTERNATIONAL' },
};

const LOT = 40; // clés par appel : assez pour le contexte, assez peu pour rester fiable

function flag(n) { return process.argv.includes(n); }

function consigne(langue) {
  const l = LANGUES[langue];
  const gloss = GLOSSARY.map(([fr, tr]) => `- « ${fr} » → ${tr}`).join('\n');
  return [
    `Tu traduis l'INTERFACE d'un site e-commerce de pièces auto FR→${langue.toUpperCase()},`,
    `pour le marché ${l.marche}.`,
    '',
    'RÈGLES STRICTES :',
    '1. Ce sont des libellés d\'interface : boutons, titres, étiquettes. Reste COURT —',
    '   une traduction plus longue que l\'original casse la mise en page.',
    '2. Ne traduis JAMAIS les codes, références, nombres, unités. Convertis « ch » en « PS ».',
    '3. Conserve EXACTEMENT les marqueurs de variables : %amount%, %days%, {{x}}, %s.',
    '   Ils sont remplacés par du code — les modifier casse l\'affichage.',
    '4. Conserve la ponctuation de structure (« : », « — », « ? ») et les majuscules initiales.',
    '5. Ton commercial naturel, pas du mot-à-mot.',
    '',
    ...(langue === 'de' ? ['GLOSSAIRE (obligatoire, mêmes mots que les fiches produit) :', gloss, ''] : []),
    'SORTIE : un JSON valide, EXACTEMENT les mêmes clés que l\'entrée, valeurs traduites.',
  ].join('\n');
}

(async () => {
  const langue = (process.argv[2] || '').toLowerCase();
  if (!LANGUES[langue]) {
    console.error('Usage : node scripts/translate-locale.js <de|en> [--dry-run]');
    process.exit(1);
  }
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) { console.error('❌ OPENAI_API_KEY manquante'); process.exit(1); }

  const dryRun = flag('--dry-run');
  const dir = path.join(__dirname, '..', 'src', 'locales');
  const fr = JSON.parse(fs.readFileSync(path.join(dir, 'fr.json'), 'utf8'));
  const cible = JSON.parse(fs.readFileSync(path.join(dir, `${langue}.json`), 'utf8'));

  const manquantes = Object.keys(fr).filter((k) => !(k in cible) && typeof fr[k] === 'string');
  if (!manquantes.length) { console.log(`Rien à faire : ${langue}.json est complet.`); return; }

  const volume = manquantes.reduce((n, k) => n + fr[k].length, 0);
  console.log(`${manquantes.length} clé(s) manquante(s) en ${LANGUES[langue].nom} — ${volume} caractères`
    + (dryRun ? ' — DRY-RUN (aucune écriture)' : ''));

  const traduites = {};
  for (let i = 0; i < manquantes.length; i += LOT) {
    const lot = manquantes.slice(i, i + LOT);
    const entree = {};
    for (const k of lot) entree[k] = fr[k];
    process.stdout.write(`… ${Math.min(i + LOT, manquantes.length)}/${manquantes.length}\r`);
    const res = await appelOpenAI({
      apiKey,
      system: consigne(langue),
      user: 'Traduis les VALEURS de ce JSON, en gardant EXACTEMENT les mêmes clés :\n'
        + JSON.stringify(entree, null, 2),
    });
    for (const k of lot) {
      if (typeof res[k] === 'string' && res[k].trim()) traduites[k] = res[k].trim();
    }
  }
  console.log(`\n${Object.keys(traduites).length} clé(s) traduite(s), ${manquantes.length - Object.keys(traduites).length} en échec.`);

  /* Contrôle des marqueurs de variables : une %amount% perdue casse
     l'affichage en silence sur la page. On le dit AVANT d'écrire. */
  const casses = [];
  for (const [k, v] of Object.entries(traduites)) {
    const attendus = (fr[k].match(/%[a-zA-Z_]+%|\{\{[^}]+\}\}/g) || []).sort();
    const obtenus = (v.match(/%[a-zA-Z_]+%|\{\{[^}]+\}\}/g) || []).sort();
    if (attendus.join('|') !== obtenus.join('|')) casses.push({ k, fr: fr[k], tr: v });
  }
  if (casses.length) {
    console.log(`\n⚠ ${casses.length} traduction(s) ont perdu ou modifié une variable — NON retenues :`);
    for (const c of casses.slice(0, 8)) {
      console.log(`  ${c.k}\n    FR : ${c.fr}\n    ${langue.toUpperCase()} : ${c.tr}`);
      delete traduites[c.k];
    }
  }

  console.log('\nAperçu :');
  for (const k of Object.keys(traduites).slice(0, 12)) {
    console.log(`  ${k.padEnd(32)} ${String(fr[k]).slice(0, 40).padEnd(42)} → ${traduites[k].slice(0, 46)}`);
  }

  if (dryRun) {
    console.log('\nDRY-RUN : rien écrit. Relance sans --dry-run pour appliquer.');
    return;
  }

  /* Fusion en conservant l'ordre de fr.json : les fichiers restent
     comparables ligne à ligne, ce qui rend les diffs lisibles. */
  const fusion = {};
  for (const k of Object.keys(fr)) {
    if (k in cible) fusion[k] = cible[k];
    else if (k in traduites) fusion[k] = traduites[k];
  }
  for (const k of Object.keys(cible)) if (!(k in fusion)) fusion[k] = cible[k];

  fs.writeFileSync(path.join(dir, `${langue}.json`), JSON.stringify(fusion, null, 2) + '\n', 'utf8');
  console.log(`\n✅ src/locales/${langue}.json mis à jour — ${Object.keys(fusion).length} clés au total.`);
})().catch((e) => { console.error('ÉCHEC :', e && e.message ? e.message : e); process.exit(1); });
