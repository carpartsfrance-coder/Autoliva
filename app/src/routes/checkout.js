const express = require('express');

const checkoutController = require('../controllers/checkoutController');

const router = express.Router();

function requireCheckoutAccess(req, res, next) {
  if (req.session && req.session.user) return next();

  const checkout = req.session && req.session.checkout && typeof req.session.checkout === 'object'
    ? req.session.checkout
    : null;

  if (checkout && checkout.mode === 'guest') return next();

  const originalUrl = typeof req.originalUrl === 'string' ? req.originalUrl : '';
  const isShippingPage = originalUrl.startsWith('/commande/livraison');

  if (req.method === 'GET' && isShippingPage && req.query && req.query.guest === '1') {
    if (!req.session.checkout || typeof req.session.checkout !== 'object') {
      req.session.checkout = {};
    }
    req.session.checkout.mode = 'guest';
    return next();
  }

  const returnTo = req.method === 'GET' ? req.originalUrl || '/panier' : '/panier';
  return res.redirect(`/compte/connexion?returnTo=${encodeURIComponent(returnTo)}`);
}

router.get('/livraison', requireCheckoutAccess, checkoutController.getShipping);
router.post('/livraison', requireCheckoutAccess, checkoutController.postShipping);
router.post('/livraison/adresse', requireCheckoutAccess, checkoutController.postAddAddress);

router.get('/paiement', requireCheckoutAccess, checkoutController.getPayment);
router.post('/paiement', requireCheckoutAccess, checkoutController.postPayment);

router.get('/paiement/retour', requireCheckoutAccess, checkoutController.getPaymentReturn);
router.post('/paiement/webhook', checkoutController.postPaymentWebhook);
router.post('/paiement/webhook/scalapay', checkoutController.postScalapayWebhook);

module.exports = router;
