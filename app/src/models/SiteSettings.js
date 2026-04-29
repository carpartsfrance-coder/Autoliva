const mongoose = require('mongoose');

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
  },
  { timestamps: true }
);

module.exports = mongoose.model('SiteSettings', siteSettingsSchema);
