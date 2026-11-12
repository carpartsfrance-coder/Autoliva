const express = require('express');

const newsletterController = require('../controllers/newsletterController');

const router = express.Router();

router.post('/', newsletterController.postSubscribe);

// Désinscription — lien signé en un clic (GET) ou formulaire manuel (POST).
router.get('/desinscription', newsletterController.getUnsubscribe);
router.post('/desinscription', newsletterController.postUnsubscribe);

module.exports = router;
