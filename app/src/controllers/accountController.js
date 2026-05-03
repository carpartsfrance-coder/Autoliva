const mongoose = require('mongoose');
const fs = require('fs');

const crypto = require('crypto');

const User = require('../models/User');
const Order = require('../models/Order');
const Product = require('../models/Product');
const demoProducts = require('../demoProducts');

const track17 = require('../services/track17');
const trackingLinks = require('../services/trackingLinks');
const emailService = require('../services/emailService');
const { buildOrderInvoicePdfBuffer } = require('../services/invoicePdf');
const { ensureInvoiceIssuedForPaidOrder } = require('../services/orderInvoices');
const productOptions = require('../services/productOptions');
const { logExistingCartItems } = require('../services/cartEventLogger');
const { getSiteUrlFromEnv } = require('../services/siteUrl');
const brand = require('../config/brand');

const LOGIN_BUCKETS = new Map();
const REGISTER_BUCKETS = new Map();
const FORGOT_BUCKETS = new Map();
const RESET_BUCKETS = new Map();

function getClientIp(req) {
  const xfwd = req && req.headers ? req.headers['x-forwarded-for'] : null;
  const fromHeader = Array.isArray(xfwd) ? xfwd[0] : typeof xfwd === 'string' ? xfwd.split(',')[0] : '';
  const candidate = getTrimmedString(fromHeader) || (req && req.ip ? String(req.ip) : '');
  return candidate || 'unknown';
}

function consumeRateLimit(buckets, key, { limit, windowMs } = {}) {
  const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 20;
  const safeWindowMs = Number.isFinite(windowMs) ? Math.max(1000, Math.floor(windowMs)) : 10 * 60 * 1000;
  const now = Date.now();
  const entry = buckets.get(key);

  if (!entry || typeof entry.resetAt !== 'number' || now >= entry.resetAt) {
    buckets.set(key, { count: 1, resetAt: now + safeWindowMs });
    return { limited: false, remaining: safeLimit - 1 };
  }

  entry.count += 1;
  const remaining = Math.max(0, safeLimit - entry.count);
  return { limited: entry.count > safeLimit, remaining };
}

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : value ? String(value).trim() : '';
}

function getCart(req) {
  if (!req.session.cart) {
    req.session.cart = { items: {} };
  }

  return req.session.cart;
}

function getForgotPassword(req, res) {
  const dbConnected = mongoose.connection.readyState === 1;

  return res.render('account/forgot-password', {
    title: `Mot de passe oublié - ${brand.NAME}`,
    dbConnected,
    errorMessage: null,
    successMessage: null,
    email: '',
  });
}

async function postForgotPassword(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const email = normalizeEmail(req.body.email);

    const ip = getClientIp(req);
    const honeypot = getTrimmedString(req.body && req.body.website);
    if (honeypot) {
      return res.render('account/forgot-password', {
        title: `Mot de passe oublié - ${brand.NAME}`,
        dbConnected,
        errorMessage: null,
        successMessage: "Si un compte existe avec cet email, vous allez recevoir un lien de réinitialisation.",
        email: '',
      });
    }

    const limit = consumeRateLimit(FORGOT_BUCKETS, ip, { limit: 10, windowMs: 10 * 60 * 1000 });
    if (limit.limited) {
      return res.status(429).render('account/forgot-password', {
        title: `Mot de passe oublié - ${brand.NAME}`,
        dbConnected,
        errorMessage: 'Trop de tentatives. Merci de patienter quelques minutes puis de réessayer.',
        successMessage: null,
        email,
      });
    }

    if (!email) {
      return res.status(400).render('account/forgot-password', {
        title: `Mot de passe oublié - ${brand.NAME}`,
        dbConnected,
        errorMessage: 'Merci de renseigner votre email.',
        successMessage: null,
        email,
      });
    }

    if (!dbConnected) {
      return res.status(503).render('account/forgot-password', {
        title: `Mot de passe oublié - ${brand.NAME}`,
        dbConnected,
        errorMessage: "La base de données n'est pas disponible. Réessayez plus tard.",
        successMessage: null,
        email,
      });
    }

    const user = await User.findOne({ email }).select('_id email firstName').lean();
    if (user) {
      const token = crypto.randomBytes(32).toString('hex');
      const tokenHash = sha256Hex(token);
      const ttlMinutes = getResetPasswordTtlMinutes();
      const expiresAt = new Date(Date.now() + ttlMinutes * 60 * 1000);

      await User.updateOne(
        { _id: user._id },
        {
          $set: {
            resetPasswordTokenHash: tokenHash,
            resetPasswordExpiresAt: expiresAt,
          },
        }
      );

      const resetUrl = buildResetUrl(token);
      if (resetUrl) {
        try {
          await emailService.sendResetPasswordEmail({ user, resetUrl });
        } catch (err) {
          console.error('Erreur email reset mot de passe :', err && err.message ? err.message : err);
        }
      }
    }

    return res.render('account/forgot-password', {
      title: `Mot de passe oublié - ${brand.NAME}`,
      dbConnected,
      errorMessage: null,
      successMessage: "Si un compte existe avec cet email, vous allez recevoir un lien de réinitialisation.",
      email: '',
    });
  } catch (err) {
    return next(err);
  }
}

async function getResetPassword(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const token = typeof req.query.token === 'string' ? req.query.token.trim() : '';
    const tokenHash = token ? sha256Hex(token) : '';

    if (!dbConnected) {
      return res.status(503).render('account/reset-password', {
        title: `Réinitialiser le mot de passe - ${brand.NAME}`,
        dbConnected,
        errorMessage: "La base de données n'est pas disponible. Réessayez plus tard.",
        successMessage: null,
        token,
      });
    }

    if (!tokenHash) {
      return res.status(400).render('account/reset-password', {
        title: `Réinitialiser le mot de passe - ${brand.NAME}`,
        dbConnected,
        errorMessage: 'Lien invalide.',
        successMessage: null,
        token: '',
      });
    }

    const user = await User.findOne({
      resetPasswordTokenHash: tokenHash,
      resetPasswordExpiresAt: { $gt: new Date() },
    }).select('_id').lean();

    if (!user) {
      return res.status(400).render('account/reset-password', {
        title: `Réinitialiser le mot de passe - ${brand.NAME}`,
        dbConnected,
        errorMessage: 'Lien expiré ou invalide. Merci de refaire une demande.',
        successMessage: null,
        token: '',
      });
    }

    return res.render('account/reset-password', {
      title: `Réinitialiser le mot de passe - ${brand.NAME}`,
      dbConnected,
      errorMessage: null,
      successMessage: null,
      token,
    });
  } catch (err) {
    return next(err);
  }
}

async function postResetPassword(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const token = typeof req.body.token === 'string' ? req.body.token.trim() : '';
    const newPassword = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';
    const confirmPassword = typeof req.body.confirmPassword === 'string' ? req.body.confirmPassword : '';

    const ip = getClientIp(req);
    const honeypot = getTrimmedString(req.body && req.body.website);
    if (honeypot) {
      return res.status(400).render('account/reset-password', {
        title: `Réinitialiser le mot de passe - ${brand.NAME}`,
        dbConnected,
        errorMessage: 'Lien expiré ou invalide. Merci de refaire une demande.',
        successMessage: null,
        token: '',
      });
    }

    const limit = consumeRateLimit(RESET_BUCKETS, ip, { limit: 15, windowMs: 10 * 60 * 1000 });
    if (limit.limited) {
      return res.status(429).render('account/reset-password', {
        title: `Réinitialiser le mot de passe - ${brand.NAME}`,
        dbConnected,
        errorMessage: 'Trop de tentatives. Merci de patienter quelques minutes puis de réessayer.',
        successMessage: null,
        token,
      });
    }

    if (!dbConnected) {
      return res.status(503).render('account/reset-password', {
        title: `Réinitialiser le mot de passe - ${brand.NAME}`,
        dbConnected,
        errorMessage: "La base de données n'est pas disponible. Réessayez plus tard.",
        successMessage: null,
        token,
      });
    }

    if (!token) {
      return res.status(400).render('account/reset-password', {
        title: `Réinitialiser le mot de passe - ${brand.NAME}`,
        dbConnected,
        errorMessage: 'Lien invalide.',
        successMessage: null,
        token: '',
      });
    }

    if (!newPassword || !confirmPassword) {
      return res.status(400).render('account/reset-password', {
        title: `Réinitialiser le mot de passe - ${brand.NAME}`,
        dbConnected,
        errorMessage: 'Merci de remplir tous les champs.',
        successMessage: null,
        token,
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).render('account/reset-password', {
        title: `Réinitialiser le mot de passe - ${brand.NAME}`,
        dbConnected,
        errorMessage: 'Le mot de passe doit faire au moins 6 caractères.',
        successMessage: null,
        token,
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).render('account/reset-password', {
        title: `Réinitialiser le mot de passe - ${brand.NAME}`,
        dbConnected,
        errorMessage: 'La confirmation du mot de passe ne correspond pas.',
        successMessage: null,
        token,
      });
    }

    const tokenHash = sha256Hex(token);
    const newSalt = crypto.randomBytes(16).toString('hex');
    const newHash = hashPassword(newPassword, newSalt);

    const updateResult = await User.updateOne(
      {
        resetPasswordTokenHash: tokenHash,
        resetPasswordExpiresAt: { $gt: new Date() },
      },
      {
        $set: {
          passwordSalt: newSalt,
          passwordHash: newHash,
          resetPasswordTokenHash: '',
          resetPasswordExpiresAt: null,
        },
      }
    );

    if (!updateResult || updateResult.modifiedCount !== 1) {
      return res.status(400).render('account/reset-password', {
        title: `Réinitialiser le mot de passe - ${brand.NAME}`,
        dbConnected,
        errorMessage: 'Lien expiré ou invalide. Merci de refaire une demande.',
        successMessage: null,
        token: '',
      });
    }

    if (req.session) {
      req.session.accountSuccess = 'Mot de passe réinitialisé. Vous pouvez vous connecter.';
    }
    return res.redirect('/compte/connexion');
  } catch (err) {
    return next(err);
  }
}

function getSafeReturnTo(value) {
  if (typeof value !== 'string') return null;
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//')) return null;
  return value;
}

function sha256Hex(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex');
}

function getPublicBaseUrl() {
  return getSiteUrlFromEnv();
}

function getResetPasswordTtlMinutes() {
  const raw = typeof process.env.RESET_PASSWORD_TOKEN_TTL_MINUTES === 'string'
    ? process.env.RESET_PASSWORD_TOKEN_TTL_MINUTES.trim()
    : '';
  const n = Number.parseInt(raw || '60', 10);
  if (!Number.isFinite(n) || n < 10) return 60;
  return Math.min(24 * 60, n);
}

function buildResetUrl(token) {
  const base = getPublicBaseUrl();
  if (!base) return '';
  return `${base.replace(/\/$/, '')}/compte/reinitialiser-mot-de-passe?token=${encodeURIComponent(String(token))}`;
}

function computeConsigneSummaryForOrder(order) {
  const lines = order && order.consigne && Array.isArray(order.consigne.lines)
    ? order.consigne.lines
    : [];
  const clean = lines.filter(Boolean);
  if (!clean.length) {
    return {
      hasConsigne: false,
      label: '',
      className: '',
    };
  }

  const now = new Date();
  const startToday = new Date(now);
  startToday.setHours(0, 0, 0, 0);

  let minDaysLeft = null;
  let hasOverdue = false;
  let hasPending = false;
  let totalDueCents = 0;

  for (const l of clean) {
    if (!l) continue;
    const qty = Number.isFinite(l.quantity) ? l.quantity : 1;
    const amountCents = Number.isFinite(l.amountCents) ? l.amountCents : 0;
    const lineTotalCents = qty * amountCents;
    const isReceived = !!l.receivedAt;

    if (!isReceived) {
      hasPending = true;
    }

    const dueAt = l.dueAt ? new Date(l.dueAt) : null;
    let daysLeft = null;
    if (dueAt && !Number.isNaN(dueAt.getTime())) {
      const dueDay = new Date(dueAt);
      dueDay.setHours(0, 0, 0, 0);
      daysLeft = Math.ceil((dueDay.getTime() - startToday.getTime()) / (24 * 60 * 60 * 1000));
    }

    if (!isReceived && daysLeft !== null && daysLeft < 0) {
      hasOverdue = true;
      totalDueCents += lineTotalCents;
    }

    if (!isReceived && daysLeft !== null) {
      if (minDaysLeft === null || daysLeft < minDaysLeft) minDaysLeft = daysLeft;
    }
  }

  if (hasOverdue) {
    return {
      hasConsigne: true,
      label: `Consigne en retard • Montant dû : ${formatEuro(totalDueCents)}`,
      className: 'text-red-700',
    };
  }

  if (minDaysLeft !== null) {
    return {
      hasConsigne: true,
      label: `Consigne • Jours restants : ${minDaysLeft}`,
      className: 'text-amber-800',
    };
  }

  if (hasPending) {
    return {
      hasConsigne: true,
      label: 'Consigne • À retourner après livraison',
      className: 'text-slate-700',
    };
  }

  return {
    hasConsigne: true,
    label: 'Consigne • Reçue',
    className: 'text-green-700',
  };
}

async function getInvoicesPage(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const sessionUser = req.session.user;

    if (!sessionUser || !sessionUser._id) {
      return res.redirect('/compte');
    }

    if (!dbConnected) {
      return res.status(503).render('account/invoices', {
        title: `Mes factures - ${brand.NAME}`,
        dbConnected,
        invoices: [],
      });
    }

    const orders = await Order.find({ userId: sessionUser._id, paymentStatus: 'paid' })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    for (let i = 0; i < orders.length; i += 1) {
      const o = orders[i];
      try {
        const refreshed = await ensureInvoiceIssuedForPaidOrder(o._id);
        if (refreshed && refreshed.invoice) {
          orders[i] = { ...o, invoice: refreshed.invoice };
        }
      } catch (err) {
        // ignore
      }
    }

    const invoices = orders.map((o) => ({
      id: String(o._id),
      number: o && o.invoice && o.invoice.number ? String(o.invoice.number) : o.number,
      date: formatDateFR(getInvoiceDisplayDate(o)),
      total: formatEuro(getOrderTotalCents(o)),
    }));

    return res.render('account/invoices', {
      title: `Mes factures - ${brand.NAME}`,
      dbConnected,
      invoices,
    });
  } catch (err) {
    return next(err);
  }
}

async function getOrderDetailPage(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const sessionUser = req.session.user;
    const { orderId } = req.params;

    if (!sessionUser || !sessionUser._id) {
      return res.redirect('/compte');
    }

    if (!dbConnected) {
      return res.status(503).render('errors/500', {
        title: `Erreur - ${brand.NAME}`,
      });
    }

    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(404).render('errors/404', {
        title: `Page introuvable - ${brand.NAME}`,
      });
    }

    const order = await Order.findOne({ _id: orderId, userId: sessionUser._id }).lean();

    if (!order) {
      return res.status(404).render('errors/404', {
        title: `Page introuvable - ${brand.NAME}`,
      });
    }

    const productMap = new Map();

    if (Array.isArray(order.items)) {
      const productIds = order.items
        .map((it) => (it && it.productId ? String(it.productId) : null))
        .filter(Boolean);

      const validProductIds = productIds.filter((id) => mongoose.Types.ObjectId.isValid(id));

      if (validProductIds.length) {
        const products = await Product.find({ _id: { $in: validProductIds } })
          .select('_id imageUrl inStock brand category')
          .lean();

        for (const p of products) {
          productMap.set(String(p._id), p);
        }
      }

      for (const p of demoProducts) {
        if (!productMap.has(String(p._id))) {
          productMap.set(String(p._id), p);
        }
      }
    }

    const shippingCostCents = Number.isFinite(order.shippingCostCents) ? order.shippingCostCents : 0;

    const fallbackItemsSubtotalCents = Array.isArray(order.items)
      ? order.items.reduce((sum, it) => {
          if (!it || !Number.isFinite(it.lineTotalCents)) return sum;
          return sum + it.lineTotalCents;
        }, 0)
      : 0;

    const itemsSubtotalCents = Number.isFinite(order.itemsSubtotalCents)
      ? order.itemsSubtotalCents
      : fallbackItemsSubtotalCents;

    const clientDiscountCents = Number.isFinite(order.clientDiscountCents) ? order.clientDiscountCents : 0;
    const promoDiscountCents = Number.isFinite(order.promoDiscountCents) ? order.promoDiscountCents : 0;
    const itemsTotalAfterDiscountCents = Number.isFinite(order.itemsTotalAfterDiscountCents)
      ? order.itemsTotalAfterDiscountCents
      : Math.max(0, itemsSubtotalCents - clientDiscountCents - promoDiscountCents);

    const totalCents = Number.isFinite(order.totalCents)
      ? order.totalCents
      : itemsTotalAfterDiscountCents + shippingCostCents;

    const htCents = Math.round(totalCents / 1.2);
    const vatCents = totalCents - htCents;

    const statusBanner = getOrderStatusBanner(order);

    const invoiceNumber = order && order.invoice && typeof order.invoice.number === 'string' ? order.invoice.number.trim() : '';
    const hasInvoice = getTrimmedString(order.paymentStatus).toLowerCase() === 'paid';
    const invoiceUrl = hasInvoice ? `/compte/commandes/${encodeURIComponent(String(order._id))}/facture.pdf` : '';

    const consigneLines = order && order.consigne && Array.isArray(order.consigne.lines)
      ? order.consigne.lines
      : [];

    const now = new Date();
    const startToday = new Date(now);
    startToday.setHours(0, 0, 0, 0);

    const viewConsigneLines = consigneLines
      .filter(Boolean)
      .map((l) => {
        const qty = Number.isFinite(l.quantity) ? l.quantity : 1;
        const amountCents = Number.isFinite(l.amountCents) ? l.amountCents : 0;
        const totalLineCents = amountCents * qty;

        const dueAt = l.dueAt ? new Date(l.dueAt) : null;
        const receivedAt = l.receivedAt ? new Date(l.receivedAt) : null;

        let daysLeft = null;
        if (dueAt && !Number.isNaN(dueAt.getTime())) {
          const dueDay = new Date(dueAt);
          dueDay.setHours(0, 0, 0, 0);
          daysLeft = Math.ceil((dueDay.getTime() - startToday.getTime()) / (24 * 60 * 60 * 1000));
        }

        const isReceived = !!receivedAt;
        const isOverdue = !isReceived && daysLeft !== null && daysLeft < 0;

        return {
          name: l.name || 'Produit',
          sku: l.sku || '',
          quantity: qty,
          amount: formatEuro(amountCents),
          total: formatEuro(totalLineCents),
          startAt: l.startAt ? formatDateTimeFR(l.startAt) : '',
          dueAt: dueAt ? formatDateTimeFR(dueAt) : '',
          receivedAt: receivedAt ? formatDateTimeFR(receivedAt) : '',
          daysLeft,
          isReceived,
          isOverdue,
          totalCents: totalLineCents,
        };
      });

    const totalDueCents = viewConsigneLines
      .filter((l) => l && l.isOverdue)
      .reduce((sum, l) => sum + (Number(l.totalCents) || 0), 0);

    const consigne = {
      hasConsigne: viewConsigneLines.length > 0,
      hasOverdue: viewConsigneLines.some((l) => l && l.isOverdue),
      hasPending: viewConsigneLines.some((l) => l && !l.isReceived),
      lines: viewConsigneLines,
      totalDue: formatEuro(totalDueCents),
      totalDueCents,
    };

    /* === GA4/GTM : déclenche `purchase` UNE seule fois par commande ===
       Update atomique : seule la requête qui fait passer le flag à `true`
       voit `firePurchase = true`. Évite les doubles comptages au reload. */
    let firePurchase = false;
    const isPaidOrFulfilled = ['paid', 'processing', 'shipped', 'delivered', 'completed']
      .includes(getTrimmedString(order.status).toLowerCase());

    if (isPaidOrFulfilled && !order.analyticsTracked) {
      try {
        const result = await Order.updateOne(
          { _id: order._id, analyticsTracked: { $ne: true } },
          { $set: { analyticsTracked: true } }
        );
        if (result && (result.modifiedCount === 1 || result.nModified === 1)) {
          firePurchase = true;
        }
      } catch (err) {
        console.error('[ga4-purchase] flag set failed', err && err.message);
      }
    }

    return res.render('account/order', {
      title: `Commande ${order.number} - ${brand.NAME}`,
      dbConnected,
      order: {
        id: String(order._id),
        number: order.number,
        invoiceNumber,
        invoiceUrl,
        hasInvoice,
        date: formatDateFR(order.createdAt),
        dateTime: formatDateTimeFR(order.createdAt),
        status: formatOrderStatus(order.status),
        statusKey: order.status,
        statusTitle: statusBanner.title,
        statusSubtitle: statusBanner.subtitle,
        statusBgClass: statusBanner.bgClass || 'bg-blue-600',
        statusIcon: statusBanner.icon || 'inventory_2',
        paymentRetryUrl: order.status === 'pending_payment' ? (order.mollieCheckoutUrl || order.scalapayCheckoutUrl || '') : '',
        orderType: order.orderType || 'standard',
        cloningStatus: order.cloningStatus || null,
        cloningDates: {
          labelSentAt: order.cloningDates && order.cloningDates.labelSentAt ? formatDateTimeFR(order.cloningDates.labelSentAt) : null,
          clientPieceReceivedAt: order.cloningDates && order.cloningDates.clientPieceReceivedAt ? formatDateTimeFR(order.cloningDates.clientPieceReceivedAt) : null,
          cloningStartedAt: order.cloningDates && order.cloningDates.cloningStartedAt ? formatDateTimeFR(order.cloningDates.cloningStartedAt) : null,
          cloningCompletedAt: order.cloningDates && order.cloningDates.cloningCompletedAt ? formatDateTimeFR(order.cloningDates.cloningCompletedAt) : null,
          shippedToClientAt: order.cloningDates && order.cloningDates.shippedToClientAt ? formatDateTimeFR(order.cloningDates.shippedToClientAt) : null,
        },
        cloningTracking: order.cloningTracking || { carrier: '', trackingNumber: '', trackingUrl: '' },
        cloningFailureNote: order.cloningFailureNote || '',
        cloningLabel: (() => {
          // Check direct documents first
          const docs = Array.isArray(order.documents) ? order.documents : [];
          const labelDoc = docs.find(d => d && d.docType === 'recuperation_clonage' && d.storedPath);
          if (labelDoc) {
            return {
              originalName: labelDoc.originalName || 'Étiquette de récupération.pdf',
              url: `/compte/commandes/${encodeURIComponent(String(order._id))}/documents/${encodeURIComponent(String(labelDoc._id))}`,
              uploadedAt: labelDoc.uploadedAt ? formatDateTimeFR(labelDoc.uploadedAt) : null,
            };
          }
          // Fallback: check shipments with label "Récupération clonage"
          const shipments = Array.isArray(order.shipments) ? order.shipments : [];
          const shipment = shipments.find(s => s && s.label && (s.label.toLowerCase().includes('cupération clonage') || s.label.toLowerCase().includes('recuperation clonage')) && s.document && s.document.storedPath);
          if (shipment) {
            return {
              originalName: shipment.document.originalName || 'Étiquette de récupération.pdf',
              url: `/compte/commandes/${encodeURIComponent(String(order._id))}/shipment-doc/${encodeURIComponent(String(shipment._id))}`,
              uploadedAt: shipment.document.uploadedAt ? formatDateTimeFR(shipment.document.uploadedAt) : (shipment.createdAt ? formatDateTimeFR(shipment.createdAt) : null),
            };
          }
          return null;
        })(),
        returnLabel: (() => {
          const docs = Array.isArray(order.documents) ? order.documents : [];
          const labelDoc = docs.find(d => d && d.docType === 'bon_retour' && d.storedPath);
          if (!labelDoc) return null;
          return {
            originalName: labelDoc.originalName || 'Bon de retour.pdf',
            url: `/compte/commandes/${encodeURIComponent(String(order._id))}/documents/${encodeURIComponent(String(labelDoc._id))}`,
            uploadedAt: labelDoc.uploadedAt ? formatDateTimeFR(labelDoc.uploadedAt) : null,
          };
        })(),
        shippingLabel: (() => {
          const docs = Array.isArray(order.documents) ? order.documents : [];
          const labelDoc = docs.find(d => d && d.docType === 'etiquette_envoi' && d.storedPath);
          if (!labelDoc) return null;
          return {
            originalName: labelDoc.originalName || 'Étiquette d\'envoi.pdf',
            url: `/compte/commandes/${encodeURIComponent(String(order._id))}/documents/${encodeURIComponent(String(labelDoc._id))}`,
            uploadedAt: labelDoc.uploadedAt ? formatDateTimeFR(labelDoc.uploadedAt) : null,
          };
        })(),
        total: formatEuro(totalCents),
        totalCents,
        ht: formatEuro(htCents),
        htCents,
        vat: formatEuro(vatCents),
        vatCents,
        itemsSubtotal: formatEuro(itemsSubtotalCents),
        itemsSubtotalCents,
        clientDiscountPercent: Number.isFinite(order.clientDiscountPercent) ? order.clientDiscountPercent : 0,
        clientDiscountCents,
        promoCode: typeof order.promoCode === 'string' ? order.promoCode : '',
        promoDiscountCents,
        itemsTotalAfterDiscount: formatEuro(itemsTotalAfterDiscountCents),
        itemsTotalAfterDiscountCents,
        shippingCost: formatEuro(shippingCostCents),
        shippingCostCents,
        currency: order.currency || 'EUR',
        shippingMethod: order.shippingMethod || 'domicile',
        shippingMethodLabel: formatShippingMethod(order.shippingMethod),
        shippingAddress: order.shippingAddress,
        billingAddress: order.billingAddress,
        consigne,
        items: Array.isArray(order.items)
          ? order.items.map((it) => {
              const pid = it && it.productId ? String(it.productId) : '';
              const p = pid ? productMap.get(pid) : null;
              return {
                productId: pid,
                imageUrl: p && p.imageUrl ? p.imageUrl : '',
                inStock: p && typeof p.inStock === 'boolean' ? p.inStock : null,
                name: it.name,
                sku: it.sku,
                brand: p && typeof p.brand === 'string' ? p.brand : '',
                category: p && typeof p.category === 'string' ? p.category : '',
                optionsSummary: it && typeof it.optionsSummary === 'string' ? it.optionsSummary : '',
                unitPrice: formatEuro(it.unitPriceCents),
                unitPriceCents: it.unitPriceCents,
                quantity: it.quantity,
                lineTotal: formatEuro(it.lineTotalCents),
                lineTotalCents: it.lineTotalCents,
              };
            })
          : [],
      },
      firePurchase,
    });
  } catch (err) {
    return next(err);
  }
}

async function getOrderInvoicePdf(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const sessionUser = req.session.user;
    const { orderId } = req.params;

    if (!sessionUser || !sessionUser._id) {
      return res.redirect('/compte');
    }

    if (!dbConnected) {
      return res.status(503).send('Facture indisponible');
    }

    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(404).render('errors/404', { title: `Page introuvable - ${brand.NAME}` });
    }

    let order = await Order.findOne({ _id: orderId, userId: sessionUser._id }).lean();
    if (!order) {
      return res.status(404).render('errors/404', { title: `Page introuvable - ${brand.NAME}` });
    }

    const isPaid = getTrimmedString(order.paymentStatus).toLowerCase() === 'paid';
    if (!isPaid) {
      return res.status(403).send('Facture non disponible');
    }

    await ensureInvoiceIssuedForPaidOrder(order._id);
    order = await Order.findById(order._id).lean();

    const user = await User.findById(order.userId).select('_id email firstName lastName companyName siret accountType').lean();

    const buffer = await buildOrderInvoicePdfBuffer({ order, user });
    if (!buffer || !Buffer.isBuffer(buffer) || !buffer.length) {
      return res.status(500).send('Facture indisponible');
    }

    const invoiceNumber = order && order.invoice && typeof order.invoice.number === 'string' ? order.invoice.number.trim() : '';
    const filename = invoiceNumber ? `Facture-${invoiceNumber}.pdf` : `Facture-${order.number}.pdf`;

    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename=\"${filename}\"`);
    return res.send(buffer);
  } catch (err) {
    return next(err);
  }
}

function formatPrettyDateFR(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const raw = d.toLocaleDateString('fr-FR', {
    weekday: 'long',
    day: '2-digit',
    month: 'long',
  });
  return capitalizeFirst(raw);
}

function formatTimelineTimeLabel(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';

  const now = new Date();
  const startToday = new Date(now);
  startToday.setHours(0, 0, 0, 0);

  const startDate = new Date(d);
  startDate.setHours(0, 0, 0, 0);

  const diffDays = Math.round((startToday.getTime() - startDate.getTime()) / (24 * 60 * 60 * 1000));

  const time = d.toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
  });

  if (diffDays === 0) return `${time} - Aujourd'hui`;
  if (diffDays === 1) return `${time} - Hier`;

  const date = d.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
  return `${time} - ${date}`;
}

function getTrackingUiForStatus(status) {
  switch (status) {
    case 'delivered':
    case 'completed':
      return {
        statusLabel: 'Livrée',
        statusBadgeClass: 'bg-green-50 text-green-700',
        statusDotClass: 'bg-green-600',
        statusDotPulse: false,
        activeStepIndex: 3,
        progressWidthClass: 'w-[100%]',
      };
    case 'shipped':
      return {
        statusLabel: "En cours d'acheminement",
        statusBadgeClass: 'bg-blue-50 text-blue-600',
        statusDotClass: 'bg-blue-600',
        statusDotPulse: true,
        activeStepIndex: 2,
        progressWidthClass: 'w-[66.66%]',
      };
    case 'paid':
    case 'processing':
      return {
        statusLabel: 'En préparation',
        statusBadgeClass: 'bg-amber-50 text-amber-800',
        statusDotClass: 'bg-amber-600',
        statusDotPulse: true,
        activeStepIndex: 1,
        progressWidthClass: 'w-[33.33%]',
      };
    case 'cancelled':
      return {
        statusLabel: 'Annulée',
        statusBadgeClass: 'bg-red-50 text-red-700',
        statusDotClass: 'bg-red-600',
        statusDotPulse: false,
        activeStepIndex: 0,
        progressWidthClass: 'w-[0%]',
      };
    case 'refunded':
      return {
        statusLabel: 'Remboursée',
        statusBadgeClass: 'bg-slate-100 text-slate-700',
        statusDotClass: 'bg-slate-600',
        statusDotPulse: false,
        activeStepIndex: 0,
        progressWidthClass: 'w-[0%]',
      };
    case 'pending_payment':
    default:
      return {
        statusLabel: 'En attente',
        statusBadgeClass: 'bg-amber-50 text-amber-800',
        statusDotClass: 'bg-amber-600',
        statusDotPulse: true,
        activeStepIndex: 0,
        progressWidthClass: 'w-[0%]',
      };
  }
}

function getTimelineTitleForStatus(status) {
  switch (status) {
    case 'delivered':
      return 'Commande livrée';
    case 'completed':
      return 'Commande terminée';
    case 'shipped':
      return 'Commande expédiée';
    case 'paid':
      return 'Paiement accepté';
    case 'processing':
      return 'Commande en préparation';
    case 'cancelled':
      return 'Commande annulée';
    case 'refunded':
      return 'Commande remboursée';
    case 'pending_payment':
    default:
      return 'Commande créée';
  }
}

function addDays(date, days) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + days);
  return d;
}

function getTrackingUiForParcelStatusCode(statusCode, fallbackOrderStatus) {
  const code = Number.isFinite(statusCode) ? statusCode : null;

  if (code === 0) return getTrackingUiForStatus('delivered');

  if (code === 4) {
    return {
      statusLabel: 'En livraison',
      statusBadgeClass: 'bg-blue-50 text-blue-600',
      statusDotClass: 'bg-blue-600',
      statusDotPulse: true,
      activeStepIndex: 2,
      progressWidthClass: 'w-[66.66%]',
    };
  }

  if (code === 2 || code === 3) {
    return getTrackingUiForStatus('shipped');
  }

  if (code === 8) {
    return getTrackingUiForStatus('processing');
  }

  if (code === 6 || code === 7) {
    return {
      statusLabel: 'Incident de livraison',
      statusBadgeClass: 'bg-red-50 text-red-700',
      statusDotClass: 'bg-red-600',
      statusDotPulse: true,
      activeStepIndex: 2,
      progressWidthClass: 'w-[66.66%]',
    };
  }

  if (code === 5) {
    return {
      statusLabel: 'Suivi introuvable',
      statusBadgeClass: 'bg-amber-50 text-amber-800',
      statusDotClass: 'bg-amber-600',
      statusDotPulse: true,
      activeStepIndex: 2,
      progressWidthClass: 'w-[66.66%]',
    };
  }

  return getTrackingUiForStatus(fallbackOrderStatus);
}

function getEpochMs(value) {
  const num = Number(value);
  if (!Number.isFinite(num)) return null;
  if (num > 10_000_000_000) return num;
  return num * 1000;
}

function parseParcelEventDate(value) {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d;

  if (typeof value === 'string') {
    const isoLike = value.trim().replace(' ', 'T');
    const d2 = new Date(isoLike);
    if (!Number.isNaN(d2.getTime())) return d2;
  }

  return null;
}

async function getOrderTrackingPage(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const sessionUser = req.session.user;
    const { orderId } = req.params;

    if (!sessionUser || !sessionUser._id) {
      return res.redirect('/compte');
    }

    if (!dbConnected) {
      return res.status(503).render('account/order-tracking', {
        title: `Suivi de commande - ${brand.NAME}`,
        dbConnected,
        order: null,
        tracking: null,
      });
    }

    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(404).render('errors/404', {
        title: `Page introuvable - ${brand.NAME}`,
      });
    }

    const order = await Order.findOne({ _id: orderId, userId: sessionUser._id }).lean();
    if (!order) {
      return res.status(404).render('errors/404', {
        title: `Page introuvable - ${brand.NAME}`,
      });
    }

    const productMap = new Map();

    if (Array.isArray(order.items)) {
      const productIds = order.items
        .map((it) => (it && it.productId ? String(it.productId) : null))
        .filter(Boolean);

      const validProductIds = productIds.filter((id) => mongoose.Types.ObjectId.isValid(id));

      if (validProductIds.length) {
        const products = await Product.find({ _id: { $in: validProductIds } })
          .select('_id imageUrl')
          .lean();

        for (const p of products) {
          productMap.set(String(p._id), p);
        }
      }

      for (const p of demoProducts) {
        if (!productMap.has(String(p._id))) {
          productMap.set(String(p._id), p);
        }
      }
    }

    const itemsCount = Array.isArray(order.items)
      ? order.items.reduce((sum, it) => sum + (Number(it && it.quantity) || 0), 0)
      : 0;

    const shippingCostCents = Number.isFinite(order.shippingCostCents) ? order.shippingCostCents : 0;
    const itemsSubtotalCents = Array.isArray(order.items)
      ? order.items.reduce((sum, it) => {
          if (!it || !Number.isFinite(it.lineTotalCents)) return sum;
          return sum + it.lineTotalCents;
        }, 0)
      : 0;

    const totalCents = Number.isFinite(order.totalCents)
      ? order.totalCents
      : itemsSubtotalCents + shippingCostCents;

    const shipments = Array.isArray(order.shipments) ? order.shipments.filter(Boolean) : [];
    const shipmentsSorted = shipments
      .slice()
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    const lastShipment = shipmentsSorted[0] || null;

    const track17ApiKey = typeof process.env.TRACK17_API_KEY === 'string'
      ? process.env.TRACK17_API_KEY.trim()
      : '';

    let trackingDelivery = null;
    let trackingErrorMessage = '';
    const isProd = process.env.NODE_ENV === 'production';

    const track17EnabledRaw = typeof process.env.TRACK17_ENABLED === 'string'
      ? process.env.TRACK17_ENABLED.trim().toLowerCase()
      : '';

    let track17Enabled = isProd;
    if (track17EnabledRaw) {
      track17Enabled = ['1', 'true', 'yes', 'on'].includes(track17EnabledRaw);
    }

    if (!track17Enabled && lastShipment && lastShipment.trackingNumber) {
      trackingErrorMessage = isProd
        ? 'Le suivi transporteur est temporairement indisponible.'
        : "Le suivi transporteur avancé n'est pas disponible en local.";
    } else if (track17Enabled && track17ApiKey && lastShipment && lastShipment.trackingNumber) {
      try {
        const trackingNumber = lastShipment.trackingNumber;
        trackingDelivery = await track17.getTrackingByNumber(track17ApiKey, trackingNumber);

        if (!trackingDelivery) {
          trackingErrorMessage =
            "Le transporteur n'a pas encore fourni d'informations de suivi. Réessayez un peu plus tard.";
        }
      } catch (err) {
        const rawMessage = err && err.message ? String(err.message) : '';
        trackingErrorMessage = rawMessage || 'Impossible de récupérer le suivi transporteur.';
      }
    } else if (track17Enabled && track17ApiKey && (!lastShipment || !lastShipment.trackingNumber)) {
      trackingErrorMessage = 'Aucun numéro de suivi n’est renseigné pour cette commande.';
    } else if (track17Enabled && !track17ApiKey && lastShipment && lastShipment.trackingNumber) {
      trackingErrorMessage = isProd
        ? 'Le suivi transporteur est temporairement indisponible.'
        : 'Clé 17Track manquante : configurez TRACK17_API_KEY dans le fichier .env.';
    }

    let carrierTrackingUrl = '';
    if (lastShipment && lastShipment.trackingNumber) {
      carrierTrackingUrl = trackingLinks.buildCarrierTrackingUrl(lastShipment.carrier, lastShipment.trackingNumber);
    }

    const ui = trackingDelivery
      ? getTrackingUiForParcelStatusCode(trackingDelivery.status_code, order.status)
      : getTrackingUiForStatus(order.status);

    // Steps depend on order type
    let baseSteps;
    let activeStepOverride = null;
    const isCloning = order.orderType === 'exchange_cloning';

    if (isCloning) {
      baseSteps = [
        { label: 'Validée', icon: 'check' },
        { label: 'Étiquette envoyée', icon: 'mail' },
        { label: 'Pièce en transit', icon: 'package_2' },
        { label: 'Pièce reçue', icon: 'inventory_2' },
        { label: 'Clonage', icon: 'memory' },
        { label: 'Expédiée', icon: 'local_shipping' },
        { label: 'Livrée', icon: 'task_alt' },
      ];
      const cs = order.cloningStatus || 'pending_label';
      const st = order.status || 'pending_payment';
      if (st === 'delivered' || st === 'completed') activeStepOverride = 6;
      else if (st === 'shipped') activeStepOverride = 5;
      else if (cs === 'cloning_done') activeStepOverride = 5;
      else if (cs === 'cloning_in_progress' || cs === 'cloning_failed') activeStepOverride = 4;
      else if (cs === 'client_piece_received') activeStepOverride = 3;
      else if (cs === 'client_piece_in_transit') activeStepOverride = 2;
      else if (cs === 'label_sent') activeStepOverride = 1;
      else activeStepOverride = 0;
    } else {
      baseSteps = [
        { label: 'Validée', icon: 'check' },
        { label: 'Préparation', icon: 'inventory_2' },
        { label: 'En livraison', icon: 'local_shipping' },
        { label: 'Livrée', icon: 'task_alt' },
      ];
    }

    const isDeliveredUi =
      ui.statusLabel === 'Livrée' ||
      ui.progressWidthClass === 'w-[100%]' ||
      (trackingDelivery && trackingDelivery.status_code === 0) ||
      (isCloning && activeStepOverride === 6);

    const effectiveActiveIdx = activeStepOverride !== null ? activeStepOverride : ui.activeStepIndex;

    const steps = baseSteps.map((s, idx) => {
      if (isDeliveredUi) {
        return { ...s, state: 'completed' };
      }

      if (idx < effectiveActiveIdx) return { ...s, state: 'completed' };
      if (idx === effectiveActiveIdx) {
        // Mark cloning_failed step as error
        if (isCloning && order.cloningStatus === 'cloning_failed' && idx === 4) return { ...s, state: 'error' };
        return { ...s, state: 'active' };
      }
      return { ...s, state: '' };
    });

    const carrierTimeline = [];
    const orderTimeline = [];

    const parcelEvents = trackingDelivery && Array.isArray(trackingDelivery.events) ? trackingDelivery.events : [];
    if (trackingDelivery && parcelEvents.length === 0 && !trackingErrorMessage) {
      trackingErrorMessage =
        "Le transporteur n'a pas encore fourni d'informations de suivi. Réessayez un peu plus tard.";
    }
    const carrierMilestones = new Map();
    const upsertCarrierMilestone = (key, item) => {
      if (!key || !item) return;
      const existing = carrierMilestones.get(key);
      if (!existing || (item.sortTime || 0) > (existing.sortTime || 0)) {
        carrierMilestones.set(key, item);
      }
    };

    const carrierTitleByKey = {
      delivered: 'Livré',
      out_for_delivery: 'En cours de livraison',
      delivery_attempt: 'Tentative de livraison',
      delivery_issue: 'Incident de livraison',
      picked_up: 'Pris en charge par le transporteur',
      in_transit: 'En transit',
      info_received: 'Informations d’expédition reçues',
    };

    for (const ev of parcelEvents) {
      if (!ev || !ev.event) continue;
      const dateObj = parseParcelEventDate(ev.date);
      const sortTime = dateObj ? dateObj.getTime() : 0;

      const descParts = [];
      if (ev.location) descParts.push(String(ev.location));
      if (ev.additional) descParts.push(String(ev.additional));

      const title = String(ev.event);
      const normalized = title.toLowerCase();

      let key = '';
      if (normalized.includes('livr')) key = 'delivered';
      else if (normalized.includes('en cours de livraison')) key = 'out_for_delivery';
      else if (normalized.includes('tentative')) key = 'delivery_attempt';
      else if (normalized.includes('incident')) key = 'delivery_issue';
      else if (normalized.includes('pris en charge')) key = 'picked_up';
      else if (normalized.includes('en transit') || normalized.includes('centre de tri') || normalized.includes('traitement')) {
        key = 'in_transit';
      } else if (normalized.includes('étiquette') || normalized.includes("informations d’expédition")) {
        key = 'info_received';
      }

      if (!key) continue;

      const milestoneTitle = carrierTitleByKey[key] || title;
      const descriptionParts = [];
      if (milestoneTitle !== title && title) descriptionParts.push(title);
      if (descParts.length) descriptionParts.push(descParts.join(' • '));

      upsertCarrierMilestone(key, {
        sortTime,
        title: milestoneTitle,
        description: descriptionParts.length ? descriptionParts.join(' • ') : '',
        timeLabel: dateObj ? formatTimelineTimeLabel(dateObj) : (ev.date ? String(ev.date) : '—'),
      });
    }

    for (const item of carrierMilestones.values()) {
      carrierTimeline.push(item);
    }

    carrierTimeline.sort((a, b) => (b.sortTime || 0) - (a.sortTime || 0));

    if (Array.isArray(order.statusHistory)) {
      for (const h of order.statusHistory) {
        if (!h || !h.changedAt) continue;
        const d = new Date(h.changedAt);
        orderTimeline.push({
          sortTime: Number.isNaN(d.getTime()) ? 0 : d.getTime(),
          title: getTimelineTitleForStatus(h.status),
          description: '',
          timeLabel: formatTimelineTimeLabel(h.changedAt),
        });
      }
    }

    // Add clonage events to order timeline
    if (isCloning) {
      const cd = order.cloningDates || {};
      if (cd.labelSentAt) {
        orderTimeline.push({ sortTime: new Date(cd.labelSentAt).getTime(), title: 'Étiquette de récupération envoyée', description: '', timeLabel: formatTimelineTimeLabel(cd.labelSentAt) });
      }
      if (cd.clientPieceReceivedAt) {
        orderTimeline.push({ sortTime: new Date(cd.clientPieceReceivedAt).getTime(), title: 'Votre pièce a été reçue par nos ateliers', description: '', timeLabel: formatTimelineTimeLabel(cd.clientPieceReceivedAt) });
      }
      if (cd.cloningStartedAt) {
        orderTimeline.push({ sortTime: new Date(cd.cloningStartedAt).getTime(), title: 'Clonage/programmation démarré', description: '', timeLabel: formatTimelineTimeLabel(cd.cloningStartedAt) });
      }
      if (cd.cloningCompletedAt) {
        const isFailed = order.cloningStatus === 'cloning_failed';
        orderTimeline.push({ sortTime: new Date(cd.cloningCompletedAt).getTime(), title: isFailed ? 'Problème détecté lors du clonage' : 'Clonage terminé avec succès', description: '', timeLabel: formatTimelineTimeLabel(cd.cloningCompletedAt) });
      }
      if (cd.shippedToClientAt) {
        orderTimeline.push({ sortTime: new Date(cd.shippedToClientAt).getTime(), title: 'Pièce clonée expédiée', description: '', timeLabel: formatTimelineTimeLabel(cd.shippedToClientAt) });
      }
    }

    orderTimeline.sort((a, b) => (b.sortTime || 0) - (a.sortTime || 0));

    const lastUpdateLabel = carrierTimeline.length
      ? carrierTimeline[0].title
      : (orderTimeline.length ? orderTimeline[0].title : '—');

    let estimatedDateLabel = '—';
    let estimatedTimeLabel = '';

    const parcelExpectedMs = trackingDelivery && trackingDelivery.timestamp_expected
      ? getEpochMs(trackingDelivery.timestamp_expected)
      : null;
    const parcelExpectedEndMs = trackingDelivery && trackingDelivery.timestamp_expected_end
      ? getEpochMs(trackingDelivery.timestamp_expected_end)
      : null;

    if (parcelExpectedMs) {
      estimatedDateLabel = formatPrettyDateFR(new Date(parcelExpectedMs));
      if (parcelExpectedEndMs && parcelExpectedEndMs > parcelExpectedMs) {
        const start = new Date(parcelExpectedMs).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        const end = new Date(parcelExpectedEndMs).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
        estimatedTimeLabel = `${start} - ${end}`;
      }
    } else if (order.status === 'cancelled' || order.status === 'refunded') {
      estimatedDateLabel = '—';
    } else if (order.status === 'delivered' || order.status === 'completed') {
      const delivered = Array.isArray(order.statusHistory)
        ? order.statusHistory.find((h) => h && (h.status === 'delivered' || h.status === 'completed') && h.changedAt)
        : null;
      estimatedDateLabel = delivered ? formatPrettyDateFR(delivered.changedAt) : 'Livrée';
    } else {
      const eta = addDays(order.createdAt, 3);
      estimatedDateLabel = eta ? formatPrettyDateFR(eta) : '—';
      estimatedTimeLabel = 'Entre 08:00 et 18:00';
    }

    // Dynamic progress width based on actual steps
    const totalSteps = baseSteps.length;
    const dynamicProgressPercent = Math.min(100, Math.round((effectiveActiveIdx / (totalSteps - 1)) * 100));
    const dynamicProgressWidth = isCloning ? `w-[${dynamicProgressPercent}%]` : ui.progressWidthClass;

    return res.render('account/order-tracking', {
      title: `Suivi ${order.number} - ${brand.NAME}`,
      dbConnected,
      order: {
        id: String(order._id),
        number: order.number,
        total: formatEuro(totalCents),
        itemsCount,
        statusKey: order.status,
        orderType: order.orderType || 'standard',
        cloningStatus: order.cloningStatus || null,
        cloningDates: {
          labelSentAt: order.cloningDates && order.cloningDates.labelSentAt ? formatDateTimeFR(order.cloningDates.labelSentAt) : null,
          clientPieceReceivedAt: order.cloningDates && order.cloningDates.clientPieceReceivedAt ? formatDateTimeFR(order.cloningDates.clientPieceReceivedAt) : null,
          cloningStartedAt: order.cloningDates && order.cloningDates.cloningStartedAt ? formatDateTimeFR(order.cloningDates.cloningStartedAt) : null,
          cloningCompletedAt: order.cloningDates && order.cloningDates.cloningCompletedAt ? formatDateTimeFR(order.cloningDates.cloningCompletedAt) : null,
          shippedToClientAt: order.cloningDates && order.cloningDates.shippedToClientAt ? formatDateTimeFR(order.cloningDates.shippedToClientAt) : null,
        },
        cloningTracking: order.cloningTracking || { carrier: '', trackingNumber: '', trackingUrl: '' },
        cloningFailureNote: order.cloningFailureNote || '',
        shippingAddress: order.shippingAddress,
        shippingMethod: order.shippingMethod || 'domicile',
        shippingMethodLabel: formatShippingMethod(order.shippingMethod),
        items: Array.isArray(order.items)
          ? order.items.map((it) => {
              const pid = it && it.productId ? String(it.productId) : '';
              const p = pid ? productMap.get(pid) : null;
              return {
                name: it.name,
                quantity: it.quantity,
                unitPrice: formatEuro(it.unitPriceCents),
                optionsSummary: it && typeof it.optionsSummary === 'string' ? it.optionsSummary : '',
                imageUrl: p && p.imageUrl ? p.imageUrl : '',
              };
            })
          : [],
      },
      tracking: {
        statusLabel: ui.statusLabel,
        statusBadgeClass: ui.statusBadgeClass,
        statusDotClass: ui.statusDotClass,
        statusDotPulse: ui.statusDotPulse,
        parcelErrorMessage: trackingErrorMessage,
        carrierTrackingUrl,
        estimatedDateLabel,
        estimatedTimeLabel,
        progressWidthClass: dynamicProgressWidth,
        steps,
        lastUpdateLabel,
        carrierTimeline: carrierTimeline.map((t) => ({
          title: t.title,
          description: t.description,
          timeLabel: t.timeLabel,
        })),
        orderTimeline: orderTimeline.map((t) => ({
          title: t.title,
          description: t.description,
          timeLabel: t.timeLabel,
        })),
        timeline: carrierTimeline.map((t) => ({
          title: t.title,
          description: t.description,
          timeLabel: t.timeLabel,
        })),
        trackingNumber: lastShipment && lastShipment.trackingNumber ? lastShipment.trackingNumber : '',
        trackingCarrier: lastShipment && lastShipment.carrier ? lastShipment.carrier : '',
        shippingSubtitle: formatShippingMethod(order.shippingMethod),
      },
    });
  } catch (err) {
    return next(err);
  }
}

async function postRepurchaseOrder(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const sessionUser = req.session.user;
    const { orderId } = req.params;

    if (!sessionUser || !sessionUser._id) {
      return res.redirect('/compte');
    }

    if (!dbConnected) {
      return res.status(503).render('errors/500', {
        title: `Erreur - ${brand.NAME}`,
      });
    }

    if (!mongoose.Types.ObjectId.isValid(orderId)) {
      return res.status(404).render('errors/404', {
        title: `Page introuvable - ${brand.NAME}`,
      });
    }

    const order = await Order.findOne({ _id: orderId, userId: sessionUser._id }).lean();

    if (!order || !Array.isArray(order.items) || order.items.length === 0) {
      return res.redirect('/panier');
    }

    const cart = getCart(req);

    for (const it of order.items) {
      const pid = it && it.productId ? String(it.productId) : '';
      const qty = it && Number.isFinite(it.quantity) ? it.quantity : 1;
      const selection = it && it.optionsSelection && typeof it.optionsSelection === 'object' ? it.optionsSelection : {};

      if (!pid) continue;

      const { lineId } = productOptions.buildCartLineId(pid, selection);

      if (!cart.items[lineId]) {
        cart.items[lineId] = {
          lineId,
          productId: pid,
          quantity: 0,
          optionsSelection: selection,
          optionsSummary: it && typeof it.optionsSummary === 'string' ? it.optionsSummary : '',
        };
      }

      const currentQty = Number.isFinite(cart.items[lineId].quantity) ? cart.items[lineId].quantity : 0;
      cart.items[lineId].quantity = Math.min(currentQty + qty, 99);
    }

    return res.redirect('/panier');
  } catch (err) {
    return next(err);
  }
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  return value.trim().toLowerCase();
}

function hashPassword(password, salt) {
  if (typeof password !== 'string' || password.length === 0) return '';
  if (typeof salt !== 'string' || salt.length === 0) return '';
  return crypto.pbkdf2Sync(password, salt, 120000, 32, 'sha256').toString('hex');
}

function toFiniteNumber(value) {
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (!trimmed) return null;

    const normalized = trimmed
      .replace(/\s+/g, '')
      .replace(/€/g, '')
      .replace(',', '.');
    const parsed = Number(normalized);
    return Number.isFinite(parsed) ? parsed : null;
  }

  return null;
}

function getOrderTotalCents(order) {
  const shippingCostCents = toFiniteNumber(order && order.shippingCostCents) ?? 0;

  const fallbackItemsSubtotalCents = Array.isArray(order && order.items)
    ? order.items.reduce((sum, it) => {
        const lineTotalCents = toFiniteNumber(it && it.lineTotalCents);
        return sum + (lineTotalCents ?? 0);
      }, 0)
    : 0;

  const itemsSubtotalCents = toFiniteNumber(order && order.itemsSubtotalCents) ?? fallbackItemsSubtotalCents;
  const clientDiscountCents = toFiniteNumber(order && order.clientDiscountCents) ?? 0;
  const promoDiscountCents = toFiniteNumber(order && order.promoDiscountCents) ?? 0;
  const itemsTotalAfterDiscountCents = toFiniteNumber(order && order.itemsTotalAfterDiscountCents)
    ?? Math.max(0, itemsSubtotalCents - clientDiscountCents - promoDiscountCents);

  return toFiniteNumber(order && order.totalCents) ?? (itemsTotalAfterDiscountCents + shippingCostCents);
}

function getInvoiceDisplayDate(order) {
  const createdAt = order && order.createdAt ? new Date(order.createdAt) : null;
  if (createdAt && !Number.isNaN(createdAt.getTime())) return createdAt;

  const issuedAt = order && order.invoice && order.invoice.issuedAt ? new Date(order.invoice.issuedAt) : null;
  if (issuedAt && !Number.isNaN(issuedAt.getTime())) return issuedAt;

  return null;
}

function formatEuro(totalCents) {
  const n = toFiniteNumber(totalCents);
  if (!Number.isFinite(n)) return '—';
  return new Intl.NumberFormat('fr-FR', {
    style: 'currency',
    currency: 'EUR',
  }).format(n / 100);
}

function formatDateFR(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';

  return d.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
  });
}

function capitalizeFirst(value) {
  if (typeof value !== 'string' || value.length === 0) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function formatOrderListDate(value) {
  if (!value) return { line1: '—', line2: '' };
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return { line1: '—', line2: '' };

  const line1 = capitalizeFirst(
    d.toLocaleDateString('fr-FR', {
      day: '2-digit',
      month: 'short',
    }).replace('.', '')
  );

  const line2 = String(d.getFullYear());
  return { line1, line2 };
}

function getStatusBadge(status) {
  switch (status) {
    case 'shipped':
      return { label: 'Expédiée', className: 'bg-blue-50 text-blue-700' };
    case 'delivered':
      return { label: 'Livrée', className: 'bg-green-50 text-green-700' };
    case 'completed':
      return { label: 'Terminée', className: 'bg-green-50 text-green-700' };
    case 'cancelled':
      return { label: 'Annulée', className: 'bg-red-50 text-red-700' };
    case 'refunded':
      return { label: 'Remboursée', className: 'bg-slate-100 text-slate-700' };
    case 'paid':
      return { label: 'Payée', className: 'bg-emerald-50 text-emerald-700' };
    case 'processing':
      return { label: 'En préparation', className: 'bg-amber-50 text-amber-800' };
    case 'pending_payment':
      return { label: 'Paiement en attente', className: 'bg-orange-50 text-orange-700' };
    default:
      return { label: 'En attente', className: 'bg-amber-50 text-amber-800' };
  }
}

function formatDateTimeFR(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';

  const date = d.toLocaleDateString('fr-FR', {
    day: '2-digit',
    month: 'long',
    year: 'numeric',
  });

  const time = d.toLocaleTimeString('fr-FR', {
    hour: '2-digit',
    minute: '2-digit',
  });

  return `${date} à ${time}`;
}

function formatShippingMethod(value) {
  switch (value) {
    case 'retrait':
      return 'Retrait magasin';
    case 'domicile':
    default:
      return 'Livraison à domicile';
  }
}

function getOrderStatusBanner(order) {
  const status = order && typeof order === 'object' && order.status ? order.status : (typeof order === 'string' ? order : 'pending_payment');
  const orderType = order && typeof order === 'object' ? (order.orderType || 'standard') : 'standard';
  const cloningStatus = order && typeof order === 'object' ? (order.cloningStatus || null) : null;

  // ─── Commandes CLONAGE : messages adaptés au parcours inversé ───
  if (orderType === 'exchange_cloning' && cloningStatus) {
    switch (cloningStatus) {
      case 'pending_label':
        return { title: 'Étape 1 : Nous préparons votre étiquette d\'envoi', subtitle: 'Vous recevrez par email une étiquette UPS pour nous envoyer votre ancienne pièce.', icon: 'mail', bgClass: 'bg-amber-500' };
      case 'label_sent':
        return { title: 'Étape 2 : Envoyez-nous votre ancienne pièce', subtitle: 'Votre étiquette UPS est prête. Imprimez-la et déposez votre colis en point relais UPS.', icon: 'package_2', bgClass: 'bg-orange-500' };
      case 'client_piece_in_transit':
        return { title: 'Étape 3 : Votre pièce est en route vers nos ateliers', subtitle: 'Nous vous notifierons dès réception.', icon: 'local_shipping', bgClass: 'bg-blue-500' };
      case 'client_piece_received':
        return { title: 'Étape 4 : Pièce reçue, clonage imminent', subtitle: 'Nos techniciens vont procéder à la lecture et au transfert des données.', icon: 'precision_manufacturing', bgClass: 'bg-indigo-500' };
      case 'cloning_in_progress':
        return { title: 'Étape 5 : Clonage en cours', subtitle: 'Nos techniciens programment votre nouvelle pièce. Délai estimé : 2-5 jours ouvrés.', icon: 'memory', bgClass: 'bg-violet-600' };
      case 'cloning_done':
        if (status === 'shipped') {
          return { title: 'Votre pièce clonée a été expédiée !', subtitle: 'Suivez votre colis avec le numéro de suivi ci-dessous.', icon: 'local_shipping', bgClass: 'bg-green-600' };
        }
        return { title: 'Étape 6 : Clonage terminé, expédition imminente', subtitle: 'Votre pièce programmée sera expédiée sous 24-48h.', icon: 'check_circle', bgClass: 'bg-green-600' };
      case 'cloning_failed':
        return { title: 'Un problème a été détecté sur votre pièce', subtitle: 'Notre équipe technique vous contactera dans les plus brefs délais pour trouver une solution.', icon: 'warning', bgClass: 'bg-red-600' };
    }
  }

  // ─── Commandes standard / échange : messages existants ───
  switch (status) {
    case 'shipped':
      return { title: "Votre commande est en cours d'expédition", subtitle: 'Livraison prévue sous 2-3 jours ouvrés.', icon: 'local_shipping', bgClass: 'bg-blue-600' };
    case 'paid':
    case 'processing':
      return { title: 'Votre commande est validée', subtitle: 'Nous préparons votre colis.', icon: 'inventory_2', bgClass: 'bg-blue-600' };
    case 'delivered':
      return { title: 'Votre commande a été livrée', subtitle: 'Merci pour votre commande.', icon: 'task_alt', bgClass: 'bg-green-600' };
    case 'completed':
      return { title: 'Commande terminée', subtitle: 'Tout est en ordre. Merci pour votre confiance.', icon: 'task_alt', bgClass: 'bg-slate-600' };
    case 'cancelled':
      return { title: 'Votre commande a été annulée', subtitle: 'Si besoin, contactez le support.', icon: 'cancel', bgClass: 'bg-red-600' };
    case 'refunded':
      return { title: 'Votre commande a été remboursée', subtitle: 'Le remboursement a été effectué.', icon: 'currency_exchange', bgClass: 'bg-slate-600' };
    case 'pending_payment':
    default:
      return { title: 'En attente de paiement', subtitle: 'Votre paiement n\'a pas encore été confirmé. Vous pouvez réessayer le paiement ou nous contacter si besoin.', icon: 'hourglass_top', bgClass: 'bg-amber-500' };
  }
}

function formatOrderStatus(status) {
  switch (status) {
    case 'pending_payment':
      return 'Paiement en attente';
    case 'paid':
      return 'Payée';
    case 'processing':
      return 'En préparation';
    case 'shipped':
      return 'Expédiée';
    case 'delivered':
      return 'Livrée';
    case 'completed':
      return 'Terminée';
    case 'cancelled':
      return 'Annulée';
    case 'refunded':
      return 'Remboursée';
    default:
      return '—';
  }
}

async function getAccount(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const sessionUser = req.session.user;

    let addresses = [];
    let defaultAddress = null;

    let inProgressOrderCount = 0;
    let recentOrders = [];

    if (dbConnected && sessionUser && sessionUser._id) {
      const user = await User.findById(sessionUser._id).lean();

      if (!user) {
        delete req.session.user;
        return res.redirect('/compte/connexion?returnTo=%2Fcompte');
      }

      addresses = Array.isArray(user.addresses) ? user.addresses : [];
      defaultAddress = addresses.find((a) => a && a.isDefault) || null;

      req.session.user = {
        _id: String(user._id),
        accountType: user.accountType,
        firstName: user.firstName,
        lastName: user.lastName,
        email: user.email,
        companyName: user.companyName || '',
        discountPercent: typeof user.discountPercent === 'number' ? user.discountPercent : 0,
      };

      req.session.accountType = user.accountType;

      const inProgressStatuses = ['pending_payment', 'paid', 'processing', 'shipped'];
      inProgressOrderCount = await Order.countDocuments({
        userId: user._id,
        status: { $in: inProgressStatuses },
      });

      const orders = await Order.find({ userId: user._id })
        .sort({ createdAt: -1 })
        .limit(5)
        .lean();

      recentOrders = orders.map((o) => ({
        id: String(o._id),
        number: o.number,
        date: formatDateFR(o.createdAt),
        status: formatOrderStatus(o.status),
        total: formatEuro(getOrderTotalCents(o)),
      }));
    }

    // SAV : compteur ouverts + nouvelles réponses
    let savOpen = 0; let savUnread = 0;
    try {
      const SavTicket = require('../models/SavTicket');
      const email = (req.session.user.email || '').toLowerCase();
      const SAV_OPEN = ['ouvert','pre_qualification','en_attente_documents','retour_demande','en_transit_retour','recu_atelier','en_analyse','en_attente_decision_client'];
      [savOpen, savUnread] = await Promise.all([
        SavTicket.countDocuments({ 'client.email': email, statut: { $in: SAV_OPEN } }),
        SavTicket.countDocuments({
          'client.email': email,
          $expr: { $and: [ { $ne: ['$lastAdminMessageAt', null] }, { $or: [ { $eq: ['$lastClientReadAt', null] }, { $gt: ['$lastAdminMessageAt', '$lastClientReadAt'] } ] } ] },
        }),
      ]);
    } catch (_) {}

    return res.render('account/index', {
      title: `Mon compte - ${brand.NAME}`,
      dbConnected,
      currentUser: req.session.user || null,
      accountType: req.session.accountType === 'pro' ? 'pro' : 'particulier',
      addressCount: addresses.length,
      defaultAddress,
      orderCount: inProgressOrderCount,
      vehicleCount: 0,
      orders: recentOrders,
      vehicles: [],
      savOpen,
      savUnread,
    });
  } catch (err) {
    return next(err);
  }
}

async function getOrdersPage(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const sessionUser = req.session.user;

    if (!sessionUser || !sessionUser._id) {
      return res.redirect('/compte');
    }

    if (!dbConnected) {
      return res.status(503).render('account/orders', {
        title: `Mes commandes - ${brand.NAME}`,
        dbConnected,
        orders: [],
      });
    }

    const orders = await Order.find({ userId: sessionUser._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    const viewOrders = orders.map((o) => {
      const dateParts = formatOrderListDate(o.createdAt);
      const statusBadge = getStatusBadge(o.status);
      const itemCount = Array.isArray(o.items)
        ? o.items.reduce((sum, it) => {
            if (!it || !Number.isFinite(it.quantity)) return sum;
            return sum + it.quantity;
          }, 0)
        : 0;
      const consigne = computeConsigneSummaryForOrder(o);

      const isPaid = getTrimmedString(o && o.paymentStatus).toLowerCase() === 'paid';
      const invoiceUrl = isPaid ? `/compte/commandes/${encodeURIComponent(String(o._id))}/facture.pdf` : '';

      return {
        id: String(o._id),
        number: o.number,
        date: formatDateFR(o.createdAt),
        dateLine1: dateParts.line1,
        dateLine2: dateParts.line2,
        itemCount,
        status: formatOrderStatus(o.status),
        statusKey: o.status,
        statusBadge,
        total: formatEuro(getOrderTotalCents(o)),
        consigne,
        invoiceUrl,
      };
    });

    return res.render('account/orders', {
      title: `Mes commandes - ${brand.NAME}`,
      dbConnected,
      orders: viewOrders,
    });
  } catch (err) {
    return next(err);
  }
}

function getGaragePage(req, res) {
  const dbConnected = mongoose.connection.readyState === 1;

  return res.render('account/garage', {
    title: `Mon garage - ${brand.NAME}`,
    dbConnected,
    vehicles: [],
  });
}

function setAccountType(req, res) {
  if (req.session.user) {
    const returnToBlocked = getSafeReturnTo(req.body.returnTo);
    return res.redirect(returnToBlocked || '/compte');
  }

  const type = typeof req.body.type === 'string' ? req.body.type : '';
  req.session.accountType = type === 'pro' ? 'pro' : 'particulier';

  const returnTo = getSafeReturnTo(req.body.returnTo);
  const target = returnTo || '/compte';

  if (!req.session || typeof req.session.save !== 'function') {
    return res.redirect(target);
  }

  return req.session.save(() => res.redirect(target));
}

function getLogin(req, res) {
  const dbConnected = mongoose.connection.readyState === 1;
  const returnTo = getSafeReturnTo(req.query.returnTo) || '/compte';

  const successMessage = req.session && req.session.accountSuccess ? String(req.session.accountSuccess) : null;
  if (req.session) delete req.session.accountSuccess;

  res.render('account/login', {
    title: `Connexion - ${brand.NAME}`,
    dbConnected,
    errorMessage: null,
    successMessage,
    email: '',
    returnTo,
  });
}

async function postLogin(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;

    const ip = getClientIp(req);
    const honeypot = getTrimmedString(req.body && req.body.website);
    if (honeypot) {
      return res.status(401).render('account/login', {
        title: `Connexion - ${brand.NAME}`,
        dbConnected,
        errorMessage: 'Identifiants incorrects.',
        email: normalizeEmail(req.body.email),
        returnTo: getSafeReturnTo(req.body.returnTo) || '/compte',
      });
    }

    const limit = consumeRateLimit(LOGIN_BUCKETS, ip, { limit: 25, windowMs: 10 * 60 * 1000 });
    if (limit.limited) {
      return res.status(429).render('account/login', {
        title: `Connexion - ${brand.NAME}`,
        dbConnected,
        errorMessage: 'Trop de tentatives. Merci de patienter quelques minutes puis de réessayer.',
        email: normalizeEmail(req.body.email),
        returnTo: getSafeReturnTo(req.body.returnTo) || '/compte',
      });
    }

    if (!dbConnected) {
      return res.status(503).render('account/login', {
        title: `Connexion - ${brand.NAME}`,
        dbConnected,
        errorMessage: "La base de données n'est pas disponible. Impossible de se connecter pour le moment.",
        email: normalizeEmail(req.body.email),
        returnTo: getSafeReturnTo(req.body.returnTo) || '/compte',
      });
    }

    const email = normalizeEmail(req.body.email);
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    if (!email || !password) {
      return res.status(400).render('account/login', {
        title: `Connexion - ${brand.NAME}`,
        dbConnected,
        errorMessage: 'Merci de renseigner votre email et votre mot de passe.',
        email,
        returnTo: getSafeReturnTo(req.body.returnTo) || '/compte',
      });
    }

    const user = await User.findOne({ email }).lean();

    if (!user) {
      return res.status(401).render('account/login', {
        title: `Connexion - ${brand.NAME}`,
        dbConnected,
        errorMessage: 'Identifiants incorrects.',
        email,
        returnTo: getSafeReturnTo(req.body.returnTo) || '/compte',
      });
    }

    const computed = hashPassword(password, user.passwordSalt);

    if (computed !== user.passwordHash) {
      return res.status(401).render('account/login', {
        title: `Connexion - ${brand.NAME}`,
        dbConnected,
        errorMessage: 'Identifiants incorrects.',
        email,
        returnTo: getSafeReturnTo(req.body.returnTo) || '/compte',
      });
    }

    const nextSessionUser = {
      _id: String(user._id),
      accountType: user.accountType,
      firstName: user.firstName,
      lastName: user.lastName,
      email: user.email,
      companyName: user.companyName || '',
      discountPercent: typeof user.discountPercent === 'number' ? user.discountPercent : 0,
    };

    const returnTo = getSafeReturnTo(req.body.returnTo);
    const target = returnTo || '/compte';

    const prevCart = req.session && req.session.cart ? req.session.cart : null;
    const prevCheckout = req.session && req.session.checkout ? req.session.checkout : null;
    const prevPromoCode = req.session && req.session.promoCode ? req.session.promoCode : null;

    if (req.session && typeof req.session.regenerate === 'function') {
      return req.session.regenerate((err) => {
        if (err) return next(err);
        if (prevCart) req.session.cart = prevCart;
        if (prevCheckout) req.session.checkout = prevCheckout;
        if (prevPromoCode) req.session.promoCode = prevPromoCode;
        req.session.user = nextSessionUser;
        req.session.accountType = user.accountType;
        /* Rattrape les ajouts panier faits en anonyme */
        logExistingCartItems(req);
        return req.session.save(() => res.redirect(target));
      });
    }

    req.session.user = nextSessionUser;
    req.session.accountType = user.accountType;
    /* Rattrape les ajouts panier faits en anonyme */
    logExistingCartItems(req);
    return req.session.save(() => res.redirect(target));
  } catch (err) {
    return next(err);
  }
}

function getSecurity(req, res) {
  const dbConnected = mongoose.connection.readyState === 1;

  res.render('account/security', {
    title: `Sécurité - ${brand.NAME}`,
    dbConnected,
    errorMessage: null,
    successMessage: null,
  });
}

async function postSecurity(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const sessionUser = req.session.user;

    if (!sessionUser || !sessionUser._id) {
      return res.redirect('/compte');
    }

    if (!dbConnected) {
      return res.status(503).render('account/security', {
        title: `Sécurité - ${brand.NAME}`,
        dbConnected,
        errorMessage: "La base de données n'est pas disponible. Impossible de changer le mot de passe.",
        successMessage: null,
      });
    }

    const currentPassword = typeof req.body.currentPassword === 'string' ? req.body.currentPassword : '';
    const newPassword = typeof req.body.newPassword === 'string' ? req.body.newPassword : '';
    const confirmPassword = typeof req.body.confirmPassword === 'string' ? req.body.confirmPassword : '';

    if (!currentPassword || !newPassword || !confirmPassword) {
      return res.status(400).render('account/security', {
        title: `Sécurité - ${brand.NAME}`,
        dbConnected,
        errorMessage: 'Merci de remplir tous les champs.',
        successMessage: null,
      });
    }

    if (newPassword.length < 6) {
      return res.status(400).render('account/security', {
        title: `Sécurité - ${brand.NAME}`,
        dbConnected,
        errorMessage: 'Le nouveau mot de passe doit faire au moins 6 caractères.',
        successMessage: null,
      });
    }

    if (newPassword !== confirmPassword) {
      return res.status(400).render('account/security', {
        title: `Sécurité - ${brand.NAME}`,
        dbConnected,
        errorMessage: 'La confirmation du mot de passe ne correspond pas.',
        successMessage: null,
      });
    }

    const user = await User.findById(sessionUser._id);

    if (!user) {
      delete req.session.user;
      return res.redirect('/compte');
    }

    const computedCurrent = hashPassword(currentPassword, user.passwordSalt);

    if (computedCurrent !== user.passwordHash) {
      return res.status(401).render('account/security', {
        title: `Sécurité - ${brand.NAME}`,
        dbConnected,
        errorMessage: 'Votre mot de passe actuel est incorrect.',
        successMessage: null,
      });
    }

    const newSalt = crypto.randomBytes(16).toString('hex');
    const newHash = hashPassword(newPassword, newSalt);

    user.passwordSalt = newSalt;
    user.passwordHash = newHash;
    await user.save();

    return res.render('account/security', {
      title: `Sécurité - ${brand.NAME}`,
      dbConnected,
      errorMessage: null,
      successMessage: 'Mot de passe mis à jour avec succès.',
    });
  } catch (err) {
    return next(err);
  }
}

async function getAddresses(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const sessionUser = req.session.user;

    if (!sessionUser || !sessionUser._id) {
      return res.redirect('/compte');
    }

    if (!dbConnected) {
      return res.status(503).render('account/addresses', {
        title: `Mes adresses - ${brand.NAME}`,
        dbConnected,
        errorMessage: "La base de données n'est pas disponible. Impossible d'afficher vos adresses.",
        addresses: [],
        form: {
          label: '',
          fullName: '',
          phone: '',
          line1: '',
          line2: '',
          postalCode: '',
          city: '',
          country: 'France',
          isDefault: false,
        },
      });
    }

    const user = await User.findById(sessionUser._id).lean();

    if (!user) {
      delete req.session.user;
      return res.redirect('/compte');
    }

    const addresses = Array.isArray(user.addresses) ? user.addresses : [];

    return res.render('account/addresses', {
      title: `Mes adresses - ${brand.NAME}`,
      dbConnected,
      errorMessage: null,
      addresses,
      form: {
        label: '',
        fullName: '',
        phone: '',
        line1: '',
        line2: '',
        postalCode: '',
        city: '',
        country: 'France',
        isDefault: addresses.length === 0,
      },
    });
  } catch (err) {
    return next(err);
  }
}

async function postAddAddress(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const sessionUser = req.session.user;

    if (!sessionUser || !sessionUser._id) {
      return res.redirect('/compte');
    }

    const label = typeof req.body.label === 'string' ? req.body.label.trim() : '';
    const fullName = typeof req.body.fullName === 'string' ? req.body.fullName.trim() : '';
    const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() : '';
    const line1 = typeof req.body.line1 === 'string' ? req.body.line1.trim() : '';
    const line2 = typeof req.body.line2 === 'string' ? req.body.line2.trim() : '';
    const postalCode = typeof req.body.postalCode === 'string' ? req.body.postalCode.trim() : '';
    const city = typeof req.body.city === 'string' ? req.body.city.trim() : '';
    const country = typeof req.body.country === 'string' ? req.body.country.trim() : 'France';
    const isDefault = req.body.isDefault === 'on' || req.body.isDefault === 'true' || req.body.isDefault === true;

    const form = {
      label,
      fullName,
      phone,
      line1,
      line2,
      postalCode,
      city,
      country: country || 'France',
      isDefault: !!isDefault,
    };

    if (!dbConnected) {
      return res.status(503).render('account/addresses', {
        title: `Mes adresses - ${brand.NAME}`,
        dbConnected,
        errorMessage: "La base de données n'est pas disponible. Impossible d'ajouter une adresse.",
        addresses: [],
        form,
      });
    }

    if (!line1 || !postalCode || !city) {
      const userLean = await User.findById(sessionUser._id).lean();
      const addresses = userLean && Array.isArray(userLean.addresses) ? userLean.addresses : [];

      return res.status(400).render('account/addresses', {
        title: `Mes adresses - ${brand.NAME}`,
        dbConnected,
        errorMessage: 'Merci de renseigner au minimum : adresse, code postal et ville.',
        addresses,
        form,
      });
    }

    const user = await User.findById(sessionUser._id);

    if (!user) {
      delete req.session.user;
      return res.redirect('/compte');
    }

    if (!Array.isArray(user.addresses)) {
      user.addresses = [];
    }

    const shouldBeDefault = user.addresses.length === 0 || isDefault;

    if (shouldBeDefault) {
      user.addresses.forEach((a) => {
        a.isDefault = false;
      });
    }

    user.addresses.push({
      label,
      fullName,
      phone,
      line1,
      line2,
      postalCode,
      city,
      country: country || 'France',
      isDefault: shouldBeDefault,
    });

    await user.save();
    return res.redirect('/compte/adresses');
  } catch (err) {
    return next(err);
  }
}

async function postSetDefaultAddress(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const sessionUser = req.session.user;
    const addressId = typeof req.params.addressId === 'string' ? req.params.addressId : '';

    if (!sessionUser || !sessionUser._id) {
      return res.redirect('/compte');
    }

    if (!dbConnected) {
      return res.redirect('/compte/adresses');
    }

    const user = await User.findById(sessionUser._id);
    if (!user) {
      delete req.session.user;
      return res.redirect('/compte');
    }

    if (!Array.isArray(user.addresses) || user.addresses.length === 0) {
      return res.redirect('/compte/adresses');
    }

    const target = user.addresses.id(addressId);
    if (!target) {
      return res.redirect('/compte/adresses');
    }

    user.addresses.forEach((a) => {
      a.isDefault = false;
    });
    target.isDefault = true;

    await user.save();
    return res.redirect('/compte/adresses');
  } catch (err) {
    return next(err);
  }
}

async function postDeleteAddress(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const sessionUser = req.session.user;
    const addressId = typeof req.params.addressId === 'string' ? req.params.addressId : '';

    if (!sessionUser || !sessionUser._id) {
      return res.redirect('/compte');
    }

    if (!dbConnected) {
      return res.redirect('/compte/adresses');
    }

    const user = await User.findById(sessionUser._id);
    if (!user) {
      delete req.session.user;
      return res.redirect('/compte');
    }

    if (!Array.isArray(user.addresses) || user.addresses.length === 0) {
      return res.redirect('/compte/adresses');
    }

    const target = user.addresses.id(addressId);
    if (!target) {
      return res.redirect('/compte/adresses');
    }

    const wasDefault = !!target.isDefault;
    target.deleteOne();

    if (wasDefault && user.addresses.length > 0) {
      user.addresses[0].isDefault = true;
    }

    await user.save();
    return res.redirect('/compte/adresses');
  } catch (err) {
    return next(err);
  }
}

function getRegister(req, res) {
  const dbConnected = mongoose.connection.readyState === 1;
  const returnTo = getSafeReturnTo(req.query.returnTo) || '/compte';

  const defaultType = req.session.accountType === 'pro' ? 'pro' : 'particulier';

  res.render('account/register', {
    title: `Créer un compte - ${brand.NAME}`,
    dbConnected,
    errorMessage: null,
    form: {
      accountType: defaultType,
      firstName: '',
      lastName: '',
      email: '',
      companyName: '',
      siret: '',
    },
    returnTo,
  });
}

async function postRegister(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;

    const ip = getClientIp(req);
    const honeypot = getTrimmedString(req.body && req.body.website);
    if (honeypot) {
      return res.status(400).render('account/register', {
        title: `Créer un compte - ${brand.NAME}`,
        dbConnected,
        errorMessage: 'Merci de remplir tous les champs obligatoires.',
        form: {
          accountType: req.body.accountType === 'pro' ? 'pro' : 'particulier',
          firstName: typeof req.body.firstName === 'string' ? req.body.firstName.trim() : '',
          lastName: typeof req.body.lastName === 'string' ? req.body.lastName.trim() : '',
          email: normalizeEmail(req.body.email),
          companyName: typeof req.body.companyName === 'string' ? req.body.companyName.trim() : '',
          siret: typeof req.body.siret === 'string' ? req.body.siret.trim() : '',
        },
        returnTo: getSafeReturnTo(req.body.returnTo) || '/compte',
      });
    }

    const limit = consumeRateLimit(REGISTER_BUCKETS, ip, { limit: 12, windowMs: 10 * 60 * 1000 });
    if (limit.limited) {
      return res.status(429).render('account/register', {
        title: `Créer un compte - ${brand.NAME}`,
        dbConnected,
        errorMessage: 'Trop de tentatives. Merci de patienter quelques minutes puis de réessayer.',
        form: {
          accountType: req.body.accountType === 'pro' ? 'pro' : 'particulier',
          firstName: typeof req.body.firstName === 'string' ? req.body.firstName.trim() : '',
          lastName: typeof req.body.lastName === 'string' ? req.body.lastName.trim() : '',
          email: normalizeEmail(req.body.email),
          companyName: typeof req.body.companyName === 'string' ? req.body.companyName.trim() : '',
          siret: typeof req.body.siret === 'string' ? req.body.siret.trim() : '',
        },
        returnTo: getSafeReturnTo(req.body.returnTo) || '/compte',
      });
    }
    const accountType = req.body.accountType === 'pro' ? 'pro' : 'particulier';
    const firstName = typeof req.body.firstName === 'string' ? req.body.firstName.trim() : '';
    const lastName = typeof req.body.lastName === 'string' ? req.body.lastName.trim() : '';
    const email = normalizeEmail(req.body.email);
    const password = typeof req.body.password === 'string' ? req.body.password : '';
    const companyName = typeof req.body.companyName === 'string' ? req.body.companyName.trim() : '';
    const siret = typeof req.body.siret === 'string' ? req.body.siret.trim() : '';
    const acceptTerms = req.body.acceptTerms === 'on' || req.body.acceptTerms === 'true' || req.body.acceptTerms === true;

    const form = {
      accountType,
      firstName,
      lastName,
      email,
      companyName,
      siret,
    };

    if (!dbConnected) {
      return res.status(503).render('account/register', {
        title: `Créer un compte - ${brand.NAME}`,
        dbConnected,
        errorMessage: "La base de données n'est pas disponible. Impossible de créer un compte pour le moment.",
        form,
        returnTo: getSafeReturnTo(req.body.returnTo) || '/compte',
      });
    }

    if (!firstName || !lastName || !email || !password) {
      return res.status(400).render('account/register', {
        title: `Créer un compte - ${brand.NAME}`,
        dbConnected,
        errorMessage: 'Merci de remplir tous les champs obligatoires.',
        form,
        returnTo: getSafeReturnTo(req.body.returnTo) || '/compte',
      });
    }

    if (!acceptTerms) {
      return res.status(400).render('account/register', {
        title: `Créer un compte - ${brand.NAME}`,
        dbConnected,
        errorMessage: 'Merci d’accepter les CGV et la politique de confidentialité.',
        form,
        returnTo: getSafeReturnTo(req.body.returnTo) || '/compte',
      });
    }

    if (password.length < 6) {
      return res.status(400).render('account/register', {
        title: `Créer un compte - ${brand.NAME}`,
        dbConnected,
        errorMessage: 'Le mot de passe doit faire au moins 6 caractères.',
        form,
        returnTo: getSafeReturnTo(req.body.returnTo) || '/compte',
      });
    }

    if (accountType === 'pro' && (!companyName || !siret)) {
      return res.status(400).render('account/register', {
        title: `Créer un compte - ${brand.NAME}`,
        dbConnected,
        errorMessage: 'Pour un compte Pro, merci de renseigner la société et le SIRET.',
        form,
        returnTo: getSafeReturnTo(req.body.returnTo) || '/compte',
      });
    }

    const salt = crypto.randomBytes(16).toString('hex');
    const passwordHash = hashPassword(password, salt);

    const created = await User.create({
      accountType,
      firstName,
      lastName,
      email,
      passwordSalt: salt,
      passwordHash,
      companyName: accountType === 'pro' ? companyName : '',
      siret: accountType === 'pro' ? siret : '',
    });

    try {
      await emailService.sendWelcomeEmail({ user: created });
    } catch (err) {
      console.error('Erreur email bienvenue :', err && err.message ? err.message : err);
    }

    const nextSessionUser = {
      _id: String(created._id),
      accountType: created.accountType,
      firstName: created.firstName,
      lastName: created.lastName,
      email: created.email,
      companyName: created.companyName || '',
      discountPercent: typeof created.discountPercent === 'number' ? created.discountPercent : 0,
    };

    const returnTo = getSafeReturnTo(req.body.returnTo);
    const target = returnTo || '/compte';

    const prevCart = req.session && req.session.cart ? req.session.cart : null;
    const prevCheckout = req.session && req.session.checkout ? req.session.checkout : null;
    const prevPromoCode = req.session && req.session.promoCode ? req.session.promoCode : null;

    if (req.session && typeof req.session.regenerate === 'function') {
      return req.session.regenerate((err) => {
        if (err) return next(err);
        if (prevCart) req.session.cart = prevCart;
        if (prevCheckout) req.session.checkout = prevCheckout;
        if (prevPromoCode) req.session.promoCode = prevPromoCode;
        req.session.user = nextSessionUser;
        req.session.accountType = created.accountType;
        /* Rattrape les ajouts panier faits en anonyme */
        logExistingCartItems(req);
        return req.session.save(() => res.redirect(target));
      });
    }

    req.session.user = nextSessionUser;
    req.session.accountType = created.accountType;
    /* Rattrape les ajouts panier faits en anonyme */
    logExistingCartItems(req);
    return req.session.save(() => res.redirect(target));
  } catch (err) {
    if (err && err.code === 11000) {
      const dbConnected = mongoose.connection.readyState === 1;
      const form = {
        accountType: req.body.accountType === 'pro' ? 'pro' : 'particulier',
        firstName: typeof req.body.firstName === 'string' ? req.body.firstName.trim() : '',
        lastName: typeof req.body.lastName === 'string' ? req.body.lastName.trim() : '',
        email: normalizeEmail(req.body.email),
        companyName: typeof req.body.companyName === 'string' ? req.body.companyName.trim() : '',
        siret: typeof req.body.siret === 'string' ? req.body.siret.trim() : '',
      };

      return res.status(409).render('account/register', {
        title: `Créer un compte - ${brand.NAME}`,
        dbConnected,
        errorMessage: 'Un compte existe déjà avec cet email.',
        form,
        returnTo: getSafeReturnTo(req.body.returnTo) || '/compte',
      });
    }

    return next(err);
  }
}

function postLogout(req, res) {
  delete req.session.user;

  const returnTo = getSafeReturnTo(req.body.returnTo);
  const target = returnTo || '/';

  if (!req.session || typeof req.session.save !== 'function') {
    return res.redirect(target);
  }

  return req.session.save(() => res.redirect(target));
}

async function getProfile(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const sessionUser = req.session.user;

    if (!sessionUser || !sessionUser._id) {
      return res.redirect('/compte');
    }

    if (!dbConnected) {
      return res.status(503).render('account/profile', {
        title: `Mon profil - ${brand.NAME}`,
        dbConnected,
        errorMessage: "La base de données n'est pas disponible. Impossible d'afficher le profil.",
        form: {
          accountType: sessionUser.accountType === 'pro' ? 'pro' : 'particulier',
          firstName: sessionUser.firstName || '',
          lastName: sessionUser.lastName || '',
          email: sessionUser.email || '',
          companyName: '',
          siret: '',
        },
      });
    }

    const user = await User.findById(sessionUser._id).lean();

    if (!user) {
      delete req.session.user;
      return res.redirect('/compte');
    }

    return res.render('account/profile', {
      title: `Mon profil - ${brand.NAME}`,
      dbConnected,
      errorMessage: null,
      form: {
        accountType: user.accountType === 'pro' ? 'pro' : 'particulier',
        firstName: user.firstName || '',
        lastName: user.lastName || '',
        email: user.email || '',
        companyName: user.companyName || '',
        siret: user.siret || '',
        smsOptIn: Boolean(user.smsOptIn),
      },
    });
  } catch (err) {
    return next(err);
  }
}

async function postProfile(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const sessionUser = req.session.user;

    if (!sessionUser || !sessionUser._id) {
      return res.redirect('/compte');
    }

    const firstName = typeof req.body.firstName === 'string' ? req.body.firstName.trim() : '';
    const lastName = typeof req.body.lastName === 'string' ? req.body.lastName.trim() : '';
    const companyName = typeof req.body.companyName === 'string' ? req.body.companyName.trim() : '';
    const siret = typeof req.body.siret === 'string' ? req.body.siret.trim() : '';
    const smsOptIn = req.body.smsOptIn === 'true' || req.body.smsOptIn === true;

    const form = {
      accountType: sessionUser.accountType === 'pro' ? 'pro' : 'particulier',
      firstName,
      lastName,
      email: sessionUser.email || '',
      companyName,
      siret,
      smsOptIn,
    };

    if (!dbConnected) {
      return res.status(503).render('account/profile', {
        title: `Mon profil - ${brand.NAME}`,
        dbConnected,
        errorMessage: "La base de données n'est pas disponible. Impossible d'enregistrer.",
        form,
      });
    }

    if (!firstName || !lastName) {
      return res.status(400).render('account/profile', {
        title: `Mon profil - ${brand.NAME}`,
        dbConnected,
        errorMessage: 'Merci de renseigner votre prénom et votre nom.',
        form,
      });
    }

    if (form.accountType === 'pro' && (!companyName || !siret)) {
      return res.status(400).render('account/profile', {
        title: `Mon profil - ${brand.NAME}`,
        dbConnected,
        errorMessage: 'Pour un compte Pro, merci de renseigner la société et le SIRET.',
        form,
      });
    }

    // Detect SMS opt-in change for RGPD consent tracking
    const currentUser = await User.findById(sessionUser._id).select('smsOptIn').lean();
    const smsFields = { smsOptIn };
    if (currentUser && Boolean(currentUser.smsOptIn) !== smsOptIn) {
      if (smsOptIn) {
        smsFields.smsOptInAt = new Date();
      } else {
        smsFields.smsOptOutAt = new Date();
      }
    }

    const updated = await User.findByIdAndUpdate(
      sessionUser._id,
      {
        $set: {
          firstName,
          lastName,
          companyName: form.accountType === 'pro' ? companyName : '',
          siret: form.accountType === 'pro' ? siret : '',
          ...smsFields,
        },
      },
      { new: true }
    ).lean();

    if (!updated) {
      delete req.session.user;
      return res.redirect('/compte');
    }

    req.session.user = {
      _id: String(updated._id),
      accountType: updated.accountType,
      firstName: updated.firstName,
      lastName: updated.lastName,
      email: updated.email,
      companyName: updated.companyName || '',
      discountPercent: typeof updated.discountPercent === 'number' ? updated.discountPercent : 0,
    };

    req.session.accountType = updated.accountType;

    return res.redirect('/compte/profil');
  } catch (err) {
    return next(err);
  }
}

async function getOrderDocumentForClient(req, res, next) {
  try {
    const sessionUser = req.session.user;
    const { orderId, docId } = req.params;

    if (!sessionUser || !sessionUser._id) return res.redirect('/compte');
    if (!mongoose.Types.ObjectId.isValid(orderId) || !mongoose.Types.ObjectId.isValid(docId)) {
      return res.status(404).send('Document introuvable.');
    }

    // Use MongoDB native query to bypass Mongoose select:false on nested subdocs
    const order = await Order.collection.findOne(
      { _id: new mongoose.Types.ObjectId(orderId), userId: new mongoose.Types.ObjectId(sessionUser._id) },
      { projection: { documents: 1 } }
    );
    if (!order) return res.status(404).send('Commande introuvable.');

    const doc = Array.isArray(order.documents)
      ? order.documents.find((d) => d && String(d._id) === String(docId))
      : null;

    if (!doc) return res.status(404).send('Document introuvable.');

    let fileBuffer = doc.fileData
      ? (doc.fileData.buffer || doc.fileData)
      : null;
    if (!fileBuffer && doc.storedPath && fs.existsSync(doc.storedPath)) {
      fileBuffer = fs.readFileSync(doc.storedPath);
    }
    if (!fileBuffer) return res.status(404).send('Fichier introuvable.');

    const filename = doc.originalName || 'document.pdf';
    res.setHeader('Content-Type', doc.mimeType || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    return res.send(fileBuffer);
  } catch (err) {
    return next(err);
  }
}

async function getOrderShipmentDocForClient(req, res, next) {
  try {
    const sessionUser = req.session.user;
    const { orderId, shipmentId } = req.params;

    if (!sessionUser || !sessionUser._id) return res.redirect('/compte');
    if (!mongoose.Types.ObjectId.isValid(orderId) || !mongoose.Types.ObjectId.isValid(shipmentId)) {
      return res.status(404).send('Document introuvable.');
    }

    // Use MongoDB native query to bypass Mongoose select:false on nested subdocs
    const order = await Order.collection.findOne(
      { _id: new mongoose.Types.ObjectId(orderId), userId: new mongoose.Types.ObjectId(sessionUser._id) },
      { projection: { shipments: 1 } }
    );
    if (!order) return res.status(404).send('Commande introuvable.');

    const shipment = Array.isArray(order.shipments)
      ? order.shipments.find((s) => s && String(s._id) === String(shipmentId) && s.document)
      : null;

    if (!shipment) return res.status(404).send('Document introuvable.');

    let fileBuffer = shipment.document.fileData
      ? (shipment.document.fileData.buffer || shipment.document.fileData)
      : null;
    if (!fileBuffer && shipment.document.storedPath && fs.existsSync(shipment.document.storedPath)) {
      fileBuffer = fs.readFileSync(shipment.document.storedPath);
    }
    if (!fileBuffer) return res.status(404).send('Fichier introuvable.');

    const filename = shipment.document.originalName || 'document.pdf';
    res.setHeader('Content-Type', shipment.document.mimeType || 'application/pdf');
    res.setHeader('Content-Disposition', `inline; filename="${filename}"`);
    return res.send(fileBuffer);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getAccount,
  setAccountType,
  getLogin,
  postLogin,
  getRegister,
  postRegister,
  getForgotPassword,
  postForgotPassword,
  getResetPassword,
  postResetPassword,
  postLogout,
  getProfile,
  postProfile,
  getSecurity,
  postSecurity,
  getAddresses,
  postAddAddress,
  postSetDefaultAddress,
  postDeleteAddress,
  getOrdersPage,
  getOrderDetailPage,
  getOrderInvoicePdf,
  getOrderTrackingPage,
  postRepurchaseOrder,
  getInvoicesPage,
  getGaragePage,
  getOrderDocumentForClient,
  getOrderShipmentDocForClient,
};
