const mongoose = require('mongoose');

const adminLoginAttemptSchema = new mongoose.Schema(
  {
    email: { type: String, trim: true, lowercase: true, index: true },
    ip: { type: String, trim: true, index: true },
    userAgent: { type: String, trim: true },
    success: { type: Boolean, default: false, index: true },
    reason: { type: String, trim: true }, // 'bad_password', 'unknown_user', 'rate_limited', 'honeypot'
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false }
);

// TTL : conserver 90 jours
adminLoginAttemptSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 });

module.exports = mongoose.model('AdminLoginAttempt', adminLoginAttemptSchema);
