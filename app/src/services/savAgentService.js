'use strict';

/**
 * Couche "agent API" SAV : mappe le modèle interne (SavTicket + playbook + FSM)
 * vers le contrat d'API documenté (references/api-contract.md), consommé par le
 * skill sav-autoliva. Lecture seule (Phase 1) — aucune écriture ici.
 */

const SavTicket = require('../models/SavTicket');
const FSM = require('../config/savStateMachine');
const { playbookForTicket, PLAYBOOKS } = require('../config/savPlaybooks');

const TERMINAL = FSM.TERMINAL_STATUTS.concat(['clos_sans_reponse']);

function publicBase() {
  return (process.env.PUBLIC_BASE_URL || process.env.SITE_URL || 'https://autoliva.com').replace(/\/$/, '');
}

function absUrl(url) {
  if (!url) return null;
  if (/^https?:\/\//i.test(url)) return url;
  return publicBase() + (url.startsWith('/') ? url : '/' + url);
}

function iso(d) {
  return d ? new Date(d).toISOString() : null;
}

/* ─── SLA ──────────────────────────────────────────────────────────────── */

function slaInfo(ticket) {
  const due = ticket.sla && ticket.sla.dateLimite ? new Date(ticket.sla.dateLimite) : null;
  if (!due) return { label: '', overdue_days: 0, due_at: null };
  const now = Date.now();
  const diffMs = now - due.getTime();
  if (diffMs > 0) {
    const overdueDays = Math.floor(diffMs / 86400000);
    return { label: `DÉPASSÉ ${overdueDays}J`, overdue_days: overdueDays, due_at: due.toISOString() };
  }
  const remaining = Math.ceil((due.getTime() - now) / 86400000);
  return { label: remaining <= 0 ? "Aujourd'hui" : `${remaining}J`, overdue_days: 0, due_at: due.toISOString() };
}

/* ─── Action recommandée (depuis le playbook) ──────────────────────────── */

function macroType(macro) {
  const id = String(macro.id || '').toLowerCase();
  if (/photo/.test(id)) return 'request_photo';
  if (/doc/.test(id)) return 'request_documents';
  if (/escalad|fournisseur/.test(id)) return 'escalate';
  if (macro.action === 'email') return 'reply';
  return 'status';
}

function recommendedAction(pb) {
  if (!pb) return null;
  const macros = pb.macros || [];
  const rec = macros.find((m) => m.recommended) || macros[0];
  const stepLabel = (pb.steps && pb.currentStepIndex >= 0 && pb.steps[pb.currentStepIndex])
    ? pb.steps[pb.currentStepIndex].label : '';
  const rationale = `Playbook: ${stepLabel ? 'étape ' + stepLabel + ', ' : ''}motif ${pb.motif}.`;
  if (rec) {
    return {
      type: macroType(rec),
      label: rec.label,
      macro_id: rec.id || null,
      template_id: rec.templateId || null,
      next_status: rec.nextStatut || null,
      rationale,
    };
  }
  const next = (pb.allowedNextStatuts || [])[0];
  if (next) {
    return { type: 'status', label: 'Passer à : ' + next.label, macro_id: null, template_id: null, next_status: next.key, rationale };
  }
  return null;
}

/* ─── Sérialiseurs ─────────────────────────────────────────────────────── */

function lastMessage(ticket) {
  const msgs = ticket.messages || [];
  if (!msgs.length) return null;
  const m = msgs[msgs.length - 1];
  const body = String(m.contenu || '');
  return {
    from: m.auteur === 'client' ? 'client' : (m.auteur === 'systeme' ? 'system' : 'agent'),
    channel: m.canal || '',
    at: iso(m.date),
    excerpt: body.length > 160 ? body.slice(0, 157) + '…' : body,
  };
}

function serializeQueueItem(ticket, pb) {
  const sla = slaInfo(ticket);
  return {
    id: ticket.numero,
    motif: ticket.motifSav,
    status: ticket.statut,
    status_label: FSM.labelOf(ticket.statut),
    client: { name: (ticket.client && ticket.client.nom) || '', email: (ticket.client && ticket.client.email) || '' },
    vehicle: {
      make: (ticket.vehicule && ticket.vehicule.marque) || '—',
      model: (ticket.vehicule && ticket.vehicule.modele) || '—',
      year: (ticket.vehicule && ticket.vehicule.annee) || null,
      vin: (ticket.vehicule && ticket.vehicule.vin) || null,
    },
    order_id: ticket.numeroCommande || null,
    team: ticket.assignedTeam,
    assignee: ticket.assignedToName || null,
    sla,
    last_message: lastMessage(ticket),
    recommended_action: recommendedAction(pb),
  };
}

function serializeMessage(m) {
  return {
    id: String(m._id || ''),
    channel: m.canal || '',
    from: m.auteur === 'client' ? 'client' : (m.auteur === 'systeme' ? 'system' : 'agent'),
    at: iso(m.date),
    body: m.contenu || '',
    attachments: (m.attachments || []).map((a) => ({
      id: a.url ? a.url.split('/').pop() : '',
      name: a.originalName || '',
      size: a.size || 0,
      mime: a.mime || '',
      kind: a.kind || '',
      url: absUrl(a.url),
    })),
  };
}

async function serializeTicketDetail(ticket, pb) {
  const pieceType = ticket.pieceType || '';
  return {
    id: ticket.numero,
    motif: ticket.motifSav,
    status: ticket.statut,
    status_label: FSM.labelOf(ticket.statut),
    team: ticket.assignedTeam,
    assignee: ticket.assignedToName || null,
    created_at: iso(ticket.createdAt),
    updated_at: iso(ticket.updatedAt),
    client: {
      name: (ticket.client && ticket.client.nom) || '',
      email: (ticket.client && ticket.client.email) || '',
      phone: (ticket.client && ticket.client.telephone) || '',
      type: (ticket.client && ticket.client.type) || 'B2C',
    },
    vehicle: {
      make: (ticket.vehicule && ticket.vehicule.marque) || null,
      model: (ticket.vehicule && ticket.vehicule.modele) || null,
      year: (ticket.vehicule && ticket.vehicule.annee) || null,
      vin: (ticket.vehicule && ticket.vehicule.vin) || null,
      plate: (ticket.vehicule && ticket.vehicule.immatriculation) || null,
    },
    part: { label: pieceType || null, type: pieceType || null, ref: ticket.referencePiece || null },
    order: { id: ticket.numeroCommande || null, found_in_db: false, items: [], shipped_at: null, carrier: (ticket.livraison && ticket.livraison.transporteur) || null, tracking: (ticket.livraison && ticket.livraison.numeroSuivi) || null },
    sla: slaInfo(ticket),
    playbook: { next_action: recommendedAction(pb), current_step: (pb && pb.steps && pb.currentStepIndex >= 0 && pb.steps[pb.currentStepIndex]) ? pb.steps[pb.currentStepIndex].key : null, allowed_next_status: (pb && pb.allowedNextStatuts) || [] },
    messages: (ticket.messages || []).map(serializeMessage),
    internal_notes: (ticket.pinnedNotes || []).map((n) => ({ id: String(n._id || ''), at: iso(n.createdAt), author: n.auteur || '', body: n.texte || '' })),
    briefing: (ticket.diagnostic && ticket.diagnostic.description) ? String(ticket.diagnostic.description).slice(0, 600) : '',
  };
}

/* ─── Queue ────────────────────────────────────────────────────────────── */

function buildQueueQuery(params) {
  const q = { archivedAt: { $in: [null, undefined] } };
  if (params.team) q.assignedTeam = params.team;
  if (params.motif) q.motifSav = params.motif;
  if (params.status) q.statut = params.status;
  if (params.assignee) q.assignedToUserId = params.assignee;
  if (String(params.only_overdue) === 'true') {
    q['sla.dateLimite'] = { $lt: new Date() };
    if (!q.statut) q.statut = { $nin: TERMINAL };
  }
  return q;
}

async function getQueue(params) {
  const query = buildQueueQuery(params || {});
  const limit = Math.min(Math.max(parseInt(params && params.limit, 10) || 50, 1), 100);
  const offset = Math.max(parseInt(params && params.cursor, 10) || 0, 0);

  const docs = await SavTicket.find(query)
    .sort({ 'sla.dateLimite': 1, createdAt: 1 })
    .skip(offset)
    .limit(limit + 1)
    .lean();

  const hasMore = docs.length > limit;
  const page = hasMore ? docs.slice(0, limit) : docs;
  const tickets = page.map((t) => serializeQueueItem(t, playbookForTicket(t)));

  // Compteurs globaux (indépendants de la pagination)
  const now = new Date();
  const notTerminal = { statut: { $nin: TERMINAL }, archivedAt: { $in: [null, undefined] } };
  const [open, overdue, clientReplied, awaitingClient] = await Promise.all([
    SavTicket.countDocuments(notTerminal),
    SavTicket.countDocuments({ ...notTerminal, 'sla.dateLimite': { $lt: now } }),
    SavTicket.countDocuments({ ...notTerminal, $expr: { $and: [{ $ne: ['$lastClientMessageAt', null] }, { $or: [{ $eq: ['$lastAdminMessageAt', null] }, { $gt: ['$lastClientMessageAt', '$lastAdminMessageAt'] }] }] } }),
    SavTicket.countDocuments({ ...notTerminal, $expr: { $and: [{ $ne: ['$lastAdminMessageAt', null] }, { $or: [{ $eq: ['$lastClientMessageAt', null] }, { $gt: ['$lastAdminMessageAt', '$lastClientMessageAt'] }] }] } }),
  ]);

  return {
    generated_at: now.toISOString(),
    counts: { open, overdue, client_replied: clientReplied, awaiting_client: awaitingClient },
    tickets,
    next_cursor: hasMore ? String(offset + limit) : null,
  };
}

async function getTicket(numero) {
  const ticket = await SavTicket.findOne({ numero }).lean();
  if (!ticket) return null;
  const pb = playbookForTicket(ticket);
  return serializeTicketDetail(ticket, pb);
}

/* ─── Templates (depuis les playbooks) ─────────────────────────────────── */

function getTemplates() {
  const out = [];
  const seen = new Set();
  Object.keys(PLAYBOOKS || {}).forEach((motif) => {
    const pb = PLAYBOOKS[motif];
    (pb.templates || []).forEach((t) => {
      const id = t.key;
      if (seen.has(id)) return;
      seen.add(id);
      const body = String(t.body || '');
      const variables = Array.from(new Set((body.match(/\{(\w+)\}/g) || []).map((m) => m.slice(1, -1))));
      out.push({ id, name: t.label || id, channel: 'client', motif, body, variables });
    });
  });
  return { templates: out };
}

/* ─── Report (digest) ──────────────────────────────────────────────────── */

async function getReport(period) {
  const now = new Date();
  const since = new Date(now.getTime() - (period === 'week' ? 7 : 1) * 86400000);
  const notTerminal = { statut: { $nin: TERMINAL }, archivedAt: { $in: [null, undefined] } };

  const [open, created, closed, overdue, byMotifAgg, byTeamAgg, agingAgg, needsHuman] = await Promise.all([
    SavTicket.countDocuments(notTerminal),
    SavTicket.countDocuments({ createdAt: { $gte: since } }),
    SavTicket.countDocuments({ statut: { $in: TERMINAL }, updatedAt: { $gte: since } }),
    SavTicket.countDocuments({ ...notTerminal, 'sla.dateLimite': { $lt: now } }),
    SavTicket.aggregate([{ $match: notTerminal }, { $group: { _id: '$motifSav', n: { $sum: 1 } } }]),
    SavTicket.aggregate([{ $match: notTerminal }, { $group: { _id: '$assignedTeam', n: { $sum: 1 } } }]),
    SavTicket.aggregate([
      { $match: { ...notTerminal, 'sla.dateLimite': { $lt: now } } },
      { $project: { days: { $floor: { $divide: [{ $subtract: [now, '$sla.dateLimite'] }, 86400000] } } } },
      { $group: { _id: { $cond: [{ $gte: ['$days', 15] }, '>15j', { $cond: [{ $gte: ['$days', 7] }, '7-15j', '<7j'] }] }, count: { $sum: 1 } } },
    ]),
    SavTicket.find({ ...notTerminal, 'sla.dateLimite': { $lt: now } }).sort({ 'sla.dateLimite': 1 }).limit(10).lean(),
  ]);

  const by_motif = {};
  byMotifAgg.forEach((r) => { by_motif[r._id || 'autre'] = r.n; });
  const by_team = {};
  byTeamAgg.forEach((r) => { by_team[r._id || 'sav_general'] = r.n; });
  const aging = agingAgg.map((r) => ({ bucket: r._id, count: r.count }));

  return {
    period: period === 'week' ? 'week' : 'today',
    totals: { open, created, closed, overdue },
    by_motif,
    by_team,
    aging,
    needs_human: needsHuman.map((t) => ({ id: t.numero, why: `${FSM.labelOf(t.statut)}, ${slaInfo(t).label}` })),
  };
}

module.exports = {
  getQueue,
  getTicket,
  getTemplates,
  getReport,
  // exportés pour tests
  _internal: { slaInfo, recommendedAction, serializeQueueItem, serializeTicketDetail, buildQueueQuery, TERMINAL },
};
