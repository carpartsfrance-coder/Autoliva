'use strict';

/*
 * Statut d'approvisionnement de la pièce (par commande) — saisi manuellement,
 * indépendant du stock du site. Centralise libellés, badges et logique de retard
 * fournisseur. Utilisé par le contrôleur admin, les vues et l'endpoint d'édition.
 */

const DEFAULT_EXPECTED_DAYS = 7;

const STATUSES = ['a_verifier', 'a_commander', 'commandee', 'en_stock'];

const LABELS = {
  a_verifier:  { label: 'À vérifier',  badge: 'bg-slate-100 text-slate-700 border border-slate-200',     dot: 'bg-slate-400' },
  a_commander: { label: 'À commander', badge: 'bg-rose-50 text-rose-700 border border-rose-200',          dot: 'bg-rose-500' },
  commandee:   { label: 'Commandée',   badge: 'bg-blue-50 text-blue-700 border border-blue-200',          dot: 'bg-blue-500' },
  en_stock:    { label: 'En stock',    badge: 'bg-emerald-50 text-emerald-700 border border-emerald-200', dot: 'bg-emerald-500' },
};

// Statuts de commande où le sourcing est pertinent (avant expédition).
const PRESHIP_STATUSES = ['paid', 'processing', 'label_created'];

function normalizeStatus(s) {
  return STATUSES.indexOf(s) !== -1 ? s : 'a_verifier';
}

function labelFor(s) {
  return LABELS[normalizeStatus(s)];
}

/** Date limite de réception fournisseur (commandee + orderedAt + expectedDays). */
function dueDate(sourcing) {
  if (!sourcing || sourcing.status !== 'commandee' || !sourcing.orderedAt) return null;
  const days = Number(sourcing.expectedDays);
  if (!Number.isFinite(days) || days <= 0) return null;
  return new Date(new Date(sourcing.orderedAt).getTime() + days * 24 * 60 * 60 * 1000);
}

function isOverdue(sourcing, now) {
  const d = dueDate(sourcing);
  if (!d) return false;
  return d.getTime() < (now ? now.getTime() : Date.now());
}

function options() {
  return STATUSES.map((k) => ({ key: k, label: LABELS[k].label }));
}

module.exports = {
  DEFAULT_EXPECTED_DAYS,
  STATUSES,
  LABELS,
  PRESHIP_STATUSES,
  normalizeStatus,
  labelFor,
  dueDate,
  isOverdue,
  options,
};
