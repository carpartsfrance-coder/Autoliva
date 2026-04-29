const mongoose = require('mongoose');

const productDraftGenerationSchema = new mongoose.Schema(
  {
    productId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'Product',
      default: null,
      index: true,
    },
    adminUserId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'AdminUser',
      default: null,
      index: true,
    },
    status: {
      type: String,
      enum: ['queued', 'processing', 'completed', 'failed', 'canceled'],
      default: 'queued',
      trim: true,
      index: true,
    },
    requestPayload: {
      name: { type: String, default: '', trim: true },
      sku: { type: String, default: '', trim: true },
      brand: { type: String, default: '', trim: true },
      category: { type: String, default: '', trim: true },
      compatibleReferences: { type: [String], default: [] },
      sourceNotes: { type: String, default: '', trim: true },
      profile: { type: String, default: '', trim: true },
    },
    model: { type: String, default: '', trim: true },
    resultDraft: { type: mongoose.Schema.Types.Mixed, default: null },
    errorMessage: { type: String, default: '', trim: true },
    startedAt: { type: Date, default: null },
    completedAt: { type: Date, default: null },
    expiresAt: {
      type: Date,
      default: () => new Date(Date.now() + (7 * 24 * 60 * 60 * 1000)),
      index: { expires: 0 },
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('ProductDraftGeneration', productDraftGenerationSchema);
