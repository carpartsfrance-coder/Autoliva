'use strict';

const express = require('express');

const categoryController = require('../controllers/categoryController');

const router = express.Router();

/* Sommaire des catégories en allemand. Il tombait dans le catchall /de et
 * redirigeait vers le français : il n'existait donc aucune page de rebond
 * allemande vers les 63 catégories traduites — un point d'entrée de crawl en
 * moins, et un lien mort dans le menu. */
router.get('/', categoryController.listCategories);

/* Pages catégorie en allemand (détail) — MÊME contrôleur que le FR.
 * getCategory est lang-aware (req.lang='de' posé par le middleware i18n) :
 * 301 vers le FR si la catégorie n'est pas traduite, sinon nom/seoText DE +
 * cartes localisées.
 *
 * L'index /de/categorie (liste des catégories) n'est pas encore traduit : il
 * ne matche pas /:slug, retombe donc sur le catchall /de → 301 vers le FR. */
router.get('/:slug', categoryController.getCategory);

module.exports = router;
