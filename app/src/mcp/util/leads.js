'use strict';

// Outils partagés par les outils « leads » du connecteur.
//
// Ce que rend un lead : la demande (pièce, véhicule, plaque, VIN), l'étape et
// l'onglet de la file « À traiter » (mêmes calculs que le back-office), la
// prochaine action, qui le suit, le dernier appel et la dernière note.
// Jamais le numéro de téléphone : `has_phone` et `can_call` suffisent pour
// savoir s'il faut passer la main à l'équipe.

const mongoose = require('mongoose');
const { libelleUrgence, TYPES_ACTION } = require('../../services/leadWork');
const { resumeDemande } = require('../../services/leadResume');
const { getCaptureSourceLabel } = require('../../controllers/abandonedCartAdminController');
const { iso } = require('./sav');

/** Auteur des notes et des actions posées par le connecteur. */
const CONNECTEUR = Object.freeze({ id: null, court: 'Claude', nom: 'Claude (connecteur)' });

/** Libellés des prochaines actions, y compris celles qui ne se choisissent pas. */
const LIBELLES_ACTION = Object.assign({}, TYPES_ACTION, { devis_envoye: 'Devis envoyé' });

function isLeadId(id) {
  return typeof id === 'string' && /^[a-f0-9]{24}$/i.test(id.trim()) && mongoose.Types.ObjectId.isValid(id.trim());
}

function cut(text, n) {
  const s = String(text || '').trim();
  if (!s) return '';
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
}

function euros(cents) {
  const n = Number(cents);
  return Number.isFinite(n) && n > 0 ? Math.round(n) / 100 : 0;
}

function nomClient(lead) {
  return [lead.firstName, lead.lastName].map((x) => String(x || '').trim()).filter(Boolean).join(' ') || null;
}

/**
 * Vue courte d'un lead, pour une liste.
 * @param {object} lead document AbandonedCart (lean)
 * @param {object} work résultat de computeWork(lead, now)
 */
function resumeLead(lead, work, now = new Date()) {
  const l = lead || {};
  const w = work || {};
  const r = l.requested || {};
  const d = resumeDemande(l);
  const na = l.nextAction || {};
  const notes = Array.isArray(l.notes) ? l.notes : [];
  const derniere = notes.length ? notes[notes.length - 1] : null;
  const id = String(l._id);
  return {
    id,
    received_at: iso(w.receivedAt),
    source: getCaptureSourceLabel(l.captureSource).label,
    client: nomClient(l),
    client_email: l.email || null,
    has_phone: !!l.phone,
    can_call: !!w.canCall,
    part: d.piece || null,
    vehicle: d.vehicule || null,
    plate: String(r.plate || '').trim() || null,
    vin: String(r.vin || '').trim() || null,
    request_ref: String(r.ref || '').trim() || null,
    request_message: cut(r.message, 300) || null,
    cart_items: (Array.isArray(l.items) ? l.items : []).map((i) => i && i.name).filter(Boolean).slice(0, 5),
    cart_amount_eur: euros(l.totalAmountCents),
    stage: w.stage || null,
    stage_label: w.stageLabel || null,
    group: w.group || null,
    urgency: libelleUrgence(w, now) || null,
    next_action: na.type
      ? { type: na.type, label: LIBELLES_ACTION[na.type] || na.type, due_at: iso(na.dueAt), note: na.note || '', set_by: na.setByName || '' }
      : (w.nextActionLabel ? { type: null, label: w.nextActionLabel, due_at: iso(w.dueAt), note: '', set_by: 'file (déduit)' } : null),
    taken_by: l.takenByName || null,
    last_call: l.lastCallOutcome && l.lastCallOutcome.outcome
      ? { outcome: l.lastCallOutcome.outcome, at: iso(l.lastCallOutcome.at), by: l.lastCallOutcome.byName || '' }
      : null,
    last_human_contact_at: iso(w.lastHumanAt),
    last_note: derniere ? { text: cut(derniere.text, 300), by: derniere.addedByName || '', at: iso(derniere.addedAt) } : null,
    engine_quote_status: (l.engineQuote && l.engineQuote.status) || null,
    has_workshop: !!w.hasWorkshop,
    archived: !!l.archived,
    back_office_path: `/admin/activite-panier?lead=${id}`,
  };
}

module.exports = { CONNECTEUR, LIBELLES_ACTION, isLeadId, cut, euros, resumeLead };
