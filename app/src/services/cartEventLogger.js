const mongoose = require('mongoose');
const CartEvent = require('../models/CartEvent');

/**
 * Enregistre un événement panier de façon non-bloquante (fire-and-forget).
 * Ne fait rien si l'utilisateur n'est pas connecté ou si la BDD est indisponible.
 *
 * @param {Object} options
 * @param {Object} options.req — Express request (pour accéder à la session)
 * @param {'add'|'update'|'remove'} options.action — Type d'action
 * @param {string} options.productId — ID du produit
 * @param {string} [options.productName] — Nom du produit (si disponible)
 * @param {string} [options.productSku] — SKU du produit (si disponible)
 * @param {number} [options.quantity] — Quantité ajoutée/définie
 * @param {number|null} [options.previousQuantity] — Quantité précédente (pour update)
 * @param {string} [options.optionsSummary] — Résumé des options sélectionnées
 */
function logCartEvent({ req, action, productId, productName, productSku, quantity, previousQuantity, optionsSummary }) {
  /* Vérifie que l'utilisateur est connecté */
  const user = req && req.session && req.session.user;
  if (!user || !user._id) return;

  /* Vérifie la connexion BDD */
  if (mongoose.connection.readyState !== 1) return;

  const userName = ((user.firstName || '') + ' ' + (user.lastName || '')).trim();
  const accountType = req.session.accountType || '';

  /* Fire-and-forget : on ne bloque pas l'opération panier */
  CartEvent.create({
    userId: user._id,
    userEmail: user.email || '',
    userName,
    accountType,
    action,
    productId,
    productName: productName || '',
    productSku: productSku || '',
    quantity: quantity || 0,
    previousQuantity: previousQuantity != null ? previousQuantity : null,
    optionsSummary: optionsSummary || '',
  }).catch((err) => {
    console.error('[CartEvent] Erreur de log :', err && err.message ? err.message : err);
  });
}

/**
 * Logge tous les articles déjà présents dans le panier session au moment
 * de la connexion / inscription. Permet de rattraper les ajouts faits
 * en tant que visiteur anonyme.
 *
 * Appeler APRÈS que req.session.user et req.session.cart soient définis.
 *
 * @param {Object} req — Express request
 */
function logExistingCartItems(req) {
  const user = req && req.session && req.session.user;
  if (!user || !user._id) return;

  const cart = req.session && req.session.cart;
  if (!cart || !cart.items || typeof cart.items !== 'object') return;

  if (mongoose.connection.readyState !== 1) return;

  const items = Object.values(cart.items);
  if (items.length === 0) return;

  const userName = ((user.firstName || '') + ' ' + (user.lastName || '')).trim();
  const accountType = req.session.accountType || '';

  const docs = items
    .filter((it) => it && it.productId)
    .map((it) => ({
      userId: user._id,
      userEmail: user.email || '',
      userName,
      accountType,
      action: 'add',
      productId: it.productId,
      productName: '',
      productSku: '',
      quantity: it.quantity || 1,
      previousQuantity: null,
      optionsSummary: it.optionsSummary || '',
    }));

  if (docs.length === 0) return;

  /* Fire-and-forget : insertion groupée */
  CartEvent.insertMany(docs).catch((err) => {
    console.error('[CartEvent] Erreur log panier existant :', err && err.message ? err.message : err);
  });
}

module.exports = { logCartEvent, logExistingCartItems };
