'use strict';

const express = require('express');

const blogDeController = require('../controllers/blogDeController');

const router = express.Router();

router.get('/',       blogDeController.getBlogIndexDe);
router.get('/:slug',  blogDeController.getBlogPostDe);

module.exports = router;
