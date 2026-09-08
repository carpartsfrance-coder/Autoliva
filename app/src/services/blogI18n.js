'use strict';

/**
 * Localisation des CARTES d'articles de blog (accueil, fiche produit, page
 * catégorie). Les pages blog elles-mêmes ont leur contrôleur dédié
 * (blogDeController) ; ce module sert les blocs qui citent des articles
 * ailleurs sur le site.
 *
 * Trois choses se corrigent ici, qui étaient fausses sur toutes les pages
 * allemandes :
 *   1. les articles proposés n'étaient pas filtrés sur la traduction — un
 *      visiteur allemand cliquait et atterrissait sur un article français ;
 *   2. titre, extrait et catégorie restaient en français ;
 *   3. le lien pointait vers /blog/… au lieu de /de/blog/….
 */

const CATEGORIES_DE = require('../locales/blogCategoriesDe.json');

/** Restreint une requête BlogPost aux articles réellement traduits. */
function blogLangFilter(lang) {
  return lang === 'de' ? { 'localizations.de.translatedAt': { $ne: null } } : {};
}

/** Libellé de catégorie, par SLUG : les libellés en base ont des variantes
 *  d'encodage (« Différentiel », « Differentiel », « DiffÃ©rentiel »). */
function blogCategoryLabel(category, lang) {
  if (!category) return '';
  const slug = String(category.slug || '').trim().toLowerCase();
  if (lang === 'de' && CATEGORIES_DE[slug]) return CATEGORIES_DE[slug];
  return String(category.label || slug || '');
}

/** Champs rédactionnels d'un article dans la langue demandée. */
function blogFields(doc, lang) {
  const de = (doc && doc.localizations && doc.localizations.de) || {};
  const useDe = lang === 'de';
  return {
    title: (useDe ? de.title : '') || (doc && doc.title) || '',
    excerpt: (useDe ? de.excerpt : '') || (doc && doc.excerpt) || '',
    contentHtml: (useDe ? de.contentHtml : '') || (doc && doc.contentHtml) || '',
  };
}

/** URL publique de l'article dans la langue demandée. */
function blogUrl(slug, lang) {
  return `${lang === 'de' ? '/de' : ''}/blog/${encodeURIComponent(String(slug || ''))}`;
}

/** Projection Mongo à ajouter pour disposer des champs allemands. */
const DE_PROJECTION = 'localizations.de.title localizations.de.excerpt localizations.de.contentHtml localizations.de.translatedAt';

module.exports = { blogLangFilter, blogCategoryLabel, blogFields, blogUrl, DE_PROJECTION };
