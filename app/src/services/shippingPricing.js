const mongoose = require('mongoose');

const Category = require('../models/Category');
const ShippingClass = require('../models/ShippingClass');
const { resolveZone, ZONE_IDS, normalizeCountryCode } = require('../config/shippingZones');

/** Prix (centimes) d'une classe d'expédition pour une zone donnée.
 *  zonePricesCents[zone] si défini, sinon prix métropole, sinon domicilePriceCents (legacy). */
function priceForZone(cls, zone) {
  if (!cls) return 0;
  const z = cls.zonePricesCents || {};
  const specific = z[zone];
  if (typeof specific === 'number' && Number.isFinite(specific)) return specific;
  const metro = z.metropole;
  if (typeof metro === 'number' && Number.isFinite(metro)) return metro;
  return Number.isFinite(cls.domicilePriceCents) ? cls.domicilePriceCents : 0;
}

/** Normalise l'argument zone/adresse en un id de zone valide (défaut métropole). */
function toZone(zoneOrAddress) {
  if (!zoneOrAddress) return 'metropole';
  if (typeof zoneOrAddress === 'string') return ZONE_IDS.includes(zoneOrAddress) ? zoneOrAddress : 'metropole';
  if (zoneOrAddress.zone && ZONE_IDS.includes(zoneOrAddress.zone)) return zoneOrAddress.zone;
  if (zoneOrAddress.country != null || zoneOrAddress.postalCode != null) {
    return resolveZone(zoneOrAddress.country, zoneOrAddress.postalCode);
  }
  return 'metropole';
}

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

/* Port appliqué quand aucune classe d'expédition n'est trouvée (ni classe par
   défaut, ni classe de la fiche ou de sa catégorie), ou base déconnectée. */
const PORT_DE_REPLI_CENTS = 1290;

/**
 * Résolution « catégorie de la fiche → classe d'expédition » (nom exact, puis
 * catégorie principale, puis sous-catégorie sans ambiguïté). Extraite telle
 * quelle de computeShippingPricesCents pour être partagée avec les flux Google
 * Merchant : le port annoncé dans le flux est celui que le panier encaissera,
 * calculé par le même code.
 */
function creerResolveurClasseCategorie(categoryDocs) {
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

  return getCategoryShippingClassId;
}

/** Classes candidates d'UNE fiche : défaut, fiche, catégorie (null si absente). */
function classesDuProduit(p, { classeCategorie, classById, defaultClass }) {
  const productClassId = p && p.shippingClassId ? String(p.shippingClassId) : '';
  const categoryClassId = classeCategorie(p);
  return {
    clsDefault: defaultClass || null,
    clsProduct: productClassId ? (classById.get(productClassId) || null) : null,
    clsCategory: categoryClassId ? (classById.get(categoryClassId) || null) : null,
  };
}

/** Port à domicile d'UNE fiche : le plus cher de la classe par défaut, de la
 *  classe de la fiche et de celle de sa catégorie. */
function portDuProduit(p, zone, tarifs) {
  const { clsDefault, clsProduct, clsCategory } = classesDuProduit(p, tarifs);
  return Math.max(priceForZone(clsDefault, zone), priceForZone(clsProduct, zone), priceForZone(clsCategory, zone));
}

async function computeShippingPricesCents(dbConnected, products, zoneOrAddress) {
  const fallback = { domicile: PORT_DE_REPLI_CENTS };
  const zone = toZone(zoneOrAddress);

  if (!dbConnected) return fallback;

  const list = Array.isArray(products) ? products : [];
  if (!list.length) return { domicile: 0 };

  const categoryDocs = await Category.find({})
    .select('_id name shippingClassId')
    .lean();

  const getCategoryShippingClassId = creerResolveurClasseCategorie(categoryDocs);

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
    .select('_id domicilePriceCents zonePricesCents')
    .lean();

  const classDocs = classIds.length
    ? await ShippingClass.find({ _id: { $in: classIds } })
        .select('_id domicilePriceCents zonePricesCents')
        .lean()
    : [];

  const classById = new Map(classDocs.map((c) => [String(c._id), c]));

  if (!defaultClass && !classDocs.length) return fallback;

  const tarifs = { classeCategorie: getCategoryShippingClassId, classById, defaultClass };
  let domicile = 0;

  for (const p of list) {
    domicile = Math.max(domicile, portDuProduit(p, zone, tarifs));
  }

  return { domicile };
}

/**
 * Tarifs d'expédition chargés UNE fois, pour chiffrer des milliers de fiches
 * (flux Google Merchant). Trois requêtes au lieu de trois par fiche.
 *
 * portDomicileCents(fiche, zone) rend EXACTEMENT ce que le panier facturerait
 * pour cette fiche seule (getShippingMethods → méthode « domicile ») : mêmes
 * résolutions (fiche, catégorie, défaut), même maximum, même repli à 12,90 €
 * quand aucune classe n'existe, 0 pour le service de clonage seul. Un test
 * d'intégration compare les deux fiche par fiche.
 *
 * classeRetenue(fiche, zone) : la classe qui porte ce prix (sert à classer la
 * pièce « lourde » ou non pour les délais du flux).
 */
async function chargerTarifsPort() {
  const [categoryDocs, defaultClass, classes] = await Promise.all([
    Category.find({}).select('_id name shippingClassId').lean(),
    ShippingClass.findOne({ isDefault: true }).select('_id name slug domicilePriceCents zonePricesCents').lean(),
    ShippingClass.find({}).select('_id name slug domicilePriceCents zonePricesCents').lean(),
  ]);
  const tarifs = {
    classeCategorie: creerResolveurClasseCategorie(categoryDocs),
    classById: new Map(classes.map((c) => [String(c._id), c])),
    defaultClass,
  };
  /* Le panier replie à 12,90 € quand ni la classe par défaut ni aucune des
     classes référencées (fiche, catégorie) n'existe en base. */
  const sansAucuneClasse = (p) => {
    if (tarifs.defaultClass) return false;
    const { clsProduct, clsCategory } = classesDuProduit(p, tarifs);
    return !clsProduct && !clsCategory;
  };
  return {
    portDomicileCents(p, zoneOrAddress) {
      if (p && p.serviceType === 'standalone_cloning') return 0;
      if (sansAucuneClasse(p)) return PORT_DE_REPLI_CENTS;
      return portDuProduit(p, toZone(zoneOrAddress), tarifs);
    },
    classeRetenue(p, zoneOrAddress) {
      const zone = toZone(zoneOrAddress);
      const { clsDefault, clsProduct, clsCategory } = classesDuProduit(p, tarifs);
      let retenue = null;
      for (const cls of [clsProduct, clsCategory, clsDefault]) {
        if (cls && (!retenue || priceForZone(cls, zone) > priceForZone(retenue, zone))) retenue = cls;
      }
      return retenue;
    },
  };
}

/**
 * Date de la dernière modification d'un tarif : classe d'expédition, ou
 * catégorie (c'est elle qui porte la classe de la plupart des fiches). Les flux
 * Merchant reconstruisent leur cache quand elle est postérieure : Merchant
 * compare le port du flux à celui du panier.
 */
async function dernierChangementTarifs() {
  const [cls, cat] = await Promise.all([
    ShippingClass.findOne({}).sort({ updatedAt: -1 }).select('updatedAt').lean(),
    Category.findOne({}).sort({ updatedAt: -1 }).select('updatedAt').lean(),
  ]);
  const t = (d) => (d && d.updatedAt ? new Date(d.updatedAt).getTime() : 0);
  return Math.max(t(cls), t(cat));
}

/**
 * Clé de traduction du délai de livraison à domicile pour une destination.
 *
 * Le délai annoncé était la même phrase pour toutes les zones : « 2-3 jours
 * ouvrés » promis à Berlin comme à Lyon, pour une palette partie de Nice.
 * Hors métropole on annonce 4-6 jours ouvrés — à confirmer avec le
 * transporteur, mais une estimation prudente vaut mieux qu'une promesse
 * fausse. Allemagne : 2 à 4 jours ouvrés APRÈS EXPÉDITION (confirmé par
 * Killian le 17/09/2026) : le tunnel ne connaît pas le délai d'expédition de
 * chaque pièce (la fiche ne promet un délai total qu'en expédition 24/48 h),
 * il ne peut donc promettre que le transport. Partagée avec le bandeau
 * « expédiée » de la page commande, qui suivait la LANGUE et non le pays.
 */
function cleDelaiLivraison(zoneOrAddress) {
  const zoneLivraison = toZone(zoneOrAddress);
  if (zoneLivraison === 'metropole') return 'shipping.homeDesc';
  const pays = zoneOrAddress && typeof zoneOrAddress === 'object' ? normalizeCountryCode(zoneOrAddress.country) : '';
  return pays === 'DE' ? 'shipping.homeDescGermany' : 'shipping.homeDescEurope';
}

/* Les libellés de livraison s'affichent dans le panier ET dans l'e-mail de
   confirmation : « Livraison à domicile » restait français sur toute la
   chaîne allemande. L'`id` ne bouge pas — c'est lui qui porte le tarif. */
async function getShippingMethods(dbConnected, products, zoneOrAddress, lang) {
  const { t } = require('./i18n');
  const cleDelai = cleDelaiLivraison(zoneOrAddress);
  const list = Array.isArray(products) ? products : [];
  const onlyStandaloneCloning = list.length > 0 && list.every((p) => p && p.serviceType === 'standalone_cloning');

  if (onlyStandaloneCloning) {
    return [
      {
        id: 'domicile',
        title: t(lang, 'shipping.cloningTitle'),
        description: t(lang, 'shipping.cloningDesc'),
        priceCents: 0,
      },
    ];
  }

  const prices = await computeShippingPricesCents(dbConnected, products, zoneOrAddress);

  return [
    {
      id: 'domicile',
      title: t(lang, 'shipping.homeTitle'),
      description: t(lang, cleDelai),
      priceCents: prices.domicile,
      zone: toZone(zoneOrAddress),
    },
    {
      id: 'retrait',
      title: t(lang, 'shipping.pickupTitle'),
      description: t(lang, 'shipping.pickupDesc'),
      priceCents: 0,
    },
  ];
}

module.exports = {
  PORT_DE_REPLI_CENTS,
  chargerTarifsPort,
  cleDelaiLivraison,
  computeShippingPricesCents,
  dernierChangementTarifs,
  getShippingMethods,
  priceForZone,
  toZone,
};
