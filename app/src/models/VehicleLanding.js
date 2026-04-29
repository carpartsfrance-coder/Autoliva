const mongoose = require('mongoose');

/*
 * VehicleLanding — contenu SEO admin-éditable pour les landing pages véhicule.
 *
 * Une entrée correspond à un combo (make, model, partType). Tous les champs sauf
 * `make` peuvent être null pour cibler des pages plus génériques :
 *   - { make: 'Audi' }                                              → /pieces-auto/audi
 *   - { make: 'Audi', model: 'Q5' }                                 → /pieces-auto/audi/q5
 *   - { make: 'Audi', model: 'Q5', partType: 'transmission' }       → /pieces-auto/audi/q5/transmission
 *
 * Si aucune VehicleLanding n'existe pour un combo, le controller utilise un
 * texte généré automatiquement à partir d'un template. L'admin remplit cette
 * collection pour les top-50 combos les plus stratégiques.
 */

const vehicleLandingSchema = new mongoose.Schema(
  {
    make: { type: String, required: true, trim: true, lowercase: true },
    model: { type: String, default: null, trim: true, lowercase: true },
    partType: { type: String, default: null, trim: true, lowercase: true },

    /* Contenu SEO — HTML autorisé (sanitized côté admin save). */
    seoText: { type: String, default: '', trim: false },

    /* Overrides meta — si vide, on utilise le template auto-généré. */
    metaTitle: { type: String, default: '', trim: true },
    metaDescription: { type: String, default: '', trim: true },

    /* H1 override — si vide, on utilise "Pièces auto reconditionnées {Make} {Model}". */
    h1Override: { type: String, default: '', trim: true },

    isActive: { type: Boolean, default: true },
  },
  { timestamps: true }
);

/* Index composite pour lookup rapide (make, model, partType). Le modèle null
 * est traité comme une valeur normale par MongoDB. */
vehicleLandingSchema.index(
  { make: 1, model: 1, partType: 1 },
  { unique: true }
);

module.exports = mongoose.model('VehicleLanding', vehicleLandingSchema);
