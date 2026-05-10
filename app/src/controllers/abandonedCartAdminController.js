const mongoose = require('mongoose');

const AbandonedCart = require('../models/AbandonedCart');
const { sendAbandonedCartReminder, sendEmail } = require('../services/emailService');
const { sendSms, normalizePhoneFR } = require('../services/smsService');
const {
  EMAIL_TEMPLATES,
  SMS_TEMPLATES,
  applyVariables,
  buildLeadVariables,
  renderEmailHtml,
  renderEmailText,
} = require('../services/leadEmailTemplates');
const brand = require('../config/brand');

function escapeRegExp(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function formatEuro(totalCents) {
  if (!Number.isFinite(totalCents)) return '—';
  return `${(totalCents / 100).toFixed(2).replace('.', ',')} €`;
}

function formatDateTimeFR(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const date = d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'short', year: 'numeric' });
  const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  return `${date} ${time}`;
}

function formatRelative(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  const diffMs = Date.now() - d.getTime();
  const min = Math.floor(diffMs / 60000);
  if (min < 1) return 'à l’instant';
  if (min < 60) return `il y a ${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `il y a ${h} h`;
  const days = Math.floor(h / 24);
  if (days < 30) return `il y a ${days} j`;
  return formatDateTimeFR(value);
}

function getStatusBadge(status, manualStatus) {
  if (manualStatus === 'converted') return { label: 'Converti', className: 'bg-green-100 text-green-800' };
  if (manualStatus === 'contacted') return { label: 'Contacté', className: 'bg-blue-100 text-blue-800' };
  if (manualStatus === 'lost') return { label: 'Perdu', className: 'bg-slate-200 text-slate-600' };
  const badges = {
    abandoned: { label: 'Abandonné', className: 'bg-red-50 text-red-700' },
    reminded_1: { label: 'Relance 1', className: 'bg-amber-50 text-amber-700' },
    reminded_2: { label: 'Relance 2', className: 'bg-orange-50 text-orange-700' },
    reminded_3: { label: 'Relance 3', className: 'bg-orange-100 text-orange-800' },
    recovered: { label: 'Récupéré', className: 'bg-green-50 text-green-700' },
    expired: { label: 'Expiré', className: 'bg-slate-100 text-slate-500' },
  };
  return badges[status] || { label: status || '—', className: 'bg-slate-100 text-slate-500' };
}

function getCaptureSourceLabel(captureSource) {
  const labels = {
    user: { label: 'Compte', className: 'bg-indigo-50 text-indigo-700' },
    guest_checkout: { label: 'Guest checkout', className: 'bg-purple-50 text-purple-700' },
    newsletter: { label: 'Newsletter', className: 'bg-pink-50 text-pink-700' },
    contact: { label: 'Contact', className: 'bg-cyan-50 text-cyan-700' },
    devis: { label: 'Devis', className: 'bg-teal-50 text-teal-700' },
    cart_activity: { label: 'Panier', className: 'bg-slate-100 text-slate-700' },
    manual: { label: 'Manuel', className: 'bg-yellow-50 text-yellow-700' },
  };
  return labels[captureSource] || { label: captureSource || '—', className: 'bg-slate-100 text-slate-500' };
}

function getReminderRecipients(cart) {
  const display = ((cart.firstName || '') + ' ' + (cart.lastName || '')).trim() || cart.email || 'Client';
  return { email: cart.email || '', phone: cart.phone || '', name: display };
}

/**
 * GET /admin/activite-panier — page liste des leads à relancer.
 *
 * Filtres : status, manualStatus, captureSource, channel (email/phone/both),
 * period (7d/30d/90d), search (email/nom/tel), sort (recent/amount/oldest)
 * Pagination : 30/page
 */
async function getAdminLeadsPage(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;

    const status = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    const manualStatusFilter = typeof req.query.manual === 'string' ? req.query.manual.trim() : '';
    const captureSource = typeof req.query.source === 'string' ? req.query.source.trim() : '';
    const channel = typeof req.query.channel === 'string' ? req.query.channel.trim() : '';
    const period = typeof req.query.period === 'string' ? req.query.period.trim() : '30d';
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const sort = typeof req.query.sort === 'string' ? req.query.sort.trim() : 'recent';

    const perPage = 30;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    const baseRender = (overrides = {}) => res.render('admin/cart-activity', Object.assign({
      title: 'Admin - Leads à relancer',
      dbConnected,
      leads: [],
      kpis: { total: 0, uncontacted: 0, contacted: 0, converted: 0, pendingValueCents: 0, recoveryRate: '0' },
      filters: { status, manualStatus: manualStatusFilter, captureSource, channel, period, q, sort },
      pagination: { page: 1, perPage, totalItems: 0, totalPages: 1, from: 0, to: 0, hasPrev: false, hasNext: false, prevPage: 1, nextPage: 1 },
      emailTemplates: EMAIL_TEMPLATES.map((t) => ({ key: t.key, label: t.label, subject: t.subject, body: t.body, forSource: t.forSource || [] })),
      smsTemplates: SMS_TEMPLATES.map((t) => ({ key: t.key, label: t.label, body: t.body })),
    }, overrides));

    if (!dbConnected) return baseRender();

    /* Construction du filtre principal */
    const query = {};

    const allowedStatuses = new Set(['abandoned', 'reminded_1', 'reminded_2', 'reminded_3', 'recovered', 'expired']);
    if (status && allowedStatuses.has(status)) query.status = status;

    if (manualStatusFilter === 'none') query.manualStatus = null;
    else if (['contacted', 'converted', 'lost'].includes(manualStatusFilter)) query.manualStatus = manualStatusFilter;

    const allowedSources = new Set(['user', 'guest_checkout', 'newsletter', 'contact', 'devis', 'cart_activity', 'manual']);
    if (captureSource && allowedSources.has(captureSource)) query.captureSource = captureSource;

    if (channel === 'email') query.email = { $ne: '' };
    else if (channel === 'phone') query.phone = { $ne: '' };
    else if (channel === 'both') {
      query.email = { $ne: '' };
      query.phone = { $ne: '' };
    }

    if (period && ['7d', '30d', '90d'].includes(period)) {
      const start = new Date();
      const days = parseInt(period, 10) || 30;
      start.setDate(start.getDate() - days);
      query.lastActivityAt = { $gte: start };
    }

    if (q) {
      const rx = new RegExp(escapeRegExp(q), 'i');
      query.$or = [{ email: rx }, { firstName: rx }, { lastName: rx }, { phone: rx }];
    }

    /* Tri */
    let sortSpec;
    if (sort === 'amount') sortSpec = { totalAmountCents: -1, lastActivityAt: -1 };
    else if (sort === 'oldest') sortSpec = { lastActivityAt: 1 };
    else sortSpec = { lastActivityAt: -1 };

    /* KPIs (toujours sur 30j, pas filtrés) */
    const kpiSince = new Date();
    kpiSince.setDate(kpiSince.getDate() - 30);

    const [totalAll, uncontactedAll, contactedAll, convertedAll, pendingAggregate] = await Promise.all([
      AbandonedCart.countDocuments({ lastActivityAt: { $gte: kpiSince } }),
      AbandonedCart.countDocuments({ lastActivityAt: { $gte: kpiSince }, manualStatus: null, status: { $nin: ['recovered', 'expired'] } }),
      AbandonedCart.countDocuments({ lastActivityAt: { $gte: kpiSince }, manualStatus: 'contacted' }),
      AbandonedCart.countDocuments({ lastActivityAt: { $gte: kpiSince }, $or: [{ manualStatus: 'converted' }, { status: 'recovered' }] }),
      AbandonedCart.aggregate([
        { $match: { lastActivityAt: { $gte: kpiSince }, manualStatus: { $ne: 'converted' }, status: { $nin: ['recovered', 'expired'] } } },
        { $group: { _id: null, total: { $sum: '$totalAmountCents' } } },
      ]),
    ]);

    const pendingValueCents = pendingAggregate[0] && pendingAggregate[0].total ? pendingAggregate[0].total : 0;
    const recoveryRate = totalAll > 0 ? ((convertedAll / totalAll) * 100).toFixed(1) : '0';

    /* Comptage paginé */
    const totalItems = await AbandonedCart.countDocuments(query);
    const totalPages = Math.max(1, Math.ceil(totalItems / perPage));
    const currentPage = Math.min(page, totalPages);
    const skip = (currentPage - 1) * perPage;

    const rawLeads = await AbandonedCart.find(query)
      .sort(sortSpec)
      .skip(skip)
      .limit(perPage)
      .lean();

    const leads = rawLeads.map((c) => {
      const items = Array.isArray(c.items) ? c.items : [];
      const phoneFR = normalizePhoneFR(c.phone || '');
      const fullName = ((c.firstName || '') + ' ' + (c.lastName || '')).trim();
      const req = c.requested || {};
      const isExplicitRequest = c.captureSource === 'devis' || c.captureSource === 'contact';
      const hasRequested = !!(req.vehicle || req.vin || req.plate || req.ref || req.message);

      /* Construction d'un résumé "demande explicite" pour les leads devis/contact */
      const requestSummary = (() => {
        const parts = [];
        if (req.ref) parts.push(req.ref);
        if (req.vehicle) parts.push(req.vehicle);
        if (req.vin) parts.push(`VIN ${req.vin}`);
        else if (req.plate) parts.push(req.plate);
        return parts.join(' · ');
      })();

      return {
        id: String(c._id),
        sessionId: c.sessionId || '',
        email: c.email || '',
        phone: c.phone || '',
        phoneCallable: !!phoneFR,
        firstName: c.firstName || '',
        lastName: c.lastName || '',
        fullName: fullName || '',

        /* Demande explicite (formulaire devis/contact) */
        requested: {
          vehicle: req.vehicle || '',
          vin: req.vin || '',
          plate: req.plate || '',
          ref: req.ref || '',
          message: req.message || '',
        },
        hasRequested,
        requestSummary,
        showRequestAsPrimary: isExplicitRequest && hasRequested,

        items,
        itemCount: items.length,
        itemsSummary: items.length
          ? items.slice(0, 2).map((it) => it.name || 'Article').join(', ') + (items.length > 2 ? ` +${items.length - 2}` : '')
          : '—',
        firstItemImage: items[0] && items[0].image ? items[0].image : '',
        totalAmount: formatEuro(c.totalAmountCents),
        totalAmountCents: c.totalAmountCents || 0,
        captureSource: c.captureSource || '',
        captureBadge: getCaptureSourceLabel(c.captureSource),
        status: c.status,
        manualStatus: c.manualStatus || null,
        statusBadge: getStatusBadge(c.status, c.manualStatus),
        lastActivityRel: formatRelative(c.lastActivityAt || c.abandonedAt),
        lastActivityAbsolute: formatDateTimeFR(c.lastActivityAt || c.abandonedAt),
        lastRemindedAt: formatDateTimeFR(c.lastRemindedAt),
        lastManualContactAt: formatDateTimeFR(c.lastManualContactAt),
        manualEmailsSent: c.manualEmailsSent || 0,
        manualSmsSent: c.manualSmsSent || 0,
        contextMessage: c.contextMessage || '',
        attribution: c.attribution || {},
        notes: Array.isArray(c.notes) ? c.notes : [],
        canRemind: ['abandoned', 'reminded_1', 'reminded_2'].includes(c.status) && !c.manualStatus,
        recoveryToken: c.recoveryToken || '',
      };
    });

    const pagination = {
      page: currentPage,
      perPage,
      totalItems,
      totalPages,
      from: totalItems ? skip + 1 : 0,
      to: totalItems ? skip + rawLeads.length : 0,
      hasPrev: currentPage > 1,
      hasNext: currentPage < totalPages,
      prevPage: Math.max(1, currentPage - 1),
      nextPage: Math.min(totalPages, currentPage + 1),
    };

    return baseRender({
      leads,
      kpis: {
        total: totalAll,
        uncontacted: uncontactedAll,
        contacted: contactedAll,
        converted: convertedAll,
        pendingValueCents,
        pendingValue: formatEuro(pendingValueCents),
        recoveryRate,
      },
      pagination,
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /admin/activite-panier/:id — JSON detail of a lead.
 * Backward compatible with /admin/relances/:cartId.
 */
async function getAdminLeadDetail(req, res, next) {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ ok: false, error: 'Base de données indisponible.' });
    }
    const id = req.params.id || req.params.cartId;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(400).json({ ok: false, error: 'ID invalide.' });
    }
    const cart = await AbandonedCart.findById(id).lean();
    if (!cart) return res.status(404).json({ ok: false, error: 'Lead non trouvé.' });

    const req = cart.requested || {};
    return res.json({
      ok: true,
      cart: {
        id: String(cart._id),
        sessionId: cart.sessionId,
        email: cart.email,
        phone: cart.phone,
        firstName: cart.firstName,
        lastName: cart.lastName,
        captureSource: cart.captureSource,
        captureSourceLabel: getCaptureSourceLabel(cart.captureSource).label,
        requested: {
          vehicle: req.vehicle || '',
          vin: req.vin || '',
          plate: req.plate || '',
          ref: req.ref || '',
          message: req.message || '',
        },
        hasRequested: !!(req.vehicle || req.vin || req.plate || req.ref || req.message),
        contextMessage: cart.contextMessage || '',
        attribution: cart.attribution || {},
        items: (cart.items || []).map((it) => ({
          name: it.name,
          sku: it.sku,
          price: formatEuro(it.price),
          quantity: it.quantity,
          image: it.image,
          optionsSummary: it.optionsSummary || '',
        })),
        totalAmount: formatEuro(cart.totalAmountCents),
        totalAmountCents: cart.totalAmountCents || 0,
        status: cart.status,
        manualStatus: cart.manualStatus || null,
        statusLabel: getStatusBadge(cart.status, cart.manualStatus).label,
        abandonedAt: formatDateTimeFR(cart.abandonedAt),
        lastActivityAt: formatDateTimeFR(cart.lastActivityAt || cart.abandonedAt),
        lastRemindedAt: formatDateTimeFR(cart.lastRemindedAt),
        lastManualContactAt: formatDateTimeFR(cart.lastManualContactAt),
        recoveredAt: formatDateTimeFR(cart.recoveredAt),
        manualEmailsSent: cart.manualEmailsSent || 0,
        manualSmsSent: cart.manualSmsSent || 0,
        notes: (cart.notes || []).map((n) => ({
          text: n.text,
          addedByName: n.addedByName || 'Admin',
          addedAt: formatDateTimeFR(n.addedAt),
        })),
        recoveryToken: cart.recoveryToken,
        createdAt: formatDateTimeFR(cart.createdAt),
      },
    });
  } catch (err) {
    return next(err);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  ACTIONS                                                                 */
/* ──────────────────────────────────────────────────────────────────────── */

function getAdminFromReq(req) {
  if (req && req.session && req.session.admin) {
    const a = req.session.admin;
    const adminUserId = a.adminUserId || a._id || '';
    return {
      id: adminUserId && mongoose.Types.ObjectId.isValid(adminUserId) ? new mongoose.Types.ObjectId(adminUserId) : null,
      name: ((a.firstName || '') + ' ' + (a.lastName || '')).trim() || a.email || 'Admin',
      email: a.email || '',
    };
  }
  return { id: null, name: 'Admin', email: '' };
}

/**
 * POST /admin/relances/:cartId/relancer — déclenche la relance auto suivante (legacy).
 */
async function postAdminManualReminder(req, res, next) {
  try {
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).json({ ok: false, error: 'Base de données indisponible.' });
    }
    const cartId = req.params.cartId || req.params.id;
    if (!cartId || !mongoose.Types.ObjectId.isValid(cartId)) {
      return res.status(400).json({ ok: false, error: 'ID invalide.' });
    }

    const cart = await AbandonedCart.findById(cartId).lean();
    if (!cart) return res.status(404).json({ ok: false, error: 'Lead non trouvé.' });
    if (cart.status === 'recovered' || cart.status === 'expired') {
      return res.status(400).json({ ok: false, error: 'Ce lead ne peut plus être relancé.' });
    }

    let reminderNumber, nextStatus;
    if (cart.status === 'abandoned') { reminderNumber = 1; nextStatus = 'reminded_1'; }
    else if (cart.status === 'reminded_1') { reminderNumber = 2; nextStatus = 'reminded_2'; }
    else if (cart.status === 'reminded_2') { reminderNumber = 3; nextStatus = 'reminded_3'; }
    else return res.status(400).json({ ok: false, error: 'Toutes les relances ont déjà été envoyées.' });

    const promoCode = typeof process.env.ABANDONED_CART_PROMO_CODE === 'string'
      ? process.env.ABANDONED_CART_PROMO_CODE.trim() : '';

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
      await AbandonedCart.updateOne({ _id: cart._id }, {
        $set: { status: nextStatus, lastRemindedAt: new Date() },
        $inc: { manualEmailsSent: 1 },
      });
      if (req.headers && (req.headers.accept || '').includes('application/json')) {
        return res.json({ ok: true, status: nextStatus });
      }
      return res.redirect('/admin/activite-panier');
    }
    return res.status(500).json({ ok: false, error: `Échec envoi: ${result && result.reason ? result.reason : 'erreur inconnue'}` });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /admin/api/leads/:id/email — envoie un email custom.
 * Body: { subject, body, templateKey?, includeCartCta? }
 *
 * Le sujet et le corps subissent un remplacement de variables côté serveur
 * (sécurité : on ne fait pas confiance à ce qui vient du front).
 */
async function postLeadSendEmail(req, res, next) {
  try {
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ ok: false, error: 'DB indisponible.' });
    const id = req.params.id;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ ok: false, error: 'ID invalide.' });

    const cart = await AbandonedCart.findById(id).lean();
    if (!cart) return res.status(404).json({ ok: false, error: 'Lead non trouvé.' });
    if (!cart.email) return res.status(400).json({ ok: false, error: 'Pas d’email enregistré.' });

    const rawSubject = String((req.body && req.body.subject) || '').trim().slice(0, 200);
    const rawBody = String((req.body && req.body.body) || '').trim().slice(0, 8000);
    const templateKey = String((req.body && req.body.templateKey) || '').trim().slice(0, 60);
    const includeCartCta = req.body && req.body.includeCartCta === true;
    if (!rawSubject || !rawBody) return res.status(400).json({ ok: false, error: 'Sujet et message requis.' });

    const admin = getAdminFromReq(req);
    const vars = buildLeadVariables({ lead: cart, req, adminName: admin.name });

    const finalSubject = applyVariables(rawSubject, vars);
    const finalBody = applyVariables(rawBody, vars);

    const html = renderEmailHtml({
      subject: finalSubject,
      body: finalBody,
      vars,
      ctaUrl: includeCartCta ? vars.lien_panier : '',
    });
    const text = renderEmailText({ body: finalBody, vars });

    const sendResult = await sendEmail({
      toEmail: cart.email,
      subject: finalSubject,
      html,
      text,
      replyTo: admin.email ? { email: admin.email, name: admin.name } : undefined,
    });

    if (!sendResult || !sendResult.ok) {
      return res.status(502).json({ ok: false, error: `Échec envoi email: ${sendResult && sendResult.reason ? sendResult.reason : 'inconnu'}` });
    }

    const now = new Date();
    const noteLabel = templateKey ? ` [${templateKey}]` : '';
    await AbandonedCart.updateOne({ _id: cart._id }, {
      $set: { lastManualContactAt: now },
      $inc: { manualEmailsSent: 1 },
      $push: { notes: { text: `📧 Email envoyé${noteLabel} : "${finalSubject}"`, addedBy: admin.id, addedByName: admin.name, addedAt: now } },
    });

    return res.json({ ok: true, sentTo: cart.email });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /admin/api/leads/:id/email/preview — retourne l'HTML final qui sera envoyé.
 * Body: { subject, body, includeCartCta? }
 */
async function postLeadEmailPreview(req, res, next) {
  try {
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ ok: false, error: 'DB indisponible.' });
    const id = req.params.id;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ ok: false, error: 'ID invalide.' });
    const cart = await AbandonedCart.findById(id).lean();
    if (!cart) return res.status(404).json({ ok: false, error: 'Lead non trouvé.' });

    const rawSubject = String((req.body && req.body.subject) || '').trim().slice(0, 200);
    const rawBody = String((req.body && req.body.body) || '').trim().slice(0, 8000);
    const includeCartCta = req.body && req.body.includeCartCta === true;

    const admin = getAdminFromReq(req);
    const vars = buildLeadVariables({ lead: cart, req, adminName: admin.name });

    const finalSubject = applyVariables(rawSubject, vars);
    const finalBody = applyVariables(rawBody, vars);
    const previewHtml = renderEmailHtml({ subject: finalSubject, body: finalBody, vars, ctaUrl: includeCartCta ? vars.lien_panier : '' });

    return res.json({
      ok: true,
      subject: finalSubject,
      previewHtml,
      variables: {
        prenom: vars.prenom,
        nom: vars.nom,
        nom_produit: vars.nom_produit,
        prix_total: vars.prix_total,
        lien_panier: vars.lien_panier,
        lien_produit: vars.lien_produit,
        nom_commercial: vars.nom_commercial,
        brand: vars.brand,
        telephone: vars.telephone,
      },
    });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /admin/api/leads/:id/sms — envoie un SMS.
 * Body: { text, templateKey? }
 *
 * Les variables {prenom}, {lien_panier}, etc. sont remplacées côté serveur.
 */
async function postLeadSendSms(req, res, next) {
  try {
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ ok: false, error: 'DB indisponible.' });
    const id = req.params.id;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ ok: false, error: 'ID invalide.' });

    const cart = await AbandonedCart.findById(id).lean();
    if (!cart) return res.status(404).json({ ok: false, error: 'Lead non trouvé.' });
    if (!cart.phone) return res.status(400).json({ ok: false, error: 'Pas de téléphone enregistré.' });
    const phoneFR = normalizePhoneFR(cart.phone);
    if (!phoneFR) return res.status(400).json({ ok: false, error: 'Téléphone invalide ou non français.' });

    const rawText = String((req.body && req.body.text) || '').trim().slice(0, 480);
    const templateKey = String((req.body && req.body.templateKey) || '').trim().slice(0, 60);
    if (!rawText) return res.status(400).json({ ok: false, error: 'Message requis.' });

    const admin = getAdminFromReq(req);
    const vars = buildLeadVariables({ lead: cart, req, adminName: admin.name });
    const finalText = applyVariables(rawText, vars).slice(0, 480);

    const sendResult = await sendSms({ to: phoneFR, text: finalText });
    if (!sendResult || !sendResult.ok) {
      return res.status(502).json({ ok: false, error: `Échec envoi SMS: ${sendResult && sendResult.reason ? sendResult.reason : 'inconnu'}` });
    }

    const now = new Date();
    const noteLabel = templateKey ? ` [${templateKey}]` : '';
    await AbandonedCart.updateOne({ _id: cart._id }, {
      $set: { lastManualContactAt: now },
      $inc: { manualSmsSent: 1 },
      $push: { notes: { text: `📱 SMS envoyé${noteLabel} : "${finalText.slice(0, 120)}${finalText.length > 120 ? '…' : ''}"`, addedBy: admin.id, addedByName: admin.name, addedAt: now } },
    });

    return res.json({ ok: true, sentTo: phoneFR });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /admin/api/leads/:id/status — set/clear manualStatus.
 * Body: { status: 'contacted' | 'converted' | 'lost' | null }
 */
async function postLeadSetStatus(req, res, next) {
  try {
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ ok: false, error: 'DB indisponible.' });
    const id = req.params.id;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ ok: false, error: 'ID invalide.' });

    const cart = await AbandonedCart.findById(id).select('_id email').lean();
    if (!cart) return res.status(404).json({ ok: false, error: 'Lead non trouvé.' });

    const raw = (req.body && req.body.status);
    const status = raw === null || raw === '' ? null : String(raw).trim();
    const allowed = [null, 'contacted', 'converted', 'lost'];
    if (!allowed.includes(status)) return res.status(400).json({ ok: false, error: 'Statut invalide.' });

    const admin = getAdminFromReq(req);
    const now = new Date();
    const update = {
      $set: {
        manualStatus: status,
        manualStatusBy: status ? admin.id : null,
        manualStatusByName: status ? admin.name : '',
        manualStatusAt: status ? now : null,
        lastActivityAt: now,
      },
      $push: {
        notes: {
          text: status
            ? `Statut → ${status === 'contacted' ? 'Contacté' : status === 'converted' ? 'Converti' : 'Perdu'}`
            : 'Statut manuel retiré',
          addedBy: admin.id,
          addedByName: admin.name,
          addedAt: now,
        },
      },
    };

    if (status === 'converted') update.$set.recoveredAt = now;

    await AbandonedCart.updateOne({ _id: cart._id }, update);
    return res.json({ ok: true, manualStatus: status });
  } catch (err) {
    return next(err);
  }
}

/**
 * POST /admin/api/leads/:id/note — ajoute une note libre.
 * Body: { text }
 */
async function postLeadAddNote(req, res, next) {
  try {
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ ok: false, error: 'DB indisponible.' });
    const id = req.params.id;
    if (!id || !mongoose.Types.ObjectId.isValid(id)) return res.status(400).json({ ok: false, error: 'ID invalide.' });
    const text = String((req.body && req.body.text) || '').trim().slice(0, 2000);
    if (!text) return res.status(400).json({ ok: false, error: 'Texte requis.' });

    const admin = getAdminFromReq(req);
    const now = new Date();
    const result = await AbandonedCart.updateOne(
      { _id: id },
      { $push: { notes: { text, addedBy: admin.id, addedByName: admin.name, addedAt: now } }, $set: { lastActivityAt: now } }
    );
    if (!result.matchedCount) return res.status(404).json({ ok: false, error: 'Lead non trouvé.' });
    return res.json({ ok: true });
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /admin/api/leads/templates — retourne les templates email + SMS au front.
 */
function getAdminLeadTemplates(req, res) {
  return res.json({
    ok: true,
    email: EMAIL_TEMPLATES.map((t) => ({ key: t.key, label: t.label, subject: t.subject, body: t.body, forSource: t.forSource || [] })),
    sms: SMS_TEMPLATES.map((t) => ({ key: t.key, label: t.label, body: t.body })),
  });
}

module.exports = {
  // page principale
  getAdminLeadsPage,
  getAdminLeadDetail,
  // actions
  postAdminManualReminder,
  postLeadSendEmail,
  postLeadEmailPreview,
  postLeadSendSms,
  postLeadSetStatus,
  postLeadAddNote,
  getAdminLeadTemplates,
  // legacy aliases (pour rétro-compat des routes existantes)
  getAdminAbandonedCartsPage: getAdminLeadsPage,
  getAdminAbandonedCartDetail: getAdminLeadDetail,
};
