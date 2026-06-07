'use strict';

const express = require('express');

const categoryController = require('../controllers/categoryController');

const router = express.Router();

/* Pages catégorie en allemand (détail) — MÊME contrôleur que le FR.
 * getCategory est lang-aware (req.lang='de' posé par le middleware i18n) :
 * 301 vers le FR si la catégorie n'est pas traduite, sinon nom/seoText DE +
 * cartes localisées.
 *
 * L'index /de/categorie (liste des catégories) n'est pas encore traduit : il
 * ne matche pas /:slug, retombe donc sur le catchall /de → 301 vers le FR. */
router.get('/:slug', categoryController.getCategory);

module.exports = router;
