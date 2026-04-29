const { buildProductPublicPath } = require('./productPublic');
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

const FIELD_WEIGHTS = [
  ['name', 14],
  ['sku', 12],
  ['compatibleReferences', 11],
  ['compatibility', 10],
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

function getAliasVariants(term) {
  const normalized = normalizeSearchText(term);
  if (!normalized) return [];

  const singular = singularizeToken(normalized);
  if (isCodeLikeToken(normalized) || isCodeLikeToken(singular)) {
    return uniqueStrings([normalized, singular]);
  }

  const aliases = TOKEN_ALIASES.get(normalized) || TOKEN_ALIASES.get(singular) || [];

  return uniqueStrings([normalized, singular, ...aliases]);
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

  const allVariants = uniqueStrings([
    normalizedQuery,
    ...tokenGroups.flatMap((group) => group.variants),
    ...phraseGroups.flatMap((group) => group.variants),
  ]);

  return {
    normalizedQuery,
    tokenGroups,
    phraseGroups,
    allVariants,
  };
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
  const tags = toSearchableList(product && product.tags);
  const specs = toSpecList(product && product.specs);

  const fields = {
    name: normalizeSearchText(product && product.name),
    sku: normalizeSearchText(product && product.sku),
    brand: normalizeSearchText(product && product.brand),
    category: normalizeSearchText(product && product.category),
    shortDescription: normalizeSearchText(product && product.shortDescription),
    description: normalizeSearchText(product && product.description),
    compatibleReferences: normalizeSearchText(compatibleReferences.join(' ')),
    compatibility: normalizeSearchText(
      compatibility
        .map((item) => [item.make, item.model, item.years, item.engine].filter(Boolean).join(' '))
        .join(' ')
    ),
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
    const containsMatch = meaningfulTokens.some((token) => token.includes(term) || term.includes(token));
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

  if (searchDoc.allText.includes(queryAnalysis.normalizedQuery)) {
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

function buildProductsUrl(params) {
  const searchParams = new URLSearchParams();

  if (params && params.q) searchParams.set('q', trimString(params.q));
  if (params && params.mainCategory) searchParams.set('mainCategory', trimString(params.mainCategory));
  if (params && params.subCategory) searchParams.set('subCategory', trimString(params.subCategory));
  if (params && params.vehicleMake) searchParams.set('vehicleMake', trimString(params.vehicleMake));

  const qs = searchParams.toString();
  return qs ? `/produits?${qs}` : '/produits';
}

function formatMoney(cents) {
  return new Intl.NumberFormat('fr-FR', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  }).format(Math.round(Number(cents) || 0) / 100);
}

function toProductSuggestItem(product) {
  if (!product) return null;

  const name = trimString(product.name) || 'Produit';
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
    publicPath: buildProductPublicPath(product),
    priceCents,
    price: `${formatMoney(priceCents)} €`,
  };
}

function buildCategorySuggestions(rankedProducts, query, limit) {
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
      }),
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

function buildBrandSuggestions(rankedProducts, query, limit) {
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
        href: buildProductsUrl({ q: query, vehicleMake: displayName }),
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
  const ranked = rankProducts(products, query);
  const productLimit = Number.isFinite(options.productLimit) ? options.productLimit : 4;
  const categoryLimit = Number.isFinite(options.categoryLimit) ? options.categoryLimit : 2;
  const brandLimit = Number.isFinite(options.brandLimit) ? options.brandLimit : 2;

  const productItems = ranked
    .slice(0, productLimit)
    .map((entry) => toProductSuggestItem(entry.product))
    .filter(Boolean);

  const categoryItems = buildCategorySuggestions(ranked, query, categoryLimit);
  const brandItems = buildBrandSuggestions(ranked, query, brandLimit);

  const sections = [];
  if (productItems.length) sections.push({ type: 'products', title: 'Produits', items: productItems });
  if (categoryItems.length) sections.push({ type: 'categories', title: 'Catégories', items: categoryItems });
  if (brandItems.length) sections.push({ type: 'brands', title: 'Marques', items: brandItems });

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
