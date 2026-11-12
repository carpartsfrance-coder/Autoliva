'use strict';

/**
 * Facture d'ACHAT (fournisseur) attachée à une commande.
 *
 * C'est le justificatif du régime de la marge : sans elle, la base
 * (prix de vente − prix d'achat) n'est pas vérifiable et l'administration
 * reconstitue la TVA sur le prix de vente entier.
 *
 * ⚠ Elle est rangée dans `Order.purchase.invoiceFile`, PAS dans
 * `Order.documents[]`. La route client `/compte/commandes/:id/documents/:docId`
 * sert n'importe quelle entrée de `documents[]` sans regarder son type : une
 * facture d'achat y révélerait notre prix d'achat — donc notre marge — à
 * l'acheteur. Rangée à part, aucune route client ne peut l'atteindre.
 *
 * Deux portes d'entrée l'exposent (admin et espace comptable) : la lecture est
 * ici, une seule fois, pour qu'elles ne divergent jamais.
 */

const mongoose = require('mongoose');
const Order = require('../models/Order');

/**
 * @returns {Promise<{bytes: Buffer, meta: object, orderNumber: string}|null>}
 */
async function charger(orderId) {
  if (!mongoose.Types.ObjectId.isValid(orderId)) return null;
  /* `+chemin` SEUL = projection par défaut + ce champ masqué. Y ajouter
     `purchase.invoiceFile` provoquerait une « path collision » côté Mongoose :
     on ne peut pas projeter un parent et son enfant dans la même requête. */
  const order = await Order.findById(orderId)
    .select('+purchase.invoiceFile.data')
    .lean();
  const f = order && order.purchase && order.purchase.invoiceFile;
  if (!f || !f.data) return null;
  /* En `.lean()`, un Buffer Mongo peut revenir en BSON Binary : les octets sont
     alors sous `.buffer`. Même piège que sur `documents[].fileData`. */
  const bytes = Buffer.isBuffer(f.data)
    ? f.data
    : (f.data.buffer ? Buffer.from(f.data.buffer) : null);
  if (!bytes || !bytes.length) return null;
  return { bytes, meta: f, orderNumber: order.number || '' };
}

/** Nom de fichier lisible : le n° de commande d'abord, comme dans le ZIP mensuel. */
function nomFichier(orderNumber, meta) {
  const base = orderNumber ? `Facture-achat_${orderNumber}` : 'Facture-achat';
  const ext = (meta && meta.originalName && meta.originalName.match(/\.[a-z0-9]{1,5}$/i)) || ['.pdf'];
  return base + ext[0];
}

module.exports = { charger, nomFichier };
