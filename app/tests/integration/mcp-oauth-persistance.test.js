/**
 * Connecteur MCP — les autorisations OAuth survivent à un redémarrage du site.
 *
 * Avant : codes et jetons vivaient en mémoire (Map) dans src/mcp/oauth.js.
 * Chaque déploiement Render redémarrait le site, effaçait tout, et Claude
 * perdait l'accès au connecteur jusqu'à une reconnexion manuelle.
 *
 * Maintenant : ils sont gardés dans MongoDB (empreinte SHA-256 seulement).
 * Ce test rejoue le parcours complet de Claude (consentement, code, jeton),
 * simule un redémarrage en rechargeant les modules, et vérifie que le même
 * jeton ouvre toujours le connecteur. Il vérifie aussi qu'une base
 * indisponible donne 503 (« réessayez ») et jamais 401 (« jeton mort »).
 *
 * Lancé par : npm test (mongodb-memory-server : jamais la production).
 */

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const path = require('path');
const mongoose = require('mongoose');
const express = require('express');
const { MongoMemoryServer } = require('mongodb-memory-server');

process.env.BRAND = 'autoliva';
delete process.env.MONGODB_URI;
process.env.MCP_BEARER_TOKEN = 'secret-de-test-oauth';

const REDIRECT = 'https://claude.ai/api/mcp/auth_callback';
const MODULES_MCP = ['../../src/mcp/server.js', '../../src/mcp/oauth.js'].map((p) => path.resolve(__dirname, p));

/* Démarre un « site » neuf : les modules MCP sont rechargés, donc toute mémoire
 * qu'ils auraient gardée est perdue, exactement comme après un redémarrage. */
async function demarrerSite() {
  for (const m of MODULES_MCP) delete require.cache[m];
  const { mountMcp } = require('../../src/mcp/server');
  const app = express();
  app.use(express.json());
  app.use(express.urlencoded({ extended: false }));
  mountMcp(app);
  const http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  return { http, base: `http://127.0.0.1:${http.address().port}`, fermer: () => new Promise((r) => http.close(r)) };
}

function pkce() {
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

async function obtenirCode(base, challenge) {
  const q = new URLSearchParams({
    response_type: 'code', client_id: 'cpf-analytics-cowork', redirect_uri: REDIRECT,
    state: 'etat-42', code_challenge: challenge, code_challenge_method: 'S256', scope: 'mcp',
  });
  const page = await (await fetch(`${base}/oauth/authorize?${q}`)).text();
  const payload = page.match(/name="payload" value="([^"]+)"/)[1];
  const sig = page.match(/name="sig" value="([^"]+)"/)[1];
  const r = await fetch(`${base}/oauth/authorize`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ secret: process.env.MCP_BEARER_TOKEN, payload, sig }),
  });
  assert.equal(r.status, 302, 'le consentement redirige vers Claude');
  const loc = new URL(r.headers.get('location'));
  assert.equal(loc.origin + loc.pathname, REDIRECT);
  assert.equal(loc.searchParams.get('state'), 'etat-42');
  return loc.searchParams.get('code');
}

async function demanderJeton(base, params) {
  const r = await fetch(`${base}/oauth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  return { status: r.status, corps: await r.json(), retryAfter: r.headers.get('retry-after') };
}

async function ping(base, jeton) {
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' };
  if (jeton) headers.Authorization = `Bearer ${jeton}`;
  const r = await fetch(`${base}/mcp`, { method: 'POST', headers, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping' }) });
  return { status: r.status, retryAfter: r.headers.get('retry-after'), auth: r.headers.get('www-authenticate') };
}

test('connecteur MCP — autorisations gardées en base', async (t) => {
  const serveur = await MongoMemoryServer.create();
  await mongoose.connect(serveur.getUri());
  const McpOAuthToken = require('../../src/models/McpOAuthToken');
  await McpOAuthToken.init();

  let site = await demarrerSite();
  t.after(async () => {
    await site.fermer();
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect();
    await serveur.stop();
  });

  const { verifier, challenge } = pkce();
  let jetons;

  await t.test('le parcours de Claude donne un jeton qui ouvre le connecteur', async () => {
    const code = await obtenirCode(site.base, challenge);
    const r = await demanderJeton(site.base, { grant_type: 'authorization_code', code, code_verifier: verifier });
    assert.equal(r.status, 200);
    assert.equal(r.corps.token_type, 'Bearer');
    assert.ok(r.corps.access_token && r.corps.refresh_token);
    jetons = r.corps;
    assert.equal((await ping(site.base, jetons.access_token)).status, 200);
  });

  await t.test('le jeton survit à un redémarrage du site', async () => {
    await site.fermer();
    site = await demarrerSite();
    assert.equal((await ping(site.base, jetons.access_token)).status, 200);
  });

  await t.test('le jeton de rafraîchissement survit aussi, et ne sert qu\'une fois', async () => {
    const r = await demanderJeton(site.base, { grant_type: 'refresh_token', refresh_token: jetons.refresh_token });
    assert.equal(r.status, 200);
    assert.notEqual(r.corps.refresh_token, jetons.refresh_token);
    assert.equal((await ping(site.base, r.corps.access_token)).status, 200);

    const rejoue = await demanderJeton(site.base, { grant_type: 'refresh_token', refresh_token: jetons.refresh_token });
    assert.equal(rejoue.status, 400);
    assert.equal(rejoue.corps.error, 'invalid_grant');
    jetons = r.corps;
  });

  await t.test('un code d\'autorisation ne sert qu\'une fois, et seulement avec le bon vérificateur', async () => {
    const p = pkce();
    const code = await obtenirCode(site.base, p.challenge);
    const mauvais = await demanderJeton(site.base, { grant_type: 'authorization_code', code, code_verifier: 'pas-le-bon' });
    assert.equal(mauvais.status, 400);
    // Le code a été consommé par la tentative ratée : il ne resservira pas.
    const bon = await demanderJeton(site.base, { grant_type: 'authorization_code', code, code_verifier: p.verifier });
    assert.equal(bon.status, 400);
    assert.equal(bon.corps.error, 'invalid_grant');
  });

  await t.test('un jeton expiré ou inconnu est refusé avec 401', async () => {
    const { hashToken } = require('../../src/mcp/oauth');
    const expire = crypto.randomBytes(32).toString('hex');
    await McpOAuthToken.create({ kind: 'access', tokenHash: hashToken(expire), clientId: 'test', expiresAt: new Date(Date.now() - 1000) });
    const r1 = await ping(site.base, expire);
    assert.equal(r1.status, 401);
    assert.match(r1.auth, /resource_metadata=/);
    assert.equal((await ping(site.base, 'jeton-invente')).status, 401);
    assert.equal((await ping(site.base, null)).status, 401);
  });

  await t.test('aucun jeton n\'est stocké en clair', async () => {
    const docs = await McpOAuthToken.find({}).lean();
    assert.ok(docs.length > 0);
    const brut = JSON.stringify(docs);
    assert.ok(!brut.includes(jetons.access_token), 'jeton d\'accès en clair trouvé');
    assert.ok(!brut.includes(jetons.refresh_token), 'jeton de rafraîchissement en clair trouvé');
    for (const d of docs) assert.match(d.tokenHash, /^[0-9a-f]{64}$/);
  });

  await t.test('les documents expirent tout seuls (index TTL)', async () => {
    const index = await McpOAuthToken.collection.indexes();
    const ttl = index.find((i) => i.key && i.key.expiresAt === 1);
    assert.ok(ttl, 'index sur expiresAt attendu');
    assert.equal(ttl.expireAfterSeconds, 0);
  });

  await t.test('une signature de consentement malformée est refusée sans arrêter le site', async () => {
    const r = await fetch(`${site.base}/oauth/authorize`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: 'x', payload: Buffer.from('{}').toString('base64url'), sig: 'ab' }),
    });
    assert.equal(r.status, 400);
    assert.equal((await ping(site.base, jetons.access_token)).status, 200, 'le site répond toujours');
  });

  await t.test('le secret statique reste accepté', async () => {
    assert.equal((await ping(site.base, process.env.MCP_BEARER_TOKEN)).status, 200);
  });

  await t.test('base indisponible : 503 « réessayez », jamais 401', async () => {
    await mongoose.disconnect();
    const r = await ping(site.base, jetons.access_token);
    assert.equal(r.status, 503, 'un bon jeton ne doit pas être déclaré mort');
    assert.ok(r.retryAfter);
    const tok = await demanderJeton(site.base, { grant_type: 'refresh_token', refresh_token: jetons.refresh_token });
    assert.equal(tok.status, 503);
    assert.equal(tok.corps.error, 'temporarily_unavailable');
    // Sans jeton, Claude doit toujours pouvoir découvrir où se connecter.
    assert.equal((await ping(site.base, null)).status, 401);
    // Le secret statique ne dépend pas de la base.
    assert.equal((await ping(site.base, process.env.MCP_BEARER_TOKEN)).status, 200);

    await mongoose.connect(serveur.getUri());
    assert.equal((await ping(site.base, jetons.access_token)).status, 200, 'la base revenue, le même jeton remarche');
  });
});
