#!/usr/bin/env node
// ---------------------------------------------------------------------------
// generate-blog-articles-fr.js
// Génère des articles de blog FR à partir de briefs (scripts/article-briefs-fr.json)
// via l'API Anthropic (Claude Sonnet 4.6 + tool_use forcé pour JSON valide).
//
// Usage :
//   node scripts/generate-blog-articles-fr.js                   (dry-run, 1 article)
//   node scripts/generate-blog-articles-fr.js --apply           (run réel, tous)
//   node scripts/generate-blog-articles-fr.js --slug=<slug>     (1 article ciblé)
//   node scripts/generate-blog-articles-fr.js --apply --slug=<slug>
//   node scripts/generate-blog-articles-fr.js --regenerate      (force regen même si existe)
//
// Stratégie : on respecte le style des articles autoliva.com existants
// (15-25k chars HTML, 8-12 H2, 4-7 blockquotes, 2-4 tables, FAQ, etc.)
// Le contenu est généré par Sonnet 4.6 avec un brief riche + glossaire de
// liens internes connus pour cohérence du maillage.
// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');

for (const key of ['ANTHROPIC_API_KEY', 'MONGODB_URI']) {
  if (process.env[key] === '') delete process.env[key];
}
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const mongoose = require('mongoose');
const BlogPost = require('../src/models/BlogPost');
const Product = require('../src/models/Product');

const args = process.argv.slice(2);
const DRY_RUN = !args.includes('--apply');
const REGENERATE = args.includes('--regenerate');
const TARGET_SLUG = (() => {
  const m = args.find((a) => a.startsWith('--slug='));
  return m ? m.split('=')[1].trim() : null;
})();

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const ANTHROPIC_API_VERSION = '2023-06-01';
const MODEL = process.env.ANTHROPIC_BLOG_GEN_MODEL || 'claude-sonnet-4-6';

const MAX_TOKENS_OUT = 16000;
const PACE_MS = 800;
const RETRY_MAX = 3;
const RETRY_BASE_MS = 2000;

const BRIEFS = JSON.parse(fs.readFileSync(path.join(__dirname, 'article-briefs-fr.json'), 'utf8'));

// ---------------------------------------------------------------------------
// Tool use (structured output garanti)
// ---------------------------------------------------------------------------
const GENERATION_TOOL = {
  name: 'save_article',
  description: 'Save the generated French blog article to the database. Always call this tool with the complete article.',
  input_schema: {
    type: 'object',
    properties: {
      title:           { type: 'string', description: 'Titre de l\'article (≤ 70 caractères de préférence). Doit contenir le mot-clé primaire.' },
      excerpt:         { type: 'string', description: 'Chapô / résumé en 1-3 phrases (150-250 caractères).' },
      contentHtml:     { type: 'string', description: 'Contenu HTML complet, 18000-25000 caractères, 8-12 H2, 12-20 H3, 4-7 blockquotes, 2-4 tables, FAQ section. Inclut les liens internes /blog/<slug> fournis et le placeholder produit si fourni.' },
      metaTitle:       { type: 'string', description: 'SEO meta title FR, MAXIMUM 60 caractères STRICT.' },
      metaDescription: { type: 'string', description: 'SEO meta description FR, MAXIMUM 160 caractères STRICT.' },
      readingTimeMinutes: { type: 'integer', description: 'Temps de lecture estimé en minutes (entier, 5-20).' },
    },
    required: ['title', 'excerpt', 'contentHtml', 'metaTitle', 'metaDescription', 'readingTimeMinutes'],
  },
};

// ---------------------------------------------------------------------------
// Prompt
// ---------------------------------------------------------------------------
function buildSystemPrompt() {
  return [
    'Tu es un rédacteur SEO expert spécialisé dans les pièces automobiles techniques (transmissions, mécatroniques, ponts/différentiels, moteurs Porsche/BMW/VAG/Mercedes), travaillant pour Autoliva.com (anciennement carpartsfrance.fr).',
    '',
    'STYLE DE L\'ARTICLE (impératif) :',
    '1. Ton : expert technique mais accessible. Pas de marketing creux. Le lecteur est un mécanicien amateur, garagiste indé ou propriétaire passionné qui veut une réponse précise.',
    '2. Niveau de détail : codes défaut OBD spécifiques, références OEM, kilométrages précis, fourchettes de prix datées (2026), procédures pas à pas, particularités par génération de véhicule.',
    '3. Pas de paraphrase, pas de remplissage, pas de superlatifs ("incroyable", "fantastique", etc.). Du contenu utile sinon rien.',
    '',
    'STRUCTURE HTML (impérative) :',
    '- Premier paragraphe : 2-4 phrases qui posent le sujet, mentionnent le mot-clé primaire et annoncent le plan.',
    '- 8 à 12 sections <h2>. Chaque H2 a 1-3 paragraphes <p>, et 0 à 4 sous-sections <h3>.',
    '- Au moins 4 blockquotes : "💡 Bon à savoir" (vert), "⚠️ Attention" (orange), "🔧 Astuce" (bleu). Format : <blockquote class="blockquote-info"><strong>💡 Bon à savoir</strong> : ...</blockquote>',
    '- Au moins 2 tables HTML <table> pour comparer véhicules / prix / variantes.',
    '- Une section FAQ finale avec 5 à 7 questions <h3> et leurs réponses <p>.',
    '- Liens internes <a class="text-primary underline" href="/blog/<slug>"> vers les autres articles cités. Utilise UNIQUEMENT les slugs listés dans relatedSlugs.',
    '- Si productCtaSearchHint est non null : insère exactement UNE fois le placeholder <div class="blog-product-cta" data-product-cta="1"></div> à un endroit pertinent (en général après la section "Solutions" ou au milieu de l\'article). Le serveur le remplace automatiquement.',
    '- Si l\'article est un guide HOW-TO (tuto démontage), utilise <ol><li> ou <ul><li> pour les étapes numérotées.',
    '',
    'CONTRAINTES SEO :',
    '- title : 50-70 caractères, contient le mot-clé primaire, idéalement en début.',
    '- metaTitle : ≤ 60 caractères STRICT.',
    '- metaDescription : ≤ 160 caractères STRICT. Compte les caractères avant de finaliser. Si dépassement, raccourcis.',
    '- contentHtml : 18000-25000 caractères. Pas moins, pas plus.',
    '- Mot-clé primaire et variations sémantiques répartis naturellement (densité ~1-1.5%).',
    '- Pas de "lorem ipsum", pas d\'inventions OEM. Si une donnée n\'est pas certaine, formule prudemment ("généralement", "selon les sources").',
    '',
    'FACTUALITÉ TECHNIQUE :',
    '- Tu dois être PRÉCIS : codes défaut, références OEM, codes véhicule (E83, F25, 8V, 957, 958, etc.), codes moteur (M48.01, M48.02, EA888 gen2, etc.), couples de serrage, capacités d\'huile.',
    '- Si tu n\'es pas certain d\'un chiffre exact, donne une fourchette ("environ", "selon source", "généralement entre X et Y").',
    '- N\'invente jamais de référence OEM ou de code défaut. Mieux vaut être moins précis que faux.',
    '',
    'INSPIRATION DE STYLE :',
    'Reproduis le ton et la structure des articles existants type "Mécatronique DSG7 DQ200 : diagnostic, prix et remplacement" ou "Pont arrière BMW X3 F25 / X4 F26 : diagnostic et prix". Pas de section "Sommaire" en début (la vue le génère). Pas de mention "Article rédigé par...". Pas de duplicata du titre H1.',
    '',
    'OUTPUT : tu DOIS appeler le tool save_article avec le contenu généré. Ne renvoie aucun texte en dehors du tool call.',
  ].join('\n');
}

function buildUserPrompt(brief) {
  return [
    `Génère un article FR pour Autoliva.com sur le slug : ${brief.slug}`,
    '',
    `TITRE INDICATIF (à raffiner) : ${brief.title_hint}`,
    `MOT-CLÉ PRIMAIRE : ${brief.primaryKeyword}`,
    `CATÉGORIE : ${brief.category && brief.category.label || '(non définie)'}`,
    '',
    'BRIEF DÉTAILLÉ DU SUJET :',
    brief.topic,
    '',
    'LIENS INTERNES À INTÉGRER (utilise EXACTEMENT ces slugs, sans en inventer d\'autres) :',
    (brief.relatedSlugs || []).length
      ? brief.relatedSlugs.map((s) => `  - /blog/${s}`).join('\n')
      : '  (aucun lien interne pour cet article)',
    '',
    'PLACEHOLDER PRODUIT :',
    brief.productCtaSearchHint
      ? `  Insère 1× <div class="blog-product-cta" data-product-cta="1"></div> à un endroit pertinent. Le produit lié sera : "${brief.productCtaSearchHint}".`
      : '  Aucun produit à insérer (omettre le placeholder).',
    '',
    'Appelle save_article avec l\'article complet en respectant toutes les contraintes du prompt système.',
  ].join('\n');
}

// ---------------------------------------------------------------------------
// API call
// ---------------------------------------------------------------------------
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function callAnthropic({ systemPrompt, userPrompt }) {
  if (!ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY manquant dans app/.env');
  }
  const body = {
    model: MODEL,
    max_tokens: MAX_TOKENS_OUT,
    system: systemPrompt,
    tools: [GENERATION_TOOL],
    tool_choice: { type: 'tool', name: GENERATION_TOOL.name },
    messages: [{ role: 'user', content: userPrompt }],
  };

  let lastErr = null;
  for (let attempt = 1; attempt <= RETRY_MAX; attempt++) {
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
      const toolUse = (data.content || []).find((c) => c && c.type === 'tool_use');
      if (!toolUse || !toolUse.input) {
        const txt = (data.content || []).filter((c) => c.type === 'text').map((c) => c.text).join('');
        throw new Error(`Pas de tool_use. stop_reason=${data.stop_reason}. text="${txt.slice(0, 200)}"`);
      }
      return {
        article: toolUse.input,
        usage: data.usage || null,
        model: data.model || MODEL,
        stopReason: data.stop_reason,
      };
    } catch (err) {
      lastErr = err;
      const retryable = /HTTP 4(29)|HTTP 5\d\d|abort|fetch failed|network/i.test(String(err && err.message));
      if (!retryable || attempt === RETRY_MAX) break;
      const delay = RETRY_BASE_MS * Math.pow(2, attempt - 1);
      console.warn(`  ⚠️  attempt ${attempt}/${RETRY_MAX} : ${err.message}. retry in ${delay}ms`);
      await sleep(delay);
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// Sauvegarde BDD
// ---------------------------------------------------------------------------
async function findRelatedProductId(searchHint) {
  if (!searchHint || typeof searchHint !== 'string') return null;
  // Recherche par slug d'abord, puis par nom (regex)
  const trimmed = searchHint.trim();
  if (!trimmed) return null;
  let p = await Product.findOne({ slug: trimmed.toLowerCase() }).select('_id name').lean();
  if (p) return p._id;
  // Fallback regex sur le nom (mots-clés simples)
  const tokens = trimmed.split(/[\s\-_]+/).filter((t) => t.length >= 4);
  if (!tokens.length) return null;
  const rx = new RegExp(tokens.slice(0, 4).join('.*'), 'i');
  p = await Product.findOne({ name: { $regex: rx }, isPublished: { $ne: false } }).select('_id name').lean();
  return p ? p._id : null;
}

async function saveArticle({ brief, generated, productId }) {
  const now = new Date();
  const upd = {
    title: generated.title,
    slug: brief.slug,
    excerpt: generated.excerpt,
    contentHtml: generated.contentHtml,
    contentMarkdown: '', // on ne génère pas de markdown source
    coverImageUrl: '',   // pas de cover image générée — à ajouter manuellement si besoin
    category: brief.category && brief.category.slug
      ? { slug: brief.category.slug, label: brief.category.label || brief.category.slug }
      : { slug: '', label: '' },
    authorName: 'Expert Autoliva',
    readingTimeMinutes: Math.max(1, Math.min(60, Number(generated.readingTimeMinutes) || 12)),
    relatedProductIds: productId ? [productId] : [],
    isFeatured: false,
    isHomeFeatured: false,
    isPublished: true,
    publishedAt: now,
    seo: {
      primaryKeyword: brief.primaryKeyword || '',
      metaTitle: generated.metaTitle,
      metaDescription: generated.metaDescription,
      metaRobots: '',
      ogImageUrl: '',
      canonicalPath: '',
    },
  };

  // Upsert : si l'article existe (par slug), on update ; sinon on crée.
  const existing = await BlogPost.findOne({ slug: brief.slug });
  if (existing) {
    Object.assign(existing, upd);
    await existing.save();
    return { created: false, doc: existing };
  } else {
    const doc = new BlogPost(upd);
    await doc.save();
    return { created: true, doc };
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  if (!process.env.MONGODB_URI) { console.error('❌ MONGODB_URI manquant'); process.exit(1); }
  if (!ANTHROPIC_API_KEY)        { console.error('❌ ANTHROPIC_API_KEY manquant'); process.exit(1); }

  console.log(`Mode : ${DRY_RUN ? 'DRY-RUN (rien en BDD)' : 'APPLY (écriture en BDD)'}`);
  console.log(`Modèle : ${MODEL}`);
  if (TARGET_SLUG) console.log(`Slug ciblé : ${TARGET_SLUG}`);
  console.log('');

  await mongoose.connect(process.env.MONGODB_URI);

  let briefs = BRIEFS.articles || [];
  if (TARGET_SLUG) {
    briefs = briefs.filter((b) => b.slug === TARGET_SLUG);
    if (!briefs.length) { console.error(`❌ Slug "${TARGET_SLUG}" introuvable dans les briefs`); process.exit(1); }
  }
  if (DRY_RUN && !TARGET_SLUG) {
    briefs = briefs.slice(0, 1); // dry-run = 1 seul article
  }

  // Skip articles déjà créés sauf si --regenerate ou --slug ciblé
  if (!REGENERATE && !TARGET_SLUG) {
    const existing = await BlogPost.find({ slug: { $in: briefs.map((b) => b.slug) } }).select('slug').lean();
    const existingSet = new Set(existing.map((e) => e.slug));
    const before = briefs.length;
    briefs = briefs.filter((b) => !existingSet.has(b.slug));
    if (existing.length) console.log(`📋 ${existing.length} article(s) déjà en BDD, sautés (utilise --regenerate pour forcer)`);
    if (briefs.length === 0 && before > 0) {
      console.log('✅ Tous les articles sont déjà en BDD. Rien à faire.');
      await mongoose.disconnect();
      return;
    }
  }

  console.log(`📋 ${briefs.length} article(s) à générer\n`);

  const stats = {
    total: briefs.length,
    success: 0,
    failed: 0,
    created: 0,
    updated: 0,
    inputTokens: 0,
    outputTokens: 0,
  };
  const failures = [];
  const dumpDir = path.join(__dirname, '..', '..', 'tmp', 'blog-articles-fr');
  try { fs.mkdirSync(dumpDir, { recursive: true }); } catch (_) {}

  for (let i = 0; i < briefs.length; i++) {
    const brief = briefs[i];
    console.log(`\n[${i + 1}/${briefs.length}] ${brief.slug}`);
    console.log(`  topic : ${brief.title_hint}`);

    try {
      const t0 = Date.now();
      const result = await callAnthropic({
        systemPrompt: buildSystemPrompt(),
        userPrompt: buildUserPrompt(brief),
      });
      const ms = Date.now() - t0;

      const a = result.article;
      const required = ['title', 'excerpt', 'contentHtml', 'metaTitle', 'metaDescription'];
      const missing = required.filter((k) => !a[k] || typeof a[k] !== 'string');
      if (missing.length) {
        throw new Error(`Champs manquants : ${missing.join(', ')}`);
      }
      if (result.stopReason === 'max_tokens') {
        console.warn('  ⚠️  réponse tronquée (stop_reason=max_tokens)');
      }

      stats.inputTokens += (result.usage && result.usage.input_tokens) || 0;
      stats.outputTokens += (result.usage && result.usage.output_tokens) || 0;

      console.log(`  ✓ généré en ${ms}ms`);
      console.log(`    title     (${a.title.length}c): ${a.title}`);
      console.log(`    metaTitle (${a.metaTitle.length}c): ${a.metaTitle}`);
      console.log(`    metaDesc  (${a.metaDescription.length}c): ${a.metaDescription.slice(0, 100)}...`);
      console.log(`    HTML      ${a.contentHtml.length}c, ${(a.contentHtml.match(/<h2/g) || []).length} H2, ${(a.contentHtml.match(/<h3/g) || []).length} H3`);
      console.log(`    Internal links: ${(a.contentHtml.match(/href="\/blog\//g) || []).length}`);
      console.log(`    Product CTA placeholder: ${(a.contentHtml.match(/blog-product-cta/g) || []).length}`);

      if (a.metaTitle.length > 60) console.warn(`    ⚠️  metaTitle dépasse 60c (${a.metaTitle.length})`);
      if (a.metaDescription.length > 160) console.warn(`    ⚠️  metaDesc dépasse 160c (${a.metaDescription.length})`);

      // Dump JSON pour traçabilité
      const dumpFile = path.join(dumpDir, `${brief.slug}.json`);
      fs.writeFileSync(dumpFile, JSON.stringify({ brief, generated: a, model: result.model, usage: result.usage }, null, 2), 'utf8');
      console.log(`    📄 dump: ${dumpFile}`);

      if (!DRY_RUN) {
        const productId = await findRelatedProductId(brief.productCtaSearchHint);
        if (productId) console.log(`    🔗 produit lié: ${productId}`);
        const { created, doc } = await saveArticle({ brief, generated: a, productId });
        if (created) stats.created++; else stats.updated++;
        console.log(`    💾 ${created ? 'créé' : 'mis à jour'} en BDD (id ${doc._id})`);
      } else {
        console.log('    (dry-run, pas d\'écriture BDD)');
      }

      stats.success++;
    } catch (err) {
      stats.failed++;
      failures.push({ slug: brief.slug, error: String(err && err.message) });
      console.error(`  ❌ erreur : ${err.message}`);
    }

    if (i < briefs.length - 1) await sleep(PACE_MS);
  }

  console.log('\n--- RÉCAP ---');
  console.log(`Total       : ${stats.total}`);
  console.log(`Succès      : ${stats.success}`);
  console.log(`Créés       : ${stats.created}`);
  console.log(`Mis à jour  : ${stats.updated}`);
  console.log(`Échecs      : ${stats.failed}`);
  console.log(`Tokens in   : ${stats.inputTokens.toLocaleString()}`);
  console.log(`Tokens out  : ${stats.outputTokens.toLocaleString()}`);
  if (failures.length) {
    console.log('\nÉchecs détail :');
    for (const f of failures) console.log(`  - ${f.slug}: ${f.error}`);
  }

  await mongoose.disconnect();
  process.exit(stats.failed > 0 ? 1 : 0);
}

main().catch(async (err) => {
  console.error('Fatal:', err);
  try { await mongoose.disconnect(); } catch (_) {}
  process.exit(1);
});
