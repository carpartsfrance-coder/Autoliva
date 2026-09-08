const mongoose = require('mongoose');

const legalPageSchema = new mongoose.Schema(
  {
    slug: { type: String, required: true, trim: true, lowercase: true, unique: true, index: true },
    title: { type: String, required: true, trim: true },
    content: { type: String, default: '', trim: false },
    /* Version allemande. Servie seulement si `translatedAt` est posé : le pied
       de page allemand annonçait « Impressum » et « AGB » et menait vers des
       pages FRANÇAISES — pire qu'un lien honnêtement français, parce qu'il
       promet un document allemand. Tant qu'il n'existe pas, on redirige. */
    localizations: {
      de: {
        title: { type: String, default: '', trim: true },
        content: { type: String, default: '', trim: false },
        translatedAt: { type: Date, default: null },
        translatedBy: { type: String, default: '', trim: true },
        reviewedAt: { type: Date, default: null },
      },
    },
    isPublished: { type: Boolean, default: true },
    sortOrder: { type: Number, default: 0 },
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('LegalPage', legalPageSchema);
