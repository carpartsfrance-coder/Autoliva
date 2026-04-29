const mongoose = require('mongoose');

const shippingClassSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },

    isDefault: { type: Boolean, default: false },

    domicilePriceCents: { type: Number, default: 0, min: 0 },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('ShippingClass', shippingClassSchema);
