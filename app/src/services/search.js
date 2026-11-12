const { buildProductPublicPath } = require('./productPublic');
const productI18n = require('./productI18n');
const { t } = require('./i18n');
const brand = require('../config/brand');

const STOP_WORDS = new Set([
  'a',
  'au',
  'aux',
  'avec',
  'ce',
  'ces',
  'd',
  'dans',
  'de',
  'des',
  'du',
  'en',
  'et',
  'l',
  'la',
  'le',
  'les',
  'ou',
  'par',
  'pour',
  'sur',
  'un',
  'une',
]);

const TOKEN_ALIASES = new Map([
  ['boite', ['boite', 'boites', 'boite de vitesse', 'boite de vitesses', 'transmission', 'bv', 'dsg']],
  ['boites', ['boite', 'boites', 'boite de vitesse', 'boite de vitesses', 'transmission', 'bv', 'dsg']],
  ['vitesse', ['vitesse', 'vitesses', 'transmission', 'bv', 'dsg']],
  ['vitesses', ['vitesse', 'vitesses', 'transmission', 'bv', 'dsg']],
  ['transmission', ['transmission', 'boite', 'boite de vitesse', 'boite de vitesses', 'bv', 'dsg']],
  ['bv', ['bv', 'boite', 'boite de vitesse', 'boite de vitesses', 'transmission', 'dsg']],
  ['dsg', ['dsg', 'boite', 'boite de vitesse', 'boite de vitesses', 'transmission', 'dq200']],
  ['dq200', ['dq200', 'dsg', 'mecatronique', 'boite', 'boite de vitesse', 'boite de vitesses', 'transmission']],
  ['golf', ['golf', 'volkswagen', 'vw', 'vag']],
  ['volkswagen', ['volkswagen', 'vw', 'vag', 'golf']],
  ['vw', ['vw', 'volkswagen', 'vag', 'golf']],
  ['vag', ['vag', 'vw', 'volkswagen', 'audi', 'seat', 'skoda']],
  ['mecatronique', ['mecatronique', 'mecat', 'mecatronic']],
  ['phare', ['phare', 'optique', 'feu']],
  ['optique', ['optique', 'phare', 'feu']],
  ['feu', ['feu', 'phare', 'optique']],
  ['pont', ['pont', 'differentiel', 'pont arriere', 'pont avant']],
  ['differentiel', ['differentiel', 'pont', 'pont arriere', 'pont avant']],
]);

const PHRASE_ALIASES = new Map([
  ['boite de vitesse', ['boite de vitesses', 'transmission', 'bv', 'dsg']],
  ['boite de vitesses', ['boite de vitesse', 'transmission', 'bv', 'dsg']],
  ['pont arriere', ['pont', 'differentiel']],
  ['pont avant', ['pont', 'differentiel']],
]);

// Longueur minimale pour qu'un token soit traité comme une référence OEM.
// En dessous on retomberait sur des fragments ambigus (« o2 » → « 02 ») qui
// ramèneraient des pièces sans rapport.
const MIN_REFERENCE_TOKEN_LENGTH = 5;

// Un fragment de référence reste court (« 0am », « 325 », « 025 », « d »).
const MAX_REFERENCE_FRAGMENT_LENGTH = 6;
const MIN_GLUED_REFERENCE_LENGTH = 6;

const FIELD_WEIGHTS = [
  ['name', 14],
  ['engineCode', 13],
  ['sku', 12],
  ['compatibleReferences', 11],
  ['compatibility', 10],
  ['searchSynonyms', 9],
  ['category', 8],
  ['brand', 7],
  ['shortDescription', 5],
  ['description', 4],
  ['specs', 4],
  ['keyPoints', 3],
  ['tags', 3],
];

function trimString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeSearchText(value) {
  return trimString(value)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[’']/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function tokenize(value) {
  return normalizeSearchText(value)
    .split(' ')
    .map((part) => part.trim())
    .filter(Boolean);
}

function uniqueStrings(values) {
  const seen = new Set();
  const list = [];

  for (const raw of Array.isArray(values) ? values : []) {
    const value = normalizeSearchText(raw);
    if (!value || seen.has(value)) continue;
    seen.add(value);
    list.push(value);
  }

  return list;
}

function singularizeToken(value) {
  const token = normalizeSearchText(value);
  if (!token) return '';
  if (token.endsWith('s') && !token.endsWith('ss') && token.length > 3) return token.slice(0, -1);
  return token;
}

function isCodeLikeToken(value) {
  const token = normalizeSearchText(value);
  if (!token) return false;
  return /[a-z]/.test(token) && /\d/.test(token);
}

// Les références OEM du groupe VAG commencent par un zéro (0AM325065,
// 0GC927711H). Les clients le saisissent très souvent avec la lettre O, et
// certains imports fournisseurs les stockent ainsi. On génère donc les deux
// graphies du PREMIER caractère pour les tokens de type code : c'est la seule
// position où la confusion se produit, donc aucune variante parasite ailleurs.
function getReferenceGraphyVariants(token) {
  if (!token || token.length < MIN_REFERENCE_TOKEN_LENGTH) return [];
  if (token.startsWith('o')) return [`0${token.slice(1)}`];
  if (token.startsWith('0')) return [`o${token.slice(1)}`];
  return [];
}

function getAliasVariants(term) {
  const normalized = normalizeSearchText(term);
  if (!normalized) return [];

  const singular = singularizeToken(normalized);
  if (isCodeLikeToken(normalized) || isCodeLikeToken(singular)) {
    return uniqueStrings([
      normalized,
      singular,
      ...getReferenceGraphyVariants(normalized),
      ...getReferenceGraphyVariants(singular),
    ]);
  }

  const aliases = TOKEN_ALIASES.get(normalized) || TOKEN_ALIASES.get(singular) || [];

  return uniqueStrings([normalized, singular, ...aliases]);
}

// Recolle une requête écrite en fragments (« 0am 325 025 d ») en une référence
// unique. On n'y touche que si tous les fragments sont courts : dès que la
// requête contient un vrai mot (« mecatronique dq200 »), il n'y a rien à
// recoller.
function buildGluedReference(tokens) {
  const list = Array.isArray(tokens) ? tokens : [];
  if (list.length < 2) return '';
  if (list.some((token) => token.length > MAX_REFERENCE_FRAGMENT_LENGTH)) return '';

  const glued = list.join('');
  if (glued.length < MIN_GLUED_REFERENCE_LENGTH) return '';
  if (!isCodeLikeToken(glued)) return '';

  return glued;
}

function buildQueryAnalysis(query) {
  const normalizedQuery = normalizeSearchText(query);
  if (!normalizedQuery) {
    return {
      normalizedQuery: '',
      tokenGroups: [],
      phraseGroups: [],
      allVariants: [],
    };
  }

  const rawTokens = tokenize(normalizedQuery).filter((token) => !STOP_WORDS.has(token));
  const tokenGroups = rawTokens.map((token) => ({
    key: token,
    variants: getAliasVariants(token),
  }));

  const phraseGroups = [];
  for (const [phrase, aliases] of PHRASE_ALIASES.entries()) {
    if (!normalizedQuery.includes(phrase)) continue;
    phraseGroups.push({
      key: phrase,
      variants: uniqueStrings([phrase, ...aliases]),
    });
  }

  // « 0AM 325 025 D » et « 0am325025d » désignent la même pièce : on recolle
  // les fragments pour que la référence complète pèse dans le score, sinon
  // seuls les bouts (« 325 », « 025 ») matchent et remontent n'importe quoi.
  const gluedReference = buildGluedReference(rawTokens);
  if (gluedReference) {
    phraseGroups.push({
      key: gluedReference,
      variants: uniqueStrings([gluedReference, ...getReferenceGraphyVariants(gluedReference)]),
    });
  }

  const allVariants = uniqueStrings([
    normalizedQuery,
    ...tokenGroups.flatMap((group) => group.variants),
    ...phraseGroups.flatMap((group) => group.variants),
  ]);

  // Les autres graphies de la requête entière valent la graphie tapée : sans
  // ça, « oam927769d » perdrait la prime de correspondance complète que
  // « 0am927769d » reçoit, et une fiche citant juste « 0AM » passerait devant.
  const wholeQueryVariants = uniqueStrings([
    normalizedQuery,
    ...getReferenceGraphyVariants(normalizedQuery),
    ...(gluedReference ? [gluedReference, ...getReferenceGraphyVariants(gluedReference)] : []),
  ]);

  return {
    normalizedQuery,
    tokenGroups,
    phraseGroups,
    allVariants,
    wholeQueryVariants,
  };
}

// Une même référence circule en deux graphies : « 0AM 325 025 D » sur les
// catalogues constructeur, « 0AM325025D » dans ce que tape le client. On
// indexe les deux, sinon la fiche n'est trouvable que dans la graphie où elle
// a été saisie.
function withGluedReferences(values) {
  const list = Array.isArray(values) ? values : [];
  const out = [];

  for (const value of list) {
    const normalized = normalizeSearchText(value);
    if (!normalized) continue;
    out.push(normalized);
    const glued = normalized.replace(/ /g, '');
    if (glued && glued !== normalized) out.push(glued);
  }

  return Array.from(new Set(out));
}

function toSearchableList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => trimString(item))
    .filter(Boolean);
}

function toCompatList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      return {
        make: trimString(item.make),
        model: trimString(item.model),
        years: trimString(item.years),
        engine: trimString(item.engine),
      };
    })
    .filter((item) => item && (item.make || item.model || item.years || item.engine));
}

function toSpecList(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const label = trimString(item.label);
      const val = trimString(item.value);
      if (!label && !val) return null;
      return `${label} ${val}`.trim();
    })
    .filter(Boolean);
}

function buildSearchDocument(product) {
  const compatibility = toCompatList(product && product.compatibility);
  const rawMakes = Array.from(new Set(compatibility.map((item) => trimString(item.make)).filter(Boolean)));
  const makes = uniqueStrings(compatibility.map((item) => item.make));
  const models = uniqueStrings(compatibility.map((item) => item.model));
  const engines = uniqueStrings(compatibility.map((item) => item.engine));
  const years = uniqueStrings(compatibility.map((item) => item.years));
  const compatibleReferences = toSearchableList(product && product.compatibleReferences);
  const keyPoints = toSearchableList(product && product.keyPoints);
  // Renseignés par l'admin et par les termes de recherche remontés dans
  // analyticsController, mais jamais lus jusqu'ici : ils ne servaient à rien.
  const searchSynonyms = toSearchableList(product && product.searchSynonyms);
  const tags = toSearchableList(product && product.tags);
  const specs = toSpecList(product && product.specs);

  const fields = {
    name: normalizeSearchText(product && product.name),
    sku: withGluedReferences([product && product.sku]).join(' '),
    engineCode: normalizeSearchText(product && product.engineCode),
    brand: normalizeSearchText(product && product.brand),
    category: normalizeSearchText(product && product.category),
    shortDescription: normalizeSearchText(product && product.shortDescription),
    description: normalizeSearchText(product && product.description),
    compatibleReferences: withGluedReferences(compatibleReferences).join(' '),
    compatibility: normalizeSearchText(
      compatibility
        .map((item) => [item.make, item.model, item.years, item.engine].filter(Boolean).join(' '))
        .join(' ')
    ),
    searchSynonyms: withGluedReferences(searchSynonyms).join(' '),
    specs: normalizeSearchText(specs.join(' ')),
    keyPoints: normalizeSearchText(keyPoints.join(' ')),
    tags: normalizeSearchText(tags.join(' ')),
  };

  const allText = normalizeSearchText(Object.values(fields).join(' '));
  const allTokens = Array.from(new Set(tokenize(allText)));

  const fieldTokens = {};
  for (const [fieldName, fieldValue] of Object.entries(fields)) {
    fieldTokens[fieldName] = Array.from(new Set(tokenize(fieldValue)));
  }

  return {
    product,
    fields,
    fieldTokens,
    allText,
    allTokens,
    rawMakes,
    makes,
    models,
    engines,
    years,
  };
}

function boundedLevenshtein(a, b, maxDistance) {
  const left = normalizeSearchText(a);
  const right = normalizeSearchText(b);

  if (!left || !right) return Number.MAX_SAFE_INTEGER;
  if (left === right) return 0;
  if (Math.abs(left.length - right.length) > maxDistance) return Number.MAX_SAFE_INTEGER;

  const prev = new Array(right.length + 1);
  const curr = new Array(right.length + 1);

  for (let j = 0; j <= right.length; j += 1) prev[j] = j;

  for (let i = 1; i <= left.length; i += 1) {
    curr[0] = i;
    let rowMin = curr[0];

    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + cost
      );
      if (curr[j] < rowMin) rowMin = curr[j];
    }

    if (rowMin > maxDistance) return Number.MAX_SAFE_INTEGER;

    for (let j = 0; j <= right.length; j += 1) prev[j] = curr[j];
  }

  return prev[right.length];
}

function scoreVariantAgainstField(variant, fieldText, fieldTokens, weight) {
  const term = normalizeSearchText(variant);
  if (!term || !fieldText) return 0;
  const meaningfulTokens = Array.isArray(fieldTokens)
    ? fieldTokens.filter((token) => typeof token === 'string' && token.length >= 3)
    : [];

  if (fieldText === term) return weight * 16;
  if (fieldText.includes(term)) return weight * (term.includes(' ') ? 13 : 10);

  if (term.length >= 3) {
    const prefixMatch = meaningfulTokens.some((token) => token.startsWith(term) || term.startsWith(token));
    if (prefixMatch) return weight * 8;
  }

  if (term.length >= 4) {
    // token.includes(term) : le mot du produit contient la saisie (préfixe/sous-chaîne
    // d'un mot plus long, ex. « meca » → « mecatronique ») → toujours pertinent.
    // term.includes(token) : la SAISIE contient un mot du produit. À restreindre aux
    // tokens ≥ 4 : sinon « dq250 » matche le « 250 » de « GLE 250 CDI » / « 250 ch »
    // (numéros de puissance/cylindrée) → résultats sans rapport dans l'autocomplétion.
    const containsMatch = meaningfulTokens.some((token) => token.includes(term) || (token.length >= 4 && term.includes(token)));
    if (containsMatch) return weight * 7;
  }

  if (term.length >= 4) {
    const maxDistance = term.length >= 7 ? 2 : 1;
    const fuzzyMatch = meaningfulTokens.some((token) => boundedLevenshtein(term, token, maxDistance) <= maxDistance);
    if (fuzzyMatch) return weight * 5;
  }

  return 0;
}

function scoreGroup(searchDoc, group) {
  let bestScore = 0;

  for (const variant of Array.isArray(group && group.variants) ? group.variants : []) {
    for (const [fieldName, weight] of FIELD_WEIGHTS) {
      const fieldScore = scoreVariantAgainstField(
        variant,
        searchDoc.fields[fieldName] || '',
        searchDoc.fieldTokens[fieldName] || [],
        weight
      );
      if (fieldScore > bestScore) bestScore = fieldScore;
    }
  }

  return bestScore;
}

function scoreSearchDocument(searchDoc, queryAnalysis) {
  if (!searchDoc || !queryAnalysis || !queryAnalysis.normalizedQuery) {
    return { score: 0, matchedGroups: 0, matchedPhraseGroups: 0, isMatch: false };
  }

  let score = 0;
  let matchedGroups = 0;
  let matchedPhraseGroups = 0;

  const wholeQueryVariants = Array.isArray(queryAnalysis.wholeQueryVariants) && queryAnalysis.wholeQueryVariants.length
    ? queryAnalysis.wholeQueryVariants
    : [queryAnalysis.normalizedQuery];

  if (wholeQueryVariants.some((variant) => variant && searchDoc.allText.includes(variant))) {
    score += 90;
  }

  for (const group of queryAnalysis.tokenGroups) {
    const groupScore = scoreGroup(searchDoc, group);
    if (groupScore > 0) {
      matchedGroups += 1;
      score += groupScore;
    }
  }

  for (const group of queryAnalysis.phraseGroups) {
    const groupScore = scoreGroup(searchDoc, group);
    if (groupScore > 0) {
      matchedGroups += 1;
      matchedPhraseGroups += 1;
      score += groupScore + 18;
    }
  }

  const isMatch = score >= 30 || matchedPhraseGroups > 0 || matchedGroups >= Math.min(2, Math.max(1, queryAnalysis.tokenGroups.length));

  return {
    score,
    matchedGroups,
    matchedPhraseGroups,
    isMatch,
  };
}

function rankProducts(products, query) {
  const queryAnalysis = buildQueryAnalysis(query);
  const list = Array.isArray(products) ? products : [];

  if (!queryAnalysis.normalizedQuery) {
    return list.map((product, index) => ({
      product,
      score: 0,
      matchedGroups: 0,
      matchedPhraseGroups: 0,
      index,
    }));
  }

  const ranked = [];

  list.forEach((product, index) => {
    const searchDoc = buildSearchDocument(product);
    const scored = scoreSearchDocument(searchDoc, queryAnalysis);
    if (!scored.isMatch) return;

    ranked.push({
      product,
      score: scored.score,
      matchedGroups: scored.matchedGroups,
      matchedPhraseGroups: scored.matchedPhraseGroups,
      searchDoc,
      index,
    });
  });

  ranked.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.matchedGroups !== left.matchedGroups) return right.matchedGroups - left.matchedGroups;
    if (right.matchedPhraseGroups !== left.matchedPhraseGroups) return right.matchedPhraseGroups - left.matchedPhraseGroups;
    return left.index - right.index;
  });

  return ranked;
}

function parseCategoryPath(value) {
  const parts = trimString(value)
    .split('>')
    .map((part) => part.trim())
    .filter(Boolean);

  return {
    mainCategory: parts[0] || '',
    subCategory: parts.length > 1 ? parts.slice(1).join(' > ') : '',
    label: parts.join(' > '),
  };
}

/* Le préfixe suit la langue de la page qui a lancé la suggestion : les valeurs
   de filtre (catégorie, marque) restent FRANÇAISES — elles sont stockées telles
   quelles sur les fiches — seule l'URL change de langue. */
function buildProductsUrl(params, langPrefix = '') {
  const searchParams = new URLSearchParams();

  if (params && params.q) searchParams.set('q', trimString(params.q));
  if (params && params.mainCategory) searchParams.set('mainCategory', trimString(params.mainCategory));
  if (params && params.subCategory) searchParams.set('subCategory', trimString(params.subCategory));
  if (params && params.vehicleMake) searchParams.set('vehicleMake', trimString(params.vehicleMake));

  const qs = searchParams.toString();
  return qs ? `${langPrefix}/produits?${qs}` : `${langPrefix}/produits`;
}

function formatMoney(cents) {
  return new Intl.NumberFormat('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.round(Number(cents) || 0) / 100);
}

function toProductSuggestItem(product, lang) {
  if (!product) return null;

  /* Menu déroulant du header : sur une page /de il affichait des noms français
     et renvoyait vers la fiche FR, dont le GET remettait la session — donc la
     commande et les e-mails — en français. Même calque que les cartes du
     catalogue allemand (productController, homeController). */
  const localise = lang === 'de' ? productI18n.localizeProduct(product, 'de') : product;

  const name = trimString(localise.name) || 'Produit';
  const sku = trimString(product.sku);
  const brand = trimString(product.brand);
  const imageUrl = trimString(product.imageUrl) || (Array.isArray(product.galleryUrls) && product.galleryUrls[0] ? trimString(product.galleryUrls[0]) : '');
  const priceCents = Number.isFinite(product.priceCents) ? product.priceCents : 0;

  return {
    type: 'product',
    id: product && product._id ? String(product._id) : name,
    name,
    sku,
    brand,
    imageUrl,
    publicPath: lang === 'de'
      ? `/de/produits/${encodeURIComponent(productI18n.localizedSlug(product, 'de'))}-${product._id}`
      : buildProductPublicPath(product),
    priceCents,
    price: `${formatMoney(priceCents)} €`,
  };
}

function buildCategorySuggestions(rankedProducts, query, limit, langPrefix = '') {
  const map = new Map();

  for (const entry of rankedProducts.slice(0, 24)) {
    const category = parseCategoryPath(entry && entry.product ? entry.product.category : '');
    if (!category.label) continue;

    const current = map.get(category.label) || {
      type: 'category',
      name: category.label,
      label: category.label,
      href: buildProductsUrl({
        q: query,
        mainCategory: category.mainCategory,
        subCategory: category.subCategory,
      }, langPrefix),
      count: 0,
      score: 0,
    };

    current.count += 1;
    current.score += Number(entry.score) || 0;
    map.set(category.label, current);
  }

  return Array.from(map.values())
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.count !== left.count) return right.count - left.count;
      return left.label.localeCompare(right.label, 'fr', { sensitivity: 'base' });
    })
    .slice(0, limit);
}

function buildBrandSuggestions(rankedProducts, query, limit, langPrefix = '') {
  const map = new Map();

  for (const entry of rankedProducts.slice(0, 24)) {
    const searchDoc = entry && entry.searchDoc ? entry.searchDoc : buildSearchDocument(entry.product);
    const rawMakes = Array.isArray(searchDoc.rawMakes) ? searchDoc.rawMakes : [];
    const brandValue = trimString(entry && entry.product ? entry.product.brand : '');
    const displayMakes = rawMakes.length
      ? rawMakes
      : (brandValue && normalizeSearchText(brandValue) !== normalizeSearchText(brand.NAME) ? [brandValue] : []);

    for (const displayName of displayMakes) {
      const make = normalizeSearchText(displayName);
      if (!displayName) continue;

      const current = map.get(make) || {
        type: 'brand',
        name: displayName,
        label: displayName,
        href: buildProductsUrl({ q: query, vehicleMake: displayName }, langPrefix),
        count: 0,
        score: 0,
      };

      current.count += 1;
      current.score += Number(entry.score) || 0;
      map.set(make, current);
    }
  }

  return Array.from(map.values())
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score;
      if (right.count !== left.count) return right.count - left.count;
      return left.label.localeCompare(right.label, 'fr', { sensitivity: 'base' });
    })
    .slice(0, limit);
}

function buildSuggestPayload(products, query, options = {}) {
  // options.ranked : liste déjà classée (ex. par MongoDB Atlas Search) sous la
  // forme [{ product }]. Si fournie, on NE re-classe PAS en JS (on garde l'ordre
  // de pertinence Atlas) — l'autocomplétion devient cohérente avec le catalogue.
  const ranked = Array.isArray(options.ranked) ? options.ranked : rankProducts(products, query);
  const productLimit = Number.isFinite(options.productLimit) ? options.productLimit : 4;
  const categoryLimit = Number.isFinite(options.categoryLimit) ? options.categoryLimit : 2;
  const brandLimit = Number.isFinite(options.brandLimit) ? options.brandLimit : 2;

  const lang = options.lang === 'de' ? 'de' : 'fr';
  const langPrefix = lang === 'de' ? '/de' : '';

  const productItems = ranked
    .slice(0, productLimit)
    .map((entry) => toProductSuggestItem(entry.product, lang))
    .filter(Boolean);

  const categoryItems = buildCategorySuggestions(ranked, query, categoryLimit, langPrefix);
  const brandItems = buildBrandSuggestions(ranked, query, brandLimit, langPrefix);

  const sections = [];
  if (productItems.length) sections.push({ type: 'products', title: t(lang, 'search.sectionProducts'), items: productItems });
  if (categoryItems.length) sections.push({ type: 'categories', title: t(lang, 'search.sectionCategories'), items: categoryItems });
  if (brandItems.length) sections.push({ type: 'brands', title: t(lang, 'search.sectionBrands'), items: brandItems });

  return {
    results: productItems,
    sections,
    total: ranked.length,
  };
}

function sortRankedProducts(rankedProducts, sortMode) {
  const list = Array.isArray(rankedProducts) ? rankedProducts.slice() : [];

  list.sort((left, right) => {
    if ((right.score || 0) !== (left.score || 0)) return (right.score || 0) - (left.score || 0);
    if ((right.matchedGroups || 0) !== (left.matchedGroups || 0)) return (right.matchedGroups || 0) - (left.matchedGroups || 0);

    const leftPrice = Number.isFinite(left && left.product && left.product.priceCents) ? left.product.priceCents : 0;
    const rightPrice = Number.isFinite(right && right.product && right.product.priceCents) ? right.product.priceCents : 0;
    const leftDate = left && left.product && left.product.createdAt ? new Date(left.product.createdAt).getTime() : 0;
    const rightDate = right && right.product && right.product.createdAt ? new Date(right.product.createdAt).getTime() : 0;

    if (sortMode === 'price_asc' && leftPrice !== rightPrice) return leftPrice - rightPrice;
    if (sortMode === 'price_desc' && leftPrice !== rightPrice) return rightPrice - leftPrice;
    if (sortMode === 'newest' && leftDate !== rightDate) return rightDate - leftDate;

    return (left.index || 0) - (right.index || 0);
  });

  return list;
}

module.exports = {
  buildQueryAnalysis,
  buildSuggestPayload,
  formatMoney,
  normalizeSearchText,
  rankProducts,
  sortRankedProducts,
};
