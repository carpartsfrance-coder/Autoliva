const express = require('express');

const newsletterController = require('../controllers/newsletterController');
const unsubscribeController = require('../controllers/unsubscribeController');

const router = express.Router();

router.post('/', newsletterController.postSubscribe);

/**
 * Lien historique présent dans les emails de relance déjà envoyés : il
 * pointait vers une route inexistante (404). On le redirige vers la vraie
 * page de désinscription.
 */
router.get('/desinscription', unsubscribeController.getLegacyNewsletterUnsubscribe);

module.exports = router;
