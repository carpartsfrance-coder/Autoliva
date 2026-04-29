/*
 * SAV — Moteur de priorité
 * ---------------------------------------------------------------
 * Calcule un score numérique pour classer les tickets dans la queue
 * d'un agent. Plus le score est élevé, plus le ticket est prioritaire.
 *
 * Composants du score (additif) :
 *   - SLA : pondération forte en fonction des heures restantes avant breach
 *   - Motif : coef selon la criticité métier (colis_abime > facture_document)
 *   - Montant commande : booster proportionnel (commandes premium)
 *   - Awaiting client vs Awaiting us : les tickets où la balle est chez nous
 *     sont boostés (c'est à nous de jouer)
 *   - Ancienneté : petit coef pour éviter qu'un ticket stagne indéfiniment
 */

// Coefficients par motif (1.0 = neutre)
const MOTIF_WEIGHT = {
  piece_defectueuse: 1.2,   // flow DSG long, impact client fort
  colis_abime: 1.4,          // délai légal 3 jours pour la réserve
  colis_non_recu: 1.3,       // client frustré, montant bloqué
  retard_livraison: 1.1,
  erreur_preparation: 1.25,  // responsabilité claire, doit être rapide
  retractation: 1.0,         // cadre légal, délai 14 jours
  non_compatible: 0.9,
  facture_document: 0.7,     // peu critique
  remboursement: 1.1,
  autre: 0.8,
};

// Statuts où c'est à NOUS de jouer (on boost la priorité)
const OUR_MOVE_STATUS = new Set([
  'ouvert',
  'pre_qualification',
  'recu_atelier',
  'en_analyse',
  'analyse_terminee',
  'reserve_transporteur',
  'retractation_recue',
  'remboursement_initie',
]);

// Statuts où on attend le client/transporteur/fournisseur (priorité plus faible)
const WAITING_STATUS = new Set([
  'en_attente_documents',
  'en_transit_retour',
  'en_attente_decision_client',
  'en_attente_fournisseur',
  'enquete_transporteur',
]);

// Statuts terminaux (jamais dans la queue)
const TERMINAL_STATUS = new Set(['clos', 'refuse', 'resolu_garantie', 'resolu_facture']);

function hoursBetween(a, b) {
  if (!a || !b) return null;
  return (new Date(b).getTime() - new Date(a).getTime()) / 3600000;
}

/**
 * Score SLA : fonction décroissante du temps restant.
 *   > 48 h restantes  →  0 à 10
 *     0 - 48 h        →  10 à 50
 *     breach (< 0)    →  50 à 200 (plus c'est dépassé, plus ça monte)
 */
function slaScore(ticket) {
  const limite = ticket.sla && ticket.sla.dateLimite;
  if (!limite) return 5; // pas de SLA → faible score par défaut
  const h = hoursBetween(new Date(), limite);
  if (h == null) return 5;
  if (h < 0) {
    // En breach : score d'autant plus élevé que ça date
    return Math.min(200, 50 + Math.abs(h) * 2);
  }
  if (h > 48) return Math.max(0, 10 - (h - 48) / 24);
  // 0 - 48 h restantes : score 50 → 10 (plus c'est proche, plus ça monte)
  return 10 + (48 - h) * (40 / 48);
}

/**
 * Booster montant : log scaling pour lisser l'impact des grosses commandes.
 */
function amountBoost(ticket) {
  const montant = (ticket.montantCommande || ticket.order && ticket.order.total) || 0;
  if (montant <= 0) return 0;
  return Math.min(20, Math.log10(1 + montant) * 4);
}

function agingBoost(ticket) {
  if (!ticket.createdAt) return 0;
  const days = Math.max(0, (Date.now() - new Date(ticket.createdAt).getTime()) / 86400000);
  // +0.5 point par jour, cap à 10
  return Math.min(10, days * 0.5);
}

function motifWeight(ticket) {
  return MOTIF_WEIGHT[ticket.motifSav] || 1.0;
}

function moveBoost(ticket) {
  if (OUR_MOVE_STATUS.has(ticket.statut)) return 15;
  if (WAITING_STATUS.has(ticket.statut)) return -10;
  return 0;
}

/**
 * Score final d'un ticket. Les tickets terminaux renvoient -Infinity
 * pour garantir qu'ils ne remontent jamais dans une queue.
 */
function computeScore(ticket) {
  if (!ticket || TERMINAL_STATUS.has(ticket.statut)) return -Infinity;
  const sla = slaScore(ticket);
  const base = sla + amountBoost(ticket) + agingBoost(ticket) + moveBoost(ticket);
  return base * motifWeight(ticket);
}

/**
 * Retourne un objet avec le score décomposé — utile pour l'UI
 * ("pourquoi ce ticket est en tête ?") ou le debug.
 */
function explainScore(ticket) {
  const sla = slaScore(ticket);
  const amount = amountBoost(ticket);
  const aging = agingBoost(ticket);
  const move = moveBoost(ticket);
  const weight = motifWeight(ticket);
  const total = (sla + amount + aging + move) * weight;
  return {
    total: Math.round(total * 10) / 10,
    sla: Math.round(sla * 10) / 10,
    amount: Math.round(amount * 10) / 10,
    aging: Math.round(aging * 10) / 10,
    move,
    motifWeight: weight,
  };
}

/**
 * Trie une liste de tickets par priorité décroissante.
 * Mutation en place ET retour de la liste (pour chaîner).
 */
function sortByPriority(tickets) {
  return tickets
    .map((t) => ({ t, score: computeScore(t) }))
    .sort((a, b) => b.score - a.score)
    .map((x) => Object.assign(x.t, { _priorityScore: x.score }));
}

module.exports = {
  MOTIF_WEIGHT,
  OUR_MOVE_STATUS,
  WAITING_STATUS,
  TERMINAL_STATUS,
  computeScore,
  explainScore,
  sortByPriority,
};
