const mongoose = require('mongoose');

/**
 * Liste de suppression des emails/SMS de prospection (relances panier,
 * relances devis moteur, newsletter). Une adresse présente ici ne reçoit
 * plus AUCUNE relance automatique.
 *
 * Ne concerne pas les emails transactionnels liés à une commande
 * (confirmation, suivi d'expédition, consigne, livraison, SAV) : ceux-là
 * restent dus au client et continuent de partir.
 */
const marketingOptOutSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, index: true, trim: true, lowercase: true },
    /** D'où vient la demande : 'email_link', 'form', 'admin', 'script' */
    source: { type: String, default: '', trim: true },
    /** Contexte libre (ex. numéro de commande, nom de l'agent) */
    reason: { type: String, default: '', trim: true },
    optedOutAt: { type: Date, default: Date.now },
  },
  { timestamps: true }
);

module.exports = mongoose.model('MarketingOptOut', marketingOptOutSchema);
