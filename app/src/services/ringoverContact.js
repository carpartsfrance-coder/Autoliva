'use strict';

/**
 * Fiche appelant Ringover — webhooks « Contact Call » et « Contact search ».
 *
 * ── LE SENS DE LA FLÈCHE ────────────────────────────────────────────────────
 *
 * On aurait pu POUSSER nos clients dans le carnet d'adresses Ringover
 * (`POST /contacts`). Deux raisons de ne pas le faire :
 *
 *   1. C'est l'endpoint qui répond 403 « insufficient permissions » sur ce
 *      compte, alors même que le droit `Contacts W` est coché dans l'interface.
 *   2. Surtout, ça crée une COPIE. Le jour où le client passe commande, où son
 *      devis est accepté, où son SAV se clôture, la copie ne le sait pas. On
 *      entretiendrait un annuaire faux à côté de la vraie base.
 *
 * Ici la flèche est inversée : Ringover NOUS interroge à chaque appel, on
 * répond avec l'état du dossier À CET INSTANT. Rien à synchroniser, rien à
 * révoquer, et aucun appel d'API sortant — donc le 403 ne nous concerne pas.
 *
 * ── BUDGET DE TEMPS ─────────────────────────────────────────────────────────
 *
 * La réponse est SYNCHRONE : Ringover attend pendant que le téléphone sonne.
 * Une fiche qui arrive après le décrochage ne sert plus à rien.
 *
 * D'où trois précautions. Les requêtes partent EN PARALLÈLE (on paie la plus
 * lente, pas la somme) ; chacune porte un `maxTimeMS` ; et l'ensemble est
 * borné par `DELAI_MS`. Au-delà, on renvoie « inconnu » — Ringover n'affiche
 * rien, ce qui est exactement la situation actuelle. Cette fonctionnalité ne
 * peut donc pas dégrader la prise d'appel, seulement l'améliorer.
 *
 * Mesuré sur la base de prod depuis un poste extérieur (donc pire que depuis
 * Render) : 1 700 paniers → 174 ms, 321 commandes → 102 ms, 127 SAV → 30 ms.
 * En parallèle : ~174 ms. En séquentiel ce serait 306 ms.
 *
 * ⚠ AUCUNE de ces collections n'a d'index sur le téléphone, et de toute façon
 * un index ne servirait à rien ici : on compare les 9 DERNIERS chiffres
 * (`/…$/`), parce que l'historique mélange `06…`, `+336…` et `0033…`. Un index
 * accélère les préfixes, pas les suffixes. C'est donc un parcours complet — il
 * reste peu coûteux tant que les collections sont petites. Si les paniers
 * dépassent la dizaine de milliers, il faudra stocker une clé normalisée
 * indexée plutôt que d'élargir le délai.
 */

const mongoose = require('mongoose');

const AbandonedCart = require('../models/AbandonedCart');
const Order = require('../models/Order');
const SavTicket = require('../models/SavTicket');
const User = require('../models/User');
const brand = require('../config/brand');
const { toE164, phoneKey } = require('./ringoverCalls');
const { partLexicon, leadCategoryFromSource } = require('./partLexicon');

const DELAI_MS = 2000;      // budget total de la fiche
const DELAI_REQUETE_MS = 1500; // par requête, côté serveur Mongo

/* ──────────────────────────────────────────────────────────────────────── */
/*  Outils                                                                  */
/* ──────────────────────────────────────────────────────────────────────── */

function lien(chemin) {
  return String(brand.SITE_URL || 'https://autoliva.com').replace(/\/$/, '') + chemin;
}

/** « hier », « il y a 12 j » — le standardiste a besoin de l'ancienneté, pas d'une date. */
function ilYA(date) {
  if (!date) return '';
  const t = new Date(date).getTime();
  if (Number.isNaN(t)) return '';
  const j = Math.floor((Date.now() - t) / 86400000);
  if (j <= 0) return "aujourd'hui";
  if (j === 1) return 'hier';
  return 'il y a ' + j + ' j';
}

function euros(n) {
  const v = Number(n) || 0;
  if (!v) return '';
  return Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' €';
}

/**
 * Coupe une valeur trop longue : la bulle d'information de Ringover est
 * étroite, une ligne à rallonge y devient illisible.
 */
function court(s, max) {
  const v = String(s == null ? '' : s).trim();
  return v.length <= max ? v : v.slice(0, max - 1).trim() + '…';
}

/** Ne jamais laisser une requête faire tomber la fiche entière. */
function sansEchec(promesse) {
  return promesse.then((r) => r, () => null);
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Recherche des dossiers                                                  */
/* ──────────────────────────────────────────────────────────────────────── */

function dossiers(rx) {
  const lead = AbandonedCart.findOne({ phone: rx })
    .sort({ lastActivityAt: -1 })
    .select('_id firstName lastName email captureSource lastActivityAt createdAt'
      + ' engineQuote.status engineQuote.pricing.sellPrice engineQuote.identifiedEngine'
      + ' engineQuote.updatedAt engineQuote.sentQuotes.sentAt engineQuote.sentQuotes.sellPriceTtc'
      + ' requested.plate requested.vehicle')
    /* Seulement la QUEUE de chaque fil : ces tableaux grossissent sans limite
       et les rapatrier entiers coûterait plus cher que tout le reste de la
       requête. Plusieurs entrées, pas une seule : la dernière est souvent un
       changement de statut, et il faut pouvoir remonter jusqu'à un vrai
       échange. */
    .slice('notes', -6)
    .slice('communications', -4)
    .maxTimeMS(DELAI_REQUETE_MS)
    .lean();

  /* Le téléphone d'une commande vit UNIQUEMENT dans les adresses : `Order` n'a
     pas de champ `phone` au premier niveau. Vérifié sur la prod — 0 commande en
     porte un, contre 318 sur chacune des deux adresses. Interroger `phone`
     ferait donc une clause morte. */
  const order = Order.findOne({
    $or: [{ 'shippingAddress.phone': rx }, { 'billingAddress.phone': rx }],
    paymentStatus: 'paid',
    status: { $nin: ['cancelled', 'delivered'] },
  })
    .sort({ createdAt: -1 })
    .select('_id number status totalCents createdAt billingAddress.fullName shippingAddress.fullName')
    .maxTimeMS(DELAI_REQUETE_MS)
    .lean();

  const sav = SavTicket.findOne({
    'client.telephone': rx,
    statut: { $nin: ['clos', 'cloture', 'resolu'] },
  })
    .sort({ createdAt: -1 })
    .select('_id numero motifSav statut createdAt client.nom client.type garage.nom')
    .maxTimeMS(DELAI_REQUETE_MS)
    .lean();

  return Promise.all([sansEchec(lead), sansEchec(order), sansEchec(sav)]);
}

/**
 * La société ne vit que sur le compte client (`User.companyName`), et on
 * n'arrive ici qu'avec un numéro. Cette requête part donc APRÈS les autres,
 * une fois l'e-mail connu — c'est le seul aller-retour séquentiel, et il est
 * indexé (`email` est unique).
 */
async function societe(email) {
  if (!email) return null;
  try {
    return await User.findOne({ email: String(email).toLowerCase().trim() })
      .select('accountType companyName firstName lastName')
      .maxTimeMS(DELAI_REQUETE_MS)
      .lean();
  } catch (_) { return null; }
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Construction de la fiche                                                */
/* ──────────────────────────────────────────────────────────────────────── */

function notesDevis(lead) {
  const eq = lead && lead.engineQuote;
  if (!eq || !eq.status) return '';

  /* Le sous-document s'appelle `engineQuote` pour des raisons historiques mais
     porte aussi les boîtes et les ponts : on passe par le lexique commun
     plutôt que d'écrire « moteur » en dur. */
  const lex = partLexicon(leadCategoryFromSource(lead.captureSource));
  const moteur = (eq.identifiedEngine && (eq.identifiedEngine.model || eq.identifiedEngine.code)) || '';
  const dernier = Array.isArray(eq.sentQuotes) && eq.sentQuotes.length
    ? eq.sentQuotes[eq.sentQuotes.length - 1] : null;
  const prix = euros((dernier && dernier.sellPriceTtc) || (eq.pricing && eq.pricing.sellPrice));

  const morceaux = [];
  if (eq.status === 'new') {
    /* Le cas qui doit sauter aux yeux : 250 demandes dorment sans réponse.
       Si l'une d'elles rappelle, le commercial doit le savoir avant de parler. */
    morceaux.push('À CHIFFRER depuis ' + (ilYA(eq.updatedAt || lead.lastActivityAt) || 'peu'));
  } else if (eq.status === 'quote_sent') {
    morceaux.push('envoyé ' + (ilYA(dernier && dernier.sentAt) || ilYA(eq.updatedAt)) + ', sans réponse');
  } else if (eq.status === 'analyzing') {
    morceaux.push('en cours de chiffrage');
  } else if (eq.status === 'acompte_recu') {
    morceaux.push('ACOMPTE VERSÉ');
  } else {
    morceaux.push(eq.status === 'won' ? 'gagné' : 'perdu');
  }
  if (prix) morceaux.push(prix);
  if (moteur) morceaux.push(court(moteur, 40));

  return court(lex.noun + ' — ' + morceaux.join(' · '), 90);
}

function notesCommande(order) {
  if (!order) return '';
  const age = ilYA(order.createdAt);
  return court(order.number + ' · ' + order.status + ' · ' + euros(order.totalCents / 100)
    + ' · NON LIVRÉE' + (age ? ' (' + age + ')' : ''), 90);
}

/**
 * `motifSav` est stocké en clé technique (`piece_defectueuse`). Afficher la clé
 * telle quelle dans la fenêtre d'appel serait illisible : on réutilise les
 * libellés du parcours SAV public plutôt que d'en recopier une seconde liste,
 * qui divergerait au premier ajout de motif.
 */
function libelleMotif(cle) {
  if (!cle) return '';
  try {
    const { MOTIFS } = require('../controllers/savController');
    const m = Array.isArray(MOTIFS) && MOTIFS.find((x) => x.key === cle);
    if (m && m.title) return m.title;
  } catch (_) { /* le libellé est un confort, jamais un prérequis */ }
  return String(cle).replace(/_/g, ' ');
}

function notesSav(sav) {
  if (!sav) return '';
  return court(sav.numero + ' · ' + (libelleMotif(sav.motifSav) || sav.statut || 'ouvert')
    + (ilYA(sav.createdAt) ? ' · ' + ilYA(sav.createdAt) : ''), 90);
}

/* Libellés d'origine, pour dire d'où vient un contact qu'on ne sait pas nommer. */
const SOURCES = {
  appel_manque: 'appel manqué',
  landing_moteurs: 'demande moteur',
  landing_boites: 'demande boîte',
  landing_ponts: 'demande pont',
  contact: 'formulaire de contact',
  devis: 'demande de devis',
  panier: 'panier abandonné',
};

/* Notes purement administratives : elles datent un changement d'état, elles ne
   disent rien de ce que le client veut. « Statut → Contacté » affiché comme
   dernier échange serait pire que rien — c'est le cas qu'on a rencontré au
   premier essai en conditions réelles. */
const NOTES_ADMIN = /^(Statut\s*→|Appel manqué le|📞 À RAPPELER)/u;
const REPONSE_CLIENT = /^RÉPONSE SMS du client\s*:\s*«\s*([\s\S]*?)\s*»/u;

/**
 * Dernier échange utile avec ce contact — sa demande, le plus souvent.
 *
 * L'ordre de préférence répond à la question du standardiste qui décroche :
 * « qu'est-ce que cette personne veut ? » Ce que le CLIENT a dit passe donc
 * avant ce qu'on lui a envoyé, qui passe avant une note interne.
 */
function dernierEchange(lead) {
  const comms = (lead.communications || []).slice().reverse();

  const entrant = comms.find((c) => c.sens === 'entrant' && c.corps);
  if (entrant) return court('Il nous a écrit : ' + entrant.corps, 90);

  /* Avant le journal des communications, la réponse du client n'existait que
     sous forme de note formatée par le webhook Ringover. */
  const notes = (lead.notes || []).slice().reverse();
  for (const n of notes) {
    const m = String(n.text || '').match(REPONSE_CLIENT);
    if (m) return court('Il nous a écrit : ' + m[1], 90);
  }

  const sortant = comms.find((c) => c.corps);
  if (sortant) return court('On lui a écrit : ' + sortant.corps, 90);

  const utile = notes.find((n) => n.text && !NOTES_ADMIN.test(String(n.text).trim()));
  return utile ? court(utile.text, 90) : '';
}

/** Découpe « Jean Dupont » en prénom / nom, quand on n'a qu'un nom complet. */
function decouper(complet) {
  const p = String(complet || '').trim().split(/\s+/).filter(Boolean);
  if (!p.length) return { firstname: '', lastname: '' };
  if (p.length === 1) return { firstname: '', lastname: p[0] };
  return { firstname: p[0], lastname: p.slice(1).join(' ') };
}

/**
 * Construit la fiche que Ringover affichera dans la fenêtre d'appel.
 *
 * L'`url` pointe vers UNE seule page — Ringover n'en accepte qu'une. On choisit
 * la plus actionnable : un SAV ouvert prime (quelqu'un qui a un litige
 * n'appelle presque jamais pour autre chose), puis une commande non livrée,
 * puis la fiche lead qui sert de dossier général.
 *
 * @returns {Promise<object|null>} null si le numéro est inconnu ou hors délai
 */
async function carteAppelant(numero) {
  if (mongoose.connection.readyState !== 1) return null;

  const e164 = toE164(numero);
  const key = phoneKey(e164);
  if (!key) return null;
  const rx = new RegExp(key + '$');

  const [lead, order, sav] = await dossiers(rx);
  if (!lead && !order && !sav) return null;

  const email = (lead && lead.email) || '';
  const compte = await societe(email);

  /* Identité : le compte client fait foi, puis le lead, puis les documents. */
  let firstname = (compte && compte.firstName) || (lead && lead.firstName) || '';
  let lastname = (compte && compte.lastName) || (lead && lead.lastName) || '';
  if (!firstname && !lastname) {
    const brut = (sav && sav.client && sav.client.nom)
      || (order && order.billingAddress && order.billingAddress.fullName) || '';
    ({ firstname, lastname } = decouper(brut));
  }

  /* Société : le compte pro d'abord, sinon le garage déclaré sur le SAV — un
     garage qui appelle pour un client final est un pro, même sans compte. */
  let company = (compte && compte.accountType === 'pro' && compte.companyName) || '';
  if (!company && sav && sav.garage && sav.garage.nom) company = sav.garage.nom;

  const data = {};
  const devis = notesDevis(lead);
  if (devis) data['Devis'] = devis;
  if (order) data['Commande'] = notesCommande(order);
  if (sav) data['SAV'] = notesSav(sav);

  /* Le type de client change le ton de l'accueil et les conditions applicables
     (TVA, garantie) : on ne l'affiche que quand il est ÉTABLI, jamais deviné. */
  if (compte && compte.accountType === 'pro') data['Client'] = 'Professionnel';
  else if (sav && sav.client && sav.client.type === 'B2B') data['Client'] = 'Professionnel';

  const plaque = (lead && lead.requested && lead.requested.plate) || '';
  const vehicule = (lead && lead.requested && lead.requested.vehicle) || '';
  if (plaque || vehicule) {
    data['Véhicule'] = court([vehicule, plaque].filter(Boolean).join(' · '), 60);
  }

  /* Numéro connu mais sans dossier ni nom : 181 des 839 leads qui portent un
     téléphone sont dans ce cas — typiquement un appel manqué déjà enregistré.
     Une première version les traitait comme des inconnus. C'était l'inverse de
     ce qu'il faut : c'est précisément quand on n'a pas de nom que le
     standardiste a besoin de savoir qu'on a déjà parlé à cette personne, et
     de pouvoir ouvrir sa fiche. On affiche donc ce qu'on a — le dernier
     échange, qui est souvent la demande elle-même. */
  const aDossier = !!(data['Devis'] || data['Commande'] || data['SAV']);
  if (lead && !aDossier) {
    const dernier = dernierEchange(lead);
    if (dernier) data['Dernier échange'] = dernier;
    data['Contact'] = 'Déjà en base'
      + (lead.createdAt ? ' depuis ' + ilYA(lead.createdAt) : '')
      + (SOURCES[lead.captureSource] ? ' · ' + SOURCES[lead.captureSource] : '');
  }

  if (!Object.keys(data).length && !firstname && !lastname && !company) return null;

  /* Sans nom, Ringover n'aurait qu'un numéro à afficher et la fiche passerait
     inaperçue. « Contact connu » se lit comme une étiquette, pas comme une
     identité : on ne fabrique jamais un nom de personne. */
  if (!firstname && !lastname && !company) lastname = 'Contact connu';

  let url = lien('/admin/activite-panier');
  if (sav) url = lien('/admin/sav/tickets/' + encodeURIComponent(sav.numero));
  else if (order) url = lien('/admin/commandes/' + order._id);
  else if (lead) url = lien('/admin/activite-panier/' + lead._id);

  return {
    firstname: court(firstname, 40),
    lastname: court(lastname, 40),
    company: court(company, 60),
    url,
    data,
    is_shared: true,
  };
}

/**
 * Même chose, mais bornée dans le temps. C'est cette fonction que la route
 * appelle : elle garantit qu'on rend la main, quoi qu'il arrive côté base.
 */
function carteAppelantBornee(numero) {
  const debut = Date.now();
  return Promise.race([
    carteAppelant(numero),
    new Promise((resolve) => setTimeout(() => resolve('__delai__'), DELAI_MS)),
  ]).then((r) => {
    if (r === '__delai__') {
      console.warn('[ringover] fiche appelant abandonnée après ' + DELAI_MS + ' ms');
      return null;
    }
    const ms = Date.now() - debut;
    if (ms > 800) console.warn('[ringover] fiche appelant lente : ' + ms + ' ms');
    return r;
  }).catch((err) => {
    console.error('[ringover] fiche appelant :', err && err.message ? err.message : err);
    return null;
  });
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Recherche depuis l'interface Ringover                                   */
/* ──────────────────────────────────────────────────────────────────────── */

/**
 * Webhook « Contact search » : le standardiste tape un nom ou un numéro dans
 * la barre de recherche de Ringover, et on répond depuis notre base.
 *
 * Volontairement limité aux LEADS : c'est la collection qui porte les
 * coordonnées, et c'est là que la recherche a un sens (« rappeler Dupont »).
 * La réponse est un TABLEAU, format imposé par Ringover, avec les numéros
 * détaillés — sans eux le résultat n'est pas cliquable.
 */
async function rechercherContacts(requete) {
  if (mongoose.connection.readyState !== 1) return [];
  const q = String(requete || '').trim();
  if (q.length < 2) return [];

  /* Un numéro se cherche par la fin, un nom par sous-chaîne. Les deux sont
     échappés : une requête est du texte saisi, jamais une expression. */
  const chiffres = q.replace(/\D/g, '');
  const echappe = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const ou = [
    { firstName: new RegExp(echappe, 'i') },
    { lastName: new RegExp(echappe, 'i') },
    { email: new RegExp(echappe, 'i') },
  ];
  if (chiffres.length >= 6) ou.push({ phone: new RegExp(chiffres.slice(-9) + '$') });

  try {
    const leads = await AbandonedCart.find({ $or: ou, phone: { $nin: ['', null] } })
      .sort({ lastActivityAt: -1 })
      .limit(20)
      .select('_id firstName lastName phone email')
      .maxTimeMS(DELAI_REQUETE_MS)
      .lean();

    return leads.map((l) => ({
      firstname: court(l.firstName, 40),
      lastname: court(l.lastName || l.email || '', 40),
      company: '',
      url: lien('/admin/activite-panier/' + l._id),
      numbers: [{ number: toE164(l.phone), type: 'mobile' }],
    })).filter((c) => c.numbers[0].number);
  } catch (err) {
    console.error('[ringover] recherche contacts :', err && err.message ? err.message : err);
    return [];
  }
}

module.exports = { carteAppelant, carteAppelantBornee, rechercherContacts, DELAI_MS };
