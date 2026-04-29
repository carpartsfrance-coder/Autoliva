const express = require('express');

const categoryController = require('../controllers/categoryController');

const router = express.Router();

router.get('/', categoryController.listCategories);
router.get('/:slug', categoryController.getCategory);

module.exports = router;
