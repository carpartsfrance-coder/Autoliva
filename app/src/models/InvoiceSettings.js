const mongoose = require('mongoose');

const invoiceSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true, trim: true },

    legalName: { type: String, default: '', trim: true },
    address: { type: String, default: '', trim: true },
    siret: { type: String, default: '', trim: true },
    vat: { type: String, default: '', trim: true },
    ape: { type: String, default: '', trim: true },
    legalForm: { type: String, default: '', trim: true },
    capital: { type: String, default: '', trim: true },
    rcs: { type: String, default: '', trim: true },
    website: { type: String, default: '', trim: true },

    logoUrl: { type: String, default: '', trim: true },

    paymentTermsText: { type: String, default: '', trim: true },
    latePenaltyText: { type: String, default: '', trim: true },
    proRecoveryFeeText: { type: String, default: '', trim: true },
  },
  { timestamps: true }
);

module.exports = mongoose.model('InvoiceSettings', invoiceSettingsSchema);
