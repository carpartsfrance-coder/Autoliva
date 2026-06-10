const mongoose = require('mongoose');

const shippingClassSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },

    isDefault: { type: Boolean, default: false },

    // Prix « historique » (= France métropole). Conservé pour rétro-compat :
    // sert de base/fallback quand un prix de zone n'est pas défini.
    domicilePriceCents: { type: Number, default: 0, min: 0 },

    // Prix par zone de livraison (en centimes). null = non défini → fallback
    // sur le prix métropole (domicilePriceCents). Cf. config/shippingZones.js.
    zonePricesCents: {
      metropole: { type: Number, default: null, min: 0 },
      corse: { type: Number, default: null, min: 0 },
      domtom: { type: Number, default: null, min: 0 },
      europe: { type: Number, default: null, min: 0 },
      international: { type: Number, default: null, min: 0 },
    },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('ShippingClass', shippingClassSchema);
