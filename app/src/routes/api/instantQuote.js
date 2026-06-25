'use strict';

// API publique du devis instantané : plaque -> moteur identifié -> offres dispo
// (occasion stock Ovoko au prix marge-cible + reconditionné Asysum).
// GET /api/devis-instantane?plaque=AA-123-AA

const express = require('express');
const rateLimit = require('express-rate-limit');
const { lookupPlate } = require('../../services/plateLookup');
const { matchOffers } = require('../../services/instantEngineQuote');

const router = express.Router();

// L'appel API plaque est payant (quota RapidAPI) -> on borne par IP.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { ok: false, reason: 'trop_de_requetes' },
});

router.get('/', limiter, async (req, res) => {
  const plaque = String(req.query.plaque || req.query.plate || '').trim();
  if (!plaque) {
    return res.status(400).json({ ok: false, reason: 'plaque_manquante' });
  }

  let vehicle;
  try {
    vehicle = await lookupPlate(plaque);
  } catch (err) {
    // timeout, réseau, clé absente, API down -> on bascule en devis manuel côté UI
    return res.json({ ok: false, reason: 'api_indisponible' });
  }

  if (!vehicle || !vehicle.codeMoteur) {
    return res.json({ ok: false, reason: 'moteur_non_identifie' });
  }

  const offers = matchOffers(vehicle.codeMoteur, vehicle.codesMoteur);

  return res.json({
    ok: true,
    vehicle: {
      marque: vehicle.marque,
      modele: vehicle.modele,
      label: vehicle.label,
      energie: vehicle.energie,
      cylindree: vehicle.cylindree,
      puissance: vehicle.puissance,
      codeMoteur: vehicle.codeMoteur,
    },
    offers: { occasion: offers.occasion, reman: offers.reman },
    hasOffer: offers.hasOffer,
  });
});

module.exports = router;
