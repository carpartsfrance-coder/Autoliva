const mongoose = require('mongoose');

const invoiceCounterSchema = new mongoose.Schema(
  {
    year: { type: Number, required: true, unique: true, index: true },
    seq: { type: Number, required: true, default: 0 },
  },
  { timestamps: true }
);

module.exports = mongoose.model('InvoiceCounter', invoiceCounterSchema);
