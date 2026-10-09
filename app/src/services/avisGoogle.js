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
  ['piece', "La pièce achetée (« mécatronique DQ200 ») — « commande » si on ne la reconnaît pas"],
  ['bonAchat', "Mention du bon d'achat, phrase entière — vide si le bon est désactivé"],
  ['bonSms', "Clause pour le SMS (« , un bon de 30 € vous est offert ») — VIRGULE COMPRISE, pour disparaître proprement si le bon est coupé"],
  ['phone', 'Téléphone de la marque'],
];

/* Textes par défaut de la page d'enquête. Séparés des messages : ils ne
   s'adressent pas au même moment (l'attention du client est déjà captée). */
const ENQUETE_DEFAUTS = {
  question: "Comment s'est passée votre commande #{orderNumber} ?",
  /* Pas de « partagez-LE » : depuis que la page demande une note et non un
     avis, le pronom ne renvoie plus à rien. */
  messageContent: "Merci beaucoup ! Si vous avez trente secondes de plus, un avis sur Google aide énormément les automobilistes qui hésitent encore à nous faire confiance.",
  messageMecontent: "Désolé que ça n'ait pas été à la hauteur. Dites-nous ce qui s'est passé — on s'en occupe personnellement, et on vous recontacte.",
  remerciement: "C'est noté, merci de nous l'avoir dit. Un membre de l'équipe vous recontacte sous 24 h ouvrées.",
};

/** Note minimale par défaut pour être renvoyé vers Google. */
const SEUIL_PAR_DEFAUT = 4;

/* Bon d'achat : désactivé par défaut dans le CODE (c'est une dépense, elle ne
   doit pas s'allumer toute seule chez qui déploierait ce code ailleurs). La
   valeur réellement en service vit en base. */
const BON_DEFAUTS = { actif: false, montantCents: 3000, minimumCents: 0, validiteJours: 180 };

/**
 * Ce que remplace {bonAchat} : « Un bon de 30 € pour votre réponse. »
 *
 * Une PHRASE COMPLÈTE, et non un bout de groupe nominal, pour deux raisons.
 * D'abord elle doit pouvoir disparaître sans laisser un texte bancal quand le
 * bon est coupé — un gabarit écrit autour d'un fragment devient illisible le
 * jour où il vaut ''. Ensuite elle dit « pour votre réponse » et jamais
 * « pour votre avis » : c'est précisément ce que la loi distingue.
 */
function montantEnEuros(bon) {
  if (!bon || !bon.actif || !(bon.montantCents > 0)) return '';
  return bon.montantCents % 100 === 0
    ? String(bon.montantCents / 100)
    : (bon.montantCents / 100).toFixed(2).replace('.', ',');
}

function mentionBon(bon) {
  const euros = montantEnEuros(bon);
  return euros ? `Un bon de ${euros} € pour votre réponse.` : '';
}

/**
 * Clause pour le SMS — **virgule de tête comprise**.
 *
 * La version précédente, « 30 € offerts. », tenait en un segment mais faisait
 * SMS d'arnaque : une phrase nue, sans objet, c'est exactement le vocabulaire
 * des tirages au sort frauduleux. Dans un message qui doit inspirer confiance
 * à quelqu'un qui vient de dépenser plusieurs centaines d'euros, c'est raté.
 *
 * La virgule est DANS la variable, et pas dans le gabarit, parce que la
 * clause doit disparaître avec sa ponctuation quand le bon est coupé :
 * « en 10 secondes, : <lien> » serait pire que tout.
 *
 * Le « pour quoi » est porté par la proposition précédente (« dites-le-nous
 * en 10 secondes ») : le bon récompense la réponse, jamais un avis.
 */
function mentionBonSms(bon) {
  const euros = montantEnEuros(bon);
  return euros ? `, un bon de ${euros} € vous est offert` : '';
}

/**
 * Referme les trous laissés par une variable vide : « 10 s.  https://… » avec
 * ses deux espaces, ou trois sauts de ligne là où le bon aurait dû être.
 * Sans ça, couper le bon d'achat abîme visiblement tous les messages.
 */
function nettoyerTexte(v) {
  return String(v == null ? '' : v)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const DEFAUTS = {
  email: {
    sujet: 'Votre avis sur la commande #{orderNumber}',
    corps: `Bonjour {prenom},

Vous avez reçu votre commande #{orderNumber}. Tout s'est bien passé ?

Dites-le-nous en une question : une note de 1 à 5, dix secondes. {bonAchat}

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
    /* DEUX SEGMENTS ASSUMÉS. Toutes les formulations correctes dépassent 160
       caractères une fois le lien (42) et le nom de la pièce comptés — c'est
       mesuré, pas supposé. Le second segment coûte quelques centimes ; un SMS
       qui fait arnaque coûte le client. Le test vérifie qu'on ne passe jamais
       à TROIS, et qu'un bon désactivé fait retomber à un seul. */
    corps: 'Bonjour {prenom}, c\'est {brand}. Votre {piece} vous convient ? Dites-le-nous en 10 secondes{bonSms} : {lienEnquete}',
  },
  whatsapp: {
    corps: `Bonjour {prenom}, c'est {brand}.

Votre commande #{orderNumber} est bien arrivée ? Dites-nous en une question ce que vous en avez pensé — dix secondes :
{lienEnquete}

{bonAchat}

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
/**
 * Nom de la pièce, pour parler au client dans SES mots.
 *
 * « #CP2026-000485 » est notre référence, pas la sienne : elle ne lui évoque
 * rien et fait ressembler le message à un envoi de masse. Ce dont il se
 * souvient, c'est la pièce qu'il a montée.
 *
 * Coupé à 24 caractères SUR UN MOT ENTIER, sans points de suspension : les
 * noms de fiches portent souvent la référence et le véhicule à la suite
 * (« Mécatronique DQ200 0AM325065S Audi A3 »), et un SMS a 160 caractères en
 * tout. Minuscule initiale quand c'est un mot ordinaire — « Votre
 * Mécatronique » au milieu d'une phrase fait tache — mais jamais sur un
 * acronyme comme « TCU ».
 */
function nomPiece(order) {
  const items = (order && Array.isArray(order.items)) ? order.items : [];
  const brut = texte(items[0] && items[0].name).trim().replace(/\s+/g, ' ');
  if (!brut) return 'commande';
  let nom = brut;
  if (nom.length > 24) {
    const coupe = nom.slice(0, 25);
    const espace = coupe.lastIndexOf(' ');
    nom = (espace > 8 ? coupe.slice(0, espace) : nom.slice(0, 24)).trim();
  }
  if (nom.length > 1 && nom[1] === nom[1].toLowerCase()) {
    nom = nom[0].toLowerCase() + nom.slice(1);
  }
  return nom;
}

function variablesCommande({ order, user, lienAvis, lienEnquete, bon } = {}) {
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
    piece: nomPiece(order),
    bonAchat: mentionBon(bon),
    bonSms: mentionBonSms(bon),
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
  const bonCourant = await bon();
  const ov = (doc && doc[canal]) || null;
  const enabled = ov ? ov.enabled !== false : true;
  const lienAvis = (doc && rempli(doc.lienAvis) ? doc.lienAvis.trim() : LIEN_PAR_DEFAUT);
  const defaut = DEFAUTS[canal];
  const sujetTpl = ov && rempli(ov.sujet) ? ov.sujet : (defaut.sujet || '');
  const corpsTpl = ov && rempli(ov.corps) ? ov.corps : defaut.corps;
  const vars = variablesCommande({ order, user, lienAvis, lienEnquete, bon: bonCourant });
  return {
    enabled,
    sujet: nettoyerTexte(appliquerVariables(sujetTpl, vars)),
    corps: nettoyerTexte(appliquerVariables(corpsTpl, vars)),
    lienAvis,
    /* E-mail seulement. Défaut true : le texte brut passe mieux en boîte
       principale que le gabarit maison, qui a tout d'une newsletter. */
    texteSimple: canal === 'email' ? !(ov && ov.texteSimple === false) : false,
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

/**
 * Réglages du bon d'achat offert pour une RÉPONSE à l'enquête.
 * Voir models/AvisSettings : il ne doit JAMAIS dépendre de la note.
 */
async function bon() {
  const doc = await charger();
  const b = (doc && doc.bon) || null;
  if (!b) return { ...BON_DEFAUTS };
  const n = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d);
  return {
    actif: b.actif === true,
    montantCents: n(b.montantCents, BON_DEFAUTS.montantCents),
    minimumCents: n(b.minimumCents, BON_DEFAUTS.minimumCents),
    validiteJours: Math.max(1, Math.round(n(b.validiteJours, BON_DEFAUTS.validiteJours))),
  };
}

/** Pour la page de réglages : défauts + override courant fusionnés. */
async function reglagesPourAdmin() {
  const doc = await charger();
  const enq = await enquete();
  const bonCourant = await bon();
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
      texteSimple: canal === 'email' ? !(ov && ov.texteSimple === false) : false,
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
      piece: 'mécatronique DQ200',
      bonAchat: mentionBon(bonCourant),
      bonSms: mentionBonSms(bonCourant),
    },
    enquete: enq,
    bon: bonCourant,
    /* Pour avertir en back-office : un bon actif que RIEN n'annonce dans les
       messages, c'est de l'argent distribué sans effet d'entraînement. */
    bonAnnonce: CANAUX.some((canal) => {
      const ov = (doc && doc[canal]) || null;
      const corps = ov && rempli(ov.corps) ? ov.corps : DEFAUTS[canal].corps;
      return corps.includes('{bonAchat}');
    }),
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
      texteSimple: canal === 'email' ? c.texteSimple !== false : false,
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

  const b = p.bon || {};
  const entier = (v, d) => { const n = parseInt(v, 10); return Number.isFinite(n) && n >= 0 ? n : d; };
  set.bon = {
    actif: b.actif === true,
    montantCents: entier(b.montantCents, BON_DEFAUTS.montantCents),
    minimumCents: entier(b.minimumCents, BON_DEFAUTS.minimumCents),
    validiteJours: Math.max(1, entier(b.validiteJours, BON_DEFAUTS.validiteJours)),
  };

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
  bon,
  nettoyerTexte,
  BON_DEFAUTS,
  mentionBon,
  mentionBonSms,
  nomPiece,
  appliquerVariables,
  variablesCommande,
  getLien,
  resoudre,
  reglagesPourAdmin,
  enregistrer,
  invalidateCache,
};
