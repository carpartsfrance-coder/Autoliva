const mongoose = require('mongoose');

const legalPageSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true, index: true },
    title: { type: String, required: true, trim: true },
    content: { type: String, default: '', trim: false },
    isPublished: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('LegalPage', legalPageSchema);
