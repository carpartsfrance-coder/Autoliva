const mongoose = require('mongoose');

// Audit-trail des "touches" marketing (gclid / utm) captées sur le site.
// Source de vérité côté serveur — les commandes copient un sous-ensemble
// dans Order.attribution au moment du paiement.
const attributionTouchSchema = new mongoose.Schema(
  {
    sessionId: { type: String, default: '', index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    touchType: {
      type: String,
      enum: ['first', 'last'],
      default: 'last',
      index: true,
    },

    // Identifiants de clic
    gclid: { type: String, default: '', trim: true, index: true },
    gbraid: { type: String, default: '', trim: true },
    wbraid: { type: String, default: '', trim: true },
    fbclid: { type: String, default: '', trim: true },
    msclkid: { type: String, default: '', trim: true },

    // UTM
    utmSource: { type: String, default: '', trim: true, index: true },
    utmMedium: { type: String, default: '', trim: true },
    utmCampaign: { type: String, default: '', trim: true, index: true },
    utmContent: { type: String, default: '', trim: true },
    utmTerm: { type: String, default: '', trim: true },

    // Contexte
    landingPath: { type: String, default: '', trim: true },
    referrer: { type: String, default: '', trim: true },
    userAgent: { type: String, default: '', trim: true },
    ipHash: { type: String, default: '', trim: true },
    lang: { type: String, default: '', trim: true },
  },
  { timestamps: true }
);

attributionTouchSchema.index({ createdAt: -1 });
attributionTouchSchema.index({ gclid: 1, createdAt: -1 });
attributionTouchSchema.index({ utmCampaign: 1, createdAt: -1 });

// TTL 180 jours — l'essentiel est copié dans Order.attribution au paiement.
attributionTouchSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 3600 });

module.exports = mongoose.model('AttributionTouch', attributionTouchSchema);
