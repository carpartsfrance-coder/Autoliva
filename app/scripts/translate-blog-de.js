#!/usr/bin/env node
// ---------------------------------------------------------------------------
// translate-blog-de.js
// Traduction batch FR → DE des articles BlogPost via l'API Anthropic.
//
// Usage :
//   node scripts/translate-blog-de.js                 (dry-run, 3 articles)
//   node scripts/translate-blog-de.js --apply         (run réel, tous les articles non encore traduits)
//   node scripts/translate-blog-de.js --apply --limit=10
//   node scripts/translate-blog-de.js --slug=mecatronique-dsg7-dq200-...   (1 article ciblé)
//   node scripts/translate-blog-de.js --apply --retranslate                (force re-traduction même si déjà fait)
//
// Stratification :
//   - Articles "technical" (codes défaut, mécatronique, diagnostic) → Sonnet 4.6
//   - Articles "comparative" (prix, comparatif, budget)             → Haiku 4.5
//   - Articles "simple" (entretien, vidange, généralités)           → Haiku 4.5
//   - Articles inclassés                                            → Sonnet 4.6 (par sécurité)
//
// Le glossaire technique scripts/glossary-de.json est injecté dans le prompt
// système : Claude doit utiliser EXACTEMENT les termes listés.
// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');

/* Certains environnements (Claude Code, CI, sandbox) injectent des env vars
 * vides (ex: ANTHROPIC_API_KEY=""). dotenv considère qu'elles "existent"
 * et ne les surcharge pas. On les supprime avant le load pour permettre
 * au .env local de prendre le relais. */
for (const key of ['ANTHROPIC_API_KEY', 'MONGODB_URI']) {
  if (process.env[key] === '') delete process.env[key];
}
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const BlogPost = require('../src/models/BlogPost');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--apply');
const RETRANSLATE = args.includes('--retranslate');
const LIMIT = (() => {
  const m = args.find((a) => a.startsWith('--limit='));
  if (!m) return DRY_RUN ? 3 : 0; // 0 = no limit en mode apply
  const n = Number(m.split('=')[1]);
  return Number.isFinite(n) && n > 0 ? n : 0;
})();
const TARGET_SLUG = (() => {
  const m = args.find((a) => a.startsWith('--slug='));
  return m ? m.split('=')[1].trim() : null;
})();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';

const MODEL_TECHNICAL = process.env.ANTHROPIC_BLOG_MODEL_TECHNICAL || 'claude-sonnet-4-6';
const MODEL_SIMPLE    = process.env.ANTHROPIC_BLOG_MODEL_SIMPLE    || 'claude-haiku-4-5-20251001';

const MAX_TOKENS_OUT = 16000; // articles techniques peuvent générer 6-12k tokens DE
const REQUEST_TIMEOUT_MS = 120_000;
const RETRY_MAX = 3;
const RETRY_BASE_MS = 2_000;
const PACE_MS = 600; // pause entre requêtes pour ne pas saturer le rate limit

// ---------------------------------------------------------------------------
// Glossary
// ---------------------------------------------------------------------------
const GLOSSARY = (() => {
  const p = path.join(__dirname, 'glossary-de.json');
  return JSON.parse(fs.readFileSync(p, 'utf8'));
})();

// ---------------------------------------------------------------------------
// Classification heuristique
// ---------------------------------------------------------------------------
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

const COMPARATIVE_PATTERNS = [
  /^prix-/i,
  /-prix-/i,
  /budget/i,
  /comparatif/i,
  /vehicules-compatibles/i,
];

const SIMPLE_PATTERNS = [
  /^entretien-/i,
  /-entretien-/i,
  /^vidange-/i,
  /-vidange-/i,
];

function classifyArticle(post) {
  const slug = String(post.slug || '');
  const title = String(post.title || '');
  const haystack = `${slug} ${title}`.toLowerCase();

  if (TECHNICAL_PATTERNS.some((re) => re.test(haystack))) return 'technical';
  if (SIMPLE_PATTERNS.some((re) => re.test(haystack))) return 'simple';
  if (COMPARATIVE_PATTERNS.some((re) => re.test(haystack))) return 'comparative';
  return 'technical'; // fallback prudent : Sonnet
}

function modelForBucket(bucket) {
  return bucket === 'technical' ? MODEL_TECHNICAL : MODEL_SIMPLE;
}

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------
function buildSystemPrompt() {
  return [
    'Tu es un traducteur technique expert spécialisé dans les pièces automobiles (transmissions, boîtes de transfert, différentiels, mécatroniques) qui traduit du français vers l\'allemand pour un site e-commerce vendant des pièces auto OEM.',
    '',
    'RÈGLES CRITIQUES :',
    '1. Utilise UNIQUEMENT la terminologie allemande du glossaire ci-dessous. Ne paraphrase JAMAIS les termes techniques listés.',
    '2. Préserve TOUTES les balises HTML exactement comme dans le source. Traduis uniquement le contenu textuel à l\'intérieur.',
    '3. Préserve verbatim : numéros OEM (0AM, 0B5, 1166503...), codes défaut OBD (P0811, P189500, P17D6...), codes modèle véhicule (E83, F25...), marques (Audi, BMW, Volkswagen, Porsche, Mercedes...).',
    '4. CODES TRANSMISSION À NE JAMAIS RACCOURCIR : DSG7 reste DSG7 (JAMAIS "DSG" seul), DSG6 reste DSG6, S-tronic reste S tronic (avec espace), DQ200/DQ250/DQ380/DQ381 verbatim. Cette règle prime sur toute considération de longueur.',
    '5. Conserve le ton expert mais accessible du français original. Pas de paraphrase littéraire.',
    '6. metaTitle ≤ 60 caractères STRICT.',
    '7. metaDescription ≤ 160 caractères STRICT. Compte mentalement les caractères avant de finaliser. Si dépassement, raccourcis en supprimant un adjectif ou une virgule.',
    '8. Ne traduis pas le slug — ce champ n\'est pas dans la sortie.',
    '9. Adapte les unités si nécessaire (€ reste €, km reste km, mais "boîte de transfert" → "Verteilergetriebe" via glossaire).',
    '',
    'GLOSSAIRE TECHNIQUE OBLIGATOIRE (FR → DE) :',
    JSON.stringify(GLOSSARY, null, 2),
    '',
    'FORMAT DE SORTIE : JSON uniquement, aucun texte avant/après. Schéma exact :',
    '{',
    '  "title": "...",',
    '  "excerpt": "...",',
    '  "contentHtml": "...",',
    '  "metaTitle": "...",',
    '  "metaDescription": "...",',
    '  "primaryKeyword": "..."',
    '}',
  ].join('\n');
}

function buildUserPrompt(post) {
  return [
    'Traduis cet article de blog du français vers l\'allemand en respectant strictement les règles et le glossaire du prompt système.',
    '',
    'TITRE FR :',
    post.title || '',
    '',
    'CHAPÔ FR :',
    post.excerpt || '',
    '',
    'CONTENU HTML FR :',
    post.contentHtml || '',
    '',
    'META TITLE FR (référence) :',
    (post.seo && post.seo.metaTitle) || post.title || '',
    '',
    'META DESCRIPTION FR (référence) :',
    (post.seo && post.seo.metaDescription) || post.excerpt || '',
    '',
    'MOT-CLÉ PRIMAIRE FR (référence) :',
    (post.seo && post.seo.primaryKeyword) || '',
    '',
    'Réponds en JSON uniquement.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Anthropic API call
// ---------------------------------------------------------------------------
const TRANSLATION_TOOL = {
  name: 'save_translation',
  description: 'Save the German translation of a French blog article to the database. Always call this tool with the complete translated content.',
  input_schema: {
    type: 'object',
    properties: {
      title:           { type: 'string', description: 'Titre de l\'article en allemand. Préserver les codes véhicule, marques, OEM verbatim.' },
      excerpt:         { type: 'string', description: 'Chapô (excerpt) en allemand, 1-3 phrases.' },
      contentHtml:     { type: 'string', description: 'Contenu HTML complet en allemand. Préserver TOUTES les balises HTML du source. Traduire uniquement le texte à l\'intérieur.' },
      metaTitle:       { type: 'string', description: 'SEO meta title en allemand, MAXIMUM 60 caractères.' },
      metaDescription: { type: 'string', description: 'SEO meta description en allemand, MAXIMUM 160 caractères.' },
      primaryKeyword:  { type: 'string', description: 'Mot-clé SEO primaire en allemand (1-4 mots).' },
    },
    required: ['title', 'excerpt', 'contentHtml', 'metaTitle', 'metaDescription', 'primaryKeyword'],
  },
};

async function callAnthropic({ model, systemPrompt, userPrompt }) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY manquant. Ajoute-la dans app/.env (ne jamais commiter).');
  }

  const body = {
    model,
    max_tokens: MAX_TOKENS_OUT,
    system: systemPrompt,
    tools: [TRANSLATION_TOOL],
    tool_choice: { type: 'tool', name: TRANSLATION_TOOL.name },
    messages: [{ role: 'user', content: userPrompt }],
  };

  let lastErr = null;
  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
    /* Pas d'AbortController : un environnement qui injecte un signal global
     * (Claude Code sandbox p.ex.) abortait nos fetchs en <2s. L'API
     * Anthropic répond toujours en <60s sur Sonnet 4.6 max_tokens=8000,
     * on s'en remet au TCP keepalive et au timeout natif d'undici. */
    try {
      const res = await fetch(ANTHROPIC_API_URL, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': ANTHROPIC_API_KEY,
          'anthropic-version': ANTHROPIC_API_VERSION,
        },
        body: JSON.stringify(body),
      });

      if (res.status === 429 || res.status === 529 || res.status >= 500) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} (retryable) ${txt.slice(0, 200)}`);
      }

      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${txt.slice(0, 500)}`);
      }

      const data = await res.json();
      // En mode tool_choice forcé, la réponse contient UN block tool_use
      // dont .input est un objet JSON déjà parsé et garanti valide.
      const toolUse = (data.content || []).find((c) => c && c.type === 'tool_use');
      if (!toolUse || !toolUse.input || typeof toolUse.input !== 'object') {
        const fallbackText = (data.content || [])
          .filter((c) => c && c.type === 'text')
          .map((c) => c.text)
          .join('');
        throw new Error(`Réponse sans tool_use exploitable. stop_reason=${data.stop_reason}. text="${fallbackText.slice(0, 200)}"`);
      }
      return {
        translation: toolUse.input,
        usage: data.usage || null,
        model: data.model || model,
        stopReason: data.stop_reason,
      };
    } catch (err) {
      lastErr = err;
      const retryable = /HTTP 4(29)|HTTP 5\d\d|abort|fetch failed|network/i.test(String(err && err.message));
      if (!retryable || attempt === RETRY_MAX) break;
      const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
      console.warn(`  ⚠️  attempt ${attempt}/${RETRY_MAX} failed (${err.message}). retry in ${delay}ms`);
      await sleep(delay);
    }
  }

  throw lastErr || new Error('Anthropic API call failed');
}

function parseJsonStrict(text) {
  // Le modèle peut entourer la réponse de ```json ... ``` ou de prose, et la
  // réponse peut être tronquée si max_tokens est atteint (pas de fence fermante).
  const trimmed = String(text || '').trim();
  let candidate = trimmed;

  // Strip ```json ... ``` si présent (avec ou sans fence fermante)
  candidate = candidate.replace(/^```(?:json)?\s*\n?/i, '');
  candidate = candidate.replace(/\n?```\s*$/i, '');

  // Clip entre première { et dernière }
  const firstBrace = candidate.indexOf('{');
  const lastBrace = candidate.lastIndexOf('}');
  if (firstBrace >= 0 && lastBrace > firstBrace) {
    candidate = candidate.slice(firstBrace, lastBrace + 1);
  }

  try {
    return JSON.parse(candidate);
  } catch (err) {
    // Log la réponse brute pour debug, tronquée à 600 chars
    console.error('  --- raw response (first 600 chars) ---');
    console.error('  ' + trimmed.slice(0, 600).replace(/\n/g, '\n  '));
    console.error('  --- candidate (first 300 + last 100) ---');
    console.error('  ' + candidate.slice(0, 300).replace(/\n/g, '\n  '));
    if (candidate.length > 400) {
      console.error('  [...]');
      console.error('  ' + candidate.slice(-100).replace(/\n/g, '\n  '));
    }
    throw err;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!process.env.MONGODB_URI) {
    console.error('❌ MONGODB_URI non défini dans app/.env');
    process.exit(1);
  }
  if (!ANTHROPIC_API_KEY) {
    console.error('❌ ANTHROPIC_API_KEY non défini dans app/.env');
    console.error('   Crée la clé sur https://console.anthropic.com/settings/keys');
    console.error('   Ajoute la ligne: ANTHROPIC_API_KEY=sk-ant-...');
    process.exit(1);
  }

  console.log(`Mode : ${DRY_RUN ? 'DRY-RUN (rien n\'est écrit en BDD)' : 'APPLY (écriture en BDD)'}`);
  if (LIMIT) console.log(`Limite : ${LIMIT} articles`);
  if (TARGET_SLUG) console.log(`Slug ciblé : ${TARGET_SLUG}`);
  if (RETRANSLATE) console.log('Retraduction forcée : oui');
  console.log(`Modèle technical : ${MODEL_TECHNICAL}`);
  console.log(`Modèle simple    : ${MODEL_SIMPLE}`);
  console.log('');

  await mongoose.connect(process.env.MONGODB_URI);

  // Filter : articles publiés. Si pas --retranslate, on saute ceux déjà traduits.
  const filter = { isPublished: true };
  if (TARGET_SLUG) filter.slug = TARGET_SLUG;
  if (!RETRANSLATE) filter['localizations.de.translatedAt'] = { $in: [null, undefined] };

  const cursor = BlogPost.find(filter)
    .sort({ publishedAt: -1, updatedAt: -1 })
    .limit(LIMIT || 0); // 0 = pas de limite

  const posts = await cursor.lean(false);
  console.log(`📋 ${posts.length} article(s) à traiter\n`);

  const stats = {
    total: posts.length,
    success: 0,
    failed: 0,
    byBucket: { technical: 0, comparative: 0, simple: 0 },
    inputTokens: 0,
    outputTokens: 0,
  };
  const failures = [];

  for (let i = 0; i < posts.length; i++) {
    const post = posts[i];
    const bucket = classifyArticle(post);
    const model = modelForBucket(bucket);
    stats.byBucket[bucket] = (stats.byBucket[bucket] || 0) + 1;

    const head = `[${i + 1}/${posts.length}] ${post.slug}`;
    console.log(`${head}\n  bucket=${bucket} model=${model}`);

    try {
      const t0 = Date.now();
      const result = await callAnthropic({
        model,
        systemPrompt: buildSystemPrompt(),
        userPrompt: buildUserPrompt(post),
      });
      const ms = Date.now() - t0;

      const parsed = result.translation;

      const required = ['title', 'excerpt', 'contentHtml', 'metaTitle', 'metaDescription'];
      const missing = required.filter((k) => !parsed[k] || typeof parsed[k] !== 'string');
      if (missing.length) {
        throw new Error(`Réponse incomplète, champs manquants : ${missing.join(', ')}`);
      }
      if (result.stopReason === 'max_tokens') {
        console.warn('  ⚠️  réponse tronquée (stop_reason=max_tokens) — augmenter MAX_TOKENS_OUT');
      }

      if (result.usage) {
        stats.inputTokens += result.usage.input_tokens || 0;
        stats.outputTokens += result.usage.output_tokens || 0;
      }

      console.log(`  ✓ traduit en ${ms}ms — title="${parsed.title.slice(0, 60)}..."`);
      console.log(`    metaTitle (${parsed.metaTitle.length}c): ${parsed.metaTitle}`);
      console.log(`    metaDescription (${parsed.metaDescription.length}c): ${parsed.metaDescription.slice(0, 100)}...`);

      if (parsed.metaTitle.length > 60) {
        console.warn(`    ⚠️  metaTitle dépasse 60 caractères (${parsed.metaTitle.length})`);
      }
      if (parsed.metaDescription.length > 160) {
        console.warn(`    ⚠️  metaDescription dépasse 160 caractères (${parsed.metaDescription.length})`);
      }

      // En dry-run, on dump aussi le résultat sur disque pour relecture humaine.
      if (DRY_RUN) {
        const outDir = path.join(__dirname, '..', '..', 'tmp', 'translations-de');
        try { fs.mkdirSync(outDir, { recursive: true }); } catch (_) {}
        const outFile = path.join(outDir, `${post.slug}.json`);
        fs.writeFileSync(outFile, JSON.stringify({
          slug: post.slug,
          fr: {
            title: post.title,
            excerpt: post.excerpt,
            metaTitle: post.seo && post.seo.metaTitle,
            metaDescription: post.seo && post.seo.metaDescription,
          },
          de: {
            title: parsed.title,
            excerpt: parsed.excerpt,
            metaTitle: parsed.metaTitle,
            metaDescription: parsed.metaDescription,
            primaryKeyword: parsed.primaryKeyword,
            contentHtml: parsed.contentHtml,
          },
          model: result.model,
          bucket,
          tokens: result.usage,
        }, null, 2), 'utf8');
        console.log(`  📄 dump : ${outFile}`);
      }

      if (!DRY_RUN) {
        post.localizations = post.localizations || {};
        post.localizations.de = {
          title: parsed.title,
          excerpt: parsed.excerpt,
          contentHtml: parsed.contentHtml,
          contentMarkdown: '', // on ne re-traduit pas le markdown ; le HTML est canonique côté DE
          seo: {
            primaryKeyword: parsed.primaryKeyword || '',
            metaTitle: parsed.metaTitle,
            metaDescription: parsed.metaDescription,
          },
          translatedAt: new Date(),
          translatedBy: result.model,
          translationBucket: bucket,
          reviewedAt: null,
          reviewedBy: '',
        };
        await post.save();
        console.log('  💾 sauvegardé en BDD');
      } else {
        console.log('  (dry-run, pas d\'écriture BDD)');
      }

      stats.success++;
    } catch (err) {
      stats.failed++;
      failures.push({ slug: post.slug, error: String(err && err.message) });
      console.error(`  ❌ erreur : ${err.message}`);
    }

    if (i < posts.length - 1) await sleep(PACE_MS);
  }

  console.log('\n--- RÉCAP ---');
  console.log(`Total       : ${stats.total}`);
  console.log(`Succès      : ${stats.success}`);
  console.log(`Échecs      : ${stats.failed}`);
  console.log(`Par bucket  : technical=${stats.byBucket.technical}, comparative=${stats.byBucket.comparative}, simple=${stats.byBucket.simple}`);
  console.log(`Tokens in   : ${stats.inputTokens.toLocaleString()}`);
  console.log(`Tokens out  : ${stats.outputTokens.toLocaleString()}`);
  if (failures.length) {
    console.log('\nÉchecs détail :');
    for (const f of failures) console.log(`  - ${f.slug}: ${f.error}`);
  }

  await mongoose.disconnect();
  process.exit(stats.failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
