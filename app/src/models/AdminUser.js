const mongoose = require('mongoose');

const adminUserSchema = new mongoose.Schema(
  {
    firstName: { type: String, required: true, trim: true },
    lastName: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true, unique: true },
    passwordHash: { type: String, required: true },
    passwordSalt: { type: String, required: true },
    role: {
      type: String,
      enum: ['owner', 'employe'],
      default: 'employe',
      required: true,
    },
    isActive: { type: Boolean, default: true, index: true },
    lastLoginAt: { type: Date, default: null },
    passwordUpdatedAt: { type: Date, default: Date.now },
    createdByAdminUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },

    // 2FA TOTP (otplib + qrcode)
    twoFactorEnabled: { type: Boolean, default: false },
    twoFactorSecret: { type: String, default: null }, // base32
    twoFactorBackupCodes: { type: [String], default: [] }, // hashes ou clair, simple ici
    twoFactorActivatedAt: { type: Date, default: null },

    // Templates SAV personnels (favoris de l'agent)
    savTemplates: [
      {
        key: { type: String, required: true },
        title: { type: String, required: true },
        body: { type: String, required: true },
        icon: { type: String, default: 'star' },
        createdAt: { type: Date, default: Date.now },
      },
    ],
  },
  {
    timestamps: true,
  }
);

module.exports = mongoose.model('AdminUser', adminUserSchema);
