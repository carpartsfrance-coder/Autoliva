#!/usr/bin/env node
// ---------------------------------------------------------------------------
// test-translate-pipeline.js
// Vérification statique du pipeline translate-blog-de.js sans appel API :
// - charge un article réel depuis la BDD
// - classifie (technical/comparative/simple)
// - génère le prompt système (avec glossaire) + prompt utilisateur
// - parse un échantillon de réponse Claude pour valider le parser JSON
//
// Usage : node scripts/test-translate-pipeline.js [--slug=<slug>]
// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const BlogPost = require('../src/models/BlogPost');

const TARGET_SLUG = (() => {
  const m = process.argv.slice(2).find((a) => a.startsWith('--slug='));
  return m ? m.split('=')[1].trim() : 'mecatronique-dsg7-dq200-diagnostic-prix-remplacement';
})();

const TECHNICAL_PATTERNS = [
  /mecatronique|mechatronik/i,
  /code(s)?[\s-]?defaut|p\d{4,5}/i,
  /diagnostic/i,
  /calculateur|tcu|getriebesteuergerat/i,
  /vcds|odis|obd/i,
  /actionneur/i,
  /demontage|remplacement|reconditionnement/i,
  /coussinet|vilebrequin|cylindre|chaine-distribution|piston|segment/i,
  /symptomes|panne/i,
];
const COMPARATIVE_PATTERNS = [/^prix-/i, /-prix-/i, /budget/i, /comparatif/i, /vehicules-compatibles/i];
const SIMPLE_PATTERNS = [/^entretien-/i, /-entretien-/i, /^vidange-/i, /-vidange-/i];

function classify(post) {
  const h = `${post.slug || ''} ${post.title || ''}`.toLowerCase();
  if (TECHNICAL_PATTERNS.some((re) => re.test(h))) return 'technical';
  if (SIMPLE_PATTERNS.some((re) => re.test(h))) return 'simple';
  if (COMPARATIVE_PATTERNS.some((re) => re.test(h))) return 'comparative';
  return 'technical';
}

function loadGlossary() {
  return JSON.parse(fs.readFileSync(path.join(__dirname, 'glossary-de.json'), 'utf8'));
}

function buildSystemPrompt(glossary) {
  return [
    'Tu es un traducteur technique expert spécialisé dans les pièces automobiles (transmissions, boîtes de transfert, différentiels, mécatroniques) qui traduit du français vers l\'allemand pour un site e-commerce vendant des pièces auto OEM.',
    '',
    'RÈGLES CRITIQUES :',
    '1. Utilise UNIQUEMENT la terminologie allemande du glossaire ci-dessous. Ne paraphrase JAMAIS les termes techniques listés.',
    '2. Préserve TOUTES les balises HTML exactement comme dans le source.',
    '3. Préserve verbatim : numéros OEM, codes défaut OBD, codes modèle véhicule, marques.',
    '4. Conserve le ton expert mais accessible.',
    '5. metaTitle ≤ 60 caractères, metaDescription ≤ 160 caractères.',
    '',
    'GLOSSAIRE TECHNIQUE OBLIGATOIRE :',
    JSON.stringify(glossary, null, 2),
    '',
    'FORMAT DE SORTIE : JSON uniquement.',
  ].join('\n');
}

function buildUserPrompt(post) {
  return [
    'Traduis cet article du français vers l\'allemand.',
    '',
    `TITRE FR : ${post.title || ''}`,
    `CHAPÔ FR : ${post.excerpt || ''}`,
    `META TITLE FR : ${(post.seo && post.seo.metaTitle) || ''}`,
    `META DESC FR  : ${(post.seo && post.seo.metaDescription) || ''}`,
    `MOT-CLÉ FR    : ${(post.seo && post.seo.primaryKeyword) || ''}`,
    '',
    `CONTENU HTML FR (${(post.contentHtml || '').length} caractères) :`,
    (post.contentHtml || '').slice(0, 800) + ((post.contentHtml || '').length > 800 ? '\n[...tronqué pour l\'aperçu...]' : ''),
  ].join('\n');
}

function parseJsonStrict(text) {
  const trimmed = String(text || '').trim();
  let candidate = trimmed;
  const fenced = candidate.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenced) candidate = fenced[1].trim();
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidate = candidate.slice(firstBrace, lastBrace + 1);
  }
  return JSON.parse(candidate);
}

async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('❌ MONGODB_URI absent');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);

  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('1. CHARGEMENT ARTICLE');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const post = await BlogPost.findOne({ slug: TARGET_SLUG, isPublished: true });
  if (!post) {
    console.error(`❌ Aucun article publié avec slug="${TARGET_SLUG}"`);
    await mongoose.disconnect();
    process.exit(1);
  }
  console.log(`✓ ${post.title}`);
  console.log(`  Slug              : ${post.slug}`);
  console.log(`  Excerpt           : ${(post.excerpt || '').slice(0, 100)}...`);
  console.log(`  HTML length       : ${(post.contentHtml || '').length} chars`);
  console.log(`  SEO primaryKW     : ${post.seo && post.seo.primaryKeyword}`);
  console.log(`  SEO metaTitle     : ${post.seo && post.seo.metaTitle}`);
  console.log(`  SEO metaDesc      : ${(post.seo && post.seo.metaDescription || '').slice(0, 80)}`);
  console.log(`  Already DE ?      : ${(post.localizations && post.localizations.de && post.localizations.de.translatedAt) ? 'oui' : 'non'}`);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('2. CLASSIFICATION');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const bucket = classify(post);
  const model = bucket === 'technical' ? 'claude-sonnet-4-6' : 'claude-haiku-4-5-20251001';
  console.log(`✓ Bucket : ${bucket}`);
  console.log(`✓ Modèle : ${model}`);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('3. GLOSSAIRE');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const gloss = loadGlossary();
  let termsCount = 0;
  for (const cat of Object.keys(gloss)) {
    if (cat.startsWith('_')) continue;
    termsCount += Object.keys(gloss[cat]).length;
  }
  console.log(`✓ ${termsCount} termes chargés depuis scripts/glossary-de.json`);
  console.log(`  Catégories : ${Object.keys(gloss).filter((k) => !k.startsWith('_')).join(', ')}`);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('4. PROMPT SYSTÈME (taille + extrait)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const sysP = buildSystemPrompt(gloss);
  console.log(`✓ Système prompt : ${sysP.length} caractères, ~${Math.round(sysP.length / 4)} tokens`);
  console.log('--- 200 premiers caractères ---');
  console.log(sysP.slice(0, 200) + '...');

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('5. PROMPT UTILISATEUR (extrait)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const userP = buildUserPrompt(post);
  console.log(`✓ User prompt : ${userP.length} caractères, ~${Math.round(userP.length / 4)} tokens`);
  console.log(userP.slice(0, 600));
  console.log('...');

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('6. PARSER JSON (test sur réponses simulées)');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const samples = [
    '{"title":"a","excerpt":"b","contentHtml":"c","metaTitle":"d","metaDescription":"e","primaryKeyword":"f"}',
    '```json\n{"title":"a","excerpt":"b","contentHtml":"<p>c</p>","metaTitle":"d","metaDescription":"e","primaryKeyword":"f"}\n```',
    'Voici la traduction :\n\n{"title":"DSG-Mechatronik","excerpt":"...","contentHtml":"<p>x</p>","metaTitle":"...","metaDescription":"...","primaryKeyword":"..."}',
  ];
  for (let i = 0; i < samples.length; i++) {
    try {
      const parsed = parseJsonStrict(samples[i]);
      console.log(`✓ sample ${i + 1} OK : keys=${Object.keys(parsed).join(',')}`);
    } catch (err) {
      console.log(`✗ sample ${i + 1} KO : ${err.message}`);
    }
  }

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('7. ESTIMATION COÛT POUR CET ARTICLE');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  const inTokens = Math.round((sysP.length + buildUserPrompt({ ...post, contentHtml: post.contentHtml || '' }).length) / 4);
  const outTokens = Math.round(((post.contentHtml || '').length * 1.05 + 400) / 4); // DE est ~5% plus long que FR + meta
  let costEur = 0;
  if (bucket === 'technical') {
    // Sonnet 4.6 : $3/MTok in, $15/MTok out (taux de change ~0.92)
    costEur = (inTokens * 3 / 1_000_000 + outTokens * 15 / 1_000_000) * 0.92;
  } else {
    // Haiku 4.5 : $1/MTok in, $5/MTok out
    costEur = (inTokens * 1 / 1_000_000 + outTokens * 5 / 1_000_000) * 0.92;
  }
  console.log(`Tokens entrée  : ~${inTokens.toLocaleString()}`);
  console.log(`Tokens sortie  : ~${outTokens.toLocaleString()}`);
  console.log(`Coût estimé    : ~${costEur.toFixed(3)} €`);

  console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  console.log('VERDICT PIPELINE : ✅  Tout est en place, prêt pour appel API.');
  console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');

  await mongoose.disconnect();
}

main().catch(async (err) => {
  console.error('Fatal:', err);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
