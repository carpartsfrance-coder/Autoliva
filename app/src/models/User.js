const mongoose = require('mongoose');

const addressSchema = new mongoose.Schema(
  {
    label: { type: String, default: '', trim: true },
    fullName: { type: String, default: '', trim: true },
    phone: { type: String, default: '', trim: true },
    line1: { type: String, required: true, trim: true },
    line2: { type: String, default: '', trim: true },
    postalCode: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true },
    country: { type: String, default: 'France', trim: true },
    isDefault: { type: Boolean, default: false },
  },
  { timestamps: true }
);

const userSchema = new mongoose.Schema(
  {
    accountType: {
      type: String,
      enum: ['particulier', 'pro'],
      required: true,
      default: 'particulier',
    },
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
    passwordHash: { type: String, required: true },
    passwordSalt: { type: String, required: true },
    companyName: { type: String, default: '', trim: true },
    siret: { type: String, default: '', trim: true },
    discountPercent: { type: Number, default: 0, min: 0, max: 100 },
    addresses: { type: [addressSchema], default: [] },
    smsOptIn: { type: Boolean, default: false },
    smsOptInAt: { type: Date, default: null },
    smsOptOutAt: { type: Date, default: null },
    resetPasswordTokenHash: { type: String, default: '', trim: true, index: true },
    resetPasswordExpiresAt: { type: Date, default: null, index: true },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('User', userSchema);
