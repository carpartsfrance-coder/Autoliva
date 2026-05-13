/**
 * Tests d'intégration pour POST /api/blog/import-from-url
 *
 * Lance via : npm test
 *
 * Environnement requis :
 *   TEST_MONGODB_URI ou MONGODB_URI : connexion à un MongoDB de test
 *   (ne lance pas les tests si absent — skip avec un message)
 *
 * Ces tests :
 *   - démarrent un serveur Express minimal qui ne monte que le router blogImport
 *   - démarrent un mini-serveur HTTP local qui sert les fixtures markdown
 *   - créent puis suppriment leurs propres BlogPost (cleanup automatique)
 *
 * Aucune dépendance externe (pas de jest, supertest, mongodb-memory-server).
 * Utilise node:test (built-in Node 18+) + fetch built-in.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');

// Token de test fixé avant le require du router (le router lit process.env)
process.env.BLOG_IMPORT_API_TOKEN = 'test-token-abcdef123456';
process.env.NODE_ENV = process.env.NODE_ENV || 'development';

const blogImportRouter = require('../../src/routes/api/blogImport');
const BlogPost = require('../../src/models/BlogPost');

const MONGODB_URI = process.env.TEST_MONGODB_URI || process.env.MONGODB_URI;

const SAMPLE_MARKDOWN = `# Titre de l'article de test

Ceci est un **article de test** pour valider l'endpoint d'import.

## Section 1

Du contenu pour faire un peu de volume.

## Section 2

Encore du contenu.

> Citation pour la forme.

[Lien externe](https://example.com).
`;

let appServer;
let appUrl;
let fixtureServer;
let fixtureUrl;

const createdSlugs = new Set();

/* ─── Fixtures setup/teardown ───────────────────────────────────────── */

async function startApp() {
  const app = express();
  app.use('/api/blog', blogImportRouter);
  app.use((req, res) => res.status(404).json({ success: false, error: 'not found' }));
  return new Promise((resolve) => {
    appServer = app.listen(0, '127.0.0.1', () => {
      appUrl = `http://127.0.0.1:${appServer.address().port}`;
      resolve();
    });
  });
}

async function startFixtureServer() {
  const fixtures = new Map();

  // Pour le test SSRF on a besoin d'une URL "publique" et d'une URL "privée".
  // Le mini-serveur sert différents endpoints.
  const handler = (req, res) => {
    if (req.url === '/article-test.md') {
      res.writeHead(200, { 'Content-Type': 'text/markdown', 'Content-Length': Buffer.byteLength(SAMPLE_MARKDOWN) });
      return res.end(SAMPLE_MARKDOWN);
    }
    if (req.url === '/big.md') {
      const big = 'A'.repeat(250 * 1024); // 250 KB > 200 KB
      res.writeHead(200, { 'Content-Type': 'text/markdown', 'Content-Length': Buffer.byteLength(big) });
      return res.end(big);
    }
    if (req.url === '/empty.md') {
      res.writeHead(200, { 'Content-Type': 'text/markdown', 'Content-Length': 0 });
      return res.end('');
    }
    if (req.url === '/notfound') {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(404);
    return res.end('not found');
  };
  fixtureServer = http.createServer(handler);
  return new Promise((resolve) => {
    fixtureServer.listen(0, '127.0.0.1', () => {
      fixtureUrl = `http://127.0.0.1:${fixtureServer.address().port}`;
      resolve();
    });
  });
}

async function cleanupCreatedPosts() {
  if (mongoose.connection.readyState !== 1) return;
  if (createdSlugs.size === 0) return;
  await BlogPost.deleteMany({ slug: { $in: Array.from(createdSlugs) } });
  createdSlugs.clear();
}

/* ─── Hooks ──────────────────────────────────────────────────────────── */

test.before(async () => {
  await startApp();
  await startFixtureServer();
  if (MONGODB_URI) {
    await mongoose.connect(MONGODB_URI);
    console.log('[tests] Mongo connecté à', MONGODB_URI.replace(/:[^:@]+@/, ':***@'));
  } else {
    console.warn('[tests] MONGODB_URI non défini — les tests qui requièrent la DB seront skippés.');
  }
});

test.after(async () => {
  await cleanupCreatedPosts();
  if (mongoose.connection.readyState === 1) await mongoose.disconnect();
  if (appServer) await new Promise((r) => appServer.close(r));
  if (fixtureServer) await new Promise((r) => fixtureServer.close(r));
});

/* ─── Helpers ────────────────────────────────────────────────────────── */

function makeBody({ slug = 'article-test-1', title = 'Article de test', md = '/article-test.md', mode = 'create', extra = {} } = {}) {
  return {
    markdownUrl: `${fixtureUrl}${md}`,
    metadata: {
      title,
      slug,
      excerpt: 'Résumé de test pour l\'article.',
      coverImageUrl: '/media/000000000000000000000001',
      authorName: 'Expert Tests',
      readingTimeMinutes: 5,
      isPublished: true,
      publishedAt: '2026-05-13',
      category: { label: 'Transmission > Test', slug: 'transmission-test' },
      seo: {
        primaryKeyword: 'article test',
        metaTitle: 'Article test SEO — guide complet 2026',
        metaDescription: 'Article de test pour vérifier le bon fonctionnement de l\'endpoint d\'import blog server-to-server avec une description longue suffisante.',
        metaRobots: 'index, follow',
        ogImageUrl: '/media/000000000000000000000001',
        canonicalPath: `/blog/${slug}`,
      },
      ...extra,
    },
    mode,
  };
}

async function postImport({ token, body }) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const resp = await fetch(`${appUrl}/api/blog/import-from-url`, {
    method: 'POST',
    headers,
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
  const json = await resp.json().catch(() => ({}));
  return { status: resp.status, json };
}

const requiresDb = (fn) => async (t) => {
  if (mongoose.connection.readyState !== 1) {
    t.skip('MONGODB_URI non défini — test DB skippé.');
    return;
  }
  await fn(t);
};

/* ─── Tests ──────────────────────────────────────────────────────────── */

test('1. POST sans Authorization → 401', async () => {
  const { status, json } = await postImport({ body: makeBody() });
  assert.equal(status, 401);
  assert.equal(json.success, false);
});

test('2. POST avec mauvais token → 401', async () => {
  const { status, json } = await postImport({ token: 'wrong-token', body: makeBody() });
  assert.equal(status, 401);
  assert.equal(json.success, false);
});

test('3. POST avec body invalide (slug manquant) → 400', async () => {
  const body = makeBody();
  delete body.metadata.slug;
  const { status, json } = await postImport({ token: process.env.BLOG_IMPORT_API_TOKEN, body });
  assert.equal(status, 400);
  assert.match(json.error, /slug/i);
});

test('4. POST avec markdownUrl pointant vers une IP privée hors dev → 400', async () => {
  // En NODE_ENV=development on autorise les hôtes privés (sinon impossible de tester).
  // On simule prod en passant temporairement.
  const previous = process.env.NODE_ENV;
  process.env.NODE_ENV = 'production';
  try {
    const { status, json } = await postImport({
      token: process.env.BLOG_IMPORT_API_TOKEN,
      body: { ...makeBody(), markdownUrl: `${fixtureUrl}/article-test.md` },
    });
    assert.equal(status, 400);
    assert.match(json.error, /priv|hôte|http/i);
  } finally {
    process.env.NODE_ENV = previous;
  }
});

test('5. POST avec slug existant en mode create → 409', requiresDb(async () => {
  const slug = 'test-conflict-' + Date.now();
  createdSlugs.add(slug);
  // Premier insert OK
  const r1 = await postImport({ token: process.env.BLOG_IMPORT_API_TOKEN, body: makeBody({ slug }) });
  assert.equal(r1.status, 201);
  // Second insert avec même slug → 409
  const r2 = await postImport({ token: process.env.BLOG_IMPORT_API_TOKEN, body: makeBody({ slug }) });
  assert.equal(r2.status, 409);
}));

test('6. POST avec slug existant en mode upsert → 200, post mis à jour', requiresDb(async () => {
  const slug = 'test-upsert-' + Date.now();
  createdSlugs.add(slug);
  const r1 = await postImport({ token: process.env.BLOG_IMPORT_API_TOKEN, body: makeBody({ slug }) });
  assert.equal(r1.status, 201);
  const r2 = await postImport({
    token: process.env.BLOG_IMPORT_API_TOKEN,
    body: makeBody({ slug, title: 'Titre mis à jour', mode: 'upsert' }),
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.data.created, false);
  assert.equal(r2.json.data.updated, true);
  // Vérifier en DB
  const post = await BlogPost.findOne({ slug }).lean();
  assert.equal(post.title, 'Titre mis à jour');
}));

test('7. POST valide → 201, post créé en DB', requiresDb(async () => {
  const slug = 'test-create-ok-' + Date.now();
  createdSlugs.add(slug);
  const { status, json } = await postImport({ token: process.env.BLOG_IMPORT_API_TOKEN, body: makeBody({ slug }) });
  assert.equal(status, 201);
  assert.equal(json.success, true);
  assert.equal(json.data.slug, slug);
  assert.equal(typeof json.data.id, 'string');
  assert.match(json.data.url, /\/blog\//);
  const post = await BlogPost.findOne({ slug }).lean();
  assert.ok(post, 'Le post doit exister en DB');
  assert.equal(post.contentMarkdown.length > 0, true);
  assert.equal(post.contentHtml.length > 0, true);
}));

test('8. POST avec relatedProductIds invalide → 400', async () => {
  const body = makeBody({ extra: { relatedProductIds: ['not-an-objectid', 'still-bad'] } });
  const { status, json } = await postImport({ token: process.env.BLOG_IMPORT_API_TOKEN, body });
  assert.equal(status, 400);
  assert.match(json.error, /relatedProductIds/i);
});

test('9. Markdown trop grand (>200 KB) → 400', async () => {
  const body = { ...makeBody(), markdownUrl: `${fixtureUrl}/big.md` };
  const { status, json } = await postImport({ token: process.env.BLOG_IMPORT_API_TOKEN, body });
  assert.equal(status, 400);
  assert.match(json.error, /volumineux/i);
});

test('10. Markdown URL renvoie 404 → 502', async () => {
  const body = { ...makeBody(), markdownUrl: `${fixtureUrl}/notfound` };
  const { status, json } = await postImport({ token: process.env.BLOG_IMPORT_API_TOKEN, body });
  assert.equal(status, 502);
  assert.match(json.error, /HTTP 404/);
});
