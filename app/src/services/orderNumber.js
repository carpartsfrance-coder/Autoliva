const OrderCounter = require('../models/OrderCounter');

function formatOrderNumber({ year, seq }) {
  const y = Number(year);
  const n = Number(seq);
  const safeYear = Number.isFinite(y) ? y : new Date().getFullYear();
  const safeSeq = Number.isFinite(n) ? n : 0;
  return `CP${safeYear}-${String(safeSeq).padStart(6, '0')}`;
}

async function getNextOrderNumber({ date } = {}) {
  const d = date instanceof Date && !Number.isNaN(date.getTime()) ? date : new Date();
  const year = d.getFullYear();

  const counter = await OrderCounter.findOneAndUpdate(
    { year },
    { $inc: { seq: 1 } },
    { new: true, upsert: true }
  ).lean();

  const seq = counter && Number.isFinite(counter.seq) ? counter.seq : 0;
  return {
    year,
    seq,
    orderNumber: formatOrderNumber({ year, seq }),
  };
}

module.exports = {
  formatOrderNumber,
  getNextOrderNumber,
};
