const express = require('express');

const legalController = require('../controllers/legalController');

const router = express.Router();

router.get('/', legalController.getLegalIndex);
router.get('/:slug', legalController.getLegalPage);

module.exports = router;
