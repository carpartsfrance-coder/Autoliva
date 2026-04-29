const mongoose = require('mongoose');

const productOptionTemplateSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    key: { type: String, required: true, trim: true, lowercase: true },
    type: { type: String, enum: ['choice', 'text'], default: 'choice', required: true },
    required: { type: Boolean, default: false },
    placeholder: { type: String, default: '', trim: true },
    helpText: { type: String, default: '', trim: true },
    priceDeltaCents: { type: Number, default: 0 },
    choices: {
      type: [
        {
          key: { type: String, default: '', trim: true, lowercase: true },
          label: { type: String, default: '', trim: true },
          priceDeltaCents: { type: Number, default: 0 },
          triggersCloning: { type: Boolean, default: false },
        },
      ],
      default: [],
    },
    isActive: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 },
  },
  {
    timestamps: true,
  }
);

productOptionTemplateSchema.index({ key: 1 }, { unique: true });
productOptionTemplateSchema.index({ isActive: 1, sortOrder: 1, name: 1 });

module.exports = mongoose.model('ProductOptionTemplate', productOptionTemplateSchema);
