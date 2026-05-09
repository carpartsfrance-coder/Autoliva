'use strict';

// OAuth 2.1 minimal pour Claude.ai/Cowork.
//
// Pourquoi : les Custom Connectors de claude.ai exigent strictement OAuth 2.1
// avec Dynamic Client Registration (RFC 7591) et Protected Resource Metadata
// (RFC 9728). Pas de support du Bearer statique direct dans l'UI.
//
// Architecture choisie :
// - Single-user, single-secret : `MCP_BEARER_TOKEN` reste le secret partagé
//   que l'utilisateur saisit sur la page de consent /oauth/authorize.
// - L'AS émet un access token random (32 bytes) après validation du secret.
// - Tokens et codes vivent en mémoire (Map). Un redémarrage les invalide
//   → l'utilisateur doit refaire le consent. Acceptable en pratique
//   (auth perdure quelques jours, refresh inclus, redémarrages rares).
// - PKCE S256 obligatoire (OAuth 2.1).

const crypto = require('crypto');

const STATIC_CLIENT_ID = 'cpf-analytics-cowork';
const ACCESS_TOKEN_TTL_S = 30 * 24 * 3600; // 30 jours
const CODE_TTL_MS = 5 * 60 * 1000; // 5 min

// Stockage en mémoire :
// codes : Map<code, { code_challenge, redirect_uri, client_id, expiresAt }>
// accessTokens : Map<token, { issuedAt, expiresAt, clientId }>
// refreshTokens : Map<token, { issuedAt }>
const codes = new Map();
const accessTokens = new Map();
const refreshTokens = new Map();

function getBaseUrl(req) {
  const proto = req.get('x-forwarded-proto') || (req.secure ? 'https' : 'http');
  const host = req.get('x-forwarded-host') || req.get('host');
  return `${proto}://${host}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// La CSP globale d'helmet inclut form-action 'self' https://*.mollie.com
// https://*.scalapay.com mais PAS claude.ai. Le navigateur bloque alors le
// redirect 302 du POST /oauth/authorize vers https://claude.ai/api/mcp/auth_callback.
// On surcharge donc la CSP sur les routes OAuth pour autoriser claude.ai.
function setOAuthCsp(res) {
  res.set(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "form-action 'self' https://claude.ai https://*.claude.ai https://*.anthropic.com",
      "frame-ancestors 'none'",
      "base-uri 'self'",
    ].join('; ')
  );
}

// === Endpoints metadata (RFC 9728 + RFC 8414) ============================

function handleProtectedResourceMetadata(req, res) {
  const base = getBaseUrl(req);
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp'],
    resource_documentation: `${base}/mcp`,
  });
}

function handleAuthorizationServerMetadata(req, res) {
  const base = getBaseUrl(req);
  res.set('Cache-Control', 'public, max-age=3600');
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    registration_endpoint: `${base}/oauth/register`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code', 'refresh_token'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none', 'client_secret_post'],
    scopes_supported: ['mcp'],
  });
}

// === Dynamic Client Registration (RFC 7591) ==============================

function handleRegister(req, res) {
  // On accepte tous les clients : pas de validation, ID statique partagé.
  // Le contrôle d'accès se fait au /oauth/authorize via le secret saisi.
  const body = req.body || {};
  res.status(201).json({
    client_id: STATIC_CLIENT_ID,
    client_id_issued_at: Math.floor(Date.now() / 1000),
    token_endpoint_auth_method: 'none',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    redirect_uris: Array.isArray(body.redirect_uris) && body.redirect_uris.length > 0
      ? body.redirect_uris
      : ['https://claude.ai/api/mcp/auth_callback'],
    client_name: body.client_name || 'Claude.ai',
    scope: 'mcp',
  });
}

// === /oauth/authorize ====================================================

function handleAuthorizeGet(req, res) {
  setOAuthCsp(res);
  const {
    client_id,
    redirect_uri,
    response_type,
    state,
    code_challenge,
    code_challenge_method,
    scope,
  } = req.query;

  if (response_type !== 'code') {
    return res.status(400).send('response_type doit être "code"');
  }
  if (!code_challenge) {
    return res.status(400).send('code_challenge manquant (PKCE requis)');
  }
  if (code_challenge_method !== 'S256') {
    return res.status(400).send('code_challenge_method doit être S256');
  }
  if (!redirect_uri) {
    return res.status(400).send('redirect_uri manquant');
  }

  // On encode les paramètres dans un champ caché, signés HMAC pour empêcher
  // un attaquant de forger un consent vers une autre redirect_uri.
  const expected = process.env.MCP_BEARER_TOKEN;
  if (!expected) return res.status(503).send('Serveur non configuré (MCP_BEARER_TOKEN absent)');

  const payload = JSON.stringify({
    client_id: client_id || STATIC_CLIENT_ID,
    redirect_uri,
    state: state || '',
    code_challenge,
    scope: scope || 'mcp',
  });
  const sig = crypto.createHmac('sha256', expected).update(payload).digest('hex');
  const encoded = Buffer.from(payload).toString('base64url');

  const html = `<!DOCTYPE html>
<html lang="fr">
<head>
  <meta charset="utf-8">
  <title>Autoliva — Autoriser Claude</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; max-width: 420px; margin: 60px auto; padding: 24px; color: #111; }
    h1 { font-size: 22px; margin: 0 0 8px; }
    p { color: #555; line-height: 1.5; }
    label { display: block; margin: 24px 0 8px; font-weight: 600; font-size: 14px; }
    input[type=password] { width: 100%; padding: 12px; font-size: 15px; border: 1px solid #ccc; border-radius: 8px; box-sizing: border-box; }
    button { width: 100%; padding: 14px; margin-top: 20px; font-size: 15px; font-weight: 600; background: #4f46e5; color: white; border: 0; border-radius: 8px; cursor: pointer; }
    button:hover { background: #4338ca; }
    .info { background: #f3f4f6; border-radius: 8px; padding: 12px; font-size: 13px; margin-top: 24px; color: #4b5563; }
    .info code { background: #e5e7eb; padding: 2px 5px; border-radius: 3px; font-size: 12px; }
  </style>
</head>
<body>
  <h1>Autoliva — Autoriser Claude</h1>
  <p>Claude souhaite accéder à vos données business (CA, ventes, campagnes, paniers abandonnés) en lecture seule.</p>
  <form method="POST" action="/oauth/authorize">
    <input type="hidden" name="payload" value="${escapeHtml(encoded)}">
    <input type="hidden" name="sig" value="${escapeHtml(sig)}">
    <label for="secret">Secret d'accès</label>
    <input type="password" id="secret" name="secret" autocomplete="current-password" autofocus required>
    <button type="submit">Autoriser Claude</button>
  </form>
  <div class="info">
    Le secret d'accès est la valeur de la variable d'environnement <code>MCP_BEARER_TOKEN</code> configurée sur Render.
  </div>
</body>
</html>`;
  res.set('Content-Type', 'text/html; charset=utf-8').send(html);
}

function handleAuthorizePost(req, res) {
  setOAuthCsp(res);
  const expected = process.env.MCP_BEARER_TOKEN;
  if (!expected) return res.status(503).send('Serveur non configuré');

  const { secret, payload, sig } = req.body || {};
  if (!secret || !payload || !sig) {
    return res.status(400).send('Paramètres manquants');
  }

  // Vérifie la signature pour empêcher un consent forgé.
  const decoded = (() => {
    try { return Buffer.from(payload, 'base64url').toString('utf8'); } catch { return null; }
  })();
  if (!decoded) return res.status(400).send('Payload invalide');

  const expectedSig = crypto.createHmac('sha256', expected).update(decoded).digest('hex');
  if (!crypto.timingSafeEqual(Buffer.from(sig, 'hex'), Buffer.from(expectedSig, 'hex'))) {
    return res.status(400).send('Signature invalide');
  }

  const params = JSON.parse(decoded);

  // Validation du secret saisi par l'utilisateur (constant-time).
  const a = Buffer.from(secret);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    return res
      .status(403)
      .set('Content-Type', 'text/html; charset=utf-8')
      .send('<!DOCTYPE html><html><body style="font-family:sans-serif;max-width:420px;margin:60px auto;padding:24px"><h1>Secret incorrect</h1><p><a href="javascript:history.back()">Retour</a></p></body></html>');
  }

  // Émet un code d'autorisation.
  const code = crypto.randomBytes(32).toString('hex');
  codes.set(code, {
    code_challenge: params.code_challenge,
    redirect_uri: params.redirect_uri,
    client_id: params.client_id,
    expiresAt: Date.now() + CODE_TTL_MS,
  });

  const url = new URL(params.redirect_uri);
  url.searchParams.set('code', code);
  if (params.state) url.searchParams.set('state', params.state);
  return res.redirect(url.toString());
}

// === /oauth/token ========================================================

function issueAccessToken(clientId) {
  const accessToken = crypto.randomBytes(32).toString('hex');
  const refreshToken = crypto.randomBytes(32).toString('hex');
  const now = Date.now();
  accessTokens.set(accessToken, {
    issuedAt: now,
    expiresAt: now + ACCESS_TOKEN_TTL_S * 1000,
    clientId,
  });
  refreshTokens.set(refreshToken, { issuedAt: now, clientId });
  return { accessToken, refreshToken };
}

function handleToken(req, res) {
  const body = req.body || {};
  const grantType = body.grant_type;

  if (grantType === 'authorization_code') {
    const { code, code_verifier } = body;
    const data = codes.get(code);
    if (!data) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Code inconnu' });
    }
    codes.delete(code);
    if (data.expiresAt < Date.now()) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Code expiré' });
    }
    if (!code_verifier) {
      return res.status(400).json({ error: 'invalid_request', error_description: 'code_verifier manquant' });
    }
    const challenge = crypto.createHash('sha256').update(code_verifier).digest('base64url');
    if (challenge !== data.code_challenge) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'PKCE mismatch' });
    }

    const { accessToken, refreshToken } = issueAccessToken(data.client_id);
    return res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: refreshToken,
      scope: 'mcp',
    });
  }

  if (grantType === 'refresh_token') {
    const { refresh_token } = body;
    const data = refreshTokens.get(refresh_token);
    if (!data) {
      return res.status(400).json({ error: 'invalid_grant', error_description: 'Refresh token inconnu' });
    }
    const { accessToken, refreshToken: newRefresh } = issueAccessToken(data.clientId);
    refreshTokens.delete(refresh_token);
    return res.json({
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_S,
      refresh_token: newRefresh,
      scope: 'mcp',
    });
  }

  return res.status(400).json({ error: 'unsupported_grant_type' });
}

// === Validation d'un access token (utilisé par bearerAuth de server.js) ===

function isValidAccessToken(token) {
  const data = accessTokens.get(token);
  if (!data) return false;
  if (data.expiresAt < Date.now()) {
    accessTokens.delete(token);
    return false;
  }
  return true;
}

// === Montage des routes ===================================================

function mountOAuth(app) {
  // Metadata (RFC 9728 + RFC 8414) — accessibles sans auth, en GET.
  // Les chemins .well-known sont au root du domaine (convention Anthropic).
  app.get('/.well-known/oauth-protected-resource', handleProtectedResourceMetadata);
  app.get('/.well-known/oauth-protected-resource/mcp', handleProtectedResourceMetadata);
  app.get('/.well-known/oauth-authorization-server', handleAuthorizationServerMetadata);

  // Dynamic Client Registration
  app.post('/oauth/register', handleRegister);

  // Authorization endpoint — page HTML de consent
  app.get('/oauth/authorize', handleAuthorizeGet);
  app.post('/oauth/authorize', handleAuthorizePost);

  // Token endpoint
  app.post('/oauth/token', handleToken);
}

module.exports = { mountOAuth, isValidAccessToken };
