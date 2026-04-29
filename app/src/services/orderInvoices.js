const Order = require('../models/Order');
const { getNextInvoiceNumber } = require('./invoiceNumber');

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : value ? String(value).trim() : '';
}

function toValidDate(value) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }

  if (!value) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

async function ensureInvoiceIssuedForPaidOrder(orderId, { date } = {}) {
  if (!orderId) return null;

  const current = await Order.findById(orderId)
    .select('_id paymentStatus invoice createdAt')
    .lean();

  if (!current) return null;

  const isPaid = getTrimmedString(current.paymentStatus).toLowerCase() === 'paid';
  const alreadyIssued = current.invoice && typeof current.invoice.number === 'string' && current.invoice.number.trim();
  const requestedDate = toValidDate(date);
  const orderCreatedAt = toValidDate(current.createdAt);
  const existingIssuedAt = toValidDate(current && current.invoice ? current.invoice.issuedAt : null);
  const stableIssuedAt = requestedDate || orderCreatedAt || existingIssuedAt || new Date();

  if (!isPaid) return current;

  if (alreadyIssued) {
    const needsIssuedAtUpdate = !existingIssuedAt || existingIssuedAt.getTime() !== stableIssuedAt.getTime();
    if (!needsIssuedAtUpdate) return current;

    await Order.updateOne(
      { _id: current._id },
      {
        $set: {
          'invoice.issuedAt': stableIssuedAt,
        },
      }
    );

    return Order.findById(current._id)
      .select('_id paymentStatus invoice createdAt')
      .lean();
  }

  const next = await getNextInvoiceNumber({ date: stableIssuedAt });

  await Order.updateOne(
    {
      _id: current._id,
      $or: [
        { 'invoice.number': { $exists: false } },
        { 'invoice.number': null },
        { 'invoice.number': '' },
      ],
    },
    {
      $set: {
        'invoice.number': next.invoiceNumber,
        'invoice.issuedAt': stableIssuedAt,
      },
    }
  );

  return Order.findById(current._id)
    .select('_id paymentStatus invoice createdAt')
    .lean();
}

module.exports = {
  ensureInvoiceIssuedForPaidOrder,
};
