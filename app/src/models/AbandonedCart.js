const mongoose = require('mongoose');
const crypto = require('crypto');

const abandonedCartItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, trim: true },
    sku: { type: String, default: '', trim: true },
    price: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1, max: 99 },
    image: { type: String, default: '', trim: true },
    optionsSelection: { type: Object, default: {} },
    optionsSummary: { type: String, default: '', trim: true },
  },
  { _id: false }
);

const abandonedCartNoteSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, trim: true },
    addedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    addedByName: { type: String, default: '', trim: true },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

const abandonedCartSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, trim: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    email: { type: String, default: '', trim: true, index: true },
    firstName: { type: String, default: '', trim: true },
    lastName: { type: String, default: '', trim: true },
    phone: { type: String, default: '', trim: true },
    isGuest: { type: Boolean, default: false, index: true },

    /**
     * Comment ce lead a été capturé. Permet de différencier le panier
     * abandonné (cron) d'une demande de devis explicite ou d'un contact form.
     */
    captureSource: {
      type: String,
      enum: ['user', 'guest_checkout', 'newsletter', 'contact', 'devis', 'cart_activity', 'manual', ''],
      default: '',
      index: true,
    },

    items: { type: [abandonedCartItemSchema], default: [] },
    totalAmountCents: { type: Number, default: 0, min: 0 },

    /** Statut workflow automatique (cron) */
    status: {
      type: String,
      enum: ['abandoned', 'reminded_1', 'reminded_2', 'reminded_3', 'recovered', 'expired'],
      default: 'abandoned',
      required: true,
      index: true,
    },

    /** Statut manuel posé par un admin — bloque les relances auto si != null */
    manualStatus: {
      type: String,
      enum: ['contacted', 'converted', 'lost', null],
      default: null,
      index: true,
    },
    manualStatusBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    manualStatusByName: { type: String, default: '', trim: true },
    manualStatusAt: { type: Date, default: null },

    /** Notes internes admin (chronologique) */
    notes: { type: [abandonedCartNoteSchema], default: [] },

    /** Contexte additionnel (message du devis/contact, attribution, etc.) */
    contextMessage: { type: String, default: '', trim: true },
    attribution: {
      source: { type: String, default: '' },
      medium: { type: String, default: '' },
      campaign: { type: String, default: '' },
      referrer: { type: String, default: '' },
      gclid: { type: String, default: '' },
    },

    /** Compteurs d'actions manuelles depuis le dashboard admin */
    manualEmailsSent: { type: Number, default: 0 },
    manualSmsSent: { type: Number, default: 0 },
    lastManualContactAt: { type: Date, default: null },

    abandonedAt: { type: Date, required: true, index: true },
    lastActivityAt: { type: Date, default: Date.now, index: true },
    lastRemindedAt: { type: Date, default: null },
    recoveredAt: { type: Date, default: null },
    recoveryToken: {
      type: String,
      unique: true,
      required: true,
      default: () => crypto.randomBytes(32).toString('hex'),
    },
  },
  {
    timestamps: true,
  }
);

abandonedCartSchema.index({ status: 1, abandonedAt: 1 });
abandonedCartSchema.index({ email: 1, status: 1 });
abandonedCartSchema.index({ manualStatus: 1, lastActivityAt: -1 });
abandonedCartSchema.index({ captureSource: 1, lastActivityAt: -1 });

module.exports = mongoose.model('AbandonedCart', abandonedCartSchema);
