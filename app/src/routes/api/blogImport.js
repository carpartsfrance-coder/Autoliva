/**
 * API d'import de BlogPost à partir d'une URL pointant vers un fichier markdown.
 *
 * Endpoint : POST /api/blog/import-from-url
 * Auth     : Bearer BLOG_IMPORT_API_TOKEN
 *
 * Cas d'usage : scheduled task SEO orchestrant N sous-agents Claude qui
 * publient chacun leur cocon (5 articles). Le markdown ne transite plus
 * dans le corps des commandes JS — il est exposé via une URL publique
 * (tunnel cloudflared / serveur HTTP local) puis fetché par le serveur.
 *
 * Bénéfices vs POST multipart classique :
 *   - Coût contexte réduit côté agent (pas de markdown 12-20 Ko dans le prompt)
 *   - Server-to-server propre (Bearer token, audit log, validation stricte)
 *   - Compatible avec mode upsert pour ré-exécutions idempotentes
 */

const express = require('express');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');
const dns = require('dns').promises;

const blogPostService = require('../../services/blogPostService');
const audit = require('../../services/auditLogger');
const { getSiteUrlFromEnv } = require('../../services/siteUrl');

const router = express.Router();

/* ─── Logger ─────────────────────────────────────────────────────────── */

const LOG_DIR = path.join(__dirname, '..', '..', '..', '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'blog-import-api.log');

function ensureLogDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (_) { /* best-effort */ }
}
ensureLogDir();

function logApi(req, res, extra = '') {
  const line = `${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode}${extra ? ' ' + extra : ''}\n`;
  try { fs.appendFile(LOG_FILE, line, () => {}); } catch (_) {}
}

router.use((req, res, next) => {
  res.on('finish', () => logApi(req, res));
  next();
});

/* ─── Helpers réponse ────────────────────────────────────────────────── */

function ok(res, data, status = 200) {
  return res.status(status).json({ success: true, data });
}

function fail(res, error, status = 400, details = null) {
  const body = { success: false, error };
  if (details) body.details = details;
  return res.status(status).json(body);
}

/* ─── Auth Bearer ────────────────────────────────────────────────────── */

/**
 * Comparaison à temps constant pour éviter le timing-attack sur le token.
 * (Buffer.compare est constant-time uniquement si les longueurs matchent.)
 */
function timingSafeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  if (a.length !== b.length) return false;
  const crypto = require('crypto');
  return crypto.timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

function requireBlogImportToken(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const expected = (process.env.BLOG_IMPORT_API_TOKEN || '').trim();
  if (!expected) {
    return fail(res, 'BLOG_IMPORT_API_TOKEN non configuré côté serveur.', 500);
  }
  if (!token || !timingSafeEqual(token, expected)) {
    return fail(res, 'Non autorisé : token absent ou invalide.', 401);
  }
  // On stocke un préfixe identifiable pour les logs/audit (jamais le token entier)
  req.blogImportTokenId = token.slice(0, 8);
  return next();
}

/* ─── Validation manuelle (le projet n'utilise ni joi ni ajv) ────────── */

const MAX_TITLE = 200;
const MAX_SLUG = 150;
const SLUG_REGEX = /^[a-z0-9-]+$/;
const MAX_MARKDOWN_BYTES = 200 * 1024; // 200 KB
const FETCH_TIMEOUT_MS = 15_000;

const PRIVATE_HOST_PATTERNS = [
  /^localhost$/i,
  /^127\./,
  /^10\./,
  /^192\.168\./,
  /^169\.254\./,
  /^0\./,
  /^::1$/,
  /^fe80:/i,
  /^fc00:/i,
  /^fd[0-9a-f]{2}:/i,
];

function isPrivateHost(hostname) {
  if (!hostname) return true;
  for (const pat of PRIVATE_HOST_PATTERNS) {
    if (pat.test(hostname)) return true;
  }
  return false;
}

/**
 * Vérifie qu'une URL est sûre à fetch :
 *   - protocole https en prod (http accepté en dev)
 *   - hostname pas dans le bloc privé
 *   - hostname résolu pas dans le bloc privé non plus (anti-DNS-rebinding)
 */
async function validateMarkdownUrl(rawUrl, { allowHttp = false, allowPrivate = false }) {
  let u;
  try {
    u = new URL(rawUrl);
  } catch (_) {
    throw new blogPostService.ValidationError('markdownUrl invalide (format URL).');
  }

  if (u.protocol !== 'https:' && !(allowHttp && u.protocol === 'http:')) {
    throw new blogPostService.ValidationError('markdownUrl doit utiliser https:// (http:// accepté uniquement en dev).');
  }

  if (!allowPrivate && isPrivateHost(u.hostname)) {
    throw new blogPostService.ValidationError(`markdownUrl pointe vers un hôte privé non autorisé : ${u.hostname}`);
  }

  // Anti-DNS-rebinding : on résout l'hostname côté serveur et on vérifie que
  // l'IP n'est pas privée. Skippé en dev pour permettre les hostnames de test.
  if (!allowPrivate) {
    try {
      const records = await dns.lookup(u.hostname, { all: true });
      for (const rec of records) {
        if (isPrivateHost(rec.address)) {
          throw new blogPostService.ValidationError(`markdownUrl résout vers une IP privée : ${rec.address}`);
        }
      }
    } catch (err) {
      if (err instanceof blogPostService.ValidationError) throw err;
      // DNS lookup failure : on rejette plutôt que de risquer un fetch aveugle
      throw new blogPostService.ValidationError(`Impossible de résoudre markdownUrl : ${err.message}`);
    }
  }

  return u;
}

/**
 * Fetch un fichier markdown depuis une URL avec :
 *   - timeout AbortController
 *   - taille max 200 KB
 *   - User-Agent identifiable
 *   - vérification soft du Content-Type (warn mais ne bloque pas pour
 *     supporter les hébergeurs qui servent en application/octet-stream)
 */
async function fetchMarkdown(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let resp;
  try {
    resp = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        'User-Agent': 'CarPartsFrance-BlogImporter/1.0',
        Accept: 'text/markdown, text/plain, */*;q=0.5',
      },
      signal: controller.signal,
      redirect: 'follow',
    });
  } catch (err) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new blogPostService.ServiceError(
        `Timeout (${FETCH_TIMEOUT_MS}ms) en récupérant le markdown.`,
        { code: 'fetch_timeout', status: 502 }
      );
    }
    throw new blogPostService.ServiceError(
      `Erreur réseau en récupérant le markdown : ${err.message}`,
      { code: 'fetch_network_error', status: 502 }
    );
  }
  clearTimeout(timer);

  if (!resp.ok) {
    throw new blogPostService.ServiceError(
      `Le serveur du markdown a répondu HTTP ${resp.status}.`,
      { code: 'fetch_http_error', status: 502, details: { upstreamStatus: resp.status } }
    );
  }

  const contentLength = parseInt(resp.headers.get('content-length') || '0', 10);
  if (Number.isFinite(contentLength) && contentLength > MAX_MARKDOWN_BYTES) {
    throw new blogPostService.ValidationError(
      `Markdown trop volumineux : ${contentLength} octets (max ${MAX_MARKDOWN_BYTES}).`
    );
  }

  // Buffering avec garde de taille (au cas où content-length n'est pas fourni)
  const reader = resp.body.getReader();
  const chunks = [];
  let total = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_MARKDOWN_BYTES) {
      try { reader.cancel(); } catch (_) {}
      throw new blogPostService.ValidationError(
        `Markdown trop volumineux (>${MAX_MARKDOWN_BYTES} octets).`
      );
    }
    chunks.push(value);
  }
  const buf = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return buf.toString('utf8');
}

/* ─── Validation du body JSON ────────────────────────────────────────── */

function validateRequestBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new blogPostService.ValidationError('Body JSON requis.');
  }

  const markdownUrl = typeof body.markdownUrl === 'string' ? body.markdownUrl.trim() : '';
  if (!markdownUrl) throw new blogPostService.ValidationError('markdownUrl requis.');

  const metadata = body.metadata && typeof body.metadata === 'object' ? body.metadata : null;
  if (!metadata) throw new blogPostService.ValidationError('metadata (objet) requis.');

  const title = typeof metadata.title === 'string' ? metadata.title.trim() : '';
  if (!title) throw new blogPostService.ValidationError('metadata.title requis.');
  if (title.length > MAX_TITLE) throw new blogPostService.ValidationError(`metadata.title trop long (max ${MAX_TITLE}).`);

  const slug = typeof metadata.slug === 'string' ? metadata.slug.trim() : '';
  if (!slug) throw new blogPostService.ValidationError('metadata.slug requis.');
  if (slug.length > MAX_SLUG) throw new blogPostService.ValidationError(`metadata.slug trop long (max ${MAX_SLUG}).`);
  if (!SLUG_REGEX.test(slug)) {
    throw new blogPostService.ValidationError('metadata.slug invalide (format attendu : [a-z0-9-]+).');
  }

  // Warnings non bloquants (loggés en réponse pour info, on ne refuse pas l'article)
  const warnings = [];
  if (metadata.seo && typeof metadata.seo === 'object') {
    const mt = typeof metadata.seo.metaTitle === 'string' ? metadata.seo.metaTitle.trim() : '';
    if (mt && (mt.length < 30 || mt.length > 80)) {
      warnings.push(`seo.metaTitle hors plage recommandée (${mt.length} car., conseillé 50-65)`);
    }
    const md = typeof metadata.seo.metaDescription === 'string' ? metadata.seo.metaDescription.trim() : '';
    if (md && (md.length < 80 || md.length > 200)) {
      warnings.push(`seo.metaDescription hors plage recommandée (${md.length} car., conseillé 120-165)`);
    }
  }

  // relatedProductIds : si présent, doit être un array (sinon on accepte aussi string pour
  // compat form, mais on validera strict en service ensuite)
  if (typeof metadata.relatedProductIds !== 'undefined') {
    if (!Array.isArray(metadata.relatedProductIds) && typeof metadata.relatedProductIds !== 'string') {
      throw new blogPostService.ValidationError('metadata.relatedProductIds doit être un array d\'ObjectId (ou une chaîne CSV/multi-lignes).');
    }
  }

  const modeRaw = typeof body.mode === 'string' ? body.mode.trim().toLowerCase() : 'create';
  if (modeRaw && !['create', 'upsert'].includes(modeRaw)) {
    throw new blogPostService.ValidationError('mode invalide (valeurs autorisées : create, upsert).');
  }

  return { markdownUrl, metadata, mode: modeRaw || 'create', warnings };
}

/* ─── Endpoint principal ─────────────────────────────────────────────── */

router.post('/import-from-url', requireBlogImportToken, express.json({ limit: '256kb' }), async (req, res) => {
  const isDev = (process.env.NODE_ENV || 'development') !== 'production';

  let parsed;
  try {
    parsed = validateRequestBody(req.body);
  } catch (err) {
    if (err instanceof blogPostService.ValidationError) {
      return fail(res, err.message, 400, err.details);
    }
    return fail(res, err.message || 'Erreur de validation.', 400);
  }

  const { markdownUrl, metadata, mode, warnings } = parsed;

  // Validation URL + SSRF
  let urlObj;
  try {
    urlObj = await validateMarkdownUrl(markdownUrl, { allowHttp: isDev, allowPrivate: isDev });
  } catch (err) {
    if (err instanceof blogPostService.ValidationError) return fail(res, err.message, 400);
    return fail(res, err.message || 'URL invalide.', 400);
  }

  // Fetch markdown
  let markdown;
  try {
    markdown = await fetchMarkdown(urlObj);
  } catch (err) {
    if (err instanceof blogPostService.ValidationError) return fail(res, err.message, 400);
    if (err instanceof blogPostService.ServiceError) return fail(res, err.message, err.status, err.details);
    return fail(res, err.message || 'Erreur lors du fetch du markdown.', 502);
  }

  if (!markdown || !markdown.trim()) {
    return fail(res, 'Le markdown récupéré est vide.', 400);
  }

  // Construction de l'objet data attendu par le service
  const data = {
    ...metadata,
    contentMarkdown: markdown,
    // Si publishedAt n'est pas fourni mais isPublished=true, le service utilisera now
  };

  // Création / Upsert
  try {
    let result;
    if (mode === 'upsert') {
      result = await blogPostService.upsertBlogPost({
        data,
        source: 'api-import',
        options: { strictProducts: true },
      });
    } else {
      const created = await blogPostService.createBlogPost({
        data,
        source: 'api-import',
        options: { slugMode: 'strict', strictProducts: true },
      });
      result = { post: created.post, created: true, updated: false };
    }

    // Audit log (best-effort, n'échoue pas la requête)
    try {
      await audit.log({
        req,
        action: 'blog.import-from-url',
        entityType: 'blog_post',
        entityId: String(result.post._id),
        after: {
          slug: result.post.slug,
          mode,
          source: 'api-import',
          tokenId: req.blogImportTokenId,
          markdownUrl: urlObj.toString(),
          markdownBytes: Buffer.byteLength(markdown, 'utf8'),
          isPublished: result.post.isPublished,
          warnings,
        },
      });
    } catch (_) { /* best-effort */ }

    const baseUrl = getSiteUrlFromEnv() || '';
    const publicUrl = baseUrl
      ? `${baseUrl}/blog/${encodeURIComponent(result.post.slug)}`
      : `/blog/${encodeURIComponent(result.post.slug)}`;

    return ok(res, {
      id: String(result.post._id),
      slug: result.post.slug,
      url: publicUrl,
      created: result.created,
      updated: result.updated,
      isPublished: result.post.isPublished,
      warnings,
    }, result.created ? 201 : 200);
  } catch (err) {
    if (err instanceof blogPostService.ConflictError) {
      return fail(res, err.message, 409, err.details);
    }
    if (err instanceof blogPostService.ValidationError) {
      return fail(res, err.message, 400, err.details);
    }
    if (err instanceof blogPostService.ServiceError) {
      return fail(res, err.message, err.status, err.details);
    }
    console.error('[blogImport] Erreur inattendue :', err);
    return fail(res, 'Erreur serveur interne.', 500);
  }
});

module.exports = router;
