const mongoose = require('mongoose');

const PromoCode = require('../models/PromoCode');
const PromoRedemption = require('../models/PromoRedemption');

function normalizeCode(value) {
  if (typeof value !== 'string') return '';
  return value.replace(/\s+/g, '').trim().toUpperCase();
}

function isValidCode(value) {
  if (!value) return false;
  return /^[A-Z0-9_-]{3,30}$/.test(value);
}

function isWithinPeriod(promo, now) {
  if (!promo) return false;
  const t = now.getTime();
  if (promo.startsAt) {
    const s = new Date(promo.startsAt);
    if (!Number.isNaN(s.getTime()) && t < s.getTime()) return false;
  }
  if (promo.endsAt) {
    const e = new Date(promo.endsAt);
    if (!Number.isNaN(e.getTime()) && t > e.getTime()) return false;
  }
  return true;
}

async function getApplicablePromo({ code, userId = null, itemsSubtotalCents = 0 } = {}) {
  const normalized = normalizeCode(code);
  if (!normalized || !isValidCode(normalized)) {
    return { ok: false, reason: 'Code invalide.', promo: null, code: normalized };
  }

  const promo = await PromoCode.findOne({ code: normalized }).lean();
  if (!promo) {
    return { ok: false, reason: 'Code promo introuvable.', promo: null, code: normalized };
  }

  if (promo.isActive === false) {
    return { ok: false, reason: 'Ce code promo est inactif.', promo: null, code: normalized };
  }

  const now = new Date();
  if (!isWithinPeriod(promo, now)) {
    return { ok: false, reason: 'Ce code promo n’est pas valide à cette date.', promo: null, code: normalized };
  }

  const subtotal = Number(itemsSubtotalCents) || 0;
  const minSubtotal = Number(promo.minSubtotalCents) || 0;
  if (minSubtotal > 0 && subtotal < minSubtotal) {
    return {
      ok: false,
      reason: `Montant minimum requis : ${(minSubtotal / 100).toFixed(2).replace('.', ',')} €`,
      promo: null,
      code: normalized,
    };
  }

  const promoId = promo && promo._id ? promo._id : null;

  if (promoId && promo.maxTotalUses) {
    const max = Number(promo.maxTotalUses) || 0;
    if (max > 0) {
      const activeCount = await PromoRedemption.countDocuments({
        promoCodeId: promoId,
        $or: [
          { state: 'redeemed' },
          { state: 'reserved', expiresAt: { $gt: now } },
        ],
      });

      if (activeCount >= max) {
        return { ok: false, reason: 'Ce code promo a atteint sa limite d’utilisation.', promo: null, code: normalized };
      }
    }
  }

  if (promoId && promo.maxUsesPerUser && userId && mongoose.Types.ObjectId.isValid(String(userId))) {
    const max = Number(promo.maxUsesPerUser) || 0;
    if (max > 0) {
      const activeUserCount = await PromoRedemption.countDocuments({
        promoCodeId: promoId,
        userId: new mongoose.Types.ObjectId(String(userId)),
        $or: [
          { state: 'redeemed' },
          { state: 'reserved', expiresAt: { $gt: now } },
        ],
      });

      if (activeUserCount >= max) {
        return { ok: false, reason: 'Ce code promo a déjà été utilisé sur ce compte.', promo: null, code: normalized };
      }
    }
  }

  return { ok: true, reason: '', promo, code: normalized };
}

async function reservePromo({ promoId, userId, orderId, ttlMinutes = 120 } = {}) {
  if (!promoId || !userId || !orderId) return null;

  if (!mongoose.Types.ObjectId.isValid(String(promoId))) return null;
  if (!mongoose.Types.ObjectId.isValid(String(userId))) return null;
  if (!mongoose.Types.ObjectId.isValid(String(orderId))) return null;

  const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

  const redemption = await PromoRedemption.create({
    promoCodeId: new mongoose.Types.ObjectId(String(promoId)),
    userId: new mongoose.Types.ObjectId(String(userId)),
    orderId: new mongoose.Types.ObjectId(String(orderId)),
    state: 'reserved',
    expiresAt,
    redeemedAt: null,
  });

  return redemption;
}

async function redeemReservedForOrder(orderId) {
  if (!orderId || !mongoose.Types.ObjectId.isValid(String(orderId))) return;

  await PromoRedemption.updateMany(
    { orderId: new mongoose.Types.ObjectId(String(orderId)), state: 'reserved' },
    { $set: { state: 'redeemed', redeemedAt: new Date(), expiresAt: null } }
  );
}

async function releaseReservedForOrder(orderId) {
  if (!orderId || !mongoose.Types.ObjectId.isValid(String(orderId))) return;

  await PromoRedemption.deleteMany({
    orderId: new mongoose.Types.ObjectId(String(orderId)),
    state: 'reserved',
  });
}

module.exports = {
  normalizeCode,
  isValidCode,
  getApplicablePromo,
  reservePromo,
  redeemReservedForOrder,
  releaseReservedForOrder,
};
