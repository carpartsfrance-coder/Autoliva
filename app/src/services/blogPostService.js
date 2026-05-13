/**
 * Service partagé pour la création/mise à jour de BlogPost.
 *
 * Utilisé par :
 *   - blogAdminController (formulaire HTML admin)
 *   - routes/api/blogImport (endpoint API server-to-server)
 *
 * Centralise la validation, le mapping et la persistance pour éviter
 * la duplication de logique entre le form admin et l'API.
 */

const mongoose = require('mongoose');

const BlogPost = require('../models/BlogPost');
const { slugify } = require('./productPublic');
const { markdownToHtml, stripHtml } = require('./blogContent');

/* ─── Erreurs typées (le caller peut différencier la cause) ─────────── */

class ServiceError extends Error {
  constructor(message, { code, status, details } = {}) {
    super(message);
    this.name = 'BlogPostServiceError';
    this.code = code || 'service_error';
    this.status = status || 500;
    this.details = details || null;
  }
}

class ValidationError extends ServiceError {
  constructor(message, details) {
    super(message, { code: 'validation_failed', status: 400, details });
    this.name = 'BlogPostValidationError';
  }
}

class ConflictError extends ServiceError {
  constructor(message, details) {
    super(message, { code: 'slug_conflict', status: 409, details });
    this.name = 'BlogPostConflictError';
  }
}

/* ─── Helpers ───────────────────────────────────────────────────────── */

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeMetaText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function truncateText(value, max) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) return '';
  if (!Number.isFinite(max) || max <= 0) return input;
  if (input.length <= max) return input;
  return `${input.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function parseIntOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, Math.floor(value));
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.floor(n));
}

/**
 * Accepte plusieurs formats pour la liste d'ObjectId produit liés :
 *   - array natif : ['650abc…', '650def…']
 *   - chaîne multi-lignes (form HTML) : "650abc…\n650def…"
 *   - chaîne CSV : "650abc…, 650def…"
 * Retourne un tableau d'ObjectId Mongoose (les invalides sont silencieusement
 * ignorés en mode form ; le caller API valide en amont si strict).
 */
function parseObjectIdList(value, { strict = false } = {}) {
  let raw = [];
  if (Array.isArray(value)) {
    raw = value.map((v) => String(v || '').trim()).filter(Boolean);
  } else if (typeof value === 'string') {
    raw = value
      .split(/[\r\n,]+/)
      .map((l) => l.trim())
      .filter(Boolean);
  }

  const ids = [];
  const invalid = [];
  for (const id of raw) {
    if (mongoose.Types.ObjectId.isValid(id) && /^[a-f0-9]{24}$/i.test(id)) {
      ids.push(new mongoose.Types.ObjectId(id));
    } else {
      invalid.push(id);
    }
  }
  if (strict && invalid.length) {
    throw new ValidationError(`relatedProductIds invalides : ${invalid.join(', ')}`, { invalid });
  }
  return ids;
}

/**
 * Trouve un slug disponible en suffixant un nombre si nécessaire.
 * Si excludeId est passé, le doc avec cet id n'est pas considéré comme
 * conflictuel (utile pour les updates qui ne changent pas le slug).
 */
async function ensureUniqueSlug(baseSlug, { excludeId } = {}) {
  const base = getTrimmedString(baseSlug);
  const normalized = base || 'article';

  let candidate = normalized;
  let i = 2;

  // Safety : pas plus de 200 itérations (cas d'edge)
  while (i < 200) {
    const filter = { slug: candidate };
    if (excludeId && mongoose.Types.ObjectId.isValid(excludeId)) {
      filter._id = { $ne: new mongoose.Types.ObjectId(excludeId) };
    }
    const exists = await BlogPost.exists(filter);
    if (!exists) return candidate;
    candidate = `${normalized}-${i}`;
    i += 1;
  }
  return `${normalized}-${Date.now()}`;
}

/**
 * Vérifie si un slug existe déjà sans suffixer. Utile pour le mode "create"
 * de l'API qui veut un 409 explicite plutôt qu'un slug suffixé.
 */
async function slugExists(slug, { excludeId } = {}) {
  const filter = { slug: String(slug || '').trim().toLowerCase() };
  if (excludeId && mongoose.Types.ObjectId.isValid(excludeId)) {
    filter._id = { $ne: new mongoose.Types.ObjectId(excludeId) };
  }
  return Boolean(await BlogPost.exists(filter));
}

/* ─── Construction du document BlogPost ─────────────────────────────── */

/**
 * Normalise une donnée d'entrée (form admin OU API JSON) vers la structure
 * exacte attendue par le modèle BlogPost. C'est ici que vivent les règles
 * métier (auteur par défaut, html dérivé du markdown, publishedAt logique
 * publish/draft, etc.).
 *
 * @param {Object} data — clé/valeur (mixte form/API)
 * @returns {Object} doc BlogPost prêt à passer à create/update
 */
function buildBlogPostDoc(data, { strictProducts = false } = {}) {
  const title = getTrimmedString(data.title);
  if (!title) throw new ValidationError('title requis.');
  if (title.length > 200) throw new ValidationError('title trop long (max 200 caractères).');

  const slugInput = getTrimmedString(data.slug);
  // Si pas de slug fourni, on le génère depuis le titre.
  const slugCandidate = slugInput || slugify(title) || 'article';
  // Validation : doit matcher [a-z0-9-]+
  if (!/^[a-z0-9-]+$/.test(slugCandidate)) {
    throw new ValidationError('slug invalide (format attendu : [a-z0-9-]+).');
  }
  if (slugCandidate.length > 150) {
    throw new ValidationError('slug trop long (max 150 caractères).');
  }

  const excerpt = getTrimmedString(data.excerpt);
  const contentMarkdown = typeof data.contentMarkdown === 'string' ? data.contentMarkdown : '';
  const contentHtml = contentMarkdown
    ? markdownToHtml(contentMarkdown)
    : (typeof data.contentHtml === 'string' ? data.contentHtml : '');

  const coverImageUrl = getTrimmedString(data.coverImageUrl);
  const authorName = getTrimmedString(data.authorName) || 'Expert CarParts';

  // Catégorie : accepte soit l'objet { label, slug } (API) soit les champs plats (form)
  let categoryLabel = '';
  let categorySlugRaw = '';
  if (data.category && typeof data.category === 'object') {
    categoryLabel = getTrimmedString(data.category.label);
    categorySlugRaw = getTrimmedString(data.category.slug);
  } else {
    categoryLabel = getTrimmedString(data.categoryLabel);
    categorySlugRaw = getTrimmedString(data.categorySlug);
  }
  const categorySlug = categorySlugRaw || (categoryLabel ? slugify(categoryLabel) : '');

  // Reading time : 0 si non précisé (le front recalcule à l'affichage si besoin)
  const readingTimeMinutes = parseIntOrNull(data.readingTimeMinutes) || 0;

  const relatedProductIds = parseObjectIdList(data.relatedProductIds, { strict: strictProducts });

  const isFeatured = data.isFeatured === true || data.isFeatured === 'on' || data.isFeatured === 'true';
  const isHomeFeatured = data.isHomeFeatured === true || data.isHomeFeatured === 'on' || data.isHomeFeatured === 'true';
  const isPublished = data.isPublished === true || data.isPublished === 'on' || data.isPublished === 'true';

  // publishedAt : si publié et fournie → la date fournie ; sinon now ; sinon null (draft)
  let publishedAt = null;
  if (isPublished) {
    const raw = data.publishedAt;
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
      publishedAt = raw;
    } else if (typeof raw === 'string' && raw.trim()) {
      const trimmed = raw.trim();
      // Format YYYY-MM-DD → on caps à midi UTC pour éviter les surprises de TZ
      const date = /^\d{4}-\d{2}-\d{2}$/.test(trimmed)
        ? new Date(`${trimmed}T12:00:00.000Z`)
        : new Date(trimmed);
      if (Number.isNaN(date.getTime())) {
        throw new ValidationError('publishedAt invalide (attendu : YYYY-MM-DD ou ISO 8601).');
      }
      publishedAt = date;
    } else {
      publishedAt = new Date();
    }
  }

  // SEO : accepte soit l'objet seo (API) soit les champs plats seoXxx (form)
  const seoSource = (data.seo && typeof data.seo === 'object') ? data.seo : {};
  const seoMetaTitle = normalizeMetaText(getTrimmedString(seoSource.metaTitle || data.seoMetaTitle));
  const seoMetaDescription = normalizeMetaText(getTrimmedString(seoSource.metaDescription || data.seoMetaDescription));
  const seoPrimaryKeyword = normalizeMetaText(getTrimmedString(seoSource.primaryKeyword || data.seoPrimaryKeyword));
  const seoMetaRobots = normalizeMetaText(getTrimmedString(seoSource.metaRobots || data.seoMetaRobots));
  const seoOgImageUrl = getTrimmedString(seoSource.ogImageUrl || data.seoOgImageUrl) || coverImageUrl;
  const seoCanonicalPath = getTrimmedString(seoSource.canonicalPath || data.seoCanonicalPath);

  return {
    title,
    slugCandidate,
    excerpt,
    contentMarkdown,
    contentHtml,
    coverImageUrl,
    authorName,
    readingTimeMinutes,
    relatedProductIds,
    isFeatured,
    isHomeFeatured,
    isPublished,
    publishedAt,
    category: { label: categoryLabel, slug: categorySlug },
    seo: {
      primaryKeyword: seoPrimaryKeyword,
      metaTitle: seoMetaTitle,
      metaDescription: seoMetaDescription,
      metaRobots: seoMetaRobots,
      ogImageUrl: seoOgImageUrl,
      canonicalPath: seoCanonicalPath,
    },
  };
}

/* ─── Opérations principales ────────────────────────────────────────── */

/**
 * Crée un BlogPost à partir de données structurées.
 *
 * @param {Object} args
 * @param {Object} args.data            — données brutes (form ou API)
 * @param {string} args.source          — 'admin-form' | 'api-import' (logging)
 * @param {Object} [args.options]       — options
 * @param {string} [args.options.slugMode='auto']
 *   - 'auto'   : si slug existe, suffixe -2, -3… (comportement form admin)
 *   - 'strict' : si slug existe, throw ConflictError (comportement API create)
 * @param {boolean} [args.options.strictProducts=false]
 *   - true : throw si relatedProductIds contient un id invalide (API)
 *   - false : ignore silencieusement les invalides (form admin)
 *
 * @returns {Promise<{ post: BlogPost, slugChanged: boolean }>}
 * @throws {ValidationError} sur validation
 * @throws {ConflictError}   sur slug conflict en mode strict
 */
async function createBlogPost({ data, source = 'admin-form', options = {} } = {}) {
  const { slugMode = 'auto', strictProducts = false } = options;
  const built = buildBlogPostDoc(data, { strictProducts });

  let finalSlug;
  let slugChanged = false;
  if (slugMode === 'strict') {
    if (await slugExists(built.slugCandidate)) {
      throw new ConflictError(`Un article existe déjà avec ce slug : ${built.slugCandidate}`, {
        slug: built.slugCandidate,
      });
    }
    finalSlug = built.slugCandidate;
  } else {
    finalSlug = await ensureUniqueSlug(built.slugCandidate);
    slugChanged = finalSlug !== built.slugCandidate;
  }

  const doc = {
    title: built.title,
    slug: finalSlug,
    excerpt: built.excerpt,
    contentMarkdown: built.contentMarkdown,
    contentHtml: built.contentHtml,
    coverImageUrl: built.coverImageUrl,
    category: built.category,
    authorName: built.authorName,
    readingTimeMinutes: built.readingTimeMinutes,
    relatedProductIds: built.relatedProductIds,
    isFeatured: built.isFeatured,
    isHomeFeatured: built.isHomeFeatured,
    isPublished: built.isPublished,
    publishedAt: built.publishedAt,
    seo: built.seo,
  };

  let post;
  try {
    post = await BlogPost.create(doc);
  } catch (err) {
    if (err && err.code === 11000) {
      throw new ConflictError(`Un article existe déjà avec ce slug : ${finalSlug}`, { slug: finalSlug });
    }
    throw err;
  }

  // Si l'article est featured, on délaisse tous les autres
  if (post.isFeatured) {
    try {
      await BlogPost.updateMany({ _id: { $ne: post._id } }, { $set: { isFeatured: false } });
    } catch (_) { /* best-effort */ }
  }

  return { post, slugChanged, source };
}

/**
 * Crée OU met à jour un BlogPost selon que le slug existe déjà.
 * Mode upsert pour l'API. Réutilise buildBlogPostDoc pour la validation.
 *
 * @returns {Promise<{ post, created, updated, source }>}
 */
async function upsertBlogPost({ data, source = 'api-import', options = {} } = {}) {
  const { strictProducts = false } = options;
  const built = buildBlogPostDoc(data, { strictProducts });

  const existing = await BlogPost.findOne({ slug: built.slugCandidate });
  if (!existing) {
    // Pas de conflit → création directe sans suffixe
    const { post } = await createBlogPost({
      data,
      source,
      options: { slugMode: 'strict', strictProducts },
    });
    return { post, created: true, updated: false, source };
  }

  // Update du document existant — on garde l'_id et le slug, on remplace le reste.
  existing.title = built.title;
  existing.excerpt = built.excerpt;
  existing.contentMarkdown = built.contentMarkdown;
  existing.contentHtml = built.contentHtml;
  existing.coverImageUrl = built.coverImageUrl;
  existing.category = built.category;
  existing.authorName = built.authorName;
  existing.readingTimeMinutes = built.readingTimeMinutes;
  existing.relatedProductIds = built.relatedProductIds;
  existing.isFeatured = built.isFeatured;
  existing.isHomeFeatured = built.isHomeFeatured;
  existing.isPublished = built.isPublished;
  existing.publishedAt = built.publishedAt;
  existing.seo = built.seo;

  await existing.save();

  return { post: existing, created: false, updated: true, source };
}

module.exports = {
  ServiceError,
  ValidationError,
  ConflictError,
  createBlogPost,
  upsertBlogPost,
  ensureUniqueSlug,
  slugExists,
  parseObjectIdList,
  buildBlogPostDoc,
  // Helpers exposés pour les tests
  _internal: {
    getTrimmedString,
    normalizeMetaText,
    truncateText,
    parseIntOrNull,
  },
};
