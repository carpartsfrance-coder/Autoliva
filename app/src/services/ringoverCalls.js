'use strict';

/**
 * Capture des appels manqués Ringover.
 *
 * Un appel manqué ne laissait jusqu'ici aucune trace : la personne rappelait,
 * ou disparaissait. Ici il devient un lead dans « Leads à relancer », ce qui le
 * fait entrer dans la machinerie de relance qui existe déjà (composeur SMS /
 * WhatsApp / email, statuts, filtres).
 *
 * DEUX LIMITES CONNUES DE L'API RINGOVER, assumées ici :
 *
 *  1. Le payload documenté (`event`, `call_id`, `caller_number`,
 *     `receiver_number`, `timestamp`) NE CONTIENT PAS le choix du menu vocal.
 *
 *     ⚠ CHEZ AUTOLIVA, le SVI route « 1 » (commercial) et « 2 » (SAV) vers LE
 *     MÊME numéro. `RINGOVER_NUMBER_MAP` est donc INOPÉRANT en l'état : le
 *     motif restera vide. La carte est conservée car elle deviendra utile le
 *     jour où les deux branches auront des numéros distincts — c'est une
 *     configuration à faire côté Ringover, pas côté code.
 *
 *     Ce n'est pas une perte importante : le RAPPROCHEMENT EN BASE ci-dessous
 *     est un meilleur signal. Mesuré sur la prod, 82 % des numéros connus
 *     (686 sur 835) ont au moins un dossier ouvert — devis moteur en attente,
 *     commande non livrée, panier, SAV. Savoir que Marc a un devis moteur non
 *     chiffré depuis 11 jours en dit plus que « il a tapé 1 ».
 *
 *  2. Ringover ne signe pas ses webhooks. La route porte donc un secret dans
 *     l'URL (voir routes/api/ringover.js) : c'est la seule barrière, elle doit
 *     rester longue et privée.
 *
 * Le rapprochement avec un dossier existant (lead, commande, SAV) est fait ici
 * et STOCKÉ SUR LE LEAD, pour que le commercial voie tout de suite pourquoi la
 * personne appelle sans avoir à chercher.
 */

const mongoose = require('mongoose');

const AbandonedCart = require('../models/AbandonedCart');
const Order = require('../models/Order');
const SavTicket = require('../models/SavTicket');
const ringoverSms = require('./ringoverSms');

/* ──────────────────────────────────────────────────────────────────────── */
/*  Téléphone                                                               */
/* ──────────────────────────────────────────────────────────────────────── */

/**
 * Normalise en E.164 français. On stocke TOUJOURS en E.164 : c'est ce
 * qu'attend Brevo, et un numéro stocké en 06… n'est jamais envoyable tel quel.
 */
function toE164(raw) {
  const d = String(raw || '').replace(/[^\d+]/g, '');
  if (!d) return '';
  if (d.startsWith('+')) return d.slice(0, 16);
  if (d.startsWith('00')) return '+' + d.slice(2, 17);
  if (d.startsWith('33')) return '+' + d.slice(0, 15);
  if (d.startsWith('0') && d.length === 10) return '+33' + d.slice(1);
  return '+' + d.slice(0, 15);
}

/**
 * Clé de comparaison : les 9 derniers chiffres. Nos anciens enregistrements
 * mélangent 06…, +336…, 0033… — comparer sur la fin est le seul moyen fiable
 * de les rapprocher sans réécrire l'historique.
 */
function phoneKey(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length >= 9 ? d.slice(-9) : '';
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Motif déduit du numéro appelé                                           */
/* ──────────────────────────────────────────────────────────────────────── */

/**
 * RINGOVER_NUMBER_MAP : "+33465845488=commercial,+33465848539=sav"
 *
 * Ne sert QUE si les branches du SVI aboutissent à des numéros distincts.
 * Ce n'est pas le cas aujourd'hui chez Autoliva (une seule ligne pour le
 * commercial et le SAV) : la variable reste donc vide et le motif aussi.
 */
function numberMap() {
  const raw = String(process.env.RINGOVER_NUMBER_MAP || '').trim();
  const map = new Map();
  if (!raw) return map;
  raw.split(',').forEach((pair) => {
    const [num, motif] = pair.split('=');
    const k = phoneKey(num);
    if (k && motif) map.set(k, String(motif).trim().slice(0, 40));
  });
  return map;
}

function motifFromReceiver(receiverNumber) {
  const m = numberMap();
  if (!m.size) return '';
  return m.get(phoneKey(receiverNumber)) || '';
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Rapprochement : à qui appartient ce numéro ?                            */
/* ──────────────────────────────────────────────────────────────────────── */

/**
 * Cherche le dossier ouvert le plus pertinent pour ce numéro.
 * L'ordre reflète l'urgence commerciale : un devis moteur en attente prime sur
 * un panier abandonné.
 *
 * @returns {Promise<{ resume: string, leadId: string|null }>}
 */
async function findContext(e164) {
  const key = phoneKey(e164);
  if (!key) return { resume: '', leadId: null };
  /* On compare sur la fin du numéro : `$regex` ancré à droite, échappé. */
  const rx = new RegExp(key.replace(/\D/g, '') + '$');

  const bits = [];
  let leadId = null;
  /* `sujet` sert à PERSONNALISER le SMS : plutôt que « dites-nous ce qu'il vous
     faut », on propose ce qu'on sait déjà. `savId` permet de recopier une
     éventuelle réponse dans le ticket. */
  let savId = null;
  let sujet = '';
  let prenom = '';

  try {
    const lead = await AbandonedCart.findOne({ phone: rx })
      .sort({ lastActivityAt: -1 })
      .select('_id firstName lastName email engineQuote.status captureSource createdAt')
      .lean();
    if (lead) {
      leadId = String(lead._id);
      prenom = String(lead.firstName || '').trim();
      const nom = [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim();
      if (nom) bits.push(nom);
      const eq = lead.engineQuote && lead.engineQuote.status;
      if (eq === 'new') { bits.push('devis moteur EN ATTENTE de chiffrage'); sujet = sujet || 'devis'; }
      else if (eq === 'quote_sent') { bits.push('devis moteur envoyé, sans réponse'); sujet = sujet || 'devis'; }
      else if (eq) bits.push('devis moteur : ' + eq);
    }
  } catch (_) { /* le rapprochement est un bonus, jamais bloquant */ }

  try {
    const order = await Order.findOne({
      $or: [{ phone: rx }, { 'shippingAddress.phone': rx }],
      paymentStatus: 'paid',
      status: { $nin: ['cancelled', 'delivered'] },
    }).sort({ createdAt: -1 }).select('number status totalCents').lean();
    if (order) {
      bits.push('commande ' + order.number + ' (' + order.status + ', '
        + (order.totalCents / 100).toFixed(0) + ' €) NON LIVRÉE');
      if (!sujet) sujet = 'commande';
    }
  } catch (_) { /* idem */ }

  try {
    const sav = await SavTicket.findOne({
      'client.telephone': rx,
      statut: { $nin: ['clos', 'cloture', 'resolu'] },
    }).sort({ createdAt: -1 }).select('_id numero motifSav statut').lean();
    if (sav) {
      /* Le champ est `motifSav`, pas `motif` — `motif` renvoyait undefined et
         affichait « SAV-2026-0001 ouvert (undefined) » sur la fiche.
         Le numéro contient déjà « SAV », inutile de le préfixer. */
      bits.push(sav.numero + ' ouvert' + (sav.motifSav ? ' (' + sav.motifSav + ')' : ''));
      savId = String(sav._id);
      /* Un SAV ouvert prime : quelqu'un qui a un litige en cours n'appelle
         quasiment jamais pour autre chose. */
      sujet = 'sav';
    }
  } catch (_) { /* idem */ }

  return { resume: bits.join(' · '), leadId, savId, sujet, prenom };
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Enregistrement de l'appel manqué                                        */
/* ──────────────────────────────────────────────────────────────────────── */

/**
 * Envoie l'accusé de réception au client, au plus une fois par 24 h et par
 * numéro. Ne lève jamais : la capture de l'appel prime sur l'envoi.
 *
 * Pas de restriction horaire — choix explicite de Killian : quelqu'un qui
 * appelle à 22 h est réveillé et attend une réponse.
 *
 * @returns {Promise<string>} libellé de ce qui s'est passé, pour la note
 */
async function accuserReception(leadId, e164, ctx) {
  if (!ringoverSms.estActif()) return '';
  try {
    const lead = await AbandonedCart.findById(leadId).select('ringoverSmsSentAt').lean();
    const dernier = lead && lead.ringoverSmsSentAt ? new Date(lead.ringoverSmsSentAt) : null;
    if (dernier && Date.now() - dernier.getTime() < 24 * 3600 * 1000) return 'SMS déjà envoyé aujourd\'hui';

    const r = await ringoverSms.envoyer({
      to: e164,
      sujet: (ctx && ctx.sujet) || '',
      prenom: (ctx && ctx.prenom) || '',
    });
    if (!r.ok) return 'SMS non envoyé (' + r.raison + ')';
    await AbandonedCart.updateOne({ _id: leadId }, { $set: { ringoverSmsSentAt: new Date() } });
    return 'SMS de rappel envoyé';
  } catch (err) {
    console.error('[ringover] accusé de réception :', err && err.message ? err.message : err);
    return 'SMS non envoyé (erreur)';
  }
}

/**
 * Enregistre un appel manqué comme lead à rappeler.
 *
 * IDEMPOTENT sur `callId` : Ringover réémet ses webhooks en cas d'échec, et on
 * ne veut pas dupliquer un lead à chaque tentative.
 *
 * Si le numéro correspond à un lead existant, on ENRICHIT ce lead plutôt que
 * d'en créer un second — sinon la fiche du client se fragmente à chaque appel.
 *
 * @returns {Promise<{ ok: boolean, action: string, leadId?: string, resume?: string }>}
 */
async function recordMissedCall({ callId, callerNumber, receiverNumber, at } = {}) {
  if (mongoose.connection.readyState !== 1) return { ok: false, action: 'db_down' };

  const e164 = toE164(callerNumber);
  if (!phoneKey(e164)) return { ok: false, action: 'numero_invalide' };

  const quand = at ? new Date(at) : new Date();
  const horodatage = Number.isNaN(quand.getTime()) ? new Date() : quand;
  const ref = String(callId || '').trim();
  const sessionId = 'ringover:' + (ref || horodatage.getTime());

  /* Rejeu du même appel. Deux cas à couvrir : l'appel a créé un lead (on le
     retrouve par sessionId), ou il a enrichi un lead existant (on le retrouve
     par `ringoverCallIds`). Sans le second, chaque rejeu rajoutait une note. */
  const deja = await AbandonedCart.findOne(
    ref ? { $or: [{ sessionId }, { ringoverCallIds: ref }] } : { sessionId }
  ).select('_id').lean();
  if (deja) return { ok: true, action: 'deja_enregistre', leadId: String(deja._id) };

  const motif = motifFromReceiver(receiverNumber);
  const ctx = await findContext(e164);
  const { resume, leadId } = ctx;

  const ligne = 'Appel manqué le ' + horodatage.toLocaleString('fr-FR')
    + (motif ? ' (' + motif + ')' : '')
    + (resume ? ' — ' + resume : '');

  /* Le numéro est déjà connu : on enrichit la fiche existante plutôt que d'en
     créer une seconde. `notes` est le fil déjà affiché dans l'admin, l'appel
     apparaît donc au même endroit que les notes du commercial. */
  if (leadId) {
    /* Garde DANS la requête : si deux webhooks du même appel arrivent en
       parallèle, un seul passera — la lecture ci-dessus ne suffirait pas. */
    const filtre = ref ? { _id: leadId, ringoverCallIds: { $ne: ref } } : { _id: leadId };
    const maj = {
      $set: { lastActivityAt: horodatage, phone: e164 },
      $push: { notes: { text: ligne, addedByName: 'Ringover', addedAt: horodatage } },
    };
    if (ref) maj.$addToSet = { ringoverCallIds: ref };
    const r = await AbandonedCart.updateOne(filtre, maj);
    if (!r.modifiedCount) return { ok: true, action: 'deja_enregistre', leadId };
    const sms = await accuserReception(leadId, e164, ctx);
    return { ok: true, action: 'lead_enrichi', leadId, resume, sms };
  }

  /* Numéro inconnu : nouveau lead, sans email — on n'en a pas. */
  const cree = await AbandonedCart.create({
    sessionId,
    phone: e164,
    isGuest: true,
    captureSource: 'appel_manque',
    contextMessage: ligne,
    ringoverCallIds: ref ? [ref] : [],
    status: 'abandoned',
    abandonedAt: horodatage,
    lastActivityAt: horodatage,
  });

  const sms = await accuserReception(cree._id, e164, ctx);
  return { ok: true, action: 'lead_cree', leadId: String(cree._id), resume, sms };
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Réponse du client par SMS                                               */
/* ──────────────────────────────────────────────────────────────────────── */

/**
 * Le client répond à notre accusé de réception. La réponse arrive dans Ringover
 * (où le standardiste la voit), et on la recopie ICI sur la fiche du lead pour
 * que l'historique reste complet — sinon la conversation se coupe en deux entre
 * les deux outils.
 *
 * On ne traite QUE les messages entrants : notre propre envoi déclenche aussi
 * un événement (`event: 'sent'`) qu'il ne faut pas réinjecter.
 */
async function recordSmsReply({ from, body, at, conversationId } = {}) {
  if (mongoose.connection.readyState !== 1) return { ok: false, action: 'db_down' };

  const e164 = toE164(from);
  const texte = String(body || '').trim();
  if (!phoneKey(e164)) return { ok: false, action: 'numero_invalide' };
  if (!texte) return { ok: false, action: 'message_vide' };

  const quand = at ? new Date(at) : new Date();
  const horodatage = Number.isNaN(quand.getTime()) ? new Date() : quand;
  const { leadId, resume, savId } = await findContext(e164);

  /* Le contexte est ACCOLÉ à la réponse : sans lui, celui qui lit « ma boite
     fait du bruit » ne sait pas s'il s'agit d'une vente ou d'un SAV, et doit
     aller chercher. Avec, le tri prend une seconde. */
  const ligne = 'RÉPONSE SMS du client : « ' + texte.slice(0, 500) + ' »'
    + (resume ? ' — ' + resume : '');

  /* Numéro inconnu : on crée quand même une fiche. Quelqu'un qui répond à un
     SMS est un contact vivant — le perdre serait pire que d'avoir un doublon. */
  if (!leadId) {
    const cree = await AbandonedCart.create({
      sessionId: 'ringover-sms:' + (conversationId || horodatage.getTime()),
      phone: e164,
      isGuest: true,
      captureSource: 'appel_manque',
      contextMessage: ligne,
      status: 'abandoned',
      abandonedAt: horodatage,
      lastActivityAt: horodatage,
    });
    return { ok: true, action: 'lead_cree', leadId: String(cree._id) };
  }

  await AbandonedCart.updateOne({ _id: leadId }, {
    /* lastActivityAt remonte la fiche en tête de liste : une réponse est le
       signal le plus chaud qu'on puisse recevoir. */
    $set: { lastActivityAt: horodatage },
    $push: { notes: { text: ligne, addedByName: 'Ringover SMS', addedAt: horodatage } },
  });

  /* Ticket SAV ouvert : on RECOPIE la réponse dedans, EN PLUS du lead. Le SAV
     travaille depuis /admin/sav/tickets et ne regarde pas la liste des leads —
     sans ça, un message de litige resterait invisible pour l'équipe concernée.
     On ne DÉPLACE pas : deviner qu'un message est du SAV plutôt qu'une vente
     n'est pas fiable, et un dossier mal aiguillé attend dans la mauvaise file. */
  let versSav = false;
  if (savId) {
    try {
      await SavTicket.updateOne({ _id: savId }, {
        $push: { messages: { date: horodatage, auteur: 'Client (SMS)', canal: 'tel', contenu: texte.slice(0, 2000) } },
      });
      versSav = true;
    } catch (err) {
      console.error('[ringover] recopie vers le ticket SAV :', err && err.message ? err.message : err);
    }
  }
  return { ok: true, action: 'reponse_enregistree', leadId, versSav };
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Code saisi dans le menu vocal                                           */
/* ──────────────────────────────────────────────────────────────────────── */

/**
 * Événement `ivr_response_code` : le client a saisi un code dans un scénario
 * « Demander un code ». C'est le SEUL signal de motif que Ringover expose —
 * mais il suppose que le SVI soit configuré en scénario de saisie, pas en
 * simple menu « tapez 1 ou 2 ».
 *
 * RINGOVER_IVR_CODES traduit le code en libellé : "1=commercial,2=sav".
 *
 * Cet événement peut arriver AVANT l'appel manqué (le client tape son choix
 * puis attend). Si aucune fiche n'existe encore, on n'en crée pas : l'appel
 * manqué s'en chargera, et un code sans appel n'a pas d'intérêt commercial.
 */
async function recordIvrCode({ code, from, callId, at } = {}) {
  if (mongoose.connection.readyState !== 1) return { ok: false, action: 'db_down' };

  const e164 = toE164(from);
  if (!phoneKey(e164)) return { ok: false, action: 'numero_invalide' };
  const brut = String(code == null ? '' : code).trim();
  if (!brut) return { ok: false, action: 'code_absent' };

  const table = new Map();
  String(process.env.RINGOVER_IVR_CODES || '').split(',').forEach((p) => {
    const [k, v] = p.split('=');
    if (k && v) table.set(k.trim(), v.trim().slice(0, 40));
  });
  const libelle = table.get(brut) || '';

  const quand = at ? new Date(at) : new Date();
  const horodatage = Number.isNaN(quand.getTime()) ? new Date() : quand;
  const ligne = 'Menu vocal : le client a saisi « ' + brut + ' »'
    + (libelle ? ' (' + libelle + ')' : '');

  const { leadId } = await findContext(e164);
  if (!leadId) return { ok: true, action: 'aucune_fiche', motif: libelle };

  await AbandonedCart.updateOne({ _id: leadId }, {
    $set: { lastActivityAt: horodatage },
    $push: { notes: { text: ligne, addedByName: 'Ringover SVI', addedAt: horodatage } },
  });
  return { ok: true, action: 'code_enregistre', leadId, motif: libelle };
}

module.exports = {
  toE164, phoneKey, motifFromReceiver, findContext,
  recordMissedCall, recordSmsReply, recordIvrCode,
};
