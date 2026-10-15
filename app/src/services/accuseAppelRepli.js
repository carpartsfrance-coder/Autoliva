'use strict';

/**
 * Repli : prévenir quand même celui qui a appelé, quand Ringover refuse.
 *
 * ── Pourquoi (15/10/2026) ───────────────────────────────────────────────────
 *
 * Depuis le 25/09, l'API Ringover répond « 403 insufficient permissions » à
 * chaque envoi. Vérifié depuis deux réseaux sans rien de commun, dont la
 * machine de Killian : la clé est reconnue (une clé inconnue donne 401) mais
 * n'a plus aucun droit sur Conversations. Rien de notre côté n'y change quoi
 * que ce soit, et seul leur support peut rétablir le droit.
 *
 * En attendant, une trentaine de personnes par jour appellent, n'obtiennent
 * personne, et ne reçoivent rien. C'est ce silence qu'on supprime ici.
 *
 * ── Ce que ce repli N'EST PAS ───────────────────────────────────────────────
 *
 * Ce n'est pas aussi bien que Ringover, et le texte le reflète. Brevo envoie
 * depuis un expéditeur alphanumérique : le client NE PEUT PAS répondre au
 * message, et les opérateurs français jettent en silence les SMS contenant un
 * lien. On ne lui demande donc pas de répondre — on lui donne le numéro à
 * appeler, et aucun lien. Un message auquel on ne peut pas répondre vaut mieux
 * que pas de message du tout ; l'inverse serait vrai si Ringover marchait.
 *
 * Le jour où Ringover rétablit le droit, ce repli cesse de servir tout seul :
 * il ne se déclenche que sur un échec.
 */

const brand = require('../config/brand');
const smsService = require('./smsService');

/* ── Pourquoi on redonne le numéro mobile (15/10/2026) ──────────────────────
 *
 * Première version : « Rappelez-nous au 04 65 84 54 88 ». Ça prévenait, mais ça
 * ne DEMANDAIT PLUS LE MOTIF — alors que c'est tout l'intérêt de l'accusé :
 * savoir, avant de rappeler, de quoi il s'agit.
 *
 * Or RECEVOIR un SMS passe par un webhook, pas par l'API : la panne Ringover
 * n'a pas coupé l'entrée. Mesuré le 15/10 : des réponses arrivent encore
 * (dernière le 8 octobre), elles sont bien recopiées sur la fiche, et elles se
 * sont simplement effondrées — 280 en août, 7 en octobre — parce que plus
 * personne n'avait de fil auquel répondre depuis qu'on n'envoie plus.
 *
 * On ne peut pas répondre à un message Brevo (expéditeur alphanumérique), mais
 * rien n'empêche d'y écrire le numéro mobile auquel envoyer un SMS. La réponse
 * revient alors par le chemin habituel, sur la fiche et dans Ringover.
 *
 * Toujours pas d'accent (sinon UCS-2 et coût double) ni de lien (les opérateurs
 * français les filtrent). Un numéro de téléphone, lui, passe.
 */
const TEXTES = {
  devis: "{prenom}nous n'avons pas pu prendre votre appel. C'est au sujet du devis pour votre "
    + '{piece} ? Repondez par SMS au {mobile}, on revient vers vous. Autoliva',
  commande: "{prenom}nous n'avons pas pu prendre votre appel. C'est au sujet de votre commande ? "
    + 'Repondez par SMS au {mobile}, on revient vers vous. Autoliva',
  sav: "{prenom}nous n'avons pas pu prendre votre appel. C'est au sujet de votre dossier SAV ? "
    + 'Repondez par SMS au {mobile}, on vous rappelle. Autoliva',
};

const TEXTE_DEFAUT = "Bonjour, nous n'avons pas pu prendre votre appel. Dites-nous en deux mots ce "
  + "qu'il vous faut par SMS au {mobile}, on vous rappelle. Autoliva";

/* Repli du repli : sans numéro mobile configuré, on ne peut rien demander — on
   donne la ligne principale et on s'arrête là. */
const TEXTES_SANS_MOBILE = {
  devis: "{prenom}nous n'avons pas pu prendre votre appel au sujet du devis pour votre {piece}. "
    + 'Rappelez-nous au {tel}. Autoliva',
  commande: "{prenom}nous n'avons pas pu prendre votre appel au sujet de votre commande. "
    + 'Rappelez-nous au {tel}. Autoliva',
  sav: "{prenom}nous n'avons pas pu prendre votre appel au sujet de votre dossier SAV. "
    + 'Rappelez-nous au {tel}. Autoliva',
};

const TEXTE_DEFAUT_SANS_MOBILE = "Bonjour, nous n'avons pas pu prendre votre appel. "
  + 'Rappelez-nous au {tel}, nous avons votre dossier sous les yeux. Autoliva';

/**
 * Le numéro mobile Ringover, écrit comme on le lit : +33745880085 → 07 45 88 00 85.
 * C'est le seul numéro du compte qui reçoit des SMS, et il reste joignable même
 * quand l'API refuse de s'en servir pour envoyer.
 */
function mobileLisible() {
  const brut = String(process.env.RINGOVER_SMS_FROM || '').replace(/[^0-9+]/g, '');
  const m = brut.match(/^\+33(\d{9})$/);
  if (!m) return '';
  return ('0' + m[1]).replace(/(\d{2})(?=\d)/g, '$1 ').trim();
}

/* Les motifs qui veulent dire « le canal Ringover est coupé ». Un destinataire
   impossible n'en fait pas partie : Brevo ne ferait pas mieux sur une ligne
   fixe, et réessayer serait deux fois le même échec. */
const MOTIFS_CANAL_COUPE = new Set([
  'non_configure', 'credits_epuises', 'reseau',
]);

function justifieUnRepli(raison) {
  const r = String(raison || '');
  return MOTIFS_CANAL_COUPE.has(r) || /^http_/.test(r);
}

function sansAccent(texte) {
  return String(texte || '').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/**
 * Le message. On demande le motif — c'est l'intérêt de l'accusé — et on dit par
 * quel numéro répondre, puisque ce message-ci n'accepte pas de réponse.
 */
function texteRepli(sujet, prenom, piece) {
  const mobile = mobileLisible();
  const table = mobile ? TEXTES : TEXTES_SANS_MOBILE;
  const defaut = mobile ? TEXTE_DEFAUT : TEXTE_DEFAUT_SANS_MOBILE;
  const modele = table[String(sujet || '')] || defaut;
  const p = sansAccent(prenom).trim();
  return modele
    .replace('{prenom}', p ? p + ', ' : 'Bonjour, ')
    .replace('{piece}', sansAccent(piece || 'piece').trim())
    .replace('{mobile}', mobile)
    .replace('{tel}', brand.PHONE);
}

/**
 * Envoie le repli. Ne lève jamais : il court déjà derrière un échec.
 *
 * @returns {Promise<{ok:boolean, raison?:string, texte?:string}>}
 */
async function envoyerRepli({ to, sujet, prenom, piece } = {}) {
  const texte = texteRepli(sujet, prenom, piece);
  try {
    const r = await smsService.sendSms({ to, text: texte });
    if (r && r.ok) return { ok: true, texte };
    return { ok: false, raison: (r && r.reason) || 'inconnu' };
  } catch (err) {
    console.error('[repli-sms] échec :', err && err.message ? err.message : err);
    return { ok: false, raison: 'erreur' };
  }
}

module.exports = {
  envoyerRepli, texteRepli, justifieUnRepli, mobileLisible,
  TEXTES, TEXTE_DEFAUT, TEXTES_SANS_MOBILE, TEXTE_DEFAUT_SANS_MOBILE,
};
