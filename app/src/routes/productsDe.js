'use strict';

const express = require('express');

const productController = require('../controllers/productController');

const router = express.Router();

/* Détail produit en allemand — MÊME contrôleur que le FR. L'allemand est un
 * CALQUE : le middleware i18n pose req.lang='de' d'après le préfixe /de/, et
 * getProduct superpose alors localizations.de (301 vers le FR si non traduit).
 *
 * Le listing /de/produits (racine) n'est pas encore traduit : il ne matche pas
 * /:id, retombe donc sur le catchall app.use('/de', …) → 301 vers le FR. */
// Listing catalogue en allemand (/de/produits) — même contrôleur que le FR,
// req.lang='de' → cartes localisées + liens vers les fiches DE.
router.get('/', productController.listProducts);

router.get('/:id', productController.getProduct);

module.exports = router;
