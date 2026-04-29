const InvoiceCounter = require('../models/InvoiceCounter');

function formatInvoiceNumber({ year, seq }) {
  const y = Number(year);
  const n = Number(seq);
  const safeYear = Number.isFinite(y) ? y : new Date().getFullYear();
  const safeSeq = Number.isFinite(n) ? n : 0;
  return `F${safeYear}-${String(safeSeq).padStart(6, '0')}`;
}

async function getNextInvoiceNumber({ date } = {}) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = d.getFullYear();

  const counter = await InvoiceCounter.findOneAndUpdate(
    { year },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  ).lean();

  const seq = counter && Number.isFinite(counter.seq) ? counter.seq : 0;

  return {
    year,
    seq,
    invoiceNumber: formatInvoiceNumber({ year, seq }),
  };
}

module.exports = {
  formatInvoiceNumber,
  getNextInvoiceNumber,
};
