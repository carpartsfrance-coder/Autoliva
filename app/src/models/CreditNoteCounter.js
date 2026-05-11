const mongoose = require('mongoose');

/* Compteur annuel pour numérotation des avoirs : AV-YYYY-NNNN (4 chiffres). */
const creditNoteCounterSchema = new mongoose.Schema(
  {
    year: { type: Number, required: true, unique: true, index: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('CreditNoteCounter', creditNoteCounterSchema);
