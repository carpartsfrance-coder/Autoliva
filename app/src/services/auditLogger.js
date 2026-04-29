/*
 * Audit logger — best-effort, jamais bloquant
 *
 * Usage :
 *   const audit = require('./auditLogger');
 *   await audit.log({
 *     req,                       // facultatif (extrait userEmail/ip/ua automatiquement)
 *     action: 'sav.statut',
 *     entityType: 'sav_ticket',
 *     entityId: ticket.numero,
 *     before: { statut: 'en_analyse' },
 *     after:  { statut: 'analyse_terminee' },
 *   });
 */

const AuditLog = require('../models/AuditLog');

function pickIp(req) {
  if (!req) return '';
  return (
    (req.headers && (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim()) ||
    req.ip ||
    (req.connection && req.connection.remoteAddress) ||
    ''
  );
}

function pickUa(req) {
  return req && req.headers && (req.headers['user-agent'] || '').toString().slice(0, 500) || '';
}

function pickUser(req) {
  if (!req) return { id: null, email: '' };
  // Bearer token (API admin) → on n'a pas d'utilisateur, juste 'system'
  if (req.headers && (req.headers.authorization || '').startsWith('Bearer ')) {
    return { id: null, email: 'api-bearer' };
  }
  if (req.session && req.session.admin) {
    return {
      id: req.session.admin.adminUserId || null,
      email: req.session.admin.email || '',
    };
  }
  return { id: null, email: '' };
}

async function log({ req, userId, userEmail, action, entityType, entityId, before, after } = {}) {
  try {
    const u = req ? pickUser(req) : { id: userId || null, email: userEmail || '' };
    await AuditLog.create({
      userId: u.id,
      userEmail: u.email || '',
      action: String(action || ''),
      entityType: String(entityType || ''),
      entityId: String(entityId || ''),
      before: before == null ? null : before,
      after: after == null ? null : after,
      ip: pickIp(req),
      userAgent: pickUa(req),
    });
  } catch (e) {
    console.error('[audit] log failed:', e && e.message);
  }
}

module.exports = { log };
