'use strict';

/*
 * Retour de l'ancienne pièce (le « core ») sur les ventes en échange standard.
 *
 * Deux informations coexistent sur une commande :
 *   - order.returnStatus  : pending → overdue → received… (liste « Consignes en
 *     attente », pastille du menu, frise de la commande, filtres « en retard ») ;
 *   - order.consigne.lines[].receivedAt : ce que coche le bouton « Marquer reçu »
 *     (et ce que lisent les relances e-mail automatiques).
 *
 * Avant ce module, « Marquer reçu » ne remplissait que la seconde : la commande
 * restait « en retard » partout ailleurs, alors que la page Consignes promet
 * qu'elle disparaît de la liste. On aligne donc returnStatus au moment du
 * clic, et on ignore à la lecture les commandes déjà entièrement reçues
 * (données passées, sans toucher à la base).
 */

/* Statuts « l'ancienne pièce n'est pas encore revenue ». */
const RETOUR_PAS_REVENU = ['pending', 'label_sent', 'in_transit', 'overdue'];

/* Morceau de requête Mongo : écarte les commandes dont TOUTES les lignes de
   consigne ont une date de réception. Sans ligne de consigne → gardée. */
const SAUF_CONSIGNE_TOUTE_RECUE = {
  $nor: [
    {
      'consigne.lines.0': { $exists: true },
      'consigne.lines': { $not: { $elemMatch: { receivedAt: null } } },
    },
  ],
};

function consigneToutRecue(order) {
  const lignes = order && order.consigne && Array.isArray(order.consigne.lines) ? order.consigne.lines : [];
  return lignes.length > 0 && lignes.every((l) => l && l.receivedAt);
}

function retourAttendu(order) {
  return !!order
    && (order.orderType === 'exchange' || order.orderType === 'exchange_cloning')
    && RETOUR_PAS_REVENU.includes(order.returnStatus)
    && !consigneToutRecue(order);
}

module.exports = {
  RETOUR_PAS_REVENU,
  SAUF_CONSIGNE_TOUTE_RECUE,
  consigneToutRecue,
  retourAttendu,
};
