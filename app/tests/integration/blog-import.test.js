/**
 * Tests d'intégration pour POST /api/blog/import-from-url
 *
 * Lance via : npm test
 *
 * Base : mongodb-memory-server, créée et détruite par ce fichier. TEST_MONGODB_URI
 * permet de viser une base de test explicite ; MONGODB_URI est volontairement
 * IGNORÉE — c'est la variable de l'application, et dans ce dépôt elle désigne
 * la base de PRODUCTION. Ces tests créent, modifient et vident des collections.
 *
 * Ces tests :
 *   - démarrent un serveur Express minimal qui ne monte que le router blogImport
 *   - démarrent un mini-serveur HTTP local qui sert les fixtures markdown
 *   - créent puis suppriment leurs propres BlogPost (cleanup automatique)
 *
 * Garde-fous du plan de reprise SEO du 14/09/2026 (action A4.1) vérifiés ici :
 * brouillons seulement, 409 sur un article publié, 5 imports par 24 h, une
 * ligne d'audit par import.
 */

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const express = require('express');
const mongoose = require('mongoose');
const { MongoMemoryServer } = require('mongodb-memory-server');

// Token de test fixé avant le require du router (le router lit process.env)
process.env.BLOG_IMPORT_API_TOKEN = 'test-token-abcdef123456';
process.env.NODE_ENV = process.env.NODE_ENV || 'development';
delete process.env.BLOG_IMPORT_ALLOW_PUBLISH;

const blogImportRouter = require('../../src/routes/api/blogImport');
const BlogPost = require('../../src/models/BlogPost');

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
let memoire;

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
  const handler = (req, res) => {
    if (req.url === '/article-test.md') {
      res.writeHead(200, { 'Content-Type': 'text/markdown', 'Content-Length': Buffer.byteLength(SAMPLE_MARKDOWN) });
      return res.end(SAMPLE_MARKDOWN);
    }
    if (req.url === '/article-reecrit.md') {
      const md = '# Texte réécrit par un tiers\n\nCe contenu ne doit jamais remplacer un article en ligne.\n';
      res.writeHead(200, { 'Content-Type': 'text/markdown', 'Content-Length': Buffer.byteLength(md) });
      return res.end(md);
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

/* Le journal d'audit est « append-only » côté Mongoose (hooks qui refusent
   toute suppression) : on le vide par le pilote natif, entre deux tests. */
async function viderAudit() {
  await mongoose.connection.db.collection('auditlogs').deleteMany({});
}

async function lignesAudit(action) {
  return mongoose.connection.db.collection('auditlogs').find({ action }).sort({ createdAt: 1 }).toArray();
}

/* ─── Hooks ──────────────────────────────────────────────────────────── */

test.before(async () => {
  await startApp();
  await startFixtureServer();
  const uri = process.env.TEST_MONGODB_URI || (memoire = await MongoMemoryServer.create()).getUri();
  await mongoose.connect(uri);
});

test.after(async () => {
  if (mongoose.connection.readyState === 1) {
    await BlogPost.deleteMany({});
    await viderAudit();
    await mongoose.disconnect();
  }
  if (memoire) await memoire.stop();
  if (appServer) await new Promise((r) => appServer.close(r));
  if (fixtureServer) await new Promise((r) => fixtureServer.close(r));
});

test.beforeEach(async () => {
  delete process.env.BLOG_IMPORT_ALLOW_PUBLISH;
  if (mongoose.connection.readyState === 1) {
    await BlogPost.deleteMany({});
    await viderAudit();
  }
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
  return { status: resp.status, json, headers: resp.headers };
}

const TOKEN = () => process.env.BLOG_IMPORT_API_TOKEN;

/* Un article déjà EN LIGNE, créé comme le fait l'admin — pas par l'API. */
async function articleEnLigne(slug, extra = {}) {
  return BlogPost.create({
    title: 'Mécatronique DQ200 : le guide qui rapporte',
    slug,
    contentMarkdown: '# Guide\n\nLe vrai contenu, relu.',
    contentHtml: '<h1>Guide</h1><p>Le vrai contenu, relu.</p>',
    isPublished: true,
    publishedAt: new Date('2026-04-02T09:00:00Z'),
    seo: { metaTitle: 'DQ200 : guide complet', metaDescription: 'Le guide DQ200.' },
    ...extra,
  });
}

/* ─── Tests historiques ──────────────────────────────────────────────── */

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
  const { status, json } = await postImport({ token: TOKEN(), body });
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
      token: TOKEN(),
      body: { ...makeBody(), markdownUrl: `${fixtureUrl}/article-test.md` },
    });
    assert.equal(status, 400);
    assert.match(json.error, /priv|hôte|http/i);
  } finally {
    process.env.NODE_ENV = previous;
  }
});

test('5. POST avec slug existant en mode create → 409', async () => {
  const slug = 'test-conflict';
  const r1 = await postImport({ token: TOKEN(), body: makeBody({ slug }) });
  assert.equal(r1.status, 201);
  const r2 = await postImport({ token: TOKEN(), body: makeBody({ slug }) });
  assert.equal(r2.status, 409);
});

test('6. POST en mode upsert sur un BROUILLON existant → 200, brouillon mis à jour', async () => {
  const slug = 'test-upsert';
  const r1 = await postImport({ token: TOKEN(), body: makeBody({ slug }) });
  assert.equal(r1.status, 201);
  const r2 = await postImport({
    token: TOKEN(),
    body: makeBody({ slug, title: 'Titre mis à jour', mode: 'upsert' }),
  });
  assert.equal(r2.status, 200);
  assert.equal(r2.json.data.created, false);
  assert.equal(r2.json.data.updated, true);
  const post = await BlogPost.findOne({ slug }).lean();
  assert.equal(post.title, 'Titre mis à jour');
  assert.equal(post.isPublished, false, 'un upsert ne publie pas un brouillon');
});

test('7. POST valide → 201, post créé en DB', async () => {
  const slug = 'test-create-ok';
  const { status, json } = await postImport({ token: TOKEN(), body: makeBody({ slug }) });
  assert.equal(status, 201);
  assert.equal(json.success, true);
  assert.equal(json.data.slug, slug);
  assert.equal(typeof json.data.id, 'string');
  assert.match(json.data.url, /\/blog\//);
  const post = await BlogPost.findOne({ slug }).lean();
  assert.ok(post, 'Le post doit exister en DB');
  assert.equal(post.contentMarkdown.length > 0, true);
  assert.equal(post.contentHtml.length > 0, true);
});

test('8. POST avec relatedProductIds invalide → 400', async () => {
  const body = makeBody({ extra: { relatedProductIds: ['not-an-objectid', 'still-bad'] } });
  const { status, json } = await postImport({ token: TOKEN(), body });
  assert.equal(status, 400);
  assert.match(json.error, /relatedProductIds/i);
});

test('9. Markdown trop grand (>200 KB) → 400', async () => {
  const body = { ...makeBody(), markdownUrl: `${fixtureUrl}/big.md` };
  const { status, json } = await postImport({ token: TOKEN(), body });
  assert.equal(status, 400);
  assert.match(json.error, /volumineux/i);
});

test('10. Markdown URL renvoie 404 → 502', async () => {
  const body = { ...makeBody(), markdownUrl: `${fixtureUrl}/notfound` };
  const { status, json } = await postImport({ token: TOKEN(), body });
  assert.equal(status, 502);
  assert.match(json.error, /HTTP 404/);
});

/* ─── Garde-fous A4.1 ────────────────────────────────────────────────── */

test('A4.1 — un import demandé « publié » est enregistré en BROUILLON', async () => {
  const { status, json } = await postImport({ token: TOKEN(), body: makeBody({ slug: 'brouillon-impose' }) });
  assert.equal(status, 201);
  assert.equal(json.data.isPublished, false, 'la réponse dit la vérité');
  assert.ok(json.data.warnings.some((w) => /BROUILLON/.test(w)), 'l’agent est prévenu que rien n’est en ligne');
  const post = await BlogPost.findOne({ slug: 'brouillon-impose' }).lean();
  assert.equal(post.isPublished, false);
  assert.equal(post.publishedAt, null, 'aucune date de publication inventée');
});

test('A4.1 — « à la une » par l’API ne retire pas ce statut à l’article en ligne', async () => {
  await articleEnLigne('article-a-la-une', { isFeatured: true, isHomeFeatured: true });
  const r = await postImport({
    token: TOKEN(),
    body: makeBody({ slug: 'brouillon-vedette', extra: { isFeatured: true, isHomeFeatured: true } }),
  });
  assert.equal(r.status, 201);
  const enLigne = await BlogPost.findOne({ slug: 'article-a-la-une' }).lean();
  assert.equal(enLigne.isFeatured, true, 'l’article en ligne garde « à la une »');
  const brouillon = await BlogPost.findOne({ slug: 'brouillon-vedette' }).lean();
  assert.equal(brouillon.isFeatured, false);
  assert.equal(brouillon.isHomeFeatured, false);
});

test('A4.1 — BLOG_IMPORT_ALLOW_PUBLISH=true rend la publication, et seulement « true »', async () => {
  for (const valeur of ['1', 'yes', 'TRUE', 'on']) {
    process.env.BLOG_IMPORT_ALLOW_PUBLISH = valeur;
    const slug = `pas-publie-${valeur.toLowerCase()}`;
    const r = await postImport({ token: TOKEN(), body: makeBody({ slug }) });
    assert.equal(r.status, 201);
    assert.equal((await BlogPost.findOne({ slug }).lean()).isPublished, false, `« ${valeur} » ne doit pas armer la publication`);
  }
  process.env.BLOG_IMPORT_ALLOW_PUBLISH = 'true';
  const r = await postImport({ token: TOKEN(), body: makeBody({ slug: 'publie-autorise' }) });
  assert.equal(r.status, 201);
  const post = await BlogPost.findOne({ slug: 'publie-autorise' }).lean();
  assert.equal(post.isPublished, true);
  assert.equal(new Date(post.publishedAt).toISOString().slice(0, 10), '2026-05-13');
});

test('A4.1 — upsert sur un article PUBLIÉ → 409, et l’article ne bouge pas d’un octet', async () => {
  const avant = (await articleEnLigne('dq200-guide-qui-rapporte')).toObject();
  for (const publier of [false, true]) {
    /* Même avec la publication rendue : un jeton ne réécrit jamais un article en ligne. */
    if (publier) process.env.BLOG_IMPORT_ALLOW_PUBLISH = 'true'; else delete process.env.BLOG_IMPORT_ALLOW_PUBLISH;
    const r = await postImport({
      token: TOKEN(),
      body: makeBody({ slug: 'dq200-guide-qui-rapporte', title: 'Titre réécrit', md: '/article-reecrit.md', mode: 'upsert', extra: { isPublished: false } }),
    });
    assert.equal(r.status, 409, `publication ${publier ? 'autorisée' : 'coupée'} : 409 attendu`);
    assert.equal(r.json.details.raison, 'article_publie');
  }
  const apres = await BlogPost.findOne({ slug: 'dq200-guide-qui-rapporte' }).lean();
  for (const champ of ['title', 'contentMarkdown', 'contentHtml', 'isPublished']) {
    assert.deepEqual(apres[champ], avant[champ], `${champ} a été modifié`);
  }
  assert.equal(new Date(apres.publishedAt).getTime(), new Date(avant.publishedAt).getTime());
  assert.deepEqual(apres.seo, avant.seo);
  const refus = await lignesAudit('blog.import-from-url.refus');
  assert.equal(refus.length, 2, 'chaque tentative refusée laisse une trace');
  assert.equal(refus[0].after.raison, 'article_publie');
  assert.equal((await lignesAudit('blog.import-from-url')).length, 0, 'un refus ne compte pas comme un import');
});

test('A4.1 — 5 imports par 24 h, puis 429 ; une ligne d’audit par import', async () => {
  for (let i = 1; i <= 5; i++) {
    const r = await postImport({ token: TOKEN(), body: makeBody({ slug: `lot-${i}` }) });
    assert.equal(r.status, 201, `import ${i}`);
  }
  const r6 = await postImport({ token: TOKEN(), body: makeBody({ slug: 'lot-6' }) });
  assert.equal(r6.status, 429);
  assert.equal(r6.json.details.plafond, 5);
  const retry = Number(r6.headers.get('retry-after'));
  assert.ok(retry > 23 * 3600 && retry <= 24 * 3600, `Retry-After ≈ 24 h (reçu ${retry})`);
  assert.equal(await BlogPost.exists({ slug: 'lot-6' }), null, 'le 6e n’est pas créé');

  /* Un upsert compte aussi : sinon le plafond se contourne en changeant de mode. */
  const r7 = await postImport({ token: TOKEN(), body: makeBody({ slug: 'lot-1', mode: 'upsert', title: 'Encore' }) });
  assert.equal(r7.status, 429);

  const imports = await lignesAudit('blog.import-from-url');
  assert.equal(imports.length, 5, 'exactement une ligne par import réussi');
  assert.deepEqual(imports.map((l) => l.after.slug), ['lot-1', 'lot-2', 'lot-3', 'lot-4', 'lot-5']);
  for (const l of imports) {
    assert.equal(l.after.isPublished, false);
    assert.equal(l.after.brouillonImpose, true);
    assert.equal(l.after.tokenId, TOKEN().slice(0, 8));
  }
  const refus = await lignesAudit('blog.import-from-url.refus');
  assert.deepEqual(refus.map((l) => l.after.raison), ['plafond', 'plafond']);
});

test('A4.1 — un lot lancé EN PARALLÈLE ne passe pas le plafond non plus', async () => {
  /* Un script qui envoie ses articles d'un coup : sans file, chaque requête
     comptait « 0 import » avant que la première n'ait écrit sa ligne d'audit,
     et tout le lot passait. */
  const reponses = await Promise.all(
    Array.from({ length: 12 }, (_, i) => postImport({ token: TOKEN(), body: makeBody({ slug: `parallele-${i + 1}` }) }))
  );
  const statuts = reponses.map((r) => r.status);
  assert.equal(statuts.filter((s) => s === 201).length, 5, `5 imports au plus (reçu ${statuts.join(', ')})`);
  assert.equal(statuts.filter((s) => s === 429).length, 7);
  assert.equal(await BlogPost.countDocuments({ slug: /^parallele-/ }), 5);
  assert.equal((await lignesAudit('blog.import-from-url')).length, 5);
});

test('A4.1 — les imports de plus de 24 h ne comptent plus', async () => {
  const vieux = new Date(Date.now() - 25 * 3600 * 1000);
  await mongoose.connection.db.collection('auditlogs').insertMany(
    Array.from({ length: 5 }, (_, i) => ({ action: 'blog.import-from-url', entityId: `ancien-${i}`, createdAt: vieux }))
  );
  const r = await postImport({ token: TOKEN(), body: makeBody({ slug: 'apres-la-fenetre' }) });
  assert.equal(r.status, 201);
});
