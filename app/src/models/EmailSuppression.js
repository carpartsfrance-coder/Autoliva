const mongoose = require('mongoose');

/**
 * Liste de suppression e-mail (opt-out).
 *
 * scope:
 *  - 'marketing' : bloque uniquement les envois commerciaux (relances panier,
 *                  newsletter, demandes d'avis). Les e-mails transactionnels
 *                  (confirmation de commande, suivi colis, consigne, facture,
 *                  réinitialisation de mot de passe) continuent de partir car
 *                  ils sont nécessaires à l'exécution du contrat.
 *  - 'all'       : bloque absolument tout (demande de suppression RGPD,
 *                  plainte pour spam, adresse invalide).
 */
const emailSuppressionSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, index: true, trim: true, lowercase: true },
    scope: { type: String, enum: ['marketing', 'all'], default: 'marketing', index: true },
    reason: { type: String, default: '', trim: true },
    source: { type: String, default: 'unsubscribe_link', trim: true },
    suppressedAt: { type: Date, default: Date.now },
    createdByName: { type: String, default: '', trim: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('EmailSuppression', emailSuppressionSchema);
