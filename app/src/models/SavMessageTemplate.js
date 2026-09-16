const mongoose = require('mongoose');

/*
 * Modèle de message SAV partagé par toute l'équipe : un texte et, si besoin,
 * des pièces jointes (ex. photo d'exemple d'un écran de réglage de base).
 * Les fichiers vivent dans GridFS (sans ticket rattaché → accès admin seulement) ;
 * à l'envoi, une copie est jointe au ticket comme n'importe quelle pièce jointe.
 */
const SavMessageTemplateSchema = new mongoose.Schema(
  {
    title: { type: String, required: true, trim: true, maxlength: 80 },
    body: { type: String, required: true, trim: true, maxlength: 5000 },
    attachments: [{
      _id: false,
      url: { type: String, required: true, trim: true },
      originalName: { type: String, trim: true },
      mime: { type: String, trim: true },
      size: { type: Number, min: 0 },
    }],
    createdByEmail: { type: String, trim: true },
    usageCount: { type: Number, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('SavMessageTemplate', SavMessageTemplateSchema);
