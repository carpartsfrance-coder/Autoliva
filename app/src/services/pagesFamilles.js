'use strict';

/**
 * Pages catégorie des familles prioritaires — audit SEO du 11/11/2026,
 * problème 4.
 *
 * Les catégories « Ponts & différentiels », « Boîtes de transfert » et
 * « Mécatroniques & calculateurs » n'avaient ni texte d'introduction ni FAQ :
 * un titre générique (« Ponts & différentiels - Pièces auto »), un H1 sans
 * « reconditionné », puis la grille. Les concurrents qui sortent devant sur
 * « pont arrière reconditionné » ont tous un texte en tête de catégorie.
 *
 * Le contenu vit dans un fichier versionné (src/data/seo/pages-familles.json)
 * plutôt qu'en base : il est relu par un test (longueurs, allégations) avant
 * d'arriver en ligne. Français seulement : la couche allemande est hors de
 * Google (politique d'indexation, famille « de »).
 *
 * Les pages de devis /ponts-differentiels et /boites-de-transfert (landings
 * Google Ads) ne changent pas : la catégorie y renvoie pour un devis.
 */

const DONNEES = require('../data/seo/pages-familles.json').familles;

/** Contenu de la famille pour une catégorie, ou null. */
function pourCategorie(slug, lang = 'fr') {
  if (lang && lang !== 'fr') return null;
  const famille = DONNEES[String(slug || '').trim().toLowerCase()];
  return famille || null;
}

/** Bloc FAQPage pour le @graph de la page (page 1 seulement). */
function faqJsonLd(famille) {
  if (!famille || !Array.isArray(famille.faq) || !famille.faq.length) return null;
  return {
    '@type': 'FAQPage',
    mainEntity: famille.faq.map((q) => ({
      '@type': 'Question',
      name: q.question,
      acceptedAnswer: { '@type': 'Answer', text: q.reponse },
    })),
  };
}

function slugs() {
  return Object.keys(DONNEES);
}

/* ─── Articles de blog → page de la famille (problème 8) ─────────────────────
 *
 * Sur 40 articles relus le 11/11/2026, 37 citaient une fiche et UN SEUL la
 * page catégorie de sa famille. Le blog attire l'essentiel des visites
 * gratuites mais ne transmettait rien aux pages qui vendent. Chaque article
 * d'une famille prioritaire porte donc, en fin de texte, un lien vers la
 * catégorie, avec un texte d'ancre qui la décrit.
 *
 * La famille vient d'abord de la catégorie de l'article (vrais slugs en base,
 * voir services/landingArticles.js), sinon de son titre.
 */
const LIENS_FAMILLE = {
  ponts: { href: '/categorie/ponts-differentiels', texte: 'Voir tous nos ponts et différentiels reconditionnés' },
  transfert: { href: '/categorie/boites-de-transfert', texte: 'Voir toutes nos boîtes de transfert reconditionnées' },
  meca: { href: '/categorie/mecatroniques', texte: 'Voir toutes nos mécatroniques et calculateurs de boîte reconditionnés' },
};
const FAMILLE_PAR_CATEGORIE_BLOG = {
  'transmission-pont-differentiel': 'ponts',
  'transmission-boite-de-transfert': 'transfert',
  'transmission-boite-transfert': 'transfert',
  'boite-de-transfert': 'transfert',
  'transmission-mecatronique': 'meca',
};
/* Ordre important : une « boîte de transfert » n'est pas un « pont ». */
const FAMILLE_PAR_TITRE = [
  [/bo[iî]te\s+de\s+transfert|\bATC\s?\d{3}\b|\bPTU\b|transfer\s*case/i, 'transfert'],
  [/m[ée]ca?tronique|mechatronic|\bTCU\b|calculateur\s+de\s+bo[iî]te/i, 'meca'],
  [/\bponts?\b|diff[ée]rentiel|renvoi\s+d['’]angle/i, 'ponts'],
];

/** Lien de fin d'article vers la page de la famille, ou null. */
function lienFamillePourArticle({ categorie = '', titre = '' } = {}, lang = 'fr') {
  if (lang && lang !== 'fr') return null;
  let cle = FAMILLE_PAR_CATEGORIE_BLOG[String(categorie || '').trim().toLowerCase()] || '';
  if (!cle) {
    const trouve = FAMILLE_PAR_TITRE.find(([motif]) => motif.test(String(titre || '')));
    cle = trouve ? trouve[1] : '';
  }
  return cle ? { ...LIENS_FAMILLE[cle] } : null;
}

module.exports = { pourCategorie, faqJsonLd, slugs, lienFamillePourArticle };
