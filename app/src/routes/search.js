const express = require('express');

const searchController = require('../controllers/searchController');

const router = express.Router();

router.get('/', searchController.getSearchPage);
router.get('/suggest', searchController.getSuggest);

module.exports = router;
