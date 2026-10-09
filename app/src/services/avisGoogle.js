'use strict';

/**
 * Demande d'avis GOOGLE — contenu des messages (e-mail / SMS / WhatsApp).
 *
 * Remplace Skeepers / Avis Vérifiés, retiré en octobre 2026. Différence de
 * nature, pas seulement de prestataire : Skeepers recevait un « purchase
 * event » et expédiait l'e-mail depuis chez lui, à une date qu'on ne faisait
 * que déduire. Ici, c'est NOUS qui envoyons, par les canaux déjà en place
 * (MailerSend, Brevo, WhatsApp click-to-chat) — donc un envoi constatable,
 * journalisé sur la commande, et un texte que Killian peut réécrire.
 *
 * Le lien et les trois textes sont paramétrables depuis
 * /admin/parametres/avis ; ce fichier porte les DÉFAUTS et la résolution
 * (défaut + override back-office + variables de la commande).
 *
 * Best-effort : sans base de données, tout retombe sur les défauts — les
 * boutons restent utilisables.
 */

const mongoose = require('mongoose');
const AvisSettings = require('../models/AvisSettings');
const brand = require('../config/brand');

/**
 * Lien par défaut : le formulaire « Rédiger un avis » d'AUTOLIVA, DIRECT.
 *
 * Le premier lien fourni (https://share.google/Wi0js27zvNXPSolZe) était le
 * lien de PARTAGE de la fiche : il ouvrait le profil d'établissement, où il
 * fallait encore trouver « Rédiger un avis ». Un écran de plus entre le clic
 * et le formulaire, chez quelqu'un qui nous rend déjà service.
 *
 * Celui-ci ouvre la boîte de dialogue de notation (Google demande d'abord de
 * se connecter, c'est normal et inévitable : un avis anonyme n'existe pas).
 *
 * Identifiants relevés le 09/10/2026 sur la fiche, et recoupés entre eux :
 *   place_id ChIJQ7cZH4flyRIR7sSisS62-aI
 *   cid      11743617815010264302  (= 0xa2f9b62eb1a2c4ee, seconde moitié du
 *                                    ftid 0x12c9e5871f19b743:0xa2f9b62eb1a2c4ee)
 *   kgmid    /g/11nw257r17
 * `https://www.google.com/maps?cid=11743617815010264302` affiche bien AUTOLIVA
 * et autoliva.com — c'est ainsi qu'on a vérifié qu'il ne s'agit pas d'un
 * homonyme.
 *
 * ⚠ 79 caractères, contre 38 pour l'ancien. Sans effet sur le SMS, qui porte
 * {lienEnquete} (une quarantaine) — SAUF si l'enquête est désactivée : le
 * repli ramène alors ce lien dans le SMS, qui peut passer à deux segments.
 * Le compteur du back-office l'affiche et passe en ambre, c'est visible avant
 * d'envoyer.
 */
const LIEN_PAR_DEFAUT = 'https://search.google.com/local/writereview?placeid=ChIJQ7cZH4flyRIR7sSisS62-aI';

const CANAUX = ['email', 'sms', 'whatsapp'];

/** Variables disponibles dans les trois textes (affichées dans le back-office). */
const VARIABLES = [
  ['prenom', 'Prénom du client (ou « Bonjour » seul si inconnu)'],
  ['nom', 'Nom du client'],
  ['brand', 'Nom de la marque'],
  ['orderNumber', 'N° de commande'],
  ['lienEnquete', "Lien à envoyer : la page « quelle note ? » qui filtre avant Google (enquête coupée = lien Google)"],
  ['lienAvis', "Lien Google DIRECT, sans passer par l'enquête — en e-mail, seul sur sa ligne, il devient le bouton"],
  ['phone', 'Téléphone de la marque'],
];

/* Textes par défaut de la page d'enquête. Séparés des messages : ils ne
   s'adressent pas au même moment (l'attention du client est déjà captée). */
const ENQUETE_DEFAUTS = {
  question: "Comment s'est passée votre commande #{orderNumber} ?",
  messageContent: "Merci beaucoup ! Dernière étape : partagez-le sur Google. C'est ce qui aide le plus les automobilistes qui hésitent.",
  messageMecontent: "Désolé que ça n'ait pas été à la hauteur. Dites-nous ce qui s'est passé — on s'en occupe personnellement, et on vous recontacte.",
  remerciement: "C'est noté, merci de nous l'avoir dit. Un membre de l'équipe vous recontacte sous 24 h ouvrées.",
};

/** Note minimale par défaut pour être renvoyé vers Google. */
const SEUIL_PAR_DEFAUT = 4;

const DEFAUTS = {
  email: {
    sujet: 'Votre avis sur la commande #{orderNumber}',
    corps: `Bonjour {prenom},

Vous avez reçu votre commande #{orderNumber}. Nous espérons que la pièce vous donne entière satisfaction.

Prendriez-vous une minute pour laisser un avis sur Google ? C'est ce qui aide le plus les automobilistes qui hésitent encore à nous faire confiance.

{lienEnquete}

Merci beaucoup,
L'équipe {brand}
{phone}`,
  },
  sms: {
    /* TIENT EN UN SEUL SEGMENT (160 caractères), lien compris — c'est la
       contrainte qui a dicté ce texte, et le test unitaire la verrouille.
       Deux segments doublent le coût de chaque envoi, et les opérateurs
       découpent parfois mal un SMS long contenant une URL.
       Le téléphone a sauté volontairement : la page d'enquête est elle-même
       l'issue de secours d'un client mécontent, qui y décrit son problème et
       se fait rappeler. Le remettre coûterait 16 caractères pour un recours
       qui existe déjà deux clics plus loin — {phone} reste disponible si on
       change d'avis. */
    corps: "{brand} : votre avis sur la commande #{orderNumber} ? C'est par ici, en 10 s : {lienEnquete}",
  },
  whatsapp: {
    corps: `Bonjour {prenom}, c'est {brand}.

Votre commande #{orderNumber} est bien arrivée ? Si tout est en ordre, un avis sur Google nous aiderait énormément — ça prend une minute :
{lienEnquete}

Et si quelque chose ne va pas, répondez-moi ici : on règle ça.

Merci beaucoup !`,
  },
};

// ─── Cache court (mêmes raisons que smsSettings : évite une lecture par envoi) ─
let cache = null;
let cacheAt = 0;
const TTL_MS = 30 * 1000;

function invalidateCache() { cache = null; cacheAt = 0; }

async function charger() {
  const now = Date.now();
  if (cache && now - cacheAt < TTL_MS) return cache;
  let doc = null;
  try {
    if (mongoose.connection.readyState === 1) {
      doc = await AvisSettings.findOne({ singleton: 'avis' }).lean();
    }
  } catch (err) {
    console.error('[avisGoogle] lecture des réglages impossible :', err && err.message);
  }
  cache = doc || null;
  cacheAt = now;
  return cache;
}

function texte(v) { return typeof v === 'string' ? v : ''; }
function rempli(v) { return texte(v).trim() !== ''; }

/** Le lien courant (override back-office, sinon le défaut). */
async function getLien() {
  const doc = await charger();
  return (doc && rempli(doc.lienAvis) ? doc.lienAvis.trim() : LIEN_PAR_DEFAUT);
}

/**
 * Substitue les {variables}. Une variable inconnue est laissée telle quelle :
 * mieux vaut un « {truc} » visible dans l'aperçu qu'un trou silencieux dans
 * un message parti chez le client.
 */
function appliquerVariables(tpl, vars) {
  return texte(tpl).replace(/\{(\w+)\}/g, (brut, cle) => (
    Object.prototype.hasOwnProperty.call(vars || {}, cle) && vars[cle] != null
      ? String(vars[cle])
      : brut
  ));
}

/**
 * Variables d'une commande. `user` porte l'e-mail et le nom (ils vivent sur
 * User, pas sur Order) ; on retombe sur l'adresse de livraison quand le compte
 * est vide, ce qui est le cas des commandes invité.
 */
function variablesCommande({ order, user, lienAvis, lienEnquete } = {}) {
  const o = order || {};
  const u = user || {};
  const nomLivraison = texte(o.shippingAddress && o.shippingAddress.fullName).trim();
  const prenom = texte(u.firstName).trim() || nomLivraison.split(/\s+/)[0] || '';
  const nom = texte(u.lastName).trim() || nomLivraison.split(/\s+/).slice(1).join(' ');
  return {
    prenom,
    nom,
    brand: brand.NAME,
    orderNumber: texte(o.number) || '',
    lienAvis: lienAvis || LIEN_PAR_DEFAUT,
    /* Pas d'enquête (coupée, ou appelant qui n'en fournit pas) → le lien
       Google. Un message dont le lien manquerait ne doit jamais partir. */
    lienEnquete: lienEnquete || lienAvis || LIEN_PAR_DEFAUT,
    phone: brand.PHONE || '',
  };
}

/**
 * Résout le contenu d'un canal pour une commande donnée.
 * @returns {Promise<{enabled:boolean, sujet:string, corps:string, lienAvis:string}>}
 *   enabled=false → le canal est désactivé dans le back-office : ne pas envoyer.
 */
async function resoudre(canal, { order, user, lienEnquete } = {}) {
  if (!CANAUX.includes(canal)) return { enabled: false, sujet: '', corps: '', lienAvis: '' };
  const doc = await charger();
  const ov = (doc && doc[canal]) || null;
  const enabled = ov ? ov.enabled !== false : true;
  const lienAvis = (doc && rempli(doc.lienAvis) ? doc.lienAvis.trim() : LIEN_PAR_DEFAUT);
  const defaut = DEFAUTS[canal];
  const sujetTpl = ov && rempli(ov.sujet) ? ov.sujet : (defaut.sujet || '');
  const corpsTpl = ov && rempli(ov.corps) ? ov.corps : defaut.corps;
  const vars = variablesCommande({ order, user, lienAvis, lienEnquete });
  return {
    enabled,
    sujet: appliquerVariables(sujetTpl, vars),
    corps: appliquerVariables(corpsTpl, vars),
    lienAvis,
  };
}

const CHAMPS_ENQUETE = ['question', 'messageContent', 'messageMecontent', 'remerciement'];

/**
 * Réglages de l'enquête, défauts appliqués.
 * @returns {Promise<{active:boolean, seuil:number, proposerGoogleAuxMecontents:boolean,
 *                    question:string, messageContent:string, messageMecontent:string,
 *                    remerciement:string}>}
 */
async function enquete() {
  const doc = await charger();
  const e = (doc && doc.enquete) || null;
  const seuilBrut = e && Number.isFinite(e.seuil) ? e.seuil : SEUIL_PAR_DEFAUT;
  const out = {
    active: e ? e.active !== false : true,
    /* Borné à 2–5. Un seuil de 1 n'orienterait personne (tout passe) et un
       seuil de 6 n'enverrait plus jamais personne sur Google : deux façons de
       désactiver l'enquête sans le dire, alors qu'il y a un interrupteur. */
    seuil: Math.min(5, Math.max(2, Math.round(seuilBrut))),
    proposerGoogleAuxMecontents: !!(e && e.proposerGoogleAuxMecontents),
  };
  CHAMPS_ENQUETE.forEach((c) => {
    out[c] = e && rempli(e[c]) ? e[c] : ENQUETE_DEFAUTS[c];
  });
  return out;
}

/** Pour la page de réglages : défauts + override courant fusionnés. */
async function reglagesPourAdmin() {
  const doc = await charger();
  const enq = await enquete();
  const canaux = CANAUX.map((canal) => {
    const ov = (doc && doc[canal]) || null;
    const defaut = DEFAUTS[canal];
    return {
      canal,
      enabled: ov ? ov.enabled !== false : true,
      sujetDefaut: defaut.sujet || '',
      corpsDefaut: defaut.corps,
      /* Ce qui est AFFICHÉ dans le formulaire : l'override s'il existe, sinon
         le défaut. L'enregistrement remet '' si le texte n'a pas bougé. */
      sujet: ov && rempli(ov.sujet) ? ov.sujet : (defaut.sujet || ''),
      corps: ov && rempli(ov.corps) ? ov.corps : defaut.corps,
      personnalise: !!(ov && (rempli(ov.sujet) || rempli(ov.corps))),
    };
  });
  return {
    lienAvis: (doc && rempli(doc.lienAvis) ? doc.lienAvis.trim() : LIEN_PAR_DEFAUT),
    lienParDefaut: LIEN_PAR_DEFAUT,
    lienPersonnalise: !!(doc && rempli(doc.lienAvis) && doc.lienAvis.trim() !== LIEN_PAR_DEFAUT),
    canaux,
    variables: VARIABLES,
    /* Valeurs d'exemple pour que le compteur de la page compte le message
       RÉEL. Sans ça il compte « {lienEnquete} » (13 caractères) au lieu du
       lien (une quarantaine) : le texte paraît tenir en un segment et part
       en deux. Le jeton d'exemple a la longueur d'un vrai. */
    exemple: {
      brand: brand.NAME,
      orderNumber: 'CP2026-000485',
      prenom: 'Julien',
      nom: 'Farge',
      phone: brand.PHONE || '',
      lienAvis: (doc && rempli(doc.lienAvis) ? doc.lienAvis.trim() : LIEN_PAR_DEFAUT),
      lienEnquete: `${(brand.SITE_URL || '').replace(/\/$/, '')}/mon-avis/ABCdef123456`,
    },
    enquete: enq,
    enqueteDefauts: ENQUETE_DEFAUTS,
    seuilParDefaut: SEUIL_PAR_DEFAUT,
    updatedAt: (doc && doc.updatedAt) || null,
    updatedByName: (doc && doc.updatedByName) || '',
  };
}

/**
 * N'accepte qu'un lien http(s) : un « lien » collé de travers (texte, mailto,
 * javascript:) finirait dans un e-mail et un SMS clients.
 */
function lienValide(v) {
  const s = texte(v).trim();
  if (!s) return true; // vide = on revient au défaut
  try {
    const u = new URL(s);
    return u.protocol === 'https:' || u.protocol === 'http:';
  } catch (_) { return false; }
}

/**
 * Enregistre les réglages. `lienAvis` vide ou identique au défaut → stocké ''
 * (on suit le défaut). Idem pour chaque texte.
 * @returns {Promise<{ok:boolean, error?:string}>}
 */
async function enregistrer(payload, parNom) {
  const p = payload || {};
  if (!lienValide(p.lienAvis)) {
    return { ok: false, error: 'Le lien doit commencer par https:// (ou http://).' };
  }
  const lien = texte(p.lienAvis).trim();
  const set = {
    lienAvis: lien && lien !== LIEN_PAR_DEFAUT ? lien : '',
    updatedAt: new Date(),
    updatedByName: texte(parNom).slice(0, 120),
  };
  CANAUX.forEach((canal) => {
    const c = p[canal] || {};
    const defaut = DEFAUTS[canal];
    const sujet = texte(c.sujet).replace(/\r\n/g, '\n').trim();
    const corps = texte(c.corps).replace(/\r\n/g, '\n').trim();
    set[canal] = {
      enabled: c.enabled !== false,
      sujet: sujet && sujet !== (defaut.sujet || '') ? sujet : '',
      corps: corps && corps !== defaut.corps ? corps : '',
    };
  });
  const e = p.enquete || {};
  const seuil = parseInt(e.seuil, 10);
  const blocEnquete = {
    active: e.active !== false,
    seuil: Number.isFinite(seuil) ? Math.min(5, Math.max(2, seuil)) : SEUIL_PAR_DEFAUT,
    proposerGoogleAuxMecontents: e.proposerGoogleAuxMecontents === true,
  };
  CHAMPS_ENQUETE.forEach((c) => {
    const v = texte(e[c]).replace(/\r\n/g, '\n').trim();
    blocEnquete[c] = v && v !== ENQUETE_DEFAUTS[c] ? v : '';
  });
  set.enquete = blocEnquete;

  await AvisSettings.updateOne({ singleton: 'avis' }, { $set: set }, { upsert: true });
  invalidateCache();
  return { ok: true };
}

module.exports = {
  LIEN_PAR_DEFAUT,
  CANAUX,
  VARIABLES,
  DEFAUTS,
  ENQUETE_DEFAUTS,
  SEUIL_PAR_DEFAUT,
  enquete,
  appliquerVariables,
  variablesCommande,
  getLien,
  resoudre,
  reglagesPourAdmin,
  enregistrer,
  invalidateCache,
};
