'use strict';

/**
 * Où envoyer une adresse /product/<slug> qui ne correspond plus à aucune fiche.
 *
 * ── Pourquoi (plan de reprise SEO du 14/09/2026, action A4.8) ────────────────
 *
 * Un slug inconnu part en 301 vers la recherche /produits?q=<slug>, une page
 * noindex : pour Google un soft-404, pour le client une liste de résultats au
 * lieu de la pièce. Parmi ces adresses, 19 recevaient encore du trafic — 94
 * clics Google de juin à août, et 16 sont des pages d'arrivée Google Ads.
 *
 *   1. /product/wc-NNNN : l'adresse WooCommerce d'origine. Le SKU WC-NNNN
 *      désigne toujours la fiche : si elle est publiée, on y va.
 *   2. Les 19 slugs de data/seo/produits-disparus.json : la première fiche
 *      cible publiée, sinon une page de secours (catégorie, jamais une 404).
 *   3. Tout le reste : null — le contrôleur garde son repli d'avant. Les
 *      anciennes adresses WooCommerce arrivent encore par la redirection de
 *      carpartsfrance.fr pendant le changement d'adresse (jusqu'au 31/10) :
 *      on n'y touche pas avant qu'il soit terminé.
 *
 * Une fiche EN LIGNE n'est jamais concernée : ce service n'est consulté
 * qu'après l'échec de la recherche par slug.
 */

const Product = require('../models/Product');
const { buildProductPublicPath } = require('./productPublic');
const DONNEES = require('../data/seo/produits-disparus.json');

const REDIRECTIONS = (DONNEES && DONNEES.redirections) || {};
const SLUG_WC = /^wc-(\d{1,7})$/;
const PUBLIEE = { $ne: false };

/** Fiche PUBLIÉE dont le SKU est WC-NNNN, pour un slug « wc-NNNN ». */
async function ficheParSkuWc(slug) {
  const m = SLUG_WC.exec(String(slug || ''));
  if (!m) return null;
  return Product.findOne({ sku: `WC-${m[1]}`, isPublished: PUBLIEE }).select('_id slug name').lean();
}

/** Cible d'un des slugs disparus répertoriés, ou null s'il n'y figure pas. */
async function cibleRepertoriee(slug) {
  if (!Object.prototype.hasOwnProperty.call(REDIRECTIONS, slug)) return null;
  const entree = REDIRECTIONS[slug] || {};
  const fiches = Array.isArray(entree.fiches) ? entree.fiches : [];
  if (fiches.length) {
    const docs = await Product.find({ slug: { $in: fiches }, isPublished: PUBLIEE }).select('_id slug name').lean();
    for (const cible of fiches) {
      const doc = docs.find((d) => d.slug === cible);
      if (doc) return buildProductPublicPath(doc);
    }
  }
  return entree.secours || null;
}

/**
 * Chemin vers lequel rediriger (301) un slug de fiche inconnu, ou null pour
 * garder le repli habituel.
 */
async function redirectionPourSlugInconnu(slug) {
  const parSku = await ficheParSkuWc(slug);
  if (parSku) return buildProductPublicPath(parSku);
  return cibleRepertoriee(slug);
}

module.exports = {
  redirectionPourSlugInconnu,
  ficheParSkuWc,
  cibleRepertoriee,
  REDIRECTIONS,
};
