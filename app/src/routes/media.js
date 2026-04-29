const express = require('express');

const mediaController = require('../controllers/mediaController');

const router = express.Router();

/* Original route: /media/:id (backward compat) */
router.get('/:id([a-f0-9]{24})', mediaController.getMediaById);

/* SEO route: /media/:slug-:id.:ext  (slug is ignored, id is extracted) */
router.get('/:seoName', mediaController.getMediaBySeoUrl);

module.exports = router;
