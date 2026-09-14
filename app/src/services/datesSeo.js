'use strict';

/**
 * Dates annoncées aux moteurs : <lastmod> des sitemaps, dateModified du JSON-LD,
 * article:modified_time. Aucune ne vient plus de `updatedAt`.
 *
 * ── Pourquoi (plan de reprise SEO du 14/09/2026, action A4.5) ────────────────
 *
 * `updatedAt` bouge à chaque synchro de stock ou de prix, à chaque script, et
 * même quand on écrit une traduction. Une seule écriture en masse, le 08/09
 * vers 18 h 16, a daté du 08/09 13 345 fiches et 1 173 articles dont le texte
 * français n'avait pas changé d'un mot : sitemaps, dateModified et
 * article:modified_time annonçaient tous une fraîcheur qui n'existait pas.
 * Google documente qu'il IGNORE un lastmod qu'il juge peu fiable ; mentir en
 * masse est le moyen le plus sûr d'en arriver là, pour tout le site.
 *
 * Règle : une date n'est annoncée que si le contenu principal a VRAIMENT
 * changé ce jour-là.
 *   - Fiches françaises : la date de mise en ligne de l'action A3 pour les
 *     6 771 fiches qui y ont regagné leur description ; RIEN pour les autres.
 *   - Articles français : leur date de publication (plus tard, la date de
 *     relecture humaine, action A12).
 *   - Pages allemandes (fiches, articles, catégories) : la date de leur
 *     traduction, qui est la date de naissance de leur texte allemand.
 *   - Catégories françaises, pages légales, pages véhicule, références : rien.
 *   - Jamais une date future.
 */

const claimFilter = require('./claimFilter');
const FICHES_A3 = require('../data/seo/fiches-description-a3.json');

const IDS_FICHES_A3 = new Set((FICHES_A3.ids || []).map(String));

function enDate(valeur) {
  if (!valeur) return null;
  const d = valeur instanceof Date ? valeur : new Date(valeur);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** ISO 8601 complète, ou '' si absente, invalide ou dans le futur. */
function isoPasse(valeur, { maintenant = Date.now() } = {}) {
  const d = enDate(valeur);
  if (!d || d.getTime() > maintenant) return '';
  return d.toISOString();
}

/**
 * Jour de mise en ligne de l'action A3 (AAAA-MM-JJ), ou '' tant qu'il n'est pas
 * arrivé : on n'annonce pas un changement qui n'a pas encore eu lieu.
 */
function dateDescriptionsFiches({ maintenant = Date.now() } = {}) {
  const jour = String(FICHES_A3.dateMiseEnLigne || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(jour)) return '';
  const d = new Date(`${jour}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.getTime() > maintenant) return '';
  return jour;
}

/**
 * <lastmod> d'une fiche FRANÇAISE : la date A3 si sa page sert réellement sa
 * description depuis A3, sinon ''. La règle de claimFilter s'applique en plus
 * de la liste : une fiche DM- ou Alibaba, ou l'interrupteur
 * SHOW_PRODUCT_DESCRIPTION coupé, et la description n'est pas servie — donc
 * rien n'a changé à annoncer.
 */
function lastmodFicheFr(produit, options = {}) {
  if (!produit || !IDS_FICHES_A3.has(String(produit._id))) return '';
  if (claimFilter.motifDescriptionMasquee(produit, { lang: 'fr' })) return '';
  return dateDescriptionsFiches(options);
}

/** Date de publication d'un article français (ou sa création, à défaut). */
function datePublicationArticle(post) {
  return enDate(post && (post.publishedAt || post.createdAt));
}

/**
 * Dernière modification RÉELLE d'un article français : sa publication. La date
 * de relecture humaine (action A12) viendra s'y substituer quand elle existera.
 */
function dateModificationArticle(post) {
  return datePublicationArticle(post);
}

/** Dernière modification d'un article ALLEMAND : sa traduction. */
function dateModificationArticleDe(post) {
  const de = post && post.localizations && post.localizations.de;
  return enDate(de && de.translatedAt) || datePublicationArticle(post);
}

/** Dernière modification d'une page allemande (fiche, catégorie) : sa traduction. */
function dateTraductionDe(doc) {
  const de = doc && doc.localizations && doc.localizations.de;
  return enDate(de && de.translatedAt);
}

module.exports = {
  isoPasse,
  dateDescriptionsFiches,
  lastmodFicheFr,
  datePublicationArticle,
  dateModificationArticle,
  dateModificationArticleDe,
  dateTraductionDe,
  IDS_FICHES_A3,
};
