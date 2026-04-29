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

const abandonedCartSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, trim: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    email: { type: String, default: '', trim: true, index: true },
    firstName: { type: String, default: '', trim: true },
    items: { type: [abandonedCartItemSchema], required: true },
    totalAmountCents: { type: Number, required: true, min: 0 },
    status: {
      type: String,
      enum: ['abandoned', 'reminded_1', 'reminded_2', 'reminded_3', 'recovered', 'expired'],
      default: 'abandoned',
      required: true,
      index: true,
    },
    abandonedAt: { type: Date, required: true, index: true },
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

module.exports = mongoose.model('AbandonedCart', abandonedCartSchema);
