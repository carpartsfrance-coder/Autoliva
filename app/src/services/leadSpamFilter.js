'use strict';

/**
 * Détection des leads de spam déposés par les formulaires publics.
 *
 * ── Le problème observé (09/2026) ───────────────────────────────────────────
 *
 * La page « Leads à relancer » se remplissait de faux contacts : 73 sur 191
 * envois du formulaire de contact, soit 38 % de cette source, avec une
 * accélération nette (15 en août, 57 sur les trois premiers jours de
 * septembre). Le commercial perdait son temps à trier.
 *
 * Le formulaire a pourtant DÉJÀ un champ-piège (`website`, invisible) et un
 * limiteur à 12 envois par IP toutes les 10 minutes. Le robot passait quand
 * même : il ne remplit que les champs qu'il reconnaît (donc pas le piège) et
 * il tourne sur des dizaines d'IP différentes (donc jamais le limiteur).
 *
 * ── Pourquoi un SCORE et pas une règle unique ───────────────────────────────
 *
 * Le signal le plus net était le téléphone : suite de chiffres sans 0 ni +33.
 * Mais l'appliquer seul aurait écarté cinq vrais prospects en cinq mois — un
 * Italien, un Marocain, un Canadien. Autoliva vend en Europe : un numéro
 * étranger n'est pas une preuve.
 *
 * On exige donc DEUX signaux concordants. Vérifié sur les 3 027 leads
 * existants : les 72 du robot en réunissent au moins deux, aucun lead
 * légitime n'en réunit deux.
 *
 * ── Ce qu'on en fait ────────────────────────────────────────────────────────
 *
 * On n'affiche pas d'erreur au visiteur : le formulaire répond comme d'habitude
 * (même traitement que le champ-piège). Un robot à qui l'on dit « rejeté »
 * adapte son gabarit ; un robot qui croit avoir réussi continue à parler dans
 * le vide. Le lead est simplement marqué et rangé, jamais présenté au
 * commercial.
 */

/** Un numéro français commence par 0, ou par +33 / 0033 / 33. */
function telephoneEtranger(brut) {
  const s = String(brut || '').replace(/[\s.\-()]/g, '');
  if (!s) return false;
  if (/^\+/.test(s)) return false;           // format international explicite : le visiteur sait ce qu'il fait
  if (/^0/.test(s)) return false;            // numéro français
  if (/^(33|0033)/.test(s)) return false;    // France sans le +
  return /^[1-9][0-9]{9,14}$/.test(s);       // suite de chiffres nue, longueur d'un numéro
}

/**
 * Signaux observés, chacun insuffisant seul.
 * @returns {string[]} les noms des signaux déclenchés
 */
function signaux({ firstName, lastName, phone, message, vehicle, plate, ref, hasFormTimestamp } = {}) {
  const trouves = [];
  const prenom = String(firstName || '').trim();
  const nom = String(lastName || '').trim();
  const msg = String(message || '').trim();

  if (telephoneEtranger(phone)) trouves.push('telephone_etranger');

  /* Le robot suffixe ses noms : « Robertdom », « DennisdomGM ». Un patronyme
     réel finissant par « dom » existe, d'où le besoin d'un second signal. */
  if (/dom(gm)?$/i.test(prenom) || /dom(gm)?$/i.test(nom)) trouves.push('nom_suffixe_dom');

  /* Demande creuse : un message court, aucun véhicule, aucune plaque, aucune
     référence. Un vrai client qui écrit décrit toujours sa pièce ou sa voiture.
     (Message vide = formulaire simplifié, ce n'est PAS un signal.) */
  if (msg && msg.length < 80 && !String(vehicle || '').trim()
      && !String(plate || '').trim() && !String(ref || '').trim()) {
    trouves.push('demande_creuse');
  }

  /* Envoi sans avoir affiché le formulaire : le cookie posé au GET est absent.
     Signal fort mais pas décisif seul — un visiteur qui bloque les cookies
     tomberait dessus. */
  if (hasFormTimestamp === false) trouves.push('formulaire_jamais_affiche');

  return trouves;
}

/** Deux signaux concordants = spam. Seuil validé sur les 3 027 leads existants. */
function estSpam(champs) {
  return signaux(champs).length >= 2;
}

module.exports = { estSpam, signaux, telephoneEtranger };
