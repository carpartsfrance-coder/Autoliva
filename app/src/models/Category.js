const mongoose = require('mongoose');

/* Traduction d'une catégorie (DE d'abord, puis ES/IT…). Servie uniquement si
 * translatedAt est posé ; sinon /<lang>/categorie/... fait un 301 vers le FR
 * → jamais de page à moitié traduite indexée. */
const localizedCategorySchema = new mongoose.Schema(
  {
    name: { type: String, default: '', trim: true },
    seoText: { type: String, default: '' },
    slug: { type: String, default: '', trim: true },
    translatedAt: { type: Date, default: null },
    translatedBy: { type: String, default: '', trim: true },
    reviewedAt: { type: Date, default: null },
    reviewedBy: { type: String, default: '', trim: true },
  },
  { _id: false }
);

const categorySchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true },
    isActive: { type: Boolean, default: true },
    isHomeFeatured: { type: Boolean, default: false },
    // Affichage dans le mega-menu « Catalogue » du header + icône (nom Material Symbol).
    showInMenu: { type: Boolean, default: false },
    menuIcon: { type: String, default: '', trim: true },
    sortOrder: { type: Number, default: 0 },

    shippingClassId: { type: mongoose.Schema.Types.ObjectId, ref: 'ShippingClass', default: null },

    seoText: { type: String, default: '' },

    /* Traductions par langue (additif : default undefined → zéro impact). */
    localizations: {
      de: { type: localizedCategorySchema, default: undefined },
    },
  },
  {
    timestamps: true,
  }
);

categorySchema.index({ 'localizations.de.translatedAt': 1 });

module.exports = mongoose.model('Category', categorySchema);
