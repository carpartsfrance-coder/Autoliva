/*
 * Accès aux documents techniques produit — token magic-link HMAC.
 *
 * Même modèle que le suivi SAV invité (savGuestController) : un lien signé,
 * placé dans l'email de confirmation, donne accès aux documents techniques des
 * produits commandés SANS connexion (utile pour les commandes invité). Le token
 * est lié à (orderId, subject) où subject = userId de la commande (stable, dispo
 * sans requête supplémentaire). Il autorise le téléchargement des docs des
 * produits de CETTE commande (le docId du chemin est validé contre les produits
 * de la commande côté route).
 */

const crypto = require('crypto');

const TOKEN_SECRET = process.env.PRODUCT_DOC_TOKEN_SECRET
  || process.env.SAV_GUEST_TOKEN_SECRET
  || process.env.SESSION_SECRET
  || 'cpf-product-doc-default-secret';

function generateToken(orderId, subject) {
  const payload = `${String(orderId)}:${String(subject || '').toLowerCase().trim()}`;
  return crypto.createHmac('sha256', TOKEN_SECRET).update(payload).digest('hex').slice(0, 32);
}

function verifyToken(token, orderId, subject) {
  if (!token || !orderId || !subject) return false;
  const expected = generateToken(orderId, subject);
  try {
    return crypto.timingSafeEqual(Buffer.from(String(token), 'utf8'), Buffer.from(expected, 'utf8'));
  } catch (_) {
    return false;
  }
}

/** URL absolue de téléchargement d'un document, signée pour l'email. */
function buildDownloadUrl(baseUrl, orderId, docId, subject) {
  const base = String(baseUrl || '').replace(/\/$/, '');
  const tk = generateToken(orderId, subject);
  return `${base}/compte/commandes/${encodeURIComponent(String(orderId))}/doc-technique/${encodeURIComponent(String(docId))}?tk=${tk}`;
}

module.exports = { generateToken, verifyToken, buildDownloadUrl };
