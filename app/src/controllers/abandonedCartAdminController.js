const mongoose = require('mongoose');

const AbandonedCart = require('../models/AbandonedCart');
const { sendAbandonedCartReminder } = require('../services/emailService');

function formatEuro(totalCents) {
  if (!Number.isFinite(totalCents)) return '—';
  return `${(totalCents / 100).toFixed(2).replace('.', ',')} €`;
}

function formatDateTimeFR(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';

  const date = d.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
  });
  const time = d.toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
  });
  return `${date} ${time}`;
}

function getStatusBadge(status) {
  const badges = {
    abandoned: { label: 'Abandonné', className: 'bg-red-50 text-red-700' },
    reminded_1: { label: 'Relance 1', className: 'bg-amber-50 text-amber-700' },
    reminded_2: { label: 'Relance 2', className: 'bg-orange-50 text-orange-700' },
    reminded_3: { label: 'Relance 3', className: 'bg-orange-50 text-orange-800' },
    recovered: { label: 'Récupéré', className: 'bg-green-50 text-green-700' },
    expired: { label: 'Expiré', className: 'bg-slate-100 text-slate-500' },
  };
  return badges[status] || { label: status || '—', className: 'bg-slate-100 text-slate-500' };
}

/**
 * GET /admin/relances
 */
async function getAdminAbandonedCartsPage(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;

    const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    const period = typeof req.query.period === 'string' ? req.query.period.trim() : '';

    if (!dbConnected) {
      return res.render('admin/relances', {
        title: 'Admin - Relances paniers',
        dbConnected,
        carts: [],
        kpis: { abandoned: 0, emailsSent: 0, recovered: 0, recoveryRate: '0' },
        filters: { status, period },
      });
    }

    // KPIs over 30 days
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const [abandonedCount, recoveredCount, allRemindedCarts] = await Promise.all([
      AbandonedCart.countDocuments({ abandonedAt: { $gte: thirtyDaysAgo } }),
      AbandonedCart.countDocuments({
        status: 'recovered',
        recoveredAt: { $gte: thirtyDaysAgo },
      }),
      AbandonedCart.countDocuments({
        lastRemindedAt: { $gte: thirtyDaysAgo },
        status: { $in: ['reminded_1', 'reminded_2', 'reminded_3', 'recovered', 'expired'] },
      }),
    ]);

    const recoveryRate = abandonedCount > 0
      ? ((recoveredCount / abandonedCount) * 100).toFixed(1)
      : '0';

    const kpis = {
      abandoned: abandonedCount,
      emailsSent: allRemindedCarts,
      recovered: recoveredCount,
      recoveryRate,
    };

    // Build filter query
    const query = {};

    const allowedStatuses = new Set(['abandoned', 'reminded_1', 'reminded_2', 'reminded_3', 'recovered', 'expired']);
    if (status && allowedStatuses.has(status)) {
      query.status = status;
    }

    if (period) {
      const today = new Date();
      const start = new Date(today);
      if (period === '7d') start.setDate(start.getDate() - 7);
      if (period === '30d') start.setDate(start.getDate() - 30);
      if (period === '90d') start.setDate(start.getDate() - 90);

      if (['7d', '30d', '90d'].includes(period)) {
        query.abandonedAt = { $gte: start };
      }
    }

    const carts = await AbandonedCart.find(query)
      .sort({ abandonedAt: -1 })
      .limit(200)
      .lean();

    const viewCarts = carts.map((c) => ({
      id: String(c._id),
      abandonedAt: formatDateTimeFR(c.abandonedAt),
      email: c.email || '—',
      firstName: c.firstName || '',
      items: Array.isArray(c.items) ? c.items : [],
      itemCount: Array.isArray(c.items) ? c.items.length : 0,
      itemsSummary: Array.isArray(c.items)
        ? c.items.slice(0, 3).map((it) => it.name || 'Article').join(', ') +
          (c.items.length > 3 ? ` +${c.items.length - 3}` : '')
        : '—',
      totalAmount: formatEuro(c.totalAmountCents),
      totalAmountCents: c.totalAmountCents || 0,
      status: c.status,
      statusBadge: getStatusBadge(c.status),
      lastRemindedAt: formatDateTimeFR(c.lastRemindedAt),
      recoveredAt: formatDateTimeFR(c.recoveredAt),
      canRemind: ['abandoned', 'reminded_1', 'reminded_2'].includes(c.status),
    }));

    return res.render('admin/relances', {
      title: 'Admin - Relances paniers',
      dbConnected,
      carts: viewCarts,
      kpis,
      filters: { status, period },
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /admin/relances/:cartId/relancer
 * Manually triggers the next reminder for a given abandoned cart.
 */
async function postAdminManualReminder(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    if (!dbConnected) {
      return res.status(503).json({ ok: false, error: 'Base de données indisponible.' });
    }

    const cartId = req.params.cartId;
    if (!cartId || !mongoose.Types.ObjectId.isValid(cartId)) {
      return res.status(400).json({ ok: false, error: 'ID panier invalide.' });
    }

    const cart = await AbandonedCart.findById(cartId).lean();
    if (!cart) {
      return res.status(404).json({ ok: false, error: 'Panier non trouvé.' });
    }

    if (cart.status === 'recovered' || cart.status === 'expired') {
      return res.status(400).json({ ok: false, error: 'Ce panier ne peut plus être relancé.' });
    }

    // Determine which reminder to send
    let reminderNumber;
    let nextStatus;

    if (cart.status === 'abandoned') {
      reminderNumber = 1;
      nextStatus = 'reminded_1';
    } else if (cart.status === 'reminded_1') {
      reminderNumber = 2;
      nextStatus = 'reminded_2';
    } else if (cart.status === 'reminded_2') {
      reminderNumber = 3;
      nextStatus = 'reminded_3';
    } else if (cart.status === 'reminded_3') {
      // Already had all reminders
      return res.status(400).json({ ok: false, error: 'Toutes les relances ont déjà été envoyées.' });
    } else {
      return res.status(400).json({ ok: false, error: 'Statut invalide.' });
    }

    const promoCode = typeof process.env.ABANDONED_CART_PROMO_CODE === 'string'
      ? process.env.ABANDONED_CART_PROMO_CODE.trim()
      : '';

    const result = await sendAbandonedCartReminder({
      cart: {
        email: cart.email,
        firstName: cart.firstName || '',
        items: cart.items || [],
        totalAmountCents: cart.totalAmountCents || 0,
        recoveryToken: cart.recoveryToken,
      },
      reminderNumber,
      promoCode: reminderNumber === 3 ? promoCode : undefined,
    });

    if (result && result.ok) {
      await AbandonedCart.updateOne(
        { _id: cart._id },
        {
          $set: {
            status: nextStatus,
            lastRemindedAt: new Date(),
          },
        }
      );

      return res.redirect('/admin/relances');
    }

    return res.status(500).json({
      ok: false,
      error: `Échec envoi email: ${result && result.reason ? result.reason : 'erreur inconnue'}`,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /admin/relances/:cartId
 * Shows cart detail (JSON for now, could be a detail page later).
 */
async function getAdminAbandonedCartDetail(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    if (!dbConnected) {
      return res.status(503).json({ ok: false, error: 'Base de données indisponible.' });
    }

    const cartId = req.params.cartId;
    if (!cartId || !mongoose.Types.ObjectId.isValid(cartId)) {
      return res.status(400).json({ ok: false, error: 'ID panier invalide.' });
    }

    const cart = await AbandonedCart.findById(cartId).lean();
    if (!cart) {
      return res.status(404).json({ ok: false, error: 'Panier non trouvé.' });
    }

    return res.json({
      ok: true,
      cart: {
        id: String(cart._id),
        sessionId: cart.sessionId,
        email: cart.email,
        firstName: cart.firstName,
        items: (cart.items || []).map((it) => ({
          name: it.name,
          sku: it.sku,
          price: formatEuro(it.price),
          quantity: it.quantity,
          image: it.image,
        })),
        totalAmount: formatEuro(cart.totalAmountCents),
        status: cart.status,
        statusLabel: getStatusBadge(cart.status).label,
        abandonedAt: formatDateTimeFR(cart.abandonedAt),
        lastRemindedAt: formatDateTimeFR(cart.lastRemindedAt),
        recoveredAt: formatDateTimeFR(cart.recoveredAt),
        recoveryToken: cart.recoveryToken,
        createdAt: formatDateTimeFR(cart.createdAt),
      },
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getAdminAbandonedCartsPage,
  postAdminManualReminder,
  getAdminAbandonedCartDetail,
};
