'use strict';

/**
 * Les scripts de réparation d'images écrivent en production, lancés à la main,
 * sans sauvegarde préalable. Avant d'écrire, ils doivent répondre à UNE
 * question : « peut-on faire confiance à ce que la base vient de répondre ? »
 *
 * ── Pourquoi une fonction à part (04/10/2026) ────────────────────────────────
 *
 * Le premier garde-fou comparait le nombre d'images absentes au nombre d'images
 * du seul corpus réparé. Sur les fiches produits ça marchait (10 absents sur
 * 7 787, soit 0,13 %). Sur le blog, il a refusé d'écrire à 8,2 % — alors que
 * les 58 fichiers manquants étaient une vraie casse, pas une panne : le blog ne
 * référence que 707 illustrations, très partagées, donc le dénominateur est
 * petit et le pourcentage trompeur.
 *
 * La bonne mesure porte sur TOUT ce que le site référence. Une base incomplète,
 * une mauvaise base ou une connexion qui échoue font plonger les deux corpus
 * ensemble ; une suppression de couvertures ne touche que le blog. Ce jour-là :
 * 0 % sur 7 777 médias de fiches, 8,2 % sur le blog, 0,75 % sur l'ensemble.
 */

/** Au-delà, c'est le stockage qu'on soupçonne, pas les documents. */
const SEUIL_SITE = 0.01;
/** Au-delà, même si le reste va bien, un corpus à moitié effacé se regarde à la main. */
const SEUIL_CORPUS = 0.5;

/**
 * @param {object} mesures
 * @param {number} mesures.mediasStockes       documents dans media.files
 * @param {number} mesures.totalSite           médias distincts référencés par tout le site
 * @param {number} mesures.absentsSite         parmi eux, ceux dont le fichier manque
 * @param {number} mesures.totalCorpus         médias référencés par le corpus réparé
 * @param {number} mesures.absentsCorpus       parmi eux, ceux dont le fichier manque
 * @returns {{ ecrire: boolean, raison: string }}
 */
function verdictEcriture({
  mediasStockes = 0,
  totalSite = 0,
  absentsSite = 0,
  totalCorpus = 0,
  absentsCorpus = 0,
} = {}) {
  if (mediasStockes === 0) {
    return { ecrire: false, raison: 'AUCUN média dans le stockage : base incomplète, ou mauvaise base.' };
  }
  const partSite = totalSite ? absentsSite / totalSite : 0;
  if (partSite > SEUIL_SITE) {
    return {
      ecrire: false,
      raison: `${(100 * partSite).toFixed(1)} % des médias de TOUT le site sont absents `
        + `(seuil : ${100 * SEUIL_SITE} %). Les autres corpus sont touchés aussi : `
        + 'c’est le stockage ou la base, pas les documents.',
    };
  }
  const partCorpus = totalCorpus ? absentsCorpus / totalCorpus : 0;
  if (partCorpus > SEUIL_CORPUS) {
    return {
      ecrire: false,
      raison: `${(100 * partCorpus).toFixed(0)} % des médias de ce corpus sont absents. `
        + 'C’est trop pour un nettoyage automatique : à regarder à la main.',
    };
  }
  return { ecrire: true, raison: '' };
}

module.exports = { verdictEcriture, SEUIL_SITE, SEUIL_CORPUS };
