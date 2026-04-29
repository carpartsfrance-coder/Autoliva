/*
 * SAV — Finite State Machine
 * ---------------------------------------------------------------
 * Source de vérité unique pour :
 *   - les statuts valides d'un ticket SAV
 *   - les transitions autorisées (qui peut aller où)
 *   - le libellé humain de chaque statut
 *   - la famille logique (DSG / logistique / commercial / compta / terminal)
 *
 * Toute modification de statut doit passer par canTransition() / assertTransition()
 * afin de garantir l'intégrité (plus de statut "forcé" depuis un bouton admin).
 */

// Labels humains (réutilisés par l'UI admin et les emails)
const STATUT_LABELS = {
  ouvert: 'Ouvert',
  pre_qualification: 'Pré-qualification',
  en_attente_documents: 'En attente documents',
  retour_demande: 'Retour demandé',
  en_transit_retour: 'En transit (retour)',
  recu_atelier: 'Reçu atelier',
  en_analyse: 'En analyse',
  analyse_terminee: 'Analyse terminée',
  en_attente_decision_client: 'Attente décision client',
  en_attente_fournisseur: 'Attente fournisseur',
  remboursement_initie: 'Remboursement initié',
  resolu_garantie: 'Résolu (garantie)',
  resolu_facture: 'Résolu (facturé)',
  reserve_transporteur: 'Réserve transporteur',
  enquete_transporteur: 'Enquête transporteur',
  retractation_recue: 'Rétractation reçue',
  clos: 'Clos',
  refuse: 'Refusé',
};

// Famille logique → sert au filtrage dashboard + styling pill
const STATUT_FAMILY = {
  ouvert: 'entree',
  pre_qualification: 'dsg',
  en_attente_documents: 'dsg',
  retour_demande: 'dsg',
  en_transit_retour: 'dsg',
  recu_atelier: 'dsg',
  en_analyse: 'dsg',
  analyse_terminee: 'dsg',
  en_attente_decision_client: 'commercial',
  en_attente_fournisseur: 'sav_general',
  remboursement_initie: 'compta',
  resolu_garantie: 'terminal',
  resolu_facture: 'terminal',
  reserve_transporteur: 'logistique',
  enquete_transporteur: 'logistique',
  retractation_recue: 'commercial',
  clos: 'terminal',
  refuse: 'terminal',
};

// Statuts terminaux (pas de transition sortante sauf ré-ouverture)
const TERMINAL_STATUTS = ['clos', 'resolu_garantie', 'resolu_facture', 'refuse'];

// Transitions autorisées : statut → [statuts atteignables]
// Note : depuis n'importe quel statut non-terminal on peut aller vers "refuse" ou "clos"
// (fallback admin). Les transitions "nominales" sont listées ici.
const TRANSITIONS = {
  // ── Entrée ───────────────────────────────────────────────
  ouvert: [
    'pre_qualification', 'en_attente_documents', 'en_attente_decision_client',
    'retour_demande', 'reserve_transporteur', 'enquete_transporteur', 'retractation_recue',
    'en_attente_fournisseur', 'remboursement_initie',
    'resolu_garantie', 'resolu_facture', 'clos', 'refuse',
  ],

  // ── Flow DSG (pièce défectueuse) ─────────────────────────
  pre_qualification: ['en_attente_documents', 'retour_demande', 'refuse', 'clos'],
  en_attente_documents: ['pre_qualification', 'retour_demande', 'refuse', 'clos'],
  retour_demande: ['en_transit_retour', 'recu_atelier', 'remboursement_initie', 'refuse', 'clos'],
  en_transit_retour: ['recu_atelier', 'refuse', 'clos'],
  recu_atelier: ['en_analyse', 'en_attente_decision_client', 'refuse', 'clos'],
  en_analyse: ['analyse_terminee', 'en_attente_fournisseur'],
  analyse_terminee: ['en_attente_decision_client', 'en_attente_fournisseur', 'resolu_garantie', 'resolu_facture', 'clos'],
  en_attente_decision_client: ['resolu_garantie', 'resolu_facture', 'remboursement_initie', 'clos', 'refuse'],

  // ── Flow Logistique (colis) ──────────────────────────────
  reserve_transporteur: ['enquete_transporteur', 'en_attente_decision_client', 'remboursement_initie', 'resolu_garantie', 'refuse', 'clos'],
  enquete_transporteur: ['reserve_transporteur', 'en_attente_decision_client', 'remboursement_initie', 'resolu_garantie', 'resolu_facture', 'refuse', 'clos'],

  // ── Flow Commercial / Compta ─────────────────────────────
  retractation_recue: ['retour_demande', 'en_transit_retour', 'remboursement_initie', 'en_attente_decision_client', 'refuse', 'clos'],
  en_attente_fournisseur: ['analyse_terminee', 'en_analyse', 'en_attente_decision_client', 'resolu_garantie', 'resolu_facture', 'clos'],
  remboursement_initie: ['resolu_garantie', 'resolu_facture', 'clos'],

  // ── Terminaux (ré-ouverture autorisée vers "ouvert") ────
  resolu_garantie: ['clos', 'ouvert'],
  resolu_facture: ['clos', 'ouvert'],
  clos: ['ouvert'],
  refuse: ['ouvert'],
};

function listStatuts() {
  return Object.keys(STATUT_LABELS);
}

function isValidStatut(s) {
  return Object.prototype.hasOwnProperty.call(STATUT_LABELS, s);
}

function isTerminal(s) {
  return TERMINAL_STATUTS.indexOf(s) !== -1;
}

function labelOf(s) {
  return STATUT_LABELS[s] || s;
}

function familyOf(s) {
  return STATUT_FAMILY[s] || 'autre';
}

function allowedNext(current) {
  if (!isValidStatut(current)) return [];
  return (TRANSITIONS[current] || []).slice();
}

function canTransition(from, to) {
  if (!isValidStatut(from) || !isValidStatut(to)) return false;
  if (from === to) return false;
  return allowedNext(from).indexOf(to) !== -1;
}

/**
 * Lance une erreur explicite si la transition est refusée.
 * Utilisé côté API pour bloquer tout forçage de statut.
 */
function assertTransition(from, to) {
  if (!isValidStatut(to)) {
    throw new Error(`Statut cible inconnu : "${to}"`);
  }
  if (!isValidStatut(from)) {
    throw new Error(`Statut actuel inconnu : "${from}"`);
  }
  if (from === to) {
    throw new Error('Le ticket est déjà dans ce statut.');
  }
  if (!canTransition(from, to)) {
    const label = labelOf(to);
    const allowed = allowedNext(from).map(labelOf).join(', ') || '(aucun)';
    throw new Error(
      `Transition refusée : ${labelOf(from)} → ${label}. Transitions autorisées depuis "${labelOf(from)}" : ${allowed}.`
    );
  }
  return true;
}

module.exports = {
  STATUT_LABELS,
  STATUT_FAMILY,
  TERMINAL_STATUTS,
  TRANSITIONS,
  listStatuts,
  isValidStatut,
  isTerminal,
  labelOf,
  familyOf,
  allowedNext,
  canTransition,
  assertTransition,
};
