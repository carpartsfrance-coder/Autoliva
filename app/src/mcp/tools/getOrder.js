'use strict';

const SavTicket = require('../../models/SavTicket');
const { findOrder, summarizeOrder } = require('../util/orderSummary');
const { jsonResult } = require('../util/format');

const definition = {
  name: 'getOrder',
  description:
    "Lit une commande Autoliva (lecture seule) par son numéro (ex. « CP2026-000374 ») ou son numéro de facture (ex. « F-2026-1323 ») : dates, statut et historique des statuts, type de client (particulier ou pro), articles et prix, paiement, envois et numéros de suivi, date de livraison annoncée, approvisionnement fournisseur, retour et consigne de l'ancienne pièce, remboursements, e-mails automatiques déjà partis, documents attachés (noms seulement) et tickets SAV liés. Sans adresse postale ni téléphone. À utiliser pour vérifier ce qui a été vendu, promis et expédié avant de répondre à un client.",
  inputSchema: {
    type: 'object',
    properties: {
      orderNumber: { type: 'string', description: 'Numéro de commande (CP2026-000374) ou numéro de facture (F-2026-1323).' },
    },
    required: ['orderNumber'],
    additionalProperties: false,
  },
};

async function handler(args = {}) {
  const ref = String(args.orderNumber || '').trim();
  if (!ref) throw new Error('orderNumber manquant');

  const order = await findOrder(ref);
  if (!order) throw new Error(`Commande ${ref} introuvable`);

  const refs = [order.number, order.invoice && order.invoice.number].filter(Boolean);
  const tickets = await SavTicket.find({ numeroCommande: { $in: refs } })
    .select('numero motifSav statut createdAt')
    .sort({ createdAt: 1 })
    .limit(20)
    .lean();

  return jsonResult({
    ...summarizeOrder(order),
    sav_tickets: tickets.map((t) => ({ id: t.numero, motif: t.motifSav, status: t.statut, created_at: t.createdAt ? new Date(t.createdAt).toISOString() : null })),
    note: 'Lecture seule. Montants en euros, tels qu\'encaissés.',
  });
}

module.exports = { definition, handler };
