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

/* Pas d'accent, pas de lien : le premier ferait basculer le message en UCS-2 et
   doublerait son coût, le second le ferait filtrer par les opérateurs. */
const TEXTES = {
  devis: "{prenom}nous n'avons pas pu prendre votre appel au sujet du devis pour votre {piece}. "
    + 'Rappelez-nous au {tel}. Autoliva',
  commande: "{prenom}nous n'avons pas pu prendre votre appel au sujet de votre commande. "
    + 'Rappelez-nous au {tel}. Autoliva',
  sav: "{prenom}nous n'avons pas pu prendre votre appel au sujet de votre dossier SAV. "
    + 'Rappelez-nous au {tel}. Autoliva',
};

const TEXTE_DEFAUT = "Bonjour, nous n'avons pas pu prendre votre appel. Rappelez-nous au {tel}, "
  + 'nous avons votre dossier sous les yeux. Autoliva';

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

/** Le message, avec le numéro à rappeler — jamais « répondez à ce message ». */
function texteRepli(sujet, prenom, piece) {
  const modele = TEXTES[String(sujet || '')] || TEXTE_DEFAUT;
  const p = sansAccent(prenom).trim();
  return modele
    .replace('{prenom}', p ? p + ', ' : 'Bonjour, ')
    .replace('{piece}', sansAccent(piece || 'piece').trim())
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

module.exports = { envoyerRepli, texteRepli, justifieUnRepli, TEXTES, TEXTE_DEFAUT };
