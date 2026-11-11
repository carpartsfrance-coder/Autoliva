'use strict';

/**
 * Anciennes adresses de catégories → la catégorie qui les remplace.
 *
 * ── Pourquoi (audit SEO du 11/11/2026, problème 2) ───────────────────────────
 *
 * Quand les catégories ont été réorganisées (« Transmission > Pont /
 * Différentiel » est devenue « Ponts & différentiels »), les anciennes
 * adresses sont passées en 404 : /categorie/transmission-pont-differentiel,
 * -boite-de-transfert, -mecatronique, -boite-de-vitesses… La Search Console en
 * comptait 15 le 11/11/2026. Google perdait l'historique de ces pages, et les
 * nouvelles n'avaient encore jamais été explorées.
 *
 * Trois façons de retrouver la bonne catégorie, dans l'ordre :
 *   1. le slug suivi de caractères parasites (« transmission-mecatronique
 *      » + caractères privés + « 31 », vu dans la Search Console) : on
 *      retire la queue et on cherche la catégorie active ;
 *   2. un ancien slug gardé lors d'un renommage dans l'admin (slugAliases) ;
 *   3. la table src/data/seo/redirections-categories.json.
 * Une cible inconnue ou désactivée n'est jamais servie : la page reste en 404
 * plutôt que de renvoyer vers une autre 404.
 */

const TABLE = require('../data/seo/redirections-categories.json').redirections;

/** Slug débarrassé d'une queue parasite (tout ce qui suit le premier caractère hors [a-z0-9-]). */
function nettoyerSlug(slug) {
  return String(slug || '')
    .toLowerCase()
    .replace(/[^a-z0-9-].*$/u, '')
    .replace(/-+$/g, '')
    .trim();
}

/** Cible de la table pour un ancien slug ('' = sommaire), ou null. */
function cibleTable(slug) {
  const s = nettoyerSlug(slug);
  if (!s || !Object.prototype.hasOwnProperty.call(TABLE, s)) return null;
  return String(TABLE[s] || '');
}

async function categorieActive(Category, slug) {
  if (!slug) return null;
  return Category.findOne({ slug, isActive: { $ne: false } }).select('_id slug').lean();
}

/**
 * Slug de la catégorie qui remplace `slug`, '' pour le sommaire, ou null si
 * rien ne correspond. À n'appeler que lorsque aucune catégorie active ne
 * porte `slug` tel quel.
 */
async function resoudre(slug, { Category = require('../models/Category') } = {}) {
  const brut = String(slug || '').trim().toLowerCase();
  if (!brut) return null;
  const propre = nettoyerSlug(brut);
  if (!propre) return null;

  /* 1. Queue parasite sur un slug valide. */
  if (propre !== brut) {
    const trouvee = await categorieActive(Category, propre);
    if (trouvee) return trouvee.slug;
  }

  /* 2. Ancien slug d'un renommage fait dans l'admin. */
  const alias = await Category.findOne({ slugAliases: propre, isActive: { $ne: false } }).select('_id slug').lean();
  if (alias && alias.slug && alias.slug !== propre) return alias.slug;

  /* 3. Table des anciennes arborescences. */
  const cible = cibleTable(propre);
  if (cible === null) return null;
  if (cible === '') return '';
  const existe = await categorieActive(Category, cible);
  return existe ? existe.slug : null;
}

module.exports = {
  resoudre,
  nettoyerSlug,
  cibleTable,
};
