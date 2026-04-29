const mongoose = require('mongoose');

/**
 * CartEvent — enregistre chaque action panier d'un client connecté.
 * Les documents sont automatiquement supprimés après 90 jours (TTL index).
 */
const cartEventSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    userEmail: { type: String, default: '' },
    userName: { type: String, default: '' },
    accountType: { type: String, enum: ['particulier', 'pro', ''], default: '' },

    action: { type: String, enum: ['add', 'update', 'remove'], required: true, index: true },

    productId: { type: mongoose.Schema.Types.ObjectId, ref: 'Product', required: true, index: true },
    productName: { type: String, default: '' },
    productSku: { type: String, default: '' },

    quantity: { type: Number, default: 0 },
    previousQuantity: { type: Number, default: null },
    optionsSummary: { type: String, default: '' },
  },
  { timestamps: true }
);

/* Index composé pour les requêtes par client */
cartEventSchema.index({ userId: 1, createdAt: -1 });

/* Index pour la liste admin (tri chronologique) */
cartEventSchema.index({ createdAt: -1 });

/* TTL : suppression automatique après 90 jours (7 776 000 secondes) */
cartEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 });

module.exports = mongoose.model('CartEvent', cartEventSchema);
