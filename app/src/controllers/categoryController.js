const mongoose = require('mongoose');
const scalapay = require('../services/scalapay');

const Category = require('../models/Category');
const demoProducts = require('../demoProducts');
const brand = require('../config/brand');
const { buildProductPublicPath, slugify: slugifyGeneric } = require('../services/productPublic');
const {
  buildCategoryPublicPath,
  buildCategoryPublicUrl,
  getPublicBaseUrlFromReq,
  compterFichesPubliees,
} = require('../services/categoryPublic');
const { buildHreflangSet, t, redirectionFrGardantLaLangue } = require('../services/i18n');
const { formatCategoryDisplayName } = require('../services/brandSanitizer');
const internalLinking = require('../services/internalLinking');
const productI18n = require('../services/productI18n');
const { filtreAuDelaDuPreset } = require('../services/facettesListing');
const titreSeo = require('../services/titreSeo');
const redirectionsCategories = require('../services/redirectionsCategories');
const pagesFamilles = require('../services/pagesFamilles');

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
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

/* Title SEO : 60 caractères au plus, coupé entre deux mots, sans « … »
   (audit SEO du 11/11/2026, services/titreSeo.js). */
function clampSeoTitle(t) {
  if (!t) return t;
  const { texte, suffixe } = titreSeo.separerSuffixe(String(t), brand.NAME);
  return titreSeo.ajusterTitre(texte, { suffixe, modeSuffixe: 'prefere' });
}

/* Title d'une page 2+ : « … – page N », la mention de page jamais coupée. */
function titreAvecPage(titre, page, lang) {
  if (!(page > 1)) return clampSeoTitle(titre);
  const { texte, suffixe } = titreSeo.separerSuffixe(String(titre), brand.NAME);
  const mention = lang === 'de' ? ` – Seite ${page}` : ` – page ${page}`;
  const avecMarque = titreSeo.ajusterTitre(texte, { max: titreSeo.TITRE_MAX - mention.length - suffixe.length });
  if (suffixe && avecMarque.length >= 20) return `${avecMarque}${mention}${suffixe}`;
  return `${titreSeo.ajusterTitre(texte, { max: titreSeo.TITRE_MAX - mention.length })}${mention}`;
}

function toSafeJsonLd(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}


async function listCategories(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;

    let categories = [];

    if (dbConnected) {
      categories = await Category.find({ isActive: true })
        .sort({ sortOrder: 1, name: 1 })
        .select('_id name slug localizations.de.name localizations.de.slug localizations.de.translatedAt')
        .lean();

      /* Catégories VIDES hors du sommaire (audit du 25/09/2026) : 42 des
         catégories actives n'ont aucune fiche publiée. Leur page se sert en
         noindex et le sitemap les écarte déjà (plan SEO A4.6) ; les lister ici
         envoyait visiteurs et robots vers 42 pages vides. Même comptage que la
         page et le sitemap : une catégorie qui se remplit revient d'elle-même.
         Si le comptage échoue, la liste reste entière. */
      try {
        const comptes = await compterFichesPubliees((categories || []).map((c) => c && c.name).filter(Boolean));
        categories = (categories || []).filter((c) => c && comptes.get(c.name) > 0);
      } catch (err) {
        console.error('[categories] comptage impossible, sommaire complet :', err && err.message ? err.message : err);
      }

      categories = (categories || []).map((c) => {
        /* Sous /de : nom ET slug allemands. Le sommaire listait les 64
           catégories avec leurs URL françaises — 64 liens qui partaient tous
           en redirection depuis une page allemande. */
        const de = (req.lang === 'de' && c.localizations && c.localizations.de
          && c.localizations.de.translatedAt) ? c.localizations.de : null;
        return {
          id: String(c._id),
          name: (de && de.name) ? de.name : (c.name || ''),
          slug: c.slug || '',
          publicPath: de
            ? '/de/categorie/' + encodeURIComponent(de.slug || c.slug)
            : buildCategoryPublicPath(c),
        };
      });
    } else {
      const used = new Set();
      const derived = [];
      for (const p of demoProducts || []) {
        const cat = getTrimmedString(p && p.category ? p.category : '');
        if (!cat) continue;
        if (used.has(cat)) continue;
        used.add(cat);
        derived.push({
          id: cat,
          name: cat,
          slug: slugifyGeneric(cat) || 'categorie',
        });
      }

      categories = derived
        .sort((a, b) => a.name.localeCompare(b.name, 'fr'))
        .map((c) => ({
          ...c,
          publicPath: buildCategoryPublicPath(c),
        }));
    }

    const title = clampSeoTitle(t(req.lang, 'categories.indexTitle'));
    const metaDescription = t(req.lang, 'categories.indexMeta');
    const baseUrl = getPublicBaseUrlFromReq(req);
    const langPrefix = req.lang === 'de' ? '/de' : (req.lang === 'en' ? '/en' : '');
    const pathWithoutLang = res.locals.currentPathWithoutLang || req.path;
    const hreflang = buildHreflangSet(baseUrl, pathWithoutLang);
    const canonicalUrl = baseUrl ? `${baseUrl}${langPrefix}/categorie` : `${langPrefix}/categorie`;
    const jsonLd = toSafeJsonLd({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'CollectionPage',
          name: t(req.lang, 'breadcrumb.categoriesLd'),
          url: canonicalUrl,
          description: metaDescription,
        },
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            {
              '@type': 'ListItem',
              position: 1,
              name: t(req.lang, 'breadcrumb.homeLd'),
              item: baseUrl ? `${baseUrl}${langPrefix}/` : '/',
            },
            {
              '@type': 'ListItem',
              position: 2,
              name: t(req.lang, 'breadcrumb.categoriesLd'),
              item: canonicalUrl,
            },
          ],
        },
      ],
    });

    return res.render('categories/index', {
      title,
      metaDescription,
      canonicalUrl,
      ...hreflang,
      ogTitle: title,
      ogDescription: metaDescription,
      ogUrl: canonicalUrl,
      ogSiteName: brand.NAME,
      ogType: 'website',
      jsonLd,
      dbConnected,
      categories,
    });
  } catch (err) {
    return next(err);
  }
}

async function getCategory(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const slug = getTrimmedString(req.params.slug);
    if (!slug) {
      return res.status(404).render('errors/404', { title: `Page introuvable - ${brand.NAME}` });
    }

    let category = null;
    if (dbConnected) {
      const CAT_FIELDS = '_id name slug updatedAt seoText localizations';
      /* Sous /de, on cherche D'ABORD par le slug allemand : le canonical et le
         hreflang de ces pages pointent depuis toujours vers /de/categorie/
         <slug-de>, une URL que la route ne savait pas résoudre — Google se
         voyait donc désigner une 404 comme page canonique. */
      if (req.lang === 'de') {
        category = await Category.findOne({ 'localizations.de.slug': slug, isActive: { $ne: false } })
          .select(CAT_FIELDS)
          .lean();
        /* Ancien slug (avant translittération des umlauts) : on le résout
           quand même, et la redirection plus bas envoie vers le nouveau. */
        if (!category) {
          category = await Category.findOne({ 'localizations.de.slugAliases': slug, isActive: { $ne: false } })
            .select(CAT_FIELDS)
            .lean();
        }
      }
      if (!category) {
        category = await Category.findOne({ slug, isActive: { $ne: false } })
          .select(CAT_FIELDS)
          .lean();
      }
    } else {
      const all = new Map();
      for (const p of demoProducts || []) {
        const cat = getTrimmedString(p && p.category ? p.category : '');
        if (!cat) continue;
        const s = slugifyGeneric(cat) || '';
        if (!s) continue;
        if (!all.has(s)) all.set(s, { id: s, slug: s, name: cat, updatedAt: null });
      }
      category = all.get(slug) || null;
    }

    if (!category) {
      /* Ancienne adresse (arborescence remplacée, renommage dans l'admin,
         queue parasite) : 301 vers la catégorie qui la remplace plutôt
         qu'un 404 (audit SEO du 11/11/2026, problème 2). */
      if (dbConnected) {
        const cible = await redirectionsCategories.resoudre(slug);
        if (cible !== null) {
          const prefixe = req.lang === 'de' ? '/de' : '';
          return res.redirect(301, cible ? `${prefixe}/categorie/${encodeURIComponent(cible)}` : `${prefixe}/categorie`);
        }
      }
      return res.status(404).render('errors/404', { title: `Page introuvable - ${brand.NAME}` });
    }

    /* Délègue toute la logique de listing/filtrage/pagination au service partagé,
     * en pré-filtrant la catégorie. L'utilisateur reste libre d'appliquer d'autres
     * filtres (marque véhicule, prix, stock, tri…) qui se cumuleront avec la
     * catégorie pré-sélectionnée. */
    // ─── Localisation (DE) : la page catégorie est un calque sur le FR ───
    // Tant que la catégorie n'a pas de traduction publiée (translatedAt), on 301
    // vers le FR (jamais de page à moitié traduite). Le filtrage produits reste
    // basé sur le nom FR (presetCategoryName) ; seul l'AFFICHAGE est traduit.
    const isDe = req.lang === 'de' && productI18n.isSupportedLang('de');
    const deLoc = category.localizations && category.localizations.de;
    if (isDe && !(deLoc && deLoc.translatedAt)) {
      /* Même règle que la fiche : la page française d'arrivée ne doit pas
         remettre la session — donc la commande et les e-mails — en français. */
      return res.redirect(301, redirectionFrGardantLaLangue(req, '/categorie/' + encodeURIComponent(category.slug)));
    }
    const deCatSlug = (isDe && deLoc && deLoc.slug && deLoc.slug.trim()) ? deLoc.slug.trim() : category.slug;
    /* Une catégorie allemande = UNE URL. Arrivé par le slug français sous /de,
       on renvoie vers le slug allemand, celui que déclare le canonical. */
    if (isDe && deCatSlug !== slug) {
      const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';
      return res.redirect(301, '/de/categorie/' + encodeURIComponent(deCatSlug) + qs);
    }

    const { prepareProductListingData } = require('../services/productListingService');
    const data = await prepareProductListingData(req, { presetCategoryName: category.name });

    // Cartes en allemand + liens vers les fiches DE.
    if (isDe) {
      data.products = (data.products || []).map((p) => {
        const lp = productI18n.localizeProduct(p, 'de');
        lp.publicPath = '/de/produits/' + encodeURIComponent(productI18n.localizedSlug(p, 'de')) + '-' + p._id;
        return lp;
      });
    }

    /* Override SEO spécifique à la page catégorie (canonical /categorie/:slug,
     * title incluant le nom catégorie, JSON-LD CollectionPage + breadcrumb).
     *
     * Les noms en DB peuvent contenir " > " (hiérarchie parent > enfant) qui
     * polluerait le H1 et le <title>. On affiche le segment terminal seul
     * (« Bloc moteur » plutôt que « Moteur > Bloc moteur ») — le breadcrumb
     * au-dessus du H1 rappelle déjà la hiérarchie. */
    const rawName = getTrimmedString((isDe && deLoc && deLoc.name) ? deLoc.name : category.name);
    const name = formatCategoryDisplayName(rawName);
    /* Title clampé à 60 char + override DB éventuel.
     * Si DB a un metaTitle custom, on respecte mais on clamp toujours. */
    const dbMetaTitle = category.seo && typeof category.seo.metaTitle === 'string'
      ? category.seo.metaTitle.trim() : '';
    /* Familles prioritaires (ponts, boîtes de transfert, mécatroniques) :
       title, description, H1, introduction et FAQ rédigés et relus (audit SEO
       du 11/11/2026, problème 4 ; src/data/seo/pages-familles.json). Un
       `seo.metaTitle` en base garderait la main, comme prévu ci-dessus — mais
       le modèle Category n'a pas ce champ et la requête ne le lit pas : pour
       ces trois catégories, le title est celui du fichier. */
    const famille = isDe ? null : pagesFamilles.pourCategorie(category.slug, 'fr');
    /* `seo.metaTitle` en DB est saisi en français : on ne l'applique qu'au FR. */
    const title = titreAvecPage((!isDe && dbMetaTitle) || (famille && famille.titre) || t(req.lang, 'category.metaTitle', { name }), data.page, req.lang);
    const descriptionPage1 = isDe
      ? buildCategoryMetaDescriptionDe(name, data.totalCount)
      : ((famille && famille.description) || buildCategoryMetaDescription(name, data.totalCount));
    /* Pages 2 et suivantes : ouvertes à Google (voir metaRobots), elles ne
       doivent pas répéter le title et la description de la page 1. */
    const metaDescription = data.page > 1
      ? truncateText(normalizeMetaText(`${isDe ? 'Seite' : 'Page'} ${data.page} – ${descriptionPage1}`), 160)
      : descriptionPage1;

    const baseUrl = getPublicBaseUrlFromReq(req);
    const canonicalBase = isDe
      ? `${baseUrl}/de/categorie/${encodeURIComponent(deCatSlug)}`
      : buildCategoryPublicUrl(category, { req });
    const canonicalUrl = data.page > 1
      ? `${canonicalBase}?page=${encodeURIComponent(String(data.page))}`
      : canonicalBase;

    const langPrefix = req.lang === 'de' ? '/de' : (req.lang === 'en' ? '/en' : '');
    const pathWithoutLang = res.locals.currentPathWithoutLang || req.path;
    const hreflang = buildHreflangSet(baseUrl, pathWithoutLang);
    // hreflang FR↔DE dès qu'une traduction DE de la catégorie existe.
    let hreflangTags;
    if (isDe || (deLoc && deLoc.translatedAt)) {
      const _frHref = `${baseUrl}/categorie/${encodeURIComponent(category.slug)}`;
      const _deHref = `${baseUrl}/de/categorie/${encodeURIComponent(deCatSlug)}`;
      hreflangTags = [
        { lang: 'fr', href: _frHref },
        { lang: 'de', href: _deHref },
        { lang: 'x-default', href: _frHref },
      ];
    }
    /* Page 2+ indexable : ses hreflang la désignent ELLE (et sa version
       allemande), pas la page 1 — sinon Google lit deux signaux contraires. */
    if (data.page > 1) {
      const suffixePage = `?page=${encodeURIComponent(String(data.page))}`;
      hreflangTags = hreflangTags
        ? hreflangTags.map((tag) => ({ ...tag, href: `${tag.href}${suffixePage}` }))
        : [{ lang: 'fr', href: canonicalUrl }, { lang: 'x-default', href: canonicalUrl }];
    }

    /* Robots : on indexe la page catégorie nue (pas de filtres au-delà de la
     * catégorie présélectionnée), pages 2+ comprises. Dès qu'un filtre
     * additionnel est actif ou que la catégorie est vide, on noindex pour
     * éviter le contenu dupliqué et le "thin content" des catégories vides. */
    const isEmpty = !data.totalCount || data.totalCount === 0;
    const filtersBeyondCategory =
      data.searchQuery
      || data.selectedVehicleMake
      || data.selectedVehicleModel
      || data.selectedSubCategory
      || data.selectedStock
      || (data.minPriceEuros !== null && data.minPriceEuros !== undefined)
      || (data.maxPriceEuros !== null && data.maxPriceEuros !== undefined)
      || (data.sort && data.sort !== 'newest' && data.sort !== '')
      /* Page 2 et suivantes : INDEXABLES depuis l'audit SEO du 11/11/2026
         (problème 6). En noindex, 316 des 340 ponts n'étaient listés que sur
         des pages que Google finit par ne plus suivre. Chaque page garde sa
         propre adresse canonique (?page=N), son title et sa description. */
      /* Autre catégorie, état, véhicule… : même règle (audit du 25/09/2026,
         services/facettesListing.js). */
      || filtreAuDelaDuPreset(req.query, { categorie: category.name });
    const metaRobots = (filtersBeyondCategory || isEmpty)
      ? 'noindex, follow'
      : (res.locals.metaRobots || undefined);

    const itemListElements = (data.products || []).map((p, idx) => {
      const productUrl = baseUrl
        ? `${baseUrl}${p.publicPath || buildProductPublicPath(p)}`
        : (p.publicPath || buildProductPublicPath(p));
      return {
        '@type': 'ListItem',
        position: idx + 1,
        name: getTrimmedString(p.name),
        url: productUrl,
      };
    });

    const jsonLd = toSafeJsonLd({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'CollectionPage',
          name,
          url: canonicalUrl,
          description: metaDescription,
          mainEntity: {
            '@type': 'ItemList',
            numberOfItems: data.totalCount,
            itemListElement: itemListElements,
          },
        },
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Accueil', item: baseUrl ? `${baseUrl}/` : '/' },
            { '@type': 'ListItem', position: 2, name: 'Catégories', item: baseUrl ? `${baseUrl}/categorie` : '/categorie' },
            { '@type': 'ListItem', position: 3, name, item: canonicalUrl },
          ],
        },
        /* FAQ visible sur la page 1 seulement : ses données aussi. */
        ...((famille && !(data.page > 1) && pagesFamilles.faqJsonLd(famille)) ? [pagesFamilles.faqJsonLd(famille)] : []),
      ],
    });

    /* Maillage interne (sibling categories, sous-cat, top makes, related blog). */
    let linkingData = {};
    try {
      linkingData = await internalLinking.getCategoryLinkingData(category, req.lang);
    } catch (err) {
      console.error('[category] internalLinking error :', err && err.message);
    }

    return res.render('products/index', {
      ...data,
      // Override SEO spécifique catégorie (écrase les valeurs par défaut du service)
      title,
      metaDescription,
      canonicalUrl,
      ...hreflang,
      hreflangTags,
      ogTitle: title,
      ogDescription: metaDescription,
      ogUrl: canonicalUrl,
      ogSiteName: brand.NAME,
      ogType: 'website',
      metaRobots,
      jsonLd,
      // Contexte page catégorie (pour breadcrumb, H1, bloc SEO en bas et basePath dynamique)
      basePath: isDe ? `/de/categorie/${encodeURIComponent(deCatSlug)}` : `/categorie/${category.slug}`,
      categoryContext: {
        name,
        slug: category.slug,
        publicPath: isDe ? `/de/categorie/${encodeURIComponent(deCatSlug)}` : buildCategoryPublicPath(category),
        seoText: isDe ? ((deLoc && deLoc.seoText) || '') : (typeof category.seoText === 'string' ? category.seoText : ''),
        linking: linkingData,
        /* H1 et contenu de famille : le H1 sur toutes les pages, le texte
           d'introduction, les liens et la FAQ sur la page 1 seulement (les
           pages 2+ indexables ne doivent pas répéter le même texte). */
        h1: famille && famille.h1 ? famille.h1 : '',
        famille: (famille && !(data.page > 1)) ? {
          introHtml: famille.introHtml || '',
          liens: Array.isArray(famille.liens) ? famille.liens : [],
          faq: Array.isArray(famille.faq) ? famille.faq : [],
        } : null,
      },
    });
  } catch (err) {
    return next(err);
  }
}

/* Version allemande : le gabarit français produisait « Drehmomentwandler
   reconditionnées et testées sur banc… » — un nom allemand dans une phrase
   française, sur chacune des pages catégorie DE. */
function buildCategoryMetaDescriptionDe(name, totalCount) {
  const countText = totalCount > 0
    ? t('de', 'category.countRefs', { count: totalCount })
    : t('de', 'category.wideChoice');
  return truncateText(normalizeMetaText(t('de', 'category.metaDescription', { name, countText })), 160);
}

function buildCategoryMetaDescription(name, totalCount) {
  const n = name.toLowerCase();
  const count = totalCount > 0 ? totalCount : '';
  const countText = count ? `${count} références` : 'Large choix';
  /* Plan SEO A11 : ces descriptions promettaient « garantie 2 ans » et
     « 3x/4x sans frais » à toute la catégorie. La garantie dépend de la pièce
     (6, 12 ou 24 mois) et le paiement en plusieurs fois est coupé depuis le
     05/08 : il ne réapparaît que si Scalapay est rallumé. */
  const paiement = scalapay.estActif() ? ' Paiement en 3x/4x sans frais.' : '';

  const templates = [
    `${name} reconditionnées et d'occasion, contrôlées avant expédition. Garantie selon la pièce. ${countText} à prix compétitifs.${paiement}`,
    `${countText} de ${n} d'occasion et reconditionnées, contrôlées avant expédition, garantie indiquée sur chaque fiche.${paiement}`,
    `${name} d'occasion et reconditionnées. ${countText} contrôlées, garantie indiquée sur chaque fiche. Livraison en France et en Europe.${paiement}`,
  ];

  for (const t of templates) {
    const clean = normalizeMetaText(t);
    if (clean.length >= 140 && clean.length <= 160) return clean;
  }

  const fallback = `${name} d'occasion et reconditionnées, garantie indiquée sur chaque fiche. ${countText} disponibles, livraison en France et en Europe.${paiement}`;
  return truncateText(normalizeMetaText(fallback), 160);
}

module.exports = {
  listCategories,
  getCategory,
  /* Exposé pour les tests : les promesses de ces descriptions sont vérifiées. */
  _pourTests: { buildCategoryMetaDescription, buildCategoryMetaDescriptionDe },
};
