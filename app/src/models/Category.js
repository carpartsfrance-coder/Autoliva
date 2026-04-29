const mongoose = require('mongoose');

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true },
    isActive: { type: Boolean, default: true },
    isHomeFeatured: { type: Boolean, default: false },
    sortOrder: { type: Number, default: 0 },

    shippingClassId: { type: mongoose.Schema.Types.ObjectId, ref: 'ShippingClass', default: null },

    seoText: { type: String, default: '' },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('Category', categorySchema);
