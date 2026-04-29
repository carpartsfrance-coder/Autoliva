const mongoose = require('mongoose');

const SavProcedureSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    description: { type: String, trim: true, default: '' },
    tags: [{ type: String, trim: true }],
    fileUrl: { type: String, required: true, trim: true },
    originalName: { type: String, trim: true },
    sizeBytes: { type: Number },
    mime: { type: String, trim: true },
    createdByEmail: { type: String, trim: true },
    downloads: { type: Number, default: 0 },
  },
  { timestamps: true }
);

SavProcedureSchema.index({ title: 'text', description: 'text', tags: 'text' });

module.exports = mongoose.model('SavProcedure', SavProcedureSchema);
