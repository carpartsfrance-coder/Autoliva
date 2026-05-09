'use strict';

function eurFromCents(cents) {
  if (typeof cents !== 'number' || !isFinite(cents)) return 0;
  return Math.round(cents) / 100;
}

function pct(num, den) {
  if (!den) return 0;
  return Number(((num / den) * 100).toFixed(2));
}

function deltaPct(current, previous) {
  if (!previous) return current ? 100 : 0;
  return Number((((current - previous) / previous) * 100).toFixed(2));
}

function jsonResult(payload) {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

module.exports = { eurFromCents, pct, deltaPct, jsonResult };
