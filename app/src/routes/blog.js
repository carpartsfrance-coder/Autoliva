const express = require('express');

const blogController = require('../controllers/blogController');

const router = express.Router();

router.get('/', blogController.getBlogIndex);
router.get('/:slug', blogController.getBlogPost);

module.exports = router;
