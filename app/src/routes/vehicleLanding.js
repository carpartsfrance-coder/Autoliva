'use strict';

const express = require('express');
const ctrl = require('../controllers/vehicleLandingController');

const router = express.Router();

/* GET /pieces-auto             → index marques  */
/* GET /pieces-auto/:make       → landing marque */
/* GET /pieces-auto/:make/:model → landing modèle */
/* (Phase 2 ajoutera /:make/:model/:category) */

router.get('/', ctrl.listMakes);
router.get('/:make', ctrl.getMakeLanding);
router.get('/:make/:model', ctrl.getModelLanding);
router.get('/:make/:model/:category', ctrl.getModelCategoryLanding);

module.exports = router;
