'use strict';

/**
 * État d'une pièce (neuf / reconditionné / occasion) lu dans un texte libre.
 *
 * UNE seule lecture pour la fiche produit (itemCondition du JSON-LD, tiré de la
 * caractéristique « État » ou du badge d'état) et pour les flux Google
 * Merchant : Merchant compare l'état du flux à celui de la page, et deux
 * lectures différentes du même badge finiraient par diverger.
 *
 * Ordre des tests : « reconditionné » l'emporte (« Reconditionné à neuf » est
 * un reconditionné), puis « neuf », puis « occasion ».
 */

function sansAccents(value) {
  return String(value == null ? '' : value)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '');
}

/** 'refurbished' | 'new' | 'used' | '' */
function etatDepuisTexte(value) {
  const input = typeof value === 'string' ? value.trim() : '';
  if (!input) return '';
  const normalized = sansAccents(input).toLowerCase();
  if (/(recondition|refurb|remanufact|echange standard)/.test(normalized)) return 'refurbished';
  if (/(^|\b)(neuf|new)(\b|$)/.test(normalized)) return 'new';
  if (/(^|\b)(occasion|used|utilise)(\b|$)/.test(normalized)) return 'used';
  return '';
}

module.exports = {
  etatDepuisTexte,
  sansAccents,
};
