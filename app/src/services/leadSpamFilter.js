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

/* ── Formulaire « Conseil expert » des articles de blog (11/2026) ───────────
 *
 * Deuxième robot, autre gabarit : 209 faux leads en 8 jours sur un seul
 * article (boîte BMW GA6HP26Z), soit 91 % de la source « Article blog ».
 * Prénom seul (« Lacey », « Tina »…), numéro américain au format
 * international (+1…), email japonais ou américain, message en anglais sans
 * rapport (« this product is tasty »), aucun véhicule, aucune plaque, aucun
 * VIN. Le filtre du formulaire de contact ne le voyait pas : son numéro
 * commence par « + », donc n'est pas une « suite de chiffres nue ».
 *
 * Même principe : DEUX signaux concordants. Mesuré le 18/11/2026 sur les 230
 * leads « Article blog » des 90 derniers jours : 209/209 robots écartés, 0
 * des 21 vrais demandeurs touché (tous en 06/07 ou sans téléphone, et 18 sur
 * 21 décrivent leur véhicule).
 */

/** Indicatifs des pays où Autoliva a de vrais clients : toute l'Europe (+3x,
    +4x), la Turquie, le Maghreb et l'outre-mer français. */
const INDICATIFS_DESSERVIS = /^\+(3\d|4\d|90|212|213|216|262|269|508|590|594|596|681|687|689)/;

/** Numéro au format international explicite, hors des pays desservis. */
function telephoneHorsZone(brut) {
  const s = String(brut || '').replace(/[\s.\-()]/g, '');
  if (!/^\+\d{6,}$/.test(s)) return false;
  return !INDICATIFS_DESSERVIS.test(s);
}

function signauxBlog({ phone, vehicle, vin, plate } = {}) {
  const trouves = [];
  if (telephoneHorsZone(phone)) trouves.push('telephone_hors_zone');
  /* Le formulaire demande le véhicule et le VIN : un vrai demandeur en remplit
     presque toujours un. Seul, ce n'est pas une preuve (le formulaire de la
     colonne de droite ne demande que l'email). */
  if (!String(vehicle || '').trim() && !String(vin || '').trim() && !String(plate || '').trim()) {
    trouves.push('aucun_vehicule');
  }
  return trouves;
}

function estSpamBlog(champs) {
  return signauxBlog(champs).length >= 2;
}

module.exports = { estSpam, signaux, telephoneEtranger, estSpamBlog, signauxBlog, telephoneHorsZone };
