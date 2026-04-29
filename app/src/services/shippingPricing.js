const mongoose = require('mongoose');

const Category = require('../models/Category');
const ShippingClass = require('../models/ShippingClass');

function normalizeCategoryKey(value) {
  if (typeof value !== 'string') return '';
  const parts = value
    .split('>')
    .map((p) => String(p || '').trim())
    .filter(Boolean);
  if (!parts.length) return '';

  const canonical = parts.join(' > ');
  return canonical
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase();
}

async function computeShippingPricesCents(dbConnected, products) {
  const fallback = { domicile: 1290 };

  if (!dbConnected) return fallback;

  const list = Array.isArray(products) ? products : [];
  if (!list.length) return { domicile: 0 };

  const categoryDocs = await Category.find({})
    .select('_id name shippingClassId')
    .lean();

  const categoryInfoByKey = new Map();
  const subKeyToFullKeys = new Map();

  for (const c of categoryDocs) {
    const rawName = c && typeof c.name === 'string' ? c.name.trim() : '';
    if (!rawName) continue;
    const classId = c && c.shippingClassId ? String(c.shippingClassId) : '';

    const key = normalizeCategoryKey(rawName);
    if (!key) continue;

    const main = rawName.split('>')[0].trim();
    const mainKey = normalizeCategoryKey(main);

    categoryInfoByKey.set(key, {
      classId,
      mainKey,
    });

    const parts = rawName.split('>').map((p) => String(p || '').trim()).filter(Boolean);
    const sub = parts.length ? parts[parts.length - 1] : '';
    const subKey = normalizeCategoryKey(sub);
    if (subKey) {
      if (!subKeyToFullKeys.has(subKey)) subKeyToFullKeys.set(subKey, new Set());
      subKeyToFullKeys.get(subKey).add(key);
    }
  }

  function getClassFromKey(key) {
    const info = key ? categoryInfoByKey.get(key) : null;
    return info && info.classId ? info.classId : '';
  }

  function getClassFromMainKey(key) {
    const info = key ? categoryInfoByKey.get(key) : null;
    if (!info || !info.mainKey) return '';
    return getClassFromKey(info.mainKey);
  }

  function getCategoryShippingClassId(product) {
    const raw = product && typeof product.category === 'string' ? product.category.trim() : '';
    if (!raw) return '';

    const fullKey = normalizeCategoryKey(raw);
    const exact = fullKey ? getClassFromKey(fullKey) : '';
    if (exact) return exact;

    const inheritedFromMain = fullKey ? getClassFromMainKey(fullKey) : '';
    if (inheritedFromMain) return inheritedFromMain;

    const parts = raw.split('>').map((p) => String(p || '').trim()).filter(Boolean);
    if (parts.length >= 2) return '';

    const subKey = fullKey;
    const fullKeys = subKey ? subKeyToFullKeys.get(subKey) : null;
    if (fullKeys && fullKeys.size === 1) {
      const onlyKey = Array.from(fullKeys)[0];
      const clsExact = getClassFromKey(onlyKey);
      if (clsExact) return clsExact;
      const clsInherited = getClassFromMainKey(onlyKey);
      if (clsInherited) return clsInherited;
    }

    if (fullKeys && fullKeys.size > 1) {
      const candidates = new Set();
      for (const key of fullKeys) {
        const clsExact = getClassFromKey(key);
        if (clsExact) {
          candidates.add(clsExact);
          continue;
        }
        const clsInherited = getClassFromMainKey(key);
        if (clsInherited) candidates.add(clsInherited);
      }

      if (candidates.size === 1) {
        return Array.from(candidates)[0];
      }
    }

    return '';
  }

  const classIds = Array.from(
    new Set(
      list
        .map((p) => {
          const productClassId = p && p.shippingClassId ? String(p.shippingClassId) : '';
          const categoryClassId = getCategoryShippingClassId(p);
          return [productClassId, categoryClassId].filter(Boolean);
        })
        .flat()
        .filter(Boolean)
        .filter((id) => mongoose.Types.ObjectId.isValid(id))
    )
  );

  const defaultClass = await ShippingClass.findOne({ isDefault: true })
    .select('_id domicilePriceCents')
    .lean();

  const classDocs = classIds.length
    ? await ShippingClass.find({ _id: { $in: classIds } })
        .select('_id domicilePriceCents')
        .lean()
    : [];

  const classById = new Map(classDocs.map((c) => [String(c._id), c]));

  if (!defaultClass && !classDocs.length) return fallback;

  let domicile = 0;

  for (const p of list) {
    const productClassId = p && p.shippingClassId ? String(p.shippingClassId) : '';
    const categoryClassId = getCategoryShippingClassId(p);

    const clsDefault = defaultClass || null;
    const clsProduct = productClassId ? (classById.get(productClassId) || null) : null;
    const clsCategory = categoryClassId ? (classById.get(categoryClassId) || null) : null;

    const dDefault = clsDefault && Number.isFinite(clsDefault.domicilePriceCents) ? clsDefault.domicilePriceCents : 0;
    const dProduct = clsProduct && Number.isFinite(clsProduct.domicilePriceCents) ? clsProduct.domicilePriceCents : 0;
    const dCategory = clsCategory && Number.isFinite(clsCategory.domicilePriceCents) ? clsCategory.domicilePriceCents : 0;

    const d = Math.max(dDefault, dProduct, dCategory);
    domicile = Math.max(domicile, d);
  }

  return { domicile };
}

async function getShippingMethods(dbConnected, products) {
  const prices = await computeShippingPricesCents(dbConnected, products);

  return [
    {
      id: 'domicile',
      title: 'Livraison à domicile',
      description: 'Livré chez vous en 2-3 jours ouvrés',
      priceCents: prices.domicile,
    },
    {
      id: 'retrait',
      title: 'Retrait magasin',
      description: 'Retrait rapide (si disponible)',
      priceCents: 0,
    },
  ];
}

module.exports = {
  computeShippingPricesCents,
  getShippingMethods,
};
