const mongoose = require('mongoose');

/**
 * Bloc d'information réutilisable affiché sur les fiches produit.
 * Une modification ici se répercute sur TOUTES les fiches qui l'utilisent
 * (les produits référencent les blocs par id, le contenu n'est pas dupliqué).
 *
 * position : où le bloc s'affiche sur la fiche
 *  - 'description_end'   → à la fin de la description
 *  - 'after_inclusions'  → après le bloc « pièces incluses / non incluses »
 *  - 'dedicated_tab'     → dans un onglet dédié « Bon à savoir »
 *
 * autoCategories : sous-chaînes testées (insensible à la casse) contre la
 *  catégorie du produit pour la PRÉ-SÉLECTION par défaut sur la fiche
 *  (ex. ['moteur'] → pré-coché pour les produits « Moteurs »). Modifiable
 *  ensuite par fiche.
 */
const POSITIONS = ['description_end', 'after_inclusions', 'dedicated_tab'];

const infoBlockSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true },
    slug: { type: String, required: true, trim: true, lowercase: true },
    content: { type: String, default: '', trim: true }, // markdown simple
    position: { type: String, enum: POSITIONS, default: 'description_end' },
    autoCategories: { type: [String], default: [] },
    isActive: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 },
  },
  {
    timestamps: true,
  }
);

infoBlockSchema.index({ slug: 1 }, { unique: true });
infoBlockSchema.index({ isActive: 1, sortOrder: 1, title: 1 });

const InfoBlock = mongoose.model('InfoBlock', infoBlockSchema);
InfoBlock.POSITIONS = POSITIONS;

module.exports = InfoBlock;
