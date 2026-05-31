'use strict';

/**
 * Routes API publiques pour le workflow devis moteurs.
 * Montées sous /api/devis-moteurs dans app.js (PAS d'auth admin).
 */

const express = require('express');
const router = express.Router();
const ctrl = require('../../controllers/engineQuotePublicController');

// Webhook Mollie (form-encoded { id })
router.post('/mollie-webhook', express.urlencoded({ extended: false }), ctrl.postMollieWebhook);

// Pixel de tracking ouverture email
router.get('/track-open/:cartId/:sentQuoteId', ctrl.getTrackOpen);

// Lien tracké : clic sur le bouton de paiement (redirige vers Mollie)
router.get('/track-pay/:cartId/:sentQuoteId', ctrl.getTrackPay);

// Lien tracké : vue du PDF en ligne (redirige vers le PDF GridFS)
router.get('/track-pdf/:cartId/:sentQuoteId', ctrl.getTrackPdf);

module.exports = router;
