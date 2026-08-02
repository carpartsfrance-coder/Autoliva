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
 *     On déduit donc le motif du NUMÉRO APPELÉ : si le SVI route « 1 » et « 2 »
 *     vers deux numéros distincts, `RINGOVER_NUMBER_MAP` les traduit en motif.
 *     Sans cette carte, le motif reste inconnu — jamais deviné.
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
 * Le SVI de Ringover route le choix « 1 » / « 2 » vers des numéros différents ;
 * c'est le seul signal de motif présent dans le webhook.
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

  try {
    const lead = await AbandonedCart.findOne({ phone: rx })
      .sort({ lastActivityAt: -1 })
      .select('_id firstName lastName email engineQuote.status captureSource createdAt')
      .lean();
    if (lead) {
      leadId = String(lead._id);
      const nom = [lead.firstName, lead.lastName].filter(Boolean).join(' ').trim();
      if (nom) bits.push(nom);
      const eq = lead.engineQuote && lead.engineQuote.status;
      if (eq === 'new') bits.push('devis moteur EN ATTENTE de chiffrage');
      else if (eq === 'quote_sent') bits.push('devis moteur envoyé, sans réponse');
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
    }
  } catch (_) { /* idem */ }

  try {
    const sav = await SavTicket.findOne({
      'client.telephone': rx,
      statut: { $nin: ['clos', 'cloture', 'resolu'] },
    }).sort({ createdAt: -1 }).select('numero motif statut').lean();
    if (sav) bits.push('SAV ' + sav.numero + ' ouvert (' + sav.motif + ')');
  } catch (_) { /* idem */ }

  return { resume: bits.join(' · '), leadId };
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Enregistrement de l'appel manqué                                        */
/* ──────────────────────────────────────────────────────────────────────── */

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
  const { resume, leadId } = await findContext(e164);

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
    return { ok: true, action: 'lead_enrichi', leadId, resume };
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

  return { ok: true, action: 'lead_cree', leadId: String(cree._id), resume };
}

module.exports = { toE164, phoneKey, motifFromReceiver, findContext, recordMissedCall };
