const crypto = require('crypto');

const EmailSuppression = require('../models/EmailSuppression');

/**
 * Catégories d'e-mails.
 *  - 'transactional' : nécessaire à l'exécution de la commande. Toujours envoyé,
 *                      sauf si l'adresse est supprimée en scope 'all'.
 *  - 'marketing'     : commercial / promotionnel. Bloqué dès qu'une suppression
 *                      existe (scope 'marketing' ou 'all').
 */
const CATEGORY_TRANSACTIONAL = 'transactional';
const CATEGORY_MARKETING = 'marketing';

function normalizeEmail(email) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

/** Secret utilisé pour signer les liens de désinscription. */
function getSecret() {
  return (
    process.env.UNSUBSCRIBE_SECRET ||
    process.env.SESSION_SECRET ||
    'carpartsfrance-unsubscribe-fallback'
  );
}

/** Jeton HMAC — permet un lien de désinscription en 1 clic sans stockage. */
function makeToken(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return '';
  return crypto.createHmac('sha256', getSecret()).update(normalized).digest('hex').slice(0, 32);
}

function verifyToken(email, token) {
  const expected = makeToken(email);
  if (!expected || !token || expected.length !== String(token).length) return false;
  return crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(String(token)));
}

/** URL de désinscription signée, à insérer dans les e-mails marketing. */
function buildUnsubscribeUrl(baseUrl, email) {
  const base = String(baseUrl || '').replace(/\/+$/, '');
  if (!base) return '';
  const normalized = normalizeEmail(email);
  if (!normalized) return `${base}/newsletter/desinscription`;
  const params = new URLSearchParams({ e: normalized, t: makeToken(normalized) });
  return `${base}/newsletter/desinscription?${params.toString()}`;
}

/**
 * Indique si un envoi doit être bloqué.
 * @returns {Promise<{blocked: boolean, scope?: string}>}
 */
async function isSuppressed(email, category = CATEGORY_TRANSACTIONAL) {
  const normalized = normalizeEmail(email);
  if (!normalized) return { blocked: false };
  let entry = null;
  try {
    entry = await EmailSuppression.findOne({ email: normalized }).select('scope').lean();
  } catch (err) {
    // En cas d'incident base, on ne bloque pas les e-mails transactionnels.
    console.error('[emailSuppression] Lecture impossible :', err.message);
    return { blocked: false };
  }
  if (!entry) return { blocked: false };
  if (entry.scope === 'all') return { blocked: true, scope: 'all' };
  if (category === CATEGORY_MARKETING) return { blocked: true, scope: 'marketing' };
  return { blocked: false };
}

/** Ajoute (ou met à jour) une adresse dans la liste de suppression. */
async function suppress({ email, scope = 'marketing', reason = '', source = 'unsubscribe_link', createdByName = '' } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized) return { ok: false, reason: 'missing_email' };
  const safeScope = scope === 'all' ? 'all' : 'marketing';
  try {
    await EmailSuppression.findOneAndUpdate(
      { email: normalized },
      { $set: { scope: safeScope, reason, source, createdByName, suppressedAt: new Date() } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    // Reflète l'opt-out sur la newsletter pour garder les deux vues cohérentes.
    try {
      const NewsletterSubscriber = require('../models/NewsletterSubscriber');
      await NewsletterSubscriber.updateOne(
        { email: normalized },
        { $set: { status: 'unsubscribed', unsubscribedAt: new Date() } }
      );
    } catch (_) {
      /* la newsletter n'est pas bloquante */
    }
    return { ok: true, scope: safeScope };
  } catch (err) {
    console.error('[emailSuppression] Écriture impossible :', err.message);
    return { ok: false, reason: 'db_error' };
  }
}

/** Retire une adresse de la liste (réinscription volontaire). */
async function unsuppress(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return { ok: false, reason: 'missing_email' };
  try {
    await EmailSuppression.deleteOne({ email: normalized });
    return { ok: true };
  } catch (err) {
    console.error('[emailSuppression] Suppression impossible :', err.message);
    return { ok: false, reason: 'db_error' };
  }
}

module.exports = {
  CATEGORY_TRANSACTIONAL,
  CATEGORY_MARKETING,
  normalizeEmail,
  makeToken,
  verifyToken,
  buildUnsubscribeUrl,
  isSuppressed,
  suppress,
  unsuppress,
};
