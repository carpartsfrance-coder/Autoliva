const mongoose = require('mongoose');
const { getSiteUrlFromReq } = require('./siteUrl');

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/* Catégories du menu « Catalogue » du header : uniquement les catégories PRINCIPALES
   (≥ NAV_MIN_PRODUCTS produits publiés), triées par nombre de produits décroissant.
   Cache mémoire court (évite une requête par requête HTTP). Nom localisé DE si dispo. */
let _navCache = { at: 0, data: [] };
const NAV_TTL_MS = 5 * 60 * 1000;
const NAV_MIN_PRODUCTS = 3; // on n'affiche pas une catégorie avec 2 produits ou moins

function _escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/* Icône du menu (Material Symbol) selon le nom de la catégorie, quand aucune
   icône n'est définie en admin.
 *
 * Ces noms DOIVENT être embarqués dans la police d'icônes : elle est réduite
 * aux seules icônes utilisées (scripts/polices-locales.js). Une icône absente
 * du sous-ensemble ne s'affiche pas « vide » — le navigateur écrit son NOM en
 * toutes lettres, en 24 px, dans le menu : « cyclone », « linear_scale »,
 * « view_in_ar » se lisaient ainsi sur l'accueil (signalé le 01/10/2026).
 * D'où cette table exportée, que le script de génération lit directement :
 * les noms ne vivent plus seulement dans du code qu'il ne regardait pas. */
const ICONE_PAR_DEFAUT = 'category';
const ICONES_CATEGORIES = [
  [/transfert/, 'sync_alt'],
  [/bo[iî]te|vitesse|transmission/, 'settings'],
  [/moteur|bloc/, 'settings_suggest'],
  [/pont|diff[ée]rentiel|cardan|transmission/, 'linear_scale'],
  [/turbo|compresseur/, 'cyclone'],
  [/culasse/, 'view_in_ar'],
  [/m[ée]catronique|calculateur|injection|pompe|valve/, 'memory'],
  [/d[ée]marreur|alternateur|batterie|charge/, 'battery_charging_full'],
  [/[ée]lectr|faisceau|capteur/, 'bolt'],
  [/[ée]clairage|phare|feu|optique|ampoule/, 'lightbulb'],
  [/frein|disque|plaquette|[ée]trier/, 'album'],
  [/embrayage|volant moteur/, 'trip_origin'],
  [/direction|suspension|amortisseur|cr[ée]maill/, 'tune'],
  [/refroidiss|radiateur|climatis/, 'ac_unit'],
  [/[ée]chappement|catalyseur|fap/, 'air'],
  [/carrosserie|t[ôo]le|pare/, 'directions_car'],
];

/** Tous les noms d'icônes que ce service peut produire (police + tests). */
function icones() {
  return [...new Set(ICONES_CATEGORIES.map(([, nom]) => nom).concat(ICONE_PAR_DEFAUT))];
}

function _defaultIcon(name) {
  const n = (name || '').toLowerCase();
  const trouve = ICONES_CATEGORIES.find(([rx]) => rx.test(n));
  return trouve ? trouve[1] : ICONE_PAR_DEFAUT;
}

async function getNavCategories() {
  if (mongoose.connection.readyState !== 1) return _navCache.data || [];
  const now = Date.now();
  if (_navCache.data.length && (now - _navCache.at) < NAV_TTL_MS) return _navCache.data;
  try {
    const Category = require('../models/Category');
    const Product = require('../models/Product');

    // Triées par « Ordre » (sortOrder) éditable en admin, puis nom.
    const docs = await Category.find({ isActive: true })
      .sort({ sortOrder: 1, name: 1 })
      .select('name slug sortOrder showInMenu menuIcon localizations.de.name localizations.de.slug')
      .lean();

    const toItem = (c) => ({
      name: c.name,
      slug: c.slug,
      nameDe: (c.localizations && c.localizations.de && c.localizations.de.name) ? c.localizations.de.name : c.name,
      /* Le menu allemand affichait le nom traduit mais pointait vers le slug
         FRANÇAIS : les 13 liens du menu passaient par une redirection 301, sur
         chacune des 13 348 pages allemandes. Un lien interne doit viser
         l'adresse finale, pas un renvoi. */
      slugDe: (c.localizations && c.localizations.de && c.localizations.de.slug) ? c.localizations.de.slug : c.slug,
      icon: (c.menuIcon && String(c.menuIcon).trim()) ? String(c.menuIcon).trim() : _defaultIcon(c.name),
    });

    // Mode MANUEL : si au moins une catégorie est cochée « afficher au menu », on
    // n'affiche QUE celles-là, dans l'ordre du champ « Ordre ».
    const manual = docs.filter((c) => c && c.slug && c.name && c.showInMenu === true);
    let data;
    if (manual.length) {
      data = manual.map(toItem);
    } else {
      // Repli AUTO : catégories avec ≥ NAV_MIN_PRODUCTS produits, triées par volume.
      const counts = await Product.aggregate([
        { $match: { isPublished: true, category: { $type: 'string', $ne: '' } } },
        { $group: { _id: '$category', count: { $sum: 1 } } },
      ]);
      const countFor = (name) => {
        const rx = new RegExp('^' + _escapeRegExp(name) + '(\\s*>|$)', 'i');
        let total = 0;
        for (const cc of counts) { if (cc && typeof cc._id === 'string' && rx.test(cc._id)) total += cc.count; }
        return total;
      };
      data = docs
        .filter((c) => c && c.slug && c.name)
        .map((c) => Object.assign(toItem(c), { count: countFor(c.name) }))
        .filter((c) => c.count >= NAV_MIN_PRODUCTS)
        .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
    }

    _navCache = { at: now, data };
    return data;
  } catch (e) {
    return _navCache.data || [];
  }
}

/**
 * Nombre de fiches PUBLIÉES par catégorie, avec la règle exacte de la page
 * catégorie (productListingService) : isPublished vrai ou absent, et catégorie
 * de la fiche égale au nom OU « Nom > … », sans tenir compte de la casse. C'est
 * sur ce nombre que la page se sert elle-même en noindex quand il vaut 0 : le
 * sitemap doit dire la même chose que la page.
 *
 * Une seule agrégation (un groupe par libellé de catégorie des fiches), puis
 * le rapprochement en mémoire — une soixantaine de catégories.
 *
 * @param {string[]} noms — Category.name
 * @returns {Promise<Map<string, number>>} nom → nombre de fiches
 */
async function compterFichesPubliees(noms) {
  const Product = require('../models/Product');
  const groupes = await Product.aggregate([
    { $match: { isPublished: { $in: [true, null] }, category: { $type: 'string', $ne: '' } } },
    { $group: { _id: '$category', n: { $sum: 1 } } },
  ]);
  const comptes = new Map();
  for (const nom of noms || []) {
    const rx = new RegExp('^' + _escapeRegExp(String(nom || '').trim()) + '(\\s*>|$)', 'i');
    let total = 0;
    for (const g of groupes) if (g && typeof g._id === 'string' && rx.test(g._id)) total += g.n;
    comptes.set(nom, total);
  }
  return comptes;
}

function getPublicBaseUrlFromReq(req) {
  return getSiteUrlFromReq(req);
}

function buildCategoryPublicPath(category) {
  const slug = getTrimmedString(category && category.slug ? category.slug : '');
  if (!slug) return '/categorie';
  return `/categorie/${encodeURIComponent(slug)}`;
}

function buildCategoryPublicUrl(category, { req } = {}) {
  const base = getPublicBaseUrlFromReq(req);
  const path = buildCategoryPublicPath(category);
  if (!base) return path;
  return `${base}${path}`;
}

module.exports = {
  ICONE_PAR_DEFAUT,
  icones,
  buildCategoryPublicPath,
  buildCategoryPublicUrl,
  getPublicBaseUrlFromReq,
  getNavCategories,
  compterFichesPubliees,
};
