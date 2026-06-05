const mongoose = require('mongoose');

const Product = require('../models/Product');
const Category = require('../models/Category');
const BlogPost = require('../models/BlogPost');
const InfoBlock = require('../models/InfoBlock');
const { renderInfoBlockHtml } = require('../services/infoBlockContent');
const demoProducts = require('../demoProducts');
const sanitizeHtml = require('sanitize-html');
const { markdownToHtml } = require('../services/blogContent');
const { buildCategoryPublicUrl } = require('../services/categoryPublic');
const productOptions = require('../services/productOptions');
const { rankProducts, sortRankedProducts } = require('../services/search');
const brand = require('../config/brand');
const {
  buildProductPublicPath,
  buildProductPublicUrl,
  getPublicBaseUrlFromReq,
} = require('../services/productPublic');
const { buildHreflangSet } = require('../services/i18n');
const { buildSeoMediaUrl } = require('../services/mediaStorage');
const { sanitizeBrandLeak } = require('../services/brandSanitizer');

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toNumberOrNull(value) {
  if (typeof value !== 'string') return null;
  if (!value.trim()) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function parseNumberFromLooseString(value) {
  if (typeof value !== 'string') return null;

  const cleaned = value
    .replace(/[\s\u00A0]/g, '')
    .replace(/[^\d,.-]/g, '');

  if (!cleaned) return null;

  const hasComma = cleaned.includes(',');
  const hasDot = cleaned.includes('.');

  let normalized = cleaned;

  if (hasComma && hasDot) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      normalized = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = cleaned.replace(/,/g, '');
    }
  } else if (hasComma) {
    normalized = cleaned.replace(',', '.');
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function parseLegacyPriceCents(product) {
  if (Number.isFinite(product.priceCents)) return product.priceCents;
  if (typeof product.priceCents === 'string') {
    const parsed = parseNumberFromLooseString(product.priceCents);
    if (parsed !== null) {
      if (parsed >= 50000) return Math.round(parsed);
      return Math.round(parsed * 100);
    }
  }

  const legacy =
    product.price ??
    product.priceEuro ??
    product.priceEuros ??
    product.prix ??
    null;

  if (typeof legacy === 'number' && Number.isFinite(legacy)) {
    if (legacy >= 50000) return Math.round(legacy);
    return Math.round(legacy * 100);
  }

  if (typeof legacy === 'string') {
    const parsed = parseNumberFromLooseString(legacy);
    if (parsed === null) return 0;
    if (parsed >= 50000) return Math.round(parsed);
    return Math.round(parsed * 100);
  }

  return 0;
}

function slugifyLoose(value) {
  if (typeof value !== 'string') return '';
  const input = value.trim();
  if (!input) return '';
  return input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function normalizeFaqItem(faq) {
  const question = typeof faq.question === 'string' ? faq.question.trim() : '';
  const answer = typeof faq.answer === 'string' ? faq.answer.trim() : '';

  if (slugifyLoose(question) === 'que-signifie-echange-standard') {
    return {
      question,
      answer: "L'échange standard signifie que vous recevez un pont arrière reconditionné et testé, prêt à monter. Aucune caution n'est demandée à la commande — vous payez uniquement le prix affiché. Après montage, vous avez 30 jours pour nous retourner votre ancienne pièce. Il suffit de nous contacter : nous organisons la récupération gratuitement, soit par chauffeur à votre adresse (ou celle de votre garagiste), soit via un point relais selon le poids de la pièce. En cas de non-retour de l'ancienne pièce dans les 30 jours, la consigne sera facturée.",
    };
  }

  return { question, answer };
}

function normalizeProduct(product) {
  if (!product) return product;

  let stockQty = null;
  if (Number.isFinite(product.stockQty)) {
    stockQty = product.stockQty;
  } else if (typeof product.stockQty === 'string') {
    const trimmed = product.stockQty.trim();
    if (trimmed) {
      const n = Number(trimmed);
      if (Number.isFinite(n) && n >= 0) {
        stockQty = Math.floor(n);
      }
    }
  }

  const inStock =
    stockQty !== null
      ? stockQty > 0
      :
    product.inStock === false ||
    product.inStock === 'false' ||
    product.inStock === 0 ||
    product.inStock === '0'
      ? false
      : true;

  const rawConsigne = product.consigne && typeof product.consigne === 'object'
    ? product.consigne
    : {};
  const consigneEnabled = rawConsigne.enabled === true;
  const consigneAmountCents = Number.isFinite(rawConsigne.amountCents) && rawConsigne.amountCents >= 0
    ? Math.floor(rawConsigne.amountCents)
    : 0;
  const consigneDelayDays = Number.isFinite(rawConsigne.delayDays) && rawConsigne.delayDays >= 0
    ? Math.floor(rawConsigne.delayDays)
    : 30;

  const compareAtPriceCents =
    Number.isFinite(product.compareAtPriceCents) && product.compareAtPriceCents >= 0
      ? product.compareAtPriceCents
      : null;

  const badges =
    product.badges && typeof product.badges === 'object'
      ? {
          topLeft: typeof product.badges.topLeft === 'string' ? product.badges.topLeft.trim() : '',
          condition: typeof product.badges.condition === 'string' ? product.badges.condition.trim() : '',
          // Badges texte libres — sinon perdus à l'affichage de la fiche.
          cards: Array.isArray(product.badges.cards)
            ? product.badges.cards.map((s) => String(s || '').trim()).filter(Boolean).slice(0, 4)
            : [],
        }
      : { topLeft: '', condition: '', cards: [] };

  const galleryUrls = Array.isArray(product.galleryUrls)
    ? product.galleryUrls.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim())
    : [];

  const keyPoints = Array.isArray(product.keyPoints)
    ? product.keyPoints.filter((v) => typeof v === 'string' && v.trim()).map((v) => v.trim())
    : [];

  const specs = Array.isArray(product.specs)
    ? product.specs
        .filter((s) => s && (s.label || s.value))
        .map((s) => ({
          label: typeof s.label === 'string' ? s.label.trim() : '',
          value: typeof s.value === 'string' ? s.value.trim() : '',
        }))
        .filter((s) => s.label && s.value)
    : [];

  const reconditioningSteps = Array.isArray(product.reconditioningSteps)
    ? product.reconditioningSteps
        .filter((s) => s && (s.title || s.description))
        .map((s) => ({
          title: typeof s.title === 'string' ? s.title.trim() : '',
          description: typeof s.description === 'string' ? s.description.trim() : '',
        }))
        .filter((s) => s.title && s.description)
    : [];

  const compatibility = Array.isArray(product.compatibility)
    ? product.compatibility
        .filter((c) => c && (c.make || c.model || c.years || c.engine))
        .map((c) => ({
          make: typeof c.make === 'string' ? c.make.trim() : '',
          model: typeof c.model === 'string' ? c.model.trim() : '',
          years: typeof c.years === 'string' ? c.years.trim() : '',
          engine: typeof c.engine === 'string' ? c.engine.trim() : '',
          kw: Number(c.kw) > 0 ? Number(c.kw) : 0,
          ch: Number(c.ch) > 0 ? Number(c.ch) : 0,
        }))
        .filter((c) => c.make || c.model || c.years || c.engine)
    : [];

  const faqs = Array.isArray(product.faqs)
    ? product.faqs
        .filter((f) => f && (f.question || f.answer))
        .map((f) => normalizeFaqItem(f))
        .filter((f) => f.question && f.answer)
    : [];

  const media =
    product.media && typeof product.media === 'object'
      ? {
          videoUrl: typeof product.media.videoUrl === 'string' ? product.media.videoUrl.trim() : '',
        }
      : { videoUrl: '' };

  const shippingDelayText = typeof product.shippingDelayText === 'string'
    ? product.shippingDelayText.trim()
    : '';

  const compatibleReferences = Array.isArray(product.compatibleReferences)
    ? product.compatibleReferences
        .filter((v) => typeof v === 'string')
        .map((v) => v.trim())
        .filter(Boolean)
    : [];

  const rawSections = product.sections && typeof product.sections === 'object' ? product.sections : {};
  const sections = {
    showKeyPoints: rawSections.showKeyPoints !== false,
    showSpecs: rawSections.showSpecs !== false,
    showReconditioning: rawSections.showReconditioning !== false,
    showCompatibility: rawSections.showCompatibility !== false,
    showFaq: rawSections.showFaq !== false,
    showVideo: rawSections.showVideo !== false,
    showSupportBox: rawSections.showSupportBox !== false,
    showRelatedProducts: rawSections.showRelatedProducts !== false,
  };

  return {
    ...product,
    inStock,
    stockQty,
    shippingDelayText,
    compatibleReferences,
    priceCents: parseLegacyPriceCents(product),
    consigne: {
      enabled: consigneEnabled,
      amountCents: consigneAmountCents,
      delayDays: consigneDelayDays,
      // Indispensable pour la fiche produit : sans ça, « Encaisser la caution »
      // était perdu à l'affichage → la page montrait « Sans caution » à tort.
      chargeUpfront: rawConsigne.chargeUpfront === true,
    },
    compareAtPriceCents,
    badges,
    galleryUrls,
    shortDescription: typeof product.shortDescription === 'string' ? sanitizeBrandLeak(product.shortDescription.trim()) : '',
    description: typeof product.description === 'string' ? sanitizeBrandLeak(product.description.trim()) : '',
    keyPoints,
    specs,
    reconditioningSteps,
    compatibility,
    faqs,
    relatedBlogPostIds: Array.isArray(product.relatedBlogPostIds)
      ? product.relatedBlogPostIds.map((id) => String(id))
      : [],
    media,
    sections,
  };
}

// Charge les blocs d'information ACTIFS attachés au produit, rend leur contenu
// markdown en HTML, et les regroupe par position d'affichage (dans l'ordre du
// produit). Une modif du bloc se répercute partout (chargé à la volée).
const INFO_BLOCK_EMPTY_GROUPS = { description_end: [], after_inclusions: [], dedicated_tab: [] };

async function loadInfoBlocksByPosition(product) {
  const grouped = { description_end: [], after_inclusions: [], dedicated_tab: [] };
  const ids = Array.isArray(product && product.infoBlockIds) ? product.infoBlockIds : [];
  const validIds = ids
    .map((id) => (id == null ? '' : String(id)))
    .filter((id) => mongoose.Types.ObjectId.isValid(id));
  if (!validIds.length) return grouped;

  const docs = await InfoBlock.find({ _id: { $in: validIds }, isActive: true })
    .select('_id title content position')
    .lean();
  const byId = new Map(docs.map((d) => [String(d._id), d]));

  for (const id of validIds) {
    const d = byId.get(String(id));
    if (!d) continue;
    const pos = grouped[d.position] ? d.position : 'description_end';
    grouped[pos].push({
      id: String(d._id),
      title: typeof d.title === 'string' ? d.title.trim() : '',
      html: renderInfoBlockHtml(typeof d.content === 'string' ? d.content : ''),
    });
  }
  return grouped;
}

function truncateText(value, max) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) return '';
  if (!Number.isFinite(max) || max <= 0) return input;
  if (input.length <= max) return input;
  return `${input.slice(0, Math.max(0, max - 1)).trim()}…`;
}

function normalizeMetaText(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function stripHtml(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/<[^>]*>/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function stripMarkdown(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+[).]\s+/gm, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function normalizeImportedText(value) {
  if (typeof value !== 'string') return '';
  let out = value;
  if (out.includes('\\n')) {
    out = out.replace(/\\n/g, '\n');
  }
  out = out.replace(/\r\n?/g, '\n');
  out = out.replace(/^\s*•\s+/gm, '- ');
  return out;
}

function looksLikeHtml(value) {
  const input = typeof value === 'string' ? value : '';
  return /<\/?[a-z][\s\S]*>/i.test(input);
}

function toPlainText(value) {
  const normalized = normalizeImportedText(typeof value === 'string' ? value : '');
  const noHtml = stripHtml(normalized);
  return stripMarkdown(noHtml);
}

function estimateReadingTimeMinutes(text) {
  const plain = stripMarkdown(stripHtml(text));
  if (!plain) return 0;
  const words = plain.split(/\s+/).filter(Boolean).length;
  const minutes = words / 190;
  const rounded = Math.max(1, Math.round(minutes));
  return Math.min(120, rounded);
}

function formatDateFRShort(value) {
  try {
    if (!value) return '';
    const d = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(d.getTime())) return '';
    return new Intl.DateTimeFormat('fr-FR', {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
    }).format(d);
  } catch (e) {
    return '';
  }
}

async function getProductBySlug(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const raw = typeof req.params.slug === 'string' ? req.params.slug.trim() : '';
    const slug = slugifyLoose(raw);

    if (!slug) {
      return res.redirect(301, '/produits');
    }

    if (!dbConnected) {
      const demoHit = (Array.isArray(demoProducts) ? demoProducts : [])
        .find((p) => p && typeof p.slug === 'string' && slugifyLoose(p.slug) === slug);
      if (demoHit && demoHit._id) {
        req.params.id = String(demoHit._id);
        return getProduct(req, res, next);
      }
      return res.status(404).render('errors/404', {
        title: `Page introuvable - ${brand.NAME}`,
      });
    }

    const hit = await Product.findOne({ slug }).select('_id').lean();
    if (!hit || !hit._id) {
      // Aucun produit pour ce slug. Si le paramètre est un ObjectId valide
      // (cas d'un produit sans slug : son URL canonique retombe sur l'id),
      // on tente une résolution par _id pour que la fiche reste accessible
      // (ex. bouton « Voir en ligne » de l'admin) plutôt que d'envoyer vers
      // la recherche.
      if (mongoose.Types.ObjectId.isValid(raw)) {
        const byId = await Product.findById(raw).select('_id').lean();
        if (byId && byId._id) {
          req.params.id = String(byId._id);
          return getProduct(req, res, next);
        }
      }
      return res.redirect(301, `/produits?q=${encodeURIComponent(raw)}`);
    }

    req.params.id = String(hit._id);
    return getProduct(req, res, next);
  } catch (err) {
    return next(err);
  }
}

function sanitizeProductHtml(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!raw) return '';

  return sanitizeHtml(raw, {
    allowedTags: [
      'p', 'br', 'hr',
      'strong', 'b', 'em', 'i', 'u',
      'ul', 'ol', 'li',
      'h2', 'h3', 'h4',
      'blockquote',
      'a',
      'img',
      'table', 'thead', 'tbody', 'tr', 'th', 'td',
      'span',
    ],
    allowedAttributes: {
      a: ['href', 'name', 'target', 'rel'],
      img: ['src', 'alt', 'title', 'loading'],
      span: ['class'],
      th: ['colspan', 'rowspan'],
      td: ['colspan', 'rowspan'],
    },
    allowedSchemes: ['http', 'https', 'mailto', 'tel'],
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { rel: 'nofollow noopener', target: '_blank' }),
    },
    disallowedTagsMode: 'discard',
    allowVulnerableTags: false,
  });
}

function resolveAbsoluteUrl(req, rawUrl) {
  const input = typeof rawUrl === 'string' ? rawUrl.trim() : '';
  if (!input) return '';
  if (/^https?:\/\//i.test(input)) return input;

  const base = getPublicBaseUrlFromReq(req);
  if (!base) return input;
  if (input.startsWith('/')) return `${base}${input}`;
  return `${base}/${input}`;
}

function formatDateIso(value) {
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return d.toISOString().slice(0, 10);
}

function extractWarrantyYearsFromText(value) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) return null;

  const normalized = input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  const match = normalized.match(/(\d+(?:[.,]\d+)?)\s*(an|ans|annee|annees)/);
  if (!match) return null;

  const parsed = Number(String(match[1]).replace(',', '.'));
  if (!Number.isFinite(parsed) || parsed <= 0) return null;
  return parsed;
}

function mapSchemaCondition(value) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) return '';

  const normalized = input
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();

  if (/(recondition|refurb|remanufact|echange standard)/.test(normalized)) {
    return 'https://schema.org/RefurbishedCondition';
  }
  if (/(^|\b)(neuf|new)(\b|$)/.test(normalized)) {
    return 'https://schema.org/NewCondition';
  }
  if (/(^|\b)(occasion|used|utilise)(\b|$)/.test(normalized)) {
    return 'https://schema.org/UsedCondition';
  }

  return '';
}

async function listProducts(req, res, next) {
  try {
    // Délègue toute la logique de listing au service partagé. Lazy require pour
    // éviter le cycle (le service utilise lui-même les helpers de ce fichier).
    const { prepareProductListingData } = require('../services/productListingService');

    // Véhicule persistant : mémorise / efface le véhicule choisi en session,
    // afin que tout le site filtre automatiquement sur ce qui rentre.
    if (req.session) {
      if (req.query.vehicleClear === '1' || req.query.vehicleClear === 'true') {
        delete req.session.vehicle;
      } else if (typeof req.query.vehicleMake === 'string' && req.query.vehicleMake.trim()) {
        req.session.vehicle = {
          make: req.query.vehicleMake.trim(),
          model: typeof req.query.vehicleModel === 'string' ? req.query.vehicleModel.trim() : '',
          engine: typeof req.query.vehicleEngine === 'string' ? req.query.vehicleEngine.trim() : '',
        };
      }
    }

    const data = await prepareProductListingData(req, {});

    return res.render('products/index', {
      ...data,
      basePath: '/produits', // pour buildUrl côté template
    });
  } catch (err) {
    return next(err);
  }
}

// Endpoint léger pour le sélecteur de véhicule (marques → modèles → motorisations).
let _vehicleTreeCache = null;
let _vehicleTreeCacheAt = 0;
async function getVehicleTreeApi(req, res) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const { getVehicleTree } = require('../services/productListingService');
    const fresh = !_vehicleTreeCache || (Date.now() - _vehicleTreeCacheAt) > 5 * 60 * 1000;
    if (fresh) {
      _vehicleTreeCache = await getVehicleTree(dbConnected);
      _vehicleTreeCacheAt = Date.now();
    }
    res.setHeader('Cache-Control', 'public, max-age=300');
    return res.json(_vehicleTreeCache);
  } catch (err) {
    return res.status(500).json({ makes: [], modelsByMake: {}, enginesByMakeModel: {} });
  }
}


async function getProduct(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const errorMessage = req.session && req.session.cartError ? req.session.cartError : null;
    const rawParam = typeof req.params.id === 'string' ? req.params.id.trim() : '';
    const id = rawParam.includes('-') ? rawParam.split('-').pop() : rawParam;

    let product = null;

    if (dbConnected) {
      if (!mongoose.Types.ObjectId.isValid(id)) {
        return res.status(404).render('errors/404', {
          title: `Page introuvable - ${brand.NAME}`,
        });
      }

      product = await Product.findById(id).lean();

      product = normalizeProduct(product);

      if (!product) {
        product =
          demoProducts.find((p) => String(p._id) === String(id)) || null;
        product = normalizeProduct(product);
      }
    } else {
      product = demoProducts.find((p) => String(p._id) === String(id)) || null;
      product = normalizeProduct(product);

      if (!product) {
        if (req.session) delete req.session.cartError;
        const _baseUrl = getPublicBaseUrlFromReq(req);
        const _pathWithoutLang = res.locals.currentPathWithoutLang || req.path;
        const _hreflang = buildHreflangSet(_baseUrl, _pathWithoutLang);
        return res.render('products/show', {
          title: `Produit - ${brand.NAME}`,
          ..._hreflang,
          dbConnected,
          returnTo: req.originalUrl,
          errorMessage,
          product: null,
          relatedProducts: [],
        });
      }
    }

    if (!product) {
      return res.status(404).render('errors/404', {
        title: `Page introuvable - ${brand.NAME}`,
      });
    }

    // Blocs d'information attachés (rendus markdown → HTML, groupés par position).
    product.infoBlocksByPosition = dbConnected
      ? await loadInfoBlocksByPosition(product)
      : INFO_BLOCK_EMPTY_GROUPS;

    // On ne redirige vers l'URL canonique /product/<slug>/ QUE si le produit a
    // un vrai slug. Sans slug, cette canonique retomberait sur un slug qui ne
    // résout pas (basé sur le nom ou l'id) → on rend la fiche en place sur
    // /produits/<id> plutôt que d'envoyer l'utilisateur vers la recherche
    // (ex. bouton « Voir en ligne » de l'admin sur une fiche sans slug).
    const hasRealSlug = !!(product && typeof product.slug === 'string' && product.slug.trim());
    const canonicalPath = buildProductPublicPath(product);
    const requestedPath = `${req.baseUrl || ''}${req.path || ''}`;
    if (hasRealSlug && canonicalPath && requestedPath && canonicalPath !== requestedPath) {
      return res.redirect(301, canonicalPath);
    }

    const canonicalUrl = buildProductPublicUrl(product, { req });
    const brandText = typeof product.brand === 'string' ? product.brand.trim() : '';
    const skuText = typeof product.sku === 'string' ? product.sku.trim() : '';
    const compatibleReferences = Array.isArray(product.compatibleReferences)
      ? product.compatibleReferences
          .filter((v) => typeof v === 'string' && v.trim())
          .map((v) => v.trim())
      : [];

    const firstCompat = Array.isArray(product.compatibility)
      ? product.compatibility.find((c) => c && (c.make || c.model || c.engine))
      : null;
    const compatText = firstCompat
      ? [firstCompat.make, firstCompat.model, firstCompat.engine].filter(Boolean).join(' ')
      : '';
    const findSpecValue = (...labels) => {
      const targets = new Set(labels.map((label) => slugifyLoose(label)).filter(Boolean));
      const specs = Array.isArray(product.specs) ? product.specs : [];
      for (const spec of specs) {
        const key = slugifyLoose(spec && spec.label ? spec.label : '');
        if (!key || !targets.has(key)) continue;
        return typeof spec.value === 'string' ? spec.value.trim() : '';
      }
      return '';
    };

    /* sanitizeBrandLeak : si l'override DB contient encore "CarParts France"
       (rebranding partiel), on remplace par brand.NAME courant. */
    const titleOverride = product.seo && typeof product.seo.metaTitle === 'string'
      ? sanitizeBrandLeak(product.seo.metaTitle.trim())
      : '';

    /* Construit un title SEO en tenant dans ~60 caractères (limite SERP Google).
       Stratégie : on tente la version complète, si trop longue on retire d'abord
       la SKU (info technique moins recherchée), puis le brand véhicule, puis on
       tronque le nom pour préserver le suffix marque. */
    const SEO_TITLE_MAX = 60;
    function buildSeoTitleFitted(name, brandTxt, skuTxt) {
      const suffix = ` | ${brand.NAME}`;
      const variants = [
        `${name}${brandTxt ? ` - ${brandTxt}` : ''}${skuTxt ? ` (Réf ${skuTxt})` : ''}${suffix}`,
        `${name}${brandTxt ? ` - ${brandTxt}` : ''}${suffix}`,
        `${name}${suffix}`,
      ];
      for (const v of variants) {
        if (v.length <= SEO_TITLE_MAX) return v;
      }
      // Toutes trop longues → on tronque le nom pour préserver " | Brand"
      const maxNameLen = Math.max(10, SEO_TITLE_MAX - suffix.length - 1); // -1 pour ellipsis
      const truncatedName = name.length > maxNameLen ? `${name.slice(0, maxNameLen).trim()}…` : name;
      return `${truncatedName}${suffix}`;
    }
    /* Si l'override DB n'a pas de suffix marque, on l'ajoute pour cohérence
       SEO (sinon certaines fiches s'affichent sans " | Autoliva" en SERP).
       Respecte STRICTEMENT SEO_TITLE_MAX (60 char) pour éviter la troncature
       SERP de Google (cause des 37 alertes Semrush "title too long"). */
    function ensureBrandSuffix(t) {
      if (!t) return t;
      const suffix = ` | ${brand.NAME}`;
      const trimmed = t.trim();
      // Déjà conforme avec ou sans suffix
      if (trimmed.length <= SEO_TITLE_MAX && trimmed.endsWith(suffix)) return trimmed;
      const lower = trimmed.toLowerCase();
      const lowerName = brand.NAME.toLowerCase();
      // Si le brand est déjà présent en fin (autre séparateur), on n'ajoute
      // pas le suffix mais on tronque quand même si > 60.
      if (lower.endsWith(lowerName)) {
        if (trimmed.length <= SEO_TITLE_MAX) return trimmed;
        return `${trimmed.slice(0, SEO_TITLE_MAX - 1).trim()}…`;
      }
      // Cas standard : on essaie d'ajouter le suffix dans la limite 60 ; sinon
      // on tronque la partie titre pour préserver " | Brand".
      const candidate = `${trimmed}${suffix}`;
      if (candidate.length <= SEO_TITLE_MAX) return candidate;
      const maxLen = Math.max(20, SEO_TITLE_MAX - suffix.length - 1);
      const cut = trimmed.length > maxLen ? `${trimmed.slice(0, maxLen).trim()}…` : trimmed;
      return `${cut}${suffix}`;
    }
    /* Garde-fou ultime : quoi qu'il arrive, jamais > SEO_TITLE_MAX. */
    function clampTitle(t) {
      if (!t) return t;
      const s = String(t).trim();
      if (s.length <= SEO_TITLE_MAX) return s;
      return `${s.slice(0, SEO_TITLE_MAX - 1).trim()}…`;
    }
    const seoTitle = clampTitle(
      titleOverride
        ? ensureBrandSuffix(titleOverride)
        : buildSeoTitleFitted(product.name, brandText, skuText),
    );

    const descriptionOverride = product.seo && typeof product.seo.metaDescription === 'string'
      ? sanitizeBrandLeak(product.seo.metaDescription.trim())
      : '';
    const baseDesc = product.shortDescription || product.description || '';
    const baseDescPlain = toPlainText(baseDesc);
    const refsText = compatibleReferences.length ? compatibleReferences.slice(0, 6).join(', ') : '';
    const autoDesc = `Pièce auto ${product.name}${skuText ? ` (réf ${skuText})` : ''}${refsText ? ` (références compatibles ${refsText})` : ''}${compatText ? ` compatible ${compatText}` : ''}. Livraison rapide. Paiement sécurisé.`;
    const metaDescription = truncateText(normalizeMetaText(toPlainText(descriptionOverride) || baseDescPlain || autoDesc), 160);

    const images = [];
    if (product.imageUrl) images.push(buildSeoMediaUrl(product.imageUrl, product.name));
    if (Array.isArray(product.galleryUrls)) {
      for (const u of product.galleryUrls) {
        if (typeof u === 'string' && u.trim()) images.push(buildSeoMediaUrl(u.trim(), product.name));
      }
    }
    const mainImage = images.find(Boolean) || '';
    const ogImage = resolveAbsoluteUrl(req, mainImage);

    const price = Number.isFinite(product.priceCents) ? (product.priceCents / 100).toFixed(2) : undefined;
    const descriptionForSchema = normalizeMetaText(metaDescription || toPlainText(product.shortDescription || product.description || autoDesc));
    const schemaBrandName = brandText || (firstCompat && typeof firstCompat.make === 'string' ? firstCompat.make.trim() : '');
    const conditionText = findSpecValue('état', 'etat') || (product.badges && product.badges.condition ? String(product.badges.condition).trim() : '');
    const schemaCondition = mapSchemaCondition(conditionText);
    const warrantyText = findSpecValue('garantie') || (product.badges && product.badges.topLeft ? String(product.badges.topLeft).trim() : '');
    const warrantyYears = extractWarrantyYearsFromText(warrantyText);
    const priceValidUntil = formatDateIso(new Date(Date.now() + (30 * 24 * 60 * 60 * 1000)));

    /* Compatibilité véhicule pour les rich results.
     *
     * Historiquement on émettait isAccessoryOrSparePartFor: [Vehicle, ...] mais
     * Vehicle hérite de Product dans Schema.org, donc le validator Google
     * exige sur CHAQUE entrée : name + (aggregateRating | offers | review).
     * Même avec `name`, l'exigence offers/rating/review reste impossible à
     * satisfaire proprement (on n'a ni prix, ni avis, ni offer pour un véhicule
     * compatible). Cela générait 1099–1154 erreurs structured data.
     *
     * Décision : on n'émet plus isAccessoryOrSparePartFor dans le JSON-LD.
     * La compatibilité véhicule reste visible pour les utilisateurs (section
     * "Compatible avec" sur la page produit) et exposée à Google via :
     *   - description du produit (mentionne les véhicules)
     *   - additionalProperty: "Référence compatible" (OEM refs)
     *   - le contenu HTML structuré de la page elle-même
     * Google extrait ces signaux sans avoir besoin du markup formel et n'a
     * plus de raison de flagger d'erreur. */
    const fitsVehicles = [];

    /* additionalProperty enrichi : on combine les références OEM compatibles
     * (signal SEO clé pour les pièces auto) avec les caractéristiques
     * commerciales tirées des specs/specs section. Google accepte plusieurs
     * PropertyValue et les affiche dans les rich results de la fiche produit. */
    const enrichedAdditionalProperties = [];
    // Code moteur (ex: CLHA) : identifiant n°1 recherché par les garagistes.
    const engineCode = typeof product.engineCode === 'string' ? product.engineCode.trim() : '';
    if (engineCode) {
      enrichedAdditionalProperties.push({ '@type': 'PropertyValue', name: 'Code moteur', value: engineCode });
    }
    if (compatibleReferences.length) {
      compatibleReferences.forEach((r) => {
        enrichedAdditionalProperties.push({ '@type': 'PropertyValue', name: 'Référence compatible', value: r });
      });
    }
    if (warrantyYears) {
      enrichedAdditionalProperties.push({ '@type': 'PropertyValue', name: 'Garantie', value: `${warrantyYears} ans` });
    }
    if (product.shippingDelayText) {
      enrichedAdditionalProperties.push({ '@type': 'PropertyValue', name: 'Expédition', value: String(product.shippingDelayText).trim() });
    }
    /* Test qualité, Programmation, État : tirés des specs si dispo, sinon
     * fallback constants pour signaler le positionnement reconditionné. */
    enrichedAdditionalProperties.push({ '@type': 'PropertyValue', name: 'Test qualité', value: "Testé sur banc d'essai" });
    if (Array.isArray(product.specs)) {
      product.specs.forEach((s) => {
        if (s && typeof s === 'object') {
          const k = String(s.key || s.name || s.label || '').trim();
          const v = String(s.value || '').trim();
          if (k && v && !['Référence', 'Type', 'Garantie', 'Expédition'].includes(k)) {
            // Évite doublons avec champs déjà ajoutés
            enrichedAdditionalProperties.push({ '@type': 'PropertyValue', name: k, value: v });
          }
        }
      });
    }

    const categoryNameForSchema = typeof product.category === 'string' ? product.category.trim() : '';

    // aggregateRating : on n'émet le bloc que si on a des avis RÉELS
    // en DB. Les valeurs hardcodées (4.2 / 37) étaient flaggées invalides par
    // Semrush et exposaient à un manual action Google (rich snippet trompeur).
    const realRatings = product.ratings || product.reviews || null;
    const realRatingValue = realRatings && (realRatings.average || realRatings.value);
    const realRatingCount = realRatings && (realRatings.count || realRatings.total);
    const aggregateRatingBlock = (realRatingValue && realRatingCount && Number(realRatingCount) > 0)
      ? {
          '@type': 'AggregateRating',
          ratingValue: String(realRatingValue),
          ratingCount: String(realRatingCount),
          bestRating: '5',
          worstRating: '1',
        }
      : undefined;

    const schemaProduct = {
      /* @type='Product' uniquement : AutomotivePart n'est pas un type
       * Schema.org valide (causait 908 erreurs structured data). Le signal
       * "auto-parts" passe via category + isAccessoryOrSparePartFor. */
      '@type': 'Product',
      name: product.name,
      description: truncateText(descriptionForSchema, 5000),
      sku: skuText || undefined,
      mpn: engineCode || (compatibleReferences.length ? compatibleReferences[0] : undefined),
      productID: skuText || undefined,
      category: categoryNameForSchema || undefined,
      brand: schemaBrandName ? { '@type': 'Brand', name: schemaBrandName } : undefined,
      manufacturer: { '@type': 'Organization', name: brand.NAME },
      itemCondition: schemaCondition || undefined,
      image: ogImage || undefined,
      /* isAccessoryOrSparePartFor : retiré. Le champ exigeait Vehicle objects
       * (sous-type de Product), qui demandait name + offers/rating/review
       * sur CHAQUE véhicule. Sans ça : 1099-1154 erreurs structured data.
       * La compatibilité véhicule reste exposée par d'autres canaux (cf.
       * commentaire sur fitsVehicles). */
      // isAccessoryOrSparePartFor: <removed>,
      additionalProperty: enrichedAdditionalProperties.length ? enrichedAdditionalProperties : undefined,
      /* hasMerchantReturnPolicy : retour ancien organe sous 30 jours (échange
       * standard). Active le rich snippet "free returns" dans Google Shopping. */
      hasMerchantReturnPolicy: {
        '@type': 'MerchantReturnPolicy',
        applicableCountry: 'FR',
        returnPolicyCategory: 'https://schema.org/MerchantReturnFiniteReturnWindow',
        merchantReturnDays: 30,
        returnMethod: 'https://schema.org/ReturnByMail',
        returnFees: 'https://schema.org/FreeReturn',
      },
      aggregateRating: aggregateRatingBlock,
      offers: price
        ? {
            '@type': 'Offer',
            url: canonicalUrl,
            priceCurrency: 'EUR',
            price,
            priceValidUntil: priceValidUntil || undefined,
            availability: product.inStock ? 'https://schema.org/InStock' : 'https://schema.org/OutOfStock',
            itemCondition: schemaCondition || undefined,
            seller: { '@type': 'Organization', name: brand.NAME },
            /* shippingDetails : signal "fast & free shipping" pour Google
             * Shopping et les rich results SERP. Livraison 24h FR. */
            shippingDetails: {
              '@type': 'OfferShippingDetails',
              shippingRate: { '@type': 'MonetaryAmount', value: '0.00', currency: 'EUR' },
              shippingDestination: { '@type': 'DefinedRegion', addressCountry: 'FR' },
              deliveryTime: {
                '@type': 'ShippingDeliveryTime',
                handlingTime: { '@type': 'QuantitativeValue', minValue: 0, maxValue: 1, unitCode: 'DAY' },
                transitTime: { '@type': 'QuantitativeValue', minValue: 1, maxValue: 2, unitCode: 'DAY' },
              },
            },
            warranty: warrantyYears
              ? {
                  '@type': 'WarrantyPromise',
                  durationOfWarranty: {
                    '@type': 'QuantitativeValue',
                    value: warrantyYears,
                    unitCode: 'ANN',
                  },
                  /* PartsAndLabor : couverture pièce + main d'œuvre montage
                   * (positionnement reconditionné Autoliva), plus précis que
                   * BrokenCondition. */
                  warrantyScope: 'https://schema.org/PartsAndLabor',
                }
              : undefined,
          }
        : undefined,
    };
    const schemaFaqPage = Array.isArray(product.faqs) && product.faqs.length
      ? {
          '@type': 'FAQPage',
          mainEntity: product.faqs
            .filter((faq) => faq && faq.question && faq.answer)
            .map((faq) => ({
              '@type': 'Question',
              name: normalizeMetaText(toPlainText(faq.question)),
              acceptedAnswer: {
                '@type': 'Answer',
                text: normalizeMetaText(toPlainText(faq.answer)),
              },
            }))
            .filter((faq) => faq.name && faq.acceptedAnswer && faq.acceptedAnswer.text),
        }
      : null;

    const baseUrl = getPublicBaseUrlFromReq(req);
    const langPrefix = req.lang === 'en' ? '/en' : '';
    const pathWithoutLang = res.locals.currentPathWithoutLang || req.path;
    const hreflang = buildHreflangSet(baseUrl, pathWithoutLang);
    const categoryName = typeof product.category === 'string' ? product.category.trim() : '';
    const categorySlug = categoryName ? slugifyLoose(categoryName) : '';
    const categoryUrl = categorySlug ? buildCategoryPublicUrl({ slug: categorySlug }, { req }) : '';

    const breadcrumbItems = [
      {
        '@type': 'ListItem',
        position: 1,
        name: 'Accueil',
        item: baseUrl ? `${baseUrl}/` : '/',
      },
      {
        '@type': 'ListItem',
        position: 2,
        name: 'Catalogue',
        item: baseUrl ? `${baseUrl}/produits` : '/produits',
      },
    ];

    if (categoryName && categoryUrl) {
      breadcrumbItems.push({
        '@type': 'ListItem',
        position: 3,
        name: categoryName,
        item: categoryUrl,
      });
    }

    breadcrumbItems.push({
      '@type': 'ListItem',
      position: breadcrumbItems.length + 1,
      name: product.name,
      item: canonicalUrl,
    });

    const jsonLd = JSON.stringify({
      '@context': 'https://schema.org',
      '@graph': [
        schemaProduct,
        ...(schemaFaqPage && Array.isArray(schemaFaqPage.mainEntity) && schemaFaqPage.mainEntity.length ? [schemaFaqPage] : []),
        {
          '@type': 'BreadcrumbList',
          itemListElement: breadcrumbItems,
        },
      ],
    })
      .replace(/</g, '\u003c')
      .replace(/>/g, '\u003e')
      .replace(/&/g, '\u0026');

    let relatedProducts = [];
    let relatedBlogPosts = [];

    if (dbConnected) {
      const relatedFilter = { _id: { $ne: id } };
      if (product.category) {
        relatedFilter.category = product.category;
      }

      relatedProducts = await Product.find(relatedFilter)
        .sort({ updatedAt: -1 })
        .limit(4)
        .lean();

      relatedProducts = relatedProducts.map(normalizeProduct);

      if (relatedProducts.length < 4) {
        const already = relatedProducts.map((p) => String(p._id));
        const fallbackFilter = { _id: { $nin: [id, ...already] } };

        const fallback = await Product.find(fallbackFilter)
          .sort({ updatedAt: -1 })
          .limit(4 - relatedProducts.length)
          .lean();

        relatedProducts = relatedProducts.concat(fallback.map(normalizeProduct));
      }

      const mappedBlogCard = (b) => {
        const publishedAt = b.publishedAt || b.createdAt || null;
        const minutes = Number.isFinite(b.readingTimeMinutes) && b.readingTimeMinutes > 0
          ? b.readingTimeMinutes
          : estimateReadingTimeMinutes(b.contentHtml || '');
        const excerpt = (b.excerpt || '').trim() || truncateText(stripHtml(b.contentHtml || ''), 140);
        const categoryLabel = b.category && b.category.label
          ? String(b.category.label).trim()
          : (b.category && b.category.slug ? String(b.category.slug).trim() : 'Blog');

        return {
          id: String(b._id),
          slug: String(b.slug),
          title: b.title || '',
          excerpt,
          imageUrl: b.coverImageUrl || '',
          categoryLabel,
          dateLabel: formatDateFRShort(publishedAt),
          readTimeLabel: `${minutes} min`,
          url: `/blog/${encodeURIComponent(String(b.slug))}`,
        };
      };

      const blogProjection = 'slug title excerpt coverImageUrl category publishedAt createdAt readingTimeMinutes contentHtml';

      const chosenIds = Array.isArray(product.relatedBlogPostIds) ? product.relatedBlogPostIds : [];
      const chosenObjectIds = chosenIds
        .filter((v) => mongoose.Types.ObjectId.isValid(v))
        .map((v) => new mongoose.Types.ObjectId(v));

      const chosenDocs = chosenObjectIds.length
        ? await BlogPost.find({ _id: { $in: chosenObjectIds }, isPublished: true })
            .select(`_id ${blogProjection}`)
            .lean()
        : [];

      const chosenById = new Map((chosenDocs || []).map((d) => [String(d._id), d]));
      const chosenOrdered = chosenObjectIds
        .map((oid) => chosenById.get(String(oid)))
        .filter(Boolean);

      const fromArticlesDocs = await BlogPost.find({
        isPublished: true,
        relatedProductIds: new mongoose.Types.ObjectId(id),
      })
        .sort({ publishedAt: -1, createdAt: -1 })
        .limit(6)
        .select(`_id ${blogProjection}`)
        .lean();

      const merged = [];
      const seen = new Set();
      for (const d of chosenOrdered) {
        const key = d && d._id ? String(d._id) : '';
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(d);
      }
      for (const d of (fromArticlesDocs || [])) {
        const key = d && d._id ? String(d._id) : '';
        if (!key || seen.has(key)) continue;
        seen.add(key);
        merged.push(d);
      }

      relatedBlogPosts = merged
        .filter((b) => b && b.slug)
        .slice(0, 4)
        .map(mappedBlogCard);
    } else {
      relatedProducts = demoProducts
        .filter((p) => String(p._id) !== String(id))
        .slice(0, 4)
        .map(normalizeProduct);
    }

    relatedProducts = (relatedProducts || []).map((p) => {
      const rawImage = p.imageUrl
        || (Array.isArray(p.galleryUrls) && p.galleryUrls.find((u) => typeof u === 'string' && u.trim()))
        || '';
      return {
        ...p,
        publicPath: buildProductPublicPath(p),
        imageUrl: buildSeoMediaUrl(rawImage, p.name),
      };
    });

    const descriptionRaw = product.description || product.shortDescription || '';
    const descriptionNormalized = normalizeImportedText(descriptionRaw);
    const htmlCandidate = looksLikeHtml(descriptionNormalized)
      ? descriptionNormalized
      : markdownToHtml(descriptionNormalized);
    const safeDescriptionHtml = sanitizeProductHtml(htmlCandidate);

    product = {
      ...product,
      publicPath: canonicalPath,
      descriptionHtmlSafe: safeDescriptionHtml,
      descriptionText: toPlainText(descriptionRaw),
      displayOptions: productOptions.getProductPageOptions(product.options),
    };

    const hreflangTags = [
      { lang: 'fr', href: canonicalUrl },
      { lang: 'x-default', href: canonicalUrl },
    ];

    /* Maillage interne : on récupère parent vehicle landings + parent category
       depuis le service. La logique relatedProducts / relatedBlogPosts existante
       reste en place et est préservée pour ne pas régresser. */
    let productLinking = { parentVehicleLandings: [], parentCategory: null };
    try {
      const linking = await require('../services/internalLinking').getProductLinkingData(product);
      productLinking = {
        parentVehicleLandings: linking.parentVehicleLandings || [],
        parentCategory: linking.parentCategory || null,
      };
    } catch (err) {
      console.error('[product] internalLinking error :', err && err.message);
    }

    if (req.session) delete req.session.cartError;
    return res.render('products/show', {
      title: seoTitle,
      metaDescription,
      canonicalUrl,
      ...hreflang,
      hreflangTags,
      ogTitle: seoTitle,
      ogDescription: metaDescription,
      ogUrl: canonicalUrl,
      ogImage,
      ogSiteName: brand.NAME,
      ogType: 'product',
      // Brouillon (isPublished:false) → non indexable, mais les liens restent suivis.
      // Évite l'indexation prématurée d'une fiche non publiée (accessible en aperçu).
      metaRobots: product.isPublished === false ? 'noindex, follow' : undefined,
      jsonLd,
      dbConnected,
      returnTo: req.originalUrl,
      errorMessage,
      product,
      categoryUrl,
      categoryName,
      relatedProducts,
      relatedBlogPosts,
      productLinking,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  listProducts,
  getVehicleTreeApi,
  getProduct,
  getProductBySlug,
  // Helpers exposés pour réutilisation (ex: productListingService)
  escapeRegex,
  toNumberOrNull,
  normalizeProduct,
};
