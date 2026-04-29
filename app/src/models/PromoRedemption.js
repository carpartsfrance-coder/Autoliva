const mongoose = require('mongoose');

const promoRedemptionSchema = new mongoose.Schema(
  {
    promoCodeId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, ref: 'PromoCode' },
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, ref: 'User' },
    orderId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true, ref: 'Order' },
    state: { type: String, enum: ['reserved', 'redeemed'], required: true, default: 'reserved' },
    expiresAt: { type: Date, default: null },
    redeemedAt: { type: Date, default: null },
  },
  {
    timestamps: true,
  }
);

promoRedemptionSchema.index({ promoCodeId: 1, orderId: 1 }, { unique: true });
promoRedemptionSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

module.exports = mongoose.model('PromoRedemption', promoRedemptionSchema);
