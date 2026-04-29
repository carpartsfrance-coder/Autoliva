const mongoose = require('mongoose');

const promoCodeSchema = new mongoose.Schema(
  {
    code: { type: String, required: true, unique: true, trim: true, uppercase: true, index: true },
    label: { type: String, default: '', trim: true },
    isActive: { type: Boolean, default: true },
    discountType: { type: String, enum: ['percent', 'fixed'], required: true, default: 'percent' },
    discountPercent: { type: Number, default: 0, min: 0, max: 100 },
    discountAmountCents: { type: Number, default: 0, min: 0 },
    minSubtotalCents: { type: Number, default: 0, min: 0 },
    startsAt: { type: Date, default: null },
    endsAt: { type: Date, default: null },
    maxTotalUses: { type: Number, default: null, min: 1 },
    maxUsesPerUser: { type: Number, default: null, min: 1 },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('PromoCode', promoCodeSchema);
