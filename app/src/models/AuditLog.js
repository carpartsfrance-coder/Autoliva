const mongoose = require('mongoose');

const auditLogSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', index: true },
    userEmail: { type: String, trim: true, lowercase: true, index: true },
    action: { type: String, trim: true, required: true, index: true },
    entityType: { type: String, trim: true, index: true }, // 'sav_ticket', 'admin_user', etc.
    entityId: { type: String, trim: true, index: true },
    before: { type: mongoose.Schema.Types.Mixed },
    after: { type: mongoose.Schema.Types.Mixed },
    ip: { type: String, trim: true },
    userAgent: { type: String, trim: true },
    createdAt: { type: Date, default: Date.now, index: true },
  },
  { versionKey: false }
);

// TTL : 2 ans
auditLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 365 * 2 });

// Append-only : une fois créé, un log ne peut être ni modifié ni supprimé
// (hormis l'expiration TTL automatique). Garantit la valeur probante en cas
// de litige SAV ou contrôle RGPD.
function blockMutation(next) {
  const err = new Error('AuditLog est append-only : modification interdite.');
  err.code = 'AUDIT_IMMUTABLE';
  next(err);
}
auditLogSchema.pre('updateOne', blockMutation);
auditLogSchema.pre('updateMany', blockMutation);
auditLogSchema.pre('findOneAndUpdate', blockMutation);
auditLogSchema.pre('deleteOne', blockMutation);
auditLogSchema.pre('deleteMany', blockMutation);
auditLogSchema.pre('findOneAndDelete', blockMutation);
auditLogSchema.pre('save', function (next) {
  // Autorise l'insertion, bloque toute modification ultérieure
  if (!this.isNew) return blockMutation(next);
  next();
});

module.exports = mongoose.model('AuditLog', auditLogSchema);
