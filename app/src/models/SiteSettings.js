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
    aboutTitle: { type: String, default: '', trim: true },
    aboutText: { type: String, default: '', trim: true },
    facebookUrl: { type: String, default: '', trim: true },
    instagramUrl: { type: String, default: '', trim: true },
    youtubeUrl: { type: String, default: '', trim: true },

    heroSlides: { type: [heroSlideSchema], default: [] },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SiteSettings', siteSettingsSchema);
