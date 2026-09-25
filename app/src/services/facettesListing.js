'use strict';

/**
 * Facettes des listings /categorie/:slug et /pieces-auto/… : une adresse
 * filtrée n'est pas une page à indexer.
 *
 * ── Pourquoi (audit du 25/09/2026) ───────────────────────────────────────────
 *
 * Sur les hubs /pieces-auto et les pages catégorie gardés, « subCategory »,
 * « sort », « page », « q », « stock » et les prix passaient déjà la page en
 * « noindex, follow ». Pas « mainCategory » (une AUTRE catégorie que celle de
 * la page), « condition », ni « vehicleMake » / « vehicleModel » /
 * « vehicleEngine » / « vehicleClear » : environ 4 200 adresses filtrées se
 * servaient en « index, follow », canonique vers la page nue mais avec une
 * autre liste de fiches (ou exactement la même, pour « vehicleClear »). Elles
 * suivent désormais la règle des autres filtres. La page nue ne change pas.
 *
 * La décision porte sur l'ADRESSE (req.query), celle que Google explore :
 * un paramètre inconnu du listing, ou invalide, compte quand même — l'adresse
 * reste une copie de la page nue.
 */

function texte(valeur) {
  if (Array.isArray(valeur)) return valeur.map(texte).filter(Boolean).join(',');
  return typeof valeur === 'string' ? valeur.trim() : '';
}

/* « Boîtes de vitesses », « boites de vitesses », « BOÎTES  DE VITESSES » :
   la même catégorie. */
function normaliser(valeur) {
  return texte(valeur).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/\s+/g, ' ');
}

/**
 * L'adresse filtre-t-elle au-delà de ce que le chemin de la page fixe déjà ?
 *
 * @param {object} query   req.query
 * @param {object} preset  ce que fixe le chemin : { categorie, marque, modele }
 *                         (catégorie de /categorie/:slug ou du 3e segment de
 *                         /pieces-auto, marque et modèle de /pieces-auto)
 * @returns {boolean}      true → « noindex, follow »
 */
function filtreAuDelaDuPreset(query, { categorie = '', marque = '', modele = '' } = {}) {
  const q = query || {};
  const autreQue = (valeur, fixe) => {
    const v = normaliser(valeur);
    return v !== '' && v !== normaliser(fixe);
  };
  return autreQue(q.mainCategory, categorie)
    || autreQue(q.category, categorie)
    || autreQue(q.vehicleMake, marque)
    || autreQue(q.vehicleModel, modele)
    || texte(q.vehicleEngine) !== ''
    || texte(q.condition) !== ''
    || texte(q.vehicleClear) !== '';
}

module.exports = { filtreAuDelaDuPreset };
