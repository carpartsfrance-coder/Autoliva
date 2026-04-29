const mongoose = require('mongoose');

const BlogPost = require('../models/BlogPost');
const Product = require('../models/Product');
const { slugify } = require('../services/productPublic');
const { markdownToHtml, stripHtml: stripHtmlFromService } = require('../services/blogContent');
const mediaStorage = require('../services/mediaStorage');
const { getSiteUrlFromEnv } = require('../services/siteUrl');
const emailService = require('../services/emailService');

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function cleanupUploadedBlogFile() {}

function normalizeMetaText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function stripHtml(value) {
  return stripHtmlFromService(value);
}

function truncateText(value, max) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) return '';
  if (!Number.isFinite(max) || max <= 0) return input;
  if (input.length <= max) return input;
  return `${input.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function countWords(value) {
  const plain = stripHtml(value);
  if (!plain) return 0;
  return plain.split(/\s+/).filter(Boolean).length;
}

function buildSeoAssistant({ form, mode }) {
  const siteName = 'CarParts France';
  const baseUrl = getSiteUrlFromEnv();

  const title = getTrimmedString(form && form.title);
  const slugInput = getTrimmedString(form && form.slug);
  const slugAuto = slugify(title);
  const slug = slugify(slugInput) || slugInput || slugAuto;
  const urlPath = slug ? `/blog/${encodeURIComponent(slug)}` : '/blog';
  const url = baseUrl ? `${baseUrl}${urlPath}` : urlPath;

  const metaTitle = normalizeMetaText(getTrimmedString(form && form.seoMetaTitle));
  const metaDescription = normalizeMetaText(getTrimmedString(form && form.seoMetaDescription));
  const primaryKeyword = getTrimmedString(form && form.seoPrimaryKeyword);
  const excerpt = getTrimmedString(form && form.excerpt);
  const coverImageUrl = getTrimmedString(form && form.coverImageUrl);
  const ogImageUrl = getTrimmedString(form && form.seoOgImageUrl) || coverImageUrl;
  const canonicalPath = getTrimmedString(form && form.seoCanonicalPath);
  const canonical = canonicalPath ? (canonicalPath.startsWith('http') ? canonicalPath : (baseUrl ? `${baseUrl}${canonicalPath.startsWith('/') ? canonicalPath : `/${canonicalPath}`}` : canonicalPath)) : url;

  const finalTitle = metaTitle || (title ? `${title} - ${siteName}` : siteName);
  const contentHtml = (form && form.contentMarkdown)
    ? markdownToHtml(form.contentMarkdown)
    : (form && form.contentHtml ? form.contentHtml : '');
  const fallbackDesc = truncateText(stripHtml(excerpt || contentHtml), 160);
  const finalDescription = metaDescription || fallbackDesc;

  const metaTitleLen = finalTitle.length;
  const metaDescLen = finalDescription.length;
  const contentWords = countWords(contentHtml);

  const checks = [];

  checks.push({
    key: 'title',
    label: 'Titre renseigné',
    ok: Boolean(title),
    detail: title ? '' : 'Ajoutez un titre clair et descriptif.',
  });

  checks.push({
    key: 'slug',
    label: 'URL propre (slug)',
    ok: Boolean(slug),
    detail: slug ? '' : 'Le slug est généré automatiquement à partir du titre.',
  });

  checks.push({
    key: 'metaTitle',
    label: 'Meta title (50–60 caractères)',
    ok: metaTitleLen >= 45 && metaTitleLen <= 65,
    detail: metaTitle ? `Longueur actuelle : ${metaTitleLen}` : `Auto : ${metaTitleLen} (vous pouvez optimiser)` ,
  });

  checks.push({
    key: 'metaDescription',
    label: 'Meta description (120–160 caractères)',
    ok: metaDescLen >= 110 && metaDescLen <= 170,
    detail: metaDescription ? `Longueur actuelle : ${metaDescLen}` : `Auto : ${metaDescLen} (vous pouvez optimiser)`,
  });

  checks.push({
    key: 'cover',
    label: 'Image de couverture',
    ok: Boolean(coverImageUrl),
    detail: coverImageUrl ? '' : "Ajoutez une image pour améliorer le clic (et l'aperçu social).",
  });

  checks.push({
    key: 'og',
    label: 'Image OpenGraph (réseaux sociaux)',
    ok: Boolean(ogImageUrl),
    detail: ogImageUrl ? '' : "Sans image OG, l'aperçu sur Facebook/WhatsApp est moins attractif.",
  });

  checks.push({
    key: 'canonical',
    label: 'Canonical',
    ok: Boolean(canonical),
    detail: canonical ? '' : 'Le canonical aide Google à comprendre la page principale.',
  });

  checks.push({
    key: 'content',
    label: 'Contenu suffisant (300+ mots)',
    ok: contentWords >= 300,
    detail: `Mots : ${contentWords}`,
  });

  if (primaryKeyword) {
    const kw = primaryKeyword.toLowerCase();
    const titleOk = finalTitle.toLowerCase().includes(kw);
    const descOk = finalDescription.toLowerCase().includes(kw);
    checks.push({
      key: 'keywordTitle',
      label: 'Mot-clé dans le title',
      ok: titleOk,
      detail: titleOk ? '' : `Ajoutez "${primaryKeyword}" dans le title.`,
    });
    checks.push({
      key: 'keywordDesc',
      label: 'Mot-clé dans la meta description',
      ok: descOk,
      detail: descOk ? '' : `Ajoutez "${primaryKeyword}" dans la description.`,
    });
  }

  checks.push({
    key: 'published',
    label: 'Publié',
    ok: form && form.isPublished === true,
    detail: (form && form.isPublished === true) ? '' : "Un brouillon n'est pas indexé tant qu'il n'est pas publié.",
  });

  let score = 100;
  for (const c of checks) {
    if (!c.ok) score -= 12;
  }
  if (score < 0) score = 0;
  if (score > 100) score = 100;

  const missing = checks.filter((c) => !c.ok).map((c) => c.label);

  return {
    mode,
    score,
    missing,
    preview: {
      title: finalTitle,
      url,
      description: finalDescription,
    },
    computed: {
      canonical,
      ogImageUrl,
      metaTitle: finalTitle,
      metaDescription: finalDescription,
    },
    checks,
  };
}

function parseIntOrNull(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return null;
  const n = Number(raw);
  if (!Number.isFinite(n)) return null;
  return Math.max(0, Math.floor(n));
}

function parseObjectIdListFromLines(value) {
  const raw = typeof value === 'string' ? value : '';
  const lines = raw
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const ids = [];
  for (const line of lines) {
    if (mongoose.Types.ObjectId.isValid(line)) {
      ids.push(new mongoose.Types.ObjectId(line));
    }
  }
  return ids;
}

async function ensureUniqueSlug(baseSlug, { excludeId } = {}) {
  const base = getTrimmedString(baseSlug);
  const normalized = base || 'article';

  let candidate = normalized;
  let i = 2;

  while (true) {
    const filter = { slug: candidate };
    if (excludeId && mongoose.Types.ObjectId.isValid(excludeId)) {
      filter._id = { $ne: new mongoose.Types.ObjectId(excludeId) };
    }

    const exists = await BlogPost.countDocuments(filter);
    if (!exists) return candidate;

    candidate = `${normalized}-${i}`;
    i += 1;
    if (i > 200) return `${normalized}-${Date.now()}`;
  }
}

async function getAdminProductSearchApi(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    if (!dbConnected) {
      return res.status(503).json({ ok: false, items: [], error: "La base de données n'est pas disponible." });
    }

    const q = getTrimmedString(req.query.q);
    const idsRaw = getTrimmedString(req.query.ids);
    const limitRaw = getTrimmedString(req.query.limit);
    const limit = Math.max(1, Math.min(20, Number.parseInt(limitRaw || '10', 10) || 10));

    const projection = '_id name sku brand priceCents imageUrl slug inStock stockQty';

    if (idsRaw) {
      const ids = idsRaw
        .split(',')
        .map((v) => String(v || '').trim())
        .filter(Boolean)
        .filter((v) => mongoose.Types.ObjectId.isValid(v))
        .slice(0, 50)
        .map((v) => new mongoose.Types.ObjectId(v));

      if (!ids.length) {
        return res.json({ ok: true, items: [] });
      }

      const docs = await Product.find({ _id: { $in: ids } })
        .select(projection)
        .lean();

      const byId = new Map((docs || []).map((p) => [String(p._id), p]));
      const ordered = ids
        .map((id) => byId.get(String(id)))
        .filter(Boolean);

      const items = ordered.map((p) => ({
        id: String(p._id),
        name: p.name || '',
        sku: p.sku || '',
        brand: p.brand || '',
        priceCents: Number.isFinite(p.priceCents) ? p.priceCents : null,
        imageUrl: p.imageUrl || '',
        slug: p.slug || '',
        inStock: p.inStock !== false,
        stockQty: Number.isFinite(p.stockQty) ? p.stockQty : null,
      }));

      return res.json({ ok: true, items });
    }

    if (!q || q.length < 2) {
      return res.json({ ok: true, items: [] });
    }

    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(safe, 'i');

    const docs = await Product.find({
      $or: [
        { name: { $regex: rx } },
        { sku: { $regex: rx } },
        { brand: { $regex: rx } },
      ],
    })
      .sort({ updatedAt: -1 })
      .limit(limit)
      .select(projection)
      .lean();

    const items = (docs || []).map((p) => ({
      id: String(p._id),
      name: p.name || '',
      sku: p.sku || '',
      brand: p.brand || '',
      priceCents: Number.isFinite(p.priceCents) ? p.priceCents : null,
      imageUrl: p.imageUrl || '',
      slug: p.slug || '',
    }));

    return res.json({ ok: true, items });
  } catch (err) {
    return next(err);
  }
}

async function getAdminBlogPostSearchApi(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    if (!dbConnected) {
      return res.status(503).json({ ok: false, items: [], error: "La base de données n'est pas disponible." });
    }

    const q = getTrimmedString(req.query.q);
    const idsRaw = getTrimmedString(req.query.ids);
    const limitRaw = getTrimmedString(req.query.limit);
    const limit = Math.max(1, Math.min(20, Number.parseInt(limitRaw || '10', 10) || 10));

    const projection = '_id slug title excerpt coverImageUrl category isPublished publishedAt createdAt';

    if (idsRaw) {
      const ids = idsRaw
        .split(',')
        .map((v) => String(v || '').trim())
        .filter(Boolean)
        .filter((v) => mongoose.Types.ObjectId.isValid(v))
        .slice(0, 50)
        .map((v) => new mongoose.Types.ObjectId(v));

      if (!ids.length) {
        return res.json({ ok: true, items: [] });
      }

      const docs = await BlogPost.find({ _id: { $in: ids } })
        .select(projection)
        .lean();

      const byId = new Map((docs || []).map((p) => [String(p._id), p]));
      const ordered = ids
        .map((id) => byId.get(String(id)))
        .filter(Boolean);

      const items = ordered.map((p) => ({
        id: String(p._id),
        slug: p.slug || '',
        title: p.title || '',
        excerpt: p.excerpt || '',
        imageUrl: p.coverImageUrl || '',
        categoryLabel: p.category && p.category.label ? p.category.label : (p.category && p.category.slug ? p.category.slug : ''),
        isPublished: p.isPublished === true,
      }));

      return res.json({ ok: true, items });
    }

    if (!q || q.length < 2) {
      return res.json({ ok: true, items: [] });
    }

    const safe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const rx = new RegExp(safe, 'i');

    const docs = await BlogPost.find({
      $or: [
        { title: { $regex: rx } },
        { slug: { $regex: rx } },
        { excerpt: { $regex: rx } },
      ],
    })
      .sort({ publishedAt: -1, createdAt: -1 })
      .limit(limit)
      .select(projection)
      .lean();

    const items = (docs || []).map((p) => ({
      id: String(p._id),
      slug: p.slug || '',
      title: p.title || '',
      excerpt: p.excerpt || '',
      imageUrl: p.coverImageUrl || '',
      categoryLabel: p.category && p.category.label ? p.category.label : (p.category && p.category.slug ? p.category.slug : ''),
      isPublished: p.isPublished === true,
    }));

    return res.json({ ok: true, items });
  } catch (err) {
    return next(err);
  }
}

function buildBlogPostForm(post) {
  const categorySlug = post && post.category && post.category.slug ? post.category.slug : '';
  const categoryLabel = post && post.category && post.category.label ? post.category.label : '';

  return {
    title: post && post.title ? post.title : '',
    slug: post && post.slug ? post.slug : '',
    categoryLabel,
    categorySlug,
    excerpt: post && post.excerpt ? post.excerpt : '',
    coverImageUrl: post && post.coverImageUrl ? post.coverImageUrl : '',
    authorName: post && post.authorName ? post.authorName : 'Expert CarParts',
    readingTimeMinutes: Number.isFinite(post && post.readingTimeMinutes) ? String(post.readingTimeMinutes) : '',
    relatedProductIds: Array.isArray(post && post.relatedProductIds)
      ? post.relatedProductIds.map((id) => String(id)).join('\n')
      : '',
    isFeatured: post && post.isFeatured === true,
    isHomeFeatured: post && post.isHomeFeatured === true,
    isPublished: post && post.isPublished === true,
    publishedAt: post && post.publishedAt ? new Date(post.publishedAt).toISOString().slice(0, 10) : '',
    contentMarkdown: post && post.contentMarkdown ? post.contentMarkdown : '',
    contentHtml: post && post.contentHtml ? post.contentHtml : '',
    seoPrimaryKeyword: post && post.seo && post.seo.primaryKeyword ? post.seo.primaryKeyword : '',
    seoMetaTitle: post && post.seo && post.seo.metaTitle ? post.seo.metaTitle : '',
    seoMetaDescription: post && post.seo && post.seo.metaDescription ? post.seo.metaDescription : '',
    seoMetaRobots: post && post.seo && post.seo.metaRobots ? post.seo.metaRobots : '',
    seoOgImageUrl: post && post.seo && post.seo.ogImageUrl ? post.seo.ogImageUrl : '',
    seoCanonicalPath: post && post.seo && post.seo.canonicalPath ? post.seo.canonicalPath : '',
  };
}

async function getAdminBlogPostsPage(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const q = getTrimmedString(req.query.q);
    const status = getTrimmedString(req.query.status);

    if (!dbConnected) {
      return res.render('admin/blog-posts', {
        title: 'Admin - Blog',
        dbConnected,
        errorMessage: "La base de données n'est pas disponible.",
        successMessage: null,
        filters: { q, status },
        posts: [],
      });
    }

    const errorMessage = req.session.adminBlogError || null;
    const successMessage = req.session.adminBlogSuccess || null;
    delete req.session.adminBlogError;
    delete req.session.adminBlogSuccess;

    const filter = {};
    if (status === 'published') filter.isPublished = true;
    if (status === 'draft') filter.isPublished = false;

    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ title: { $regex: rx } }, { slug: { $regex: rx } }, { excerpt: { $regex: rx } }];
    }

    const docs = await BlogPost.find(filter)
      .sort({ updatedAt: -1 })
      .limit(200)
      .lean();

    const posts = (docs || []).map((p) => ({
      id: String(p._id),
      title: p.title || '',
      slug: p.slug || '',
      categoryLabel: p.category && p.category.label ? p.category.label : '',
      isPublished: p.isPublished === true,
      isFeatured: p.isFeatured === true,
      isHomeFeatured: p.isHomeFeatured === true,
      publishedAt: p.publishedAt ? new Date(p.publishedAt).toISOString().slice(0, 10) : '',
      updatedAt: p.updatedAt ? new Date(p.updatedAt).toISOString().slice(0, 10) : '',
      publicUrl: `/blog/${encodeURIComponent(p.slug || '')}`,
    }));

    return res.render('admin/blog-posts', {
      title: 'Admin - Blog',
      dbConnected,
      errorMessage,
      successMessage,
      filters: { q, status },
      posts,
    });
  } catch (err) {
    return next(err);
  }
}

async function getAdminNewBlogPostPage(req, res) {
  const dbConnected = mongoose.connection.readyState === 1;

  const form = buildBlogPostForm(null);

  return res.render('admin/blog-post', {
    title: 'Admin - Nouvel article',
    dbConnected,
    mode: 'new',
    errorMessage: null,
    postId: null,
    form,
    seoAssistant: buildSeoAssistant({ form, mode: 'new' }),
  });
}

async function postAdminCreateBlogPost(req, res, next) {
  let savedCover = null;

  try {
    const dbConnected = mongoose.connection.readyState === 1;
    if (!dbConnected) {
      cleanupUploadedBlogFile(req);
      return res.status(503).render('errors/500', {
        title: 'Erreur - CarParts France',
      });
    }

    const form = {
      title: getTrimmedString(req.body.title),
      slug: getTrimmedString(req.body.slug),
      categoryLabel: getTrimmedString(req.body.categoryLabel),
      categorySlug: getTrimmedString(req.body.categorySlug),
      excerpt: getTrimmedString(req.body.excerpt),
      coverImageUrl: getTrimmedString(req.body.coverImageUrl),
      authorName: getTrimmedString(req.body.authorName) || 'Expert CarParts',
      readingTimeMinutes: getTrimmedString(req.body.readingTimeMinutes),
      relatedProductIds: typeof req.body.relatedProductIds === 'string' ? req.body.relatedProductIds : '',
      isFeatured: req.body.isFeatured === 'on' || req.body.isFeatured === 'true',
      isHomeFeatured: req.body.isHomeFeatured === 'on' || req.body.isHomeFeatured === 'true',
      isPublished: req.body.isPublished === 'on' || req.body.isPublished === 'true',
      publishedAt: getTrimmedString(req.body.publishedAt),
      contentMarkdown: typeof req.body.contentMarkdown === 'string' ? req.body.contentMarkdown : '',
      seoMetaTitle: getTrimmedString(req.body.seoMetaTitle),
      seoMetaDescription: getTrimmedString(req.body.seoMetaDescription),
      seoMetaRobots: getTrimmedString(req.body.seoMetaRobots),
      seoOgImageUrl: getTrimmedString(req.body.seoOgImageUrl),
      seoCanonicalPath: getTrimmedString(req.body.seoCanonicalPath),
      seoPrimaryKeyword: getTrimmedString(req.body.seoPrimaryKeyword),
    };

    if (!form.title) {
      cleanupUploadedBlogFile(req);
      return res.status(400).render('admin/blog-post', {
        title: 'Admin - Nouvel article',
        dbConnected,
        mode: 'new',
        errorMessage: 'Merci de renseigner un titre.',
        postId: null,
        form,
        seoAssistant: buildSeoAssistant({ form, mode: 'new' }),
      });
    }

    if (req.uploadError) {
      cleanupUploadedBlogFile(req);
      return res.status(400).render('admin/blog-post', {
        title: 'Admin - Nouvel article',
        dbConnected,
        mode: 'new',
        errorMessage: req.uploadError,
        postId: null,
        form,
        seoAssistant: buildSeoAssistant({ form, mode: 'new' }),
      });
    }

    if (req.file && req.file.buffer) {
      savedCover = await mediaStorage.saveMulterFile(req.file, {
        metadata: { scope: 'blog-cover' },
        fallbackPrefix: 'blog',
      });
    }

    const coverImageUrl = savedCover && savedCover.url ? savedCover.url : form.coverImageUrl;

    const baseSlug = form.slug || slugify(form.title) || 'article';
    const finalSlug = await ensureUniqueSlug(baseSlug);

    const categorySlug = form.categorySlug || (form.categoryLabel ? slugify(form.categoryLabel) : '');

    const readingTimeMinutes = parseIntOrNull(form.readingTimeMinutes);

    const isPublished = form.isPublished === true;
    const now = new Date();
    const publishedAt = isPublished
      ? (form.publishedAt ? new Date(`${form.publishedAt}T12:00:00.000Z`) : now)
      : null;

    const contentHtml = form.contentMarkdown ? markdownToHtml(form.contentMarkdown) : '';

    const created = await BlogPost.create({
      title: form.title,
      slug: finalSlug,
      excerpt: form.excerpt,
      contentHtml,
      contentMarkdown: form.contentMarkdown,
      coverImageUrl,
      category: {
        slug: categorySlug,
        label: form.categoryLabel,
      },
      authorName: form.authorName,
      readingTimeMinutes: readingTimeMinutes !== null ? readingTimeMinutes : 0,
      relatedProductIds: parseObjectIdListFromLines(form.relatedProductIds),
      isFeatured: form.isFeatured === true,
      isHomeFeatured: form.isHomeFeatured === true,
      isPublished,
      publishedAt,
      seo: {
        primaryKeyword: normalizeMetaText(form.seoPrimaryKeyword),
        metaTitle: normalizeMetaText(form.seoMetaTitle),
        metaDescription: normalizeMetaText(form.seoMetaDescription),
        metaRobots: normalizeMetaText(form.seoMetaRobots),
        ogImageUrl: getTrimmedString(form.seoOgImageUrl),
        canonicalPath: getTrimmedString(form.seoCanonicalPath),
      },
    });

    if (created.isFeatured) {
      await BlogPost.updateMany(
        { _id: { $ne: created._id } },
        { $set: { isFeatured: false } }
      );
    }

    if (created.isPublished && !created.newsletterSentAt) {
      const baseUrl = getSiteUrlFromEnv() || '';
      BlogPost.updateOne({ _id: created._id }, { $set: { newsletterSentAt: new Date() } }).catch(() => {});
      emailService.sendNewBlogPostToSubscribers({ post: created, baseUrl }).catch((err) => {
        console.error('[Newsletter] Erreur envoi newsletter blog :', err.message);
      });
    }

    req.session.adminBlogSuccess = 'Article créé.';
    return res.redirect(`/admin/blog/${encodeURIComponent(String(created._id))}`);
  } catch (err) {
    if (err && err.code === 11000) {
      if (savedCover && savedCover.url) {
        await mediaStorage.deleteFromUrl(savedCover.url);
      }
      req.session.adminBlogError = 'Un article existe déjà avec ce slug.';
      return res.redirect('/admin/blog/nouveau');
    }
    if (savedCover && savedCover.url) {
      await mediaStorage.deleteFromUrl(savedCover.url);
    }
    return next(err);
  }
}

async function getAdminEditBlogPostPage(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const { postId } = req.params;

    if (!dbConnected) {
      return res.status(503).render('admin/blog-post', {
        title: 'Admin - Article',
        dbConnected,
        mode: 'edit',
        errorMessage: "La base de données n'est pas disponible.",
        postId: null,
        form: null,
      });
    }

    if (!mongoose.Types.ObjectId.isValid(postId)) {
      cleanupUploadedBlogFile(req);
      return res.status(404).render('errors/404', { title: 'Page introuvable - CarParts France' });
    }

    const post = await BlogPost.findById(postId).lean();
    if (!post) {
      return res.status(404).render('errors/404', { title: 'Page introuvable - CarParts France' });
    }

    const errorMessage = req.session.adminBlogError || null;
    const successMessage = req.session.adminBlogSuccess || null;
    delete req.session.adminBlogError;
    delete req.session.adminBlogSuccess;

    return res.render('admin/blog-post', {
      title: `Admin - ${post.title}`,
      dbConnected,
      mode: 'edit',
      errorMessage,
      successMessage,
      postId,
      form: buildBlogPostForm(post),
      publicUrl: `/blog/${encodeURIComponent(post.slug)}`,
      seoAssistant: buildSeoAssistant({ form: buildBlogPostForm(post), mode: 'edit' }),
    });
  } catch (err) {
    return next(err);
  }
}

async function postAdminUpdateBlogPost(req, res, next) {
  let savedCover = null;

  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const { postId } = req.params;

    if (!dbConnected) {
      cleanupUploadedBlogFile(req);
      req.session.adminBlogError = "La base de données n'est pas disponible.";
      return res.redirect(`/admin/blog/${encodeURIComponent(String(postId))}`);
    }

    if (!mongoose.Types.ObjectId.isValid(postId)) {
      cleanupUploadedBlogFile(req);
      return res.status(404).render('errors/404', { title: 'Page introuvable - CarParts France' });
    }

    const existing = await BlogPost.findById(postId).lean();
    if (!existing) {
      return res.status(404).render('errors/404', { title: 'Page introuvable - CarParts France' });
    }

    if (req.uploadError) {
      cleanupUploadedBlogFile(req);
      req.session.adminBlogError = req.uploadError;
      return res.redirect(`/admin/blog/${encodeURIComponent(String(postId))}`);
    }

    const form = {
      title: getTrimmedString(req.body.title),
      slug: getTrimmedString(req.body.slug),
      categoryLabel: getTrimmedString(req.body.categoryLabel),
      categorySlug: getTrimmedString(req.body.categorySlug),
      excerpt: getTrimmedString(req.body.excerpt),
      coverImageUrl: getTrimmedString(req.body.coverImageUrl),
      authorName: getTrimmedString(req.body.authorName) || 'Expert CarParts',
      readingTimeMinutes: getTrimmedString(req.body.readingTimeMinutes),
      relatedProductIds: typeof req.body.relatedProductIds === 'string' ? req.body.relatedProductIds : '',
      isFeatured: req.body.isFeatured === 'on' || req.body.isFeatured === 'true',
      isHomeFeatured: req.body.isHomeFeatured === 'on' || req.body.isHomeFeatured === 'true',
      isPublished: req.body.isPublished === 'on' || req.body.isPublished === 'true',
      publishedAt: getTrimmedString(req.body.publishedAt),
      contentMarkdown: typeof req.body.contentMarkdown === 'string' ? req.body.contentMarkdown : '',
      seoPrimaryKeyword: getTrimmedString(req.body.seoPrimaryKeyword),
      seoMetaTitle: getTrimmedString(req.body.seoMetaTitle),
      seoMetaDescription: getTrimmedString(req.body.seoMetaDescription),
      seoMetaRobots: getTrimmedString(req.body.seoMetaRobots),
      seoOgImageUrl: getTrimmedString(req.body.seoOgImageUrl),
      seoCanonicalPath: getTrimmedString(req.body.seoCanonicalPath),
    };

    if (!form.title) {
      cleanupUploadedBlogFile(req);
      req.session.adminBlogError = 'Merci de renseigner un titre.';
      return res.redirect(`/admin/blog/${encodeURIComponent(String(postId))}`);
    }

    const stableSlug = existing.slug && String(existing.slug).trim()
      ? String(existing.slug).trim()
      : (slugify(form.title) || 'article');
    const desiredSlug = form.slug ? form.slug : stableSlug;
    const cleanedDesiredSlug = slugify(desiredSlug) || stableSlug;
    const finalSlug = await ensureUniqueSlug(cleanedDesiredSlug, { excludeId: postId });

    const categorySlug = form.categorySlug || (form.categoryLabel ? slugify(form.categoryLabel) : '');
    const readingTimeMinutes = parseIntOrNull(form.readingTimeMinutes);

    const isPublished = form.isPublished === true;
    const now = new Date();

    const publishedAt = isPublished
      ? (existing.publishedAt
          ? existing.publishedAt
          : (form.publishedAt ? new Date(`${form.publishedAt}T12:00:00.000Z`) : now))
      : null;

    const contentHtml = form.contentMarkdown
      ? markdownToHtml(form.contentMarkdown)
      : (existing.contentHtml || '');

    if (req.file && req.file.buffer) {
      savedCover = await mediaStorage.saveMulterFile(req.file, {
        metadata: { scope: 'blog-cover' },
        fallbackPrefix: 'blog',
      });
    }

    const nextCoverImageUrl = (savedCover && savedCover.url)
      ? savedCover.url
      : (form.coverImageUrl || (existing.coverImageUrl || ''));

    if (savedCover && savedCover.url) {
      await mediaStorage.deleteFromUrl(existing.coverImageUrl);
    }

    const updated = await BlogPost.findByIdAndUpdate(
      postId,
      {
        $set: {
          title: form.title,
          slug: finalSlug,
          excerpt: form.excerpt,
          contentHtml,
          contentMarkdown: form.contentMarkdown,
          coverImageUrl: nextCoverImageUrl,
          category: {
            slug: categorySlug,
            label: form.categoryLabel,
          },
          authorName: form.authorName,
          readingTimeMinutes: readingTimeMinutes !== null
            ? readingTimeMinutes
            : (Number.isFinite(existing.readingTimeMinutes) ? existing.readingTimeMinutes : 0),
          relatedProductIds: parseObjectIdListFromLines(form.relatedProductIds),
          isFeatured: form.isFeatured === true,
          isHomeFeatured: form.isHomeFeatured === true,
          isPublished,
          publishedAt,
          seo: {
            primaryKeyword: normalizeMetaText(form.seoPrimaryKeyword),
            metaTitle: normalizeMetaText(form.seoMetaTitle),
            metaDescription: normalizeMetaText(form.seoMetaDescription),
            metaRobots: normalizeMetaText(form.seoMetaRobots),
            ogImageUrl: getTrimmedString(form.seoOgImageUrl),
            canonicalPath: getTrimmedString(form.seoCanonicalPath),
          },
        },
      },
      { new: true }
    ).lean();

    if (updated && updated.isFeatured) {
      await BlogPost.updateMany(
        { _id: { $ne: updated._id } },
        { $set: { isFeatured: false } }
      );
    }

    if (updated && updated.isPublished && !existing.newsletterSentAt) {
      const baseUrl = getSiteUrlFromEnv() || '';
      BlogPost.updateOne({ _id: updated._id }, { $set: { newsletterSentAt: new Date() } }).catch(() => {});
      emailService.sendNewBlogPostToSubscribers({ post: updated, baseUrl }).catch((err) => {
        console.error('[Newsletter] Erreur envoi newsletter blog :', err.message);
      });
    }

    req.session.adminBlogSuccess = 'Article enregistré.';
    return res.redirect(`/admin/blog/${encodeURIComponent(String(postId))}`);
  } catch (err) {
    if (err && err.code === 11000) {
      if (savedCover && savedCover.url) {
        await mediaStorage.deleteFromUrl(savedCover.url);
      }
      req.session.adminBlogError = 'Un article existe déjà avec ce slug.';
      return res.redirect(`/admin/blog/${encodeURIComponent(String(req.params.postId))}`);
    }
    if (savedCover && savedCover.url) {
      await mediaStorage.deleteFromUrl(savedCover.url);
    }
    return next(err);
  }
}

async function postAdminDeleteBlogPost(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const { postId } = req.params;

    if (!dbConnected) {
      return res.status(503).render('errors/500', { title: 'Erreur - CarParts France' });
    }

    if (!mongoose.Types.ObjectId.isValid(postId)) {
      return res.status(404).render('errors/404', { title: 'Page introuvable - CarParts France' });
    }

    const existing = await BlogPost.findById(postId).select('_id coverImageUrl').lean();
    if (existing && existing.coverImageUrl) {
      await mediaStorage.deleteFromUrl(existing.coverImageUrl);
    }

    await BlogPost.findByIdAndDelete(postId);
    req.session.adminBlogSuccess = 'Article supprimé.';
    return res.redirect('/admin/blog');
  } catch (err) {
    return next(err);
  }
}

async function postAdminBlogMediaUploadApi(req, res, next) {
  try {
    if (req.uploadError) {
      return res.status(400).json({ ok: false, url: '', error: req.uploadError });
    }

    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ ok: false, url: '', error: 'Aucun fichier reçu.' });
    }

    const saved = await mediaStorage.saveMulterFile(req.file, {
      metadata: { scope: 'blog-inline' },
      fallbackPrefix: 'blog',
    });

    return res.json({ ok: true, url: saved && saved.url ? saved.url : '' });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getAdminBlogPostsPage,
  getAdminNewBlogPostPage,
  postAdminCreateBlogPost,
  getAdminEditBlogPostPage,
  postAdminUpdateBlogPost,
  postAdminDeleteBlogPost,
  postAdminBlogMediaUploadApi,
  getAdminProductSearchApi,
  getAdminBlogPostSearchApi,
};
