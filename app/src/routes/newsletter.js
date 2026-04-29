const express = require('express');

const newsletterController = require('../controllers/newsletterController');

const router = express.Router();

router.post('/', newsletterController.postSubscribe);

module.exports = router;
