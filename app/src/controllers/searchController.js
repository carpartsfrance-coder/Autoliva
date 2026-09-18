const mongoose = require('mongoose');

const Product = require('../models/Product');
const demoProducts = require('../demoProducts');
const { getPublicBaseUrlFromReq } = require('../services/productPublic');
const { buildSuggestPayload } = require('../services/search');
const { searchProductsViaAtlas, filtreTexteRepli } = require('../services/productListingService');
const { buildHreflangSet, t } = require('../services/i18n');
const categoryI18n = require('../services/categoryI18n');
const productI18n = require('../services/productI18n');
const brand = require('../config/brand');

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function getSearchPage(req, res, next) {
  try {
    /* Servie aussi sous /de/rechercher : la loupe du header allemand pointait
       ici, et la page française qui s'affichait remettait la session — donc la
       commande et les e-mails — en français. */
    const title = `${t(req.lang, 'search.title')} - ${brand.NAME}`;
    const metaDescription = t(req.lang, 'search.metaDescription');
    const baseUrl = getPublicBaseUrlFromReq(req);
    const langPrefix = req.lang === 'de' ? '/de' : (req.lang === 'en' ? '/en' : '');
    const pathWithoutLang = res.locals.currentPathWithoutLang || req.path;
    const hreflang = buildHreflangSet(baseUrl, pathWithoutLang);
    const canonicalUrl = baseUrl ? `${baseUrl}${langPrefix}/rechercher` : `${langPrefix}/rechercher`;

    return res.render('search/index', {
      title,
      metaDescription,
      canonicalUrl,
      ...hreflang,
      ogTitle: title,
      ogDescription: metaDescription,
      ogUrl: canonicalUrl,
      ogSiteName: brand.NAME,
      ogType: 'website',
      metaRobots: 'noindex, follow',
    });
  } catch (err) {
    return next(err);
  }
}

/* Le menu déroulant montre 4 produits, 2 catégories, 2 marques. Classer 400
   fiches est déjà large ; en classer 14 464 bloquait la boucle d'événements
   plusieurs secondes par frappe — d'où les « [NODE-CRON] missed execution ». */
const SUGGEST_MAX_PRODUITS = 400;

/* Langue du menu déroulant : celle de la PAGE qui a lancé l'appel. L'URL est
   toujours française (/rechercher/suggest, appelé depuis /de aussi), et le
   middleware i18n n'y touche pas à la session — c'est donc la préférence
   mémorisée qui fait foi, comme pour le panier. */
function langueSuggestion(req) {
  if (req.lang === 'de') return 'de';
  return (req.session && req.session.preferredLang === 'de') ? 'de' : 'fr';
}

/* Les libellés de catégorie du menu sont les noms FRANÇAIS recopiés sur les
   fiches ; les 63 catégories traduites vivent dans Category.localizations. */
async function traduireSectionCategories(payload, lang) {
  if (lang !== 'de' || !payload || !Array.isArray(payload.sections)) return payload;
  const section = payload.sections.find((s) => s && s.type === 'categories');
  if (!section || !Array.isArray(section.items)) return payload;
  for (const item of section.items) {
    const traduit = await categoryI18n.traduire(item.label, 'de');
    item.label = traduit;
    item.name = traduit;
  }
  return payload;
}

async function getSuggest(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const lang = langueSuggestion(req);
    const q = getTrimmedString(req.query.q);

    if (!q || q.length < 2) {
      return res.json({ results: [], sections: [], total: 0 });
    }

    // Voie normale : MÊME moteur que le catalogue — MongoDB Atlas Search — pour
    // que les suggestions (autocomplétion mobile + dropdown desktop) soient
    // classées par pertinence EXACTEMENT comme la page de résultats /produits.
    // On prend les ~10 premiers, en conservant l'ordre de pertinence Atlas.
    /* L'index Atlas ne cartographie que les champs FRANÇAIS (name, sku, brand,
       category, description) : en allemand il répond un tableau VIDE, et un
       tableau vide reste un tableau — on renvoyait un menu vide sans même
       essayer le repli. « Getriebe », « Mechatronik », « Ölfilter » ne
       trouvaient rien alors que le champ invite à taper en allemand. Sous /de
       on prend donc directement le repli, qui sait lire `localizations.de`.
       Exactement la règle que le catalogue applique déjà
       (productListingService). À revoir le jour où l'index Atlas connaîtra
       l'allemand. */
    if (dbConnected && lang !== 'de') {
      const atlas = await searchProductsViaAtlas({
        baseFilter: { isPublished: { $ne: false } },
        searchQuery: q,
        page: 1,
        perPage: 10,
      });
      if (atlas && Array.isArray(atlas.products)) {
        const ranked = atlas.products.map((product) => ({ product }));
        const payload = buildSuggestPayload([], q, { ranked, productLimit: 6, categoryLimit: 2, brandLimit: 2, lang });
        if (Number.isFinite(atlas.totalCount)) payload.total = atlas.totalCount;
        return res.json(await traduireSectionCategories(payload, lang));
      }
      // atlas === null → Atlas indisponible : repli sur le moteur JS ci-dessous.
    }

    /* Repli moteur JS (Atlas indisponible OU base déconnectée / démo).
     *
     * ⚠ CE CHEMIN A ÉTÉ LA MOITIÉ OUBLIÉE DE LA PANNE DU 21/08/2026.
     *
     * Le correctif de /produits (productListingService) avait borné son propre
     * repli, mais celui-ci — le plus sollicité du site — chargeait toujours
     * les 14 464 fiches publiées, projection lourde comprise (description,
     * compatibility, specs, keyPoints…), À CHAQUE FRAPPE : l'autocomplétion
     * part toutes les 300 ms (public/js/search-autocomplete.js:224).
     *
     * Pire, le disjoncteur posé pour éteindre l'incendie ALIMENTAIT celui-ci :
     * disjoncteur ouvert → `searchProductsViaAtlas` renvoie null immédiatement
     * → on tombe ici sans même tenter Atlas. Le garde-fou d'un chemin était
     * l'accélérateur de l'autre.
     *
     * Deux bornes, les mêmes qu'ailleurs :
     *   — le préfiltre regex côté MongoDB (on ne rapatrie que les fiches
     *     contenant un mot cherché) ;
     *   — un plafond serré : le menu n'affiche que 4 produits, 2 catégories
     *     et 2 marques. En classer 400 est déjà généreux ; en classer 14 464
     *     bloquait la boucle d'événements plusieurs secondes.
     */
    let products = [];
    if (dbConnected) {
      /* La langue du préfiltre : sans elle, `localizations.de.*` n'entrait pas
         dans la requête Mongo et un mot allemand ne remontait aucune fiche. */
      const filtreRepli = filtreTexteRepli({ isPublished: { $ne: false } }, q, lang);
      products = await Product.find(filtreRepli)
        /* localizations.de : sans elles, le menu du header d'une page /de
           affichait les noms français (le calque n'avait rien à lire). Les
           textes allemands servent aussi au CLASSEMENT ci-dessous, sur
           400 fiches au plus — voir le plafond ci-dessus. */
        .select('_id name sku engineCode brand priceCents imageUrl galleryUrls slug category shortDescription description compatibleReferences compatibility specs keyPoints tags localizations.de.name localizations.de.slug localizations.de.translatedAt localizations.de.shortDescription localizations.de.description localizations.de.keyPoints')
        .limit(SUGGEST_MAX_PRODUITS)
        .lean();
      /* Le classement (rankProducts) note `name`, `description`, `keyPoints`… :
         sans le calque, il rejetait la fiche que le préfiltre venait de retenir
         sur son titre allemand, et le menu restait vide. Même enchaînement que
         le catalogue (productListingService). */
      if (lang === 'de') products = products.map((p) => productI18n.localizeProduct(p, 'de'));
    } else {
      products = Array.isArray(demoProducts)
        ? demoProducts.map((product) => ({
            ...product,
            _id: product && product._id ? product._id : (product && product.id ? product.id : product && product.sku ? product.sku : product && product.name ? product.name : ''),
          }))
        : [];
    }

    const payload = buildSuggestPayload(products, q, {
      productLimit: 4,
      categoryLimit: 2,
      brandLimit: 2,
      lang,
    });

    return res.json(await traduireSectionCategories(payload, lang));
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getSearchPage,
  getSuggest,
};
