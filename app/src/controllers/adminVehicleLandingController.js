'use strict';

/*
 * adminVehicleLandingController.js
 *
 * CRUD pour les pages /admin/landings-vehicule.
 * Permet à l'admin de remplir un seoText custom + meta overrides pour
 * chaque combo (make, model, partType) afin de booster les landings
 * stratégiques.
 */

const mongoose = require('mongoose');
const VehicleLanding = require('../models/VehicleLanding');
const Category = require('../models/Category');
const vehicleService = require('../services/vehicleLandingService');
const brand = require('../config/brand');

function getTrimmed(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * GET /admin/landings-vehicule
 * Liste toutes les landings configurées + form de création/filtrage.
 */
async function listLandings(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    let landings = [];
    let makes = [];
    let categories = [];

    if (dbConnected) {
      [landings, makes, categories] = await Promise.all([
        VehicleLanding.find({}).sort({ make: 1, model: 1, partType: 1 }).lean(),
        vehicleService.listMakes(),
        Category.find({ isActive: { $ne: false } }).select('name slug').sort({ sortOrder: 1, name: 1 }).lean(),
      ]);
    }

    /* Pour chaque landing, on enrichit avec un libellé "make / model / partType"
     * et une URL preview vers la page publique. */
    const landingsView = landings.map((l) => {
      const labelParts = [l.make];
      if (l.model) labelParts.push(l.model);
      if (l.partType) labelParts.push(l.partType);
      let previewUrl = `/pieces-auto/${l.make}`;
      if (l.model) previewUrl += `/${l.model}`;
      if (l.partType) previewUrl += `/${l.partType}`;
      return {
        ...l,
        label: labelParts.join(' / '),
        previewUrl,
      };
    });

    const successMessage = req.session && req.session.adminVehicleLandingSuccess
      ? req.session.adminVehicleLandingSuccess : null;
    const errorMessage = req.session && req.session.adminVehicleLandingError
      ? req.session.adminVehicleLandingError : null;
    if (req.session) {
      delete req.session.adminVehicleLandingSuccess;
      delete req.session.adminVehicleLandingError;
    }

    return res.render('admin/vehicle-landings', {
      title: `Admin - Landings véhicule | ${brand.NAME}`,
      dbConnected,
      landings: landingsView,
      makes,
      categories,
      successMessage,
      errorMessage,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /admin/landings-vehicule/:id
 * Édition d'une landing existante (ou nouvelle si :id == 'new').
 */
async function getLandingEdit(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const id = String(req.params.id || '').trim();
    let landing = null;

    if (id !== 'new' && mongoose.Types.ObjectId.isValid(id) && dbConnected) {
      landing = await VehicleLanding.findById(id).lean();
      if (!landing) {
        return res.status(404).render('errors/404', { title: `Page introuvable - ${brand.NAME}` });
      }
    }

    let makes = [];
    let categories = [];
    if (dbConnected) {
      [makes, categories] = await Promise.all([
        vehicleService.listMakes(),
        Category.find({ isActive: { $ne: false } }).select('name slug').sort({ sortOrder: 1, name: 1 }).lean(),
      ]);
    }

    return res.render('admin/vehicle-landing-edit', {
      title: landing
        ? `Éditer landing ${landing.make}${landing.model ? '/' + landing.model : ''}${landing.partType ? '/' + landing.partType : ''} | ${brand.NAME}`
        : `Nouvelle landing véhicule | ${brand.NAME}`,
      dbConnected,
      landing,
      makes,
      categories,
      isNew: id === 'new',
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /admin/landings-vehicule
 * Création (id === 'new') ou update.
 */
async function postLandingSave(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    if (!dbConnected) {
      req.session.adminVehicleLandingError = "Base de données non connectée.";
      return res.redirect('/admin/landings-vehicule');
    }

    const id = String((req.body && req.body.id) || '').trim();
    const make = getTrimmed(req.body.make).toLowerCase();
    const model = getTrimmed(req.body.model).toLowerCase() || null;
    const partType = getTrimmed(req.body.partType).toLowerCase() || null;
    const seoText = getTrimmed(req.body.seoText);
    const metaTitle = getTrimmed(req.body.metaTitle);
    const metaDescription = getTrimmed(req.body.metaDescription);
    const h1Override = getTrimmed(req.body.h1Override);
    const isActive = req.body.isActive === 'true' || req.body.isActive === true || req.body.isActive === 'on';

    if (!make) {
      req.session.adminVehicleLandingError = "Le champ Marque est obligatoire.";
      return res.redirect('/admin/landings-vehicule');
    }

    const payload = { make, model, partType, seoText, metaTitle, metaDescription, h1Override, isActive };

    let saved = null;
    if (id && id !== 'new' && mongoose.Types.ObjectId.isValid(id)) {
      saved = await VehicleLanding.findByIdAndUpdate(id, { $set: payload }, { new: true, runValidators: true });
      if (!saved) {
        req.session.adminVehicleLandingError = "Landing introuvable.";
        return res.redirect('/admin/landings-vehicule');
      }
    } else {
      try {
        saved = await VehicleLanding.create(payload);
      } catch (err) {
        if (err && err.code === 11000) {
          req.session.adminVehicleLandingError = `Une landing existe déjà pour ${make}${model ? '/' + model : ''}${partType ? '/' + partType : ''}. Édite-la au lieu de la recréer.`;
          return res.redirect('/admin/landings-vehicule');
        }
        throw err;
      }
    }

    req.session.adminVehicleLandingSuccess = `Landing ${saved.make}${saved.model ? '/' + saved.model : ''}${saved.partType ? '/' + saved.partType : ''} sauvegardée.`;
    return res.redirect('/admin/landings-vehicule');
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /admin/landings-vehicule/:id/supprimer
 */
async function postLandingDelete(req, res, next) {
  try {
    const id = String(req.params.id || '').trim();
    if (!mongoose.Types.ObjectId.isValid(id)) {
      req.session.adminVehicleLandingError = "ID invalide.";
      return res.redirect('/admin/landings-vehicule');
    }
    const deleted = await VehicleLanding.findByIdAndDelete(id);
    if (!deleted) {
      req.session.adminVehicleLandingError = "Landing introuvable.";
    } else {
      req.session.adminVehicleLandingSuccess = `Landing ${deleted.make}${deleted.model ? '/' + deleted.model : ''}${deleted.partType ? '/' + deleted.partType : ''} supprimée.`;
    }
    return res.redirect('/admin/landings-vehicule');
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  listLandings,
  getLandingEdit,
  postLandingSave,
  postLandingDelete,
};
