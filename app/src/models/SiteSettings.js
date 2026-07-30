const mongoose = require('mongoose');

const heroSlideSchema = new mongoose.Schema(
  {
    imageUrl: { type: String, default: '', trim: true },
    imageAlt: { type: String, default: '', trim: true },
    badge: { type: String, default: '', trim: true },
    title: { type: String, default: '', trim: true },
    description: { type: String, default: '', trim: true },
    ctaPrimaryText: { type: String, default: '', trim: true },
    ctaPrimaryUrl: { type: String, default: '', trim: true },
    ctaSecondaryText: { type: String, default: '', trim: true },
    ctaSecondaryUrl: { type: String, default: '', trim: true },
    sortOrder: { type: Number, default: 0 },
    isActive: { type: Boolean, default: true },
  },
  { _id: true }
);

const siteSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true, trim: true },

    promoBannerText: { type: String, default: '', trim: true },
    promoBannerCode: { type: String, default: '', trim: true },

    /* Bandeau d'alerte « usurpation d'identité ».
       Le drapeau est NÉGATIF à dessein : le bandeau est visible par défaut et
       il faut une action explicite pour le masquer. Une alerte de sécurité doit
       tomber du bon côté quand la valeur est absente (documents déjà en base)
       ou que la base est indisponible. */
    securityAlertHidden: { type: Boolean, default: false },
    securityAlertText: { type: String, default: '', trim: true },

    aboutTitle: { type: String, default: '', trim: true },
    aboutText: { type: String, default: '', trim: true },
    facebookUrl: { type: String, default: '', trim: true },
    instagramUrl: { type: String, default: '', trim: true },
    youtubeUrl: { type: String, default: '', trim: true },

    heroSlides: { type: [heroSlideSchema], default: [] },

    featuredProductIds: {
      type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Product' }],
      default: [],
    },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SiteSettings', siteSettingsSchema);
