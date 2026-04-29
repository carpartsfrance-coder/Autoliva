const express = require('express');

const cartController = require('../controllers/cartController');

const router = express.Router();

function requireAuth(req, res, next) {
  if (req.session && req.session.user) return next();

  const returnTo = req.method === 'GET' ? req.originalUrl || '/panier' : '/panier';
  return res.redirect(`/compte/connexion?returnTo=${encodeURIComponent(returnTo)}`);
}

router.get('/', cartController.showCart);
router.get('/recuperer/:token', cartController.recoverCart);
router.post('/code-promo', cartController.postCartPromoCode);
router.post('/ajouter/:id', cartController.addToCart);
router.post('/modifier/:id', cartController.updateCartItem);
router.post('/supprimer/:id', cartController.removeFromCart);
router.post('/vider', cartController.clearCart);
router.post('/commander', requireAuth, cartController.placeOrder);

module.exports = router;
