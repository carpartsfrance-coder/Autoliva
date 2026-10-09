'use strict';

/**
 * Le pont entre une COMMANDE et ses tickets SAV.
 *
 * Les deux fiches s'ignoraient : le détail d'une commande ne chargeait jamais
 * SavTicket, et le détail d'un ticket n'affichait même pas le numéro de
 * commande. Pourtant `SavTicket.numeroCommande` est rempli sur 92 % des
 * tickets (185 sur 201, mesuré le 09/10/2026) et il est indexé — la jointure
 * ne coûte rien.
 *
 * Le rapprochement se fait sur le NUMÉRO, pas sur un ObjectId : c'est ce que
 * le SAV saisit, parfois à la main, et c'est aussi ce dont on dispose quand
 * le ticket est ouvert par un invité sans compte.
 */

const mongoose = require('mongoose');
const SavTicket = require('../models/SavTicket');

/**
 * Libellé + classes Tailwind par statut. Source unique : la liste vivait dans
 * accountSavController, qui la réexporte désormais d'ici — deux listes de
 * statuts qui divergent, c'est un ticket affiché « Clos » d'un côté et
 * « Ouvert » de l'autre.
 */
const STATUTS_LABELS = {
  ouvert: ['Ouvert', 'bg-sky-100 text-sky-800'],
  pre_qualification: ['En pré-qualification', 'bg-sky-100 text-sky-800'],
  en_attente_documents: ['Documents attendus', 'bg-amber-100 text-amber-800'],
  retour_demande: ['Retour demandé', 'bg-violet-100 text-violet-800'],
  en_transit_retour: ['En transit', 'bg-violet-100 text-violet-800'],
  recu_atelier: ['Reçu atelier', 'bg-violet-100 text-violet-800'],
  en_analyse: ['En analyse', 'bg-violet-100 text-violet-800'],
  analyse_terminee: ['Analyse terminée', 'bg-emerald-100 text-emerald-800'],
  en_attente_decision_client: ['Décision attendue', 'bg-amber-100 text-amber-800'],
  resolu_garantie: ['Résolu (garantie)', 'bg-emerald-100 text-emerald-800'],
  resolu_facture: ['Résolu (facturé)', 'bg-emerald-100 text-emerald-800'],
  clos: ['Clos', 'bg-slate-100 text-slate-700'],
  refuse: ['Refusé', 'bg-red-100 text-red-700'],
};

/**
 * Statuts qui ferment un dossier. Tout le reste est considéré OUVERT —
 * volontairement, et c'est le bon sens de l'erreur : un statut nouveau,
 * inconnu de cette liste, doit compter comme ouvert. Le coût d'un faux
 * « ouvert » est un avertissement de trop ; celui d'un faux « clos » est une
 * demande d'avis envoyée à un client en plein litige.
 */
const STATUTS_CLOS = new Set(['clos', 'clos_sans_reponse', 'refuse', 'resolu_garantie', 'resolu_facture']);

function estOuvert(ticket) {
  return !!ticket && !STATUTS_CLOS.has(String(ticket.statut || ''));
}

function libelle(statut) {
  return STATUTS_LABELS[statut] || [String(statut || '—'), 'bg-slate-100 text-slate-700'];
}

/**
 * Libellés des types de pièce. Le modèle ne stocke que des slugs
 * (« mecatronique », « arbre_transmission ») : lisibles à la rigueur, mais
 * un back-office qui affiche des identifiants techniques fait douter de ce
 * qu'il affiche ailleurs. Les variantes « legacy » (mecatronique_dq200…)
 * existent encore sur d'anciens tickets.
 */
const PIECES_LABELS = {
  mecatronique: 'Mécatronique',
  boite_vitesses: 'Boîte de vitesses',
  moteur: 'Moteur',
  arbre_transmission: 'Arbre de transmission',
  visco_coupleur: 'Visco-coupleur',
  turbo: 'Turbo',
  injecteur: 'Injecteur',
  boite_transfert: 'Boîte de transfert',
  pont: 'Pont',
  differentiel: 'Différentiel',
  haldex: 'Haldex',
  reducteur: 'Réducteur',
  cardan: 'Cardan',
  autre: 'Autre',
  mecatronique_dq200: 'Mécatronique DQ200',
  mecatronique_dq250: 'Mécatronique DQ250',
  mecatronique_dq381: 'Mécatronique DQ381',
  mecatronique_dq500: 'Mécatronique DQ500',
};

function libellePiece(type) {
  if (!type) return '';
  return PIECES_LABELS[type] || String(type).replace(/_/g, ' ');
}

/**
 * Tickets SAV d'une commande, les plus récents d'abord.
 * Best-effort : une erreur ne doit jamais empêcher d'afficher la commande.
 *
 * @param {string} numeroCommande
 * @returns {Promise<Array>} tickets enrichis de { ouvert, statutLabel, statutClasse }
 */
async function ticketsPourCommande(numeroCommande) {
  const numero = typeof numeroCommande === 'string' ? numeroCommande.trim() : '';
  if (!numero || mongoose.connection.readyState !== 1) return [];
  try {
    const tickets = await SavTicket.find({ numeroCommande: numero })
      .select('numero statut createdAt updatedAt pieceType client.nom')
      .sort({ createdAt: -1 })
      .limit(10)
      .lean();
    return tickets
      .map((t) => {
        const [label, classe] = libelle(t.statut);
        return {
          ...t,
          ouvert: estOuvert(t),
          statutLabel: label,
          statutClasse: classe,
          pieceLabel: libellePiece(t.pieceType),
        };
      })
      /* Les dossiers EN COURS d'abord : c'est pour eux que le bandeau existe.
         Trié par date seule, un dossier clos récent passait devant le dossier
         ouvert qu'on voulait montrer. */
      .sort((a, b) => (Number(b.ouvert) - Number(a.ouvert))
        || (new Date(b.createdAt) - new Date(a.createdAt)));
  } catch (err) {
    console.error('[savCommande] tickets non chargés :', err && err.message);
    return [];
  }
}

/** Y a-t-il un dossier EN COURS sur cette commande ? (garde-fou demande d'avis) */
async function ticketOuvert(numeroCommande) {
  const tickets = await ticketsPourCommande(numeroCommande);
  return tickets.find((t) => t.ouvert) || null;
}

module.exports = { STATUTS_LABELS, STATUTS_CLOS, PIECES_LABELS, estOuvert, libelle, libellePiece, ticketsPourCommande, ticketOuvert };
