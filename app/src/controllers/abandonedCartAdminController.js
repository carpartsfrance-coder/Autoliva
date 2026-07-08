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
    landing_moteurs: { label: 'Moteur occasion', className: 'bg-red-50 text-red-700' },
    landing_boites: { label: 'Boîte occasion', className: 'bg-red-50 text-red-700' },
    cart_activity: { label: 'Panier', className: 'bg-slate-100 text-slate-700' },
    blog_cta: { label: 'Article blog', className: 'bg-emerald-50 text-emerald-700' },
    manual: { label: 'Manuel', className: 'bg-yellow-50 text-yellow-700' },
  };
  return labels[captureSource] || { label: captureSource || '—', className: 'bg-slate-100 text-slate-500' };
}

/**
 * Leads capturés par les tunnels devis moteur/boîte : ils ont leur PROPRE
 * pipeline (/admin/devis-moteurs — devis envoyé, relances auto J+3/J+7,
 * acompte…). La vue « À traiter » de la page leads les exclut pour ne pas
 * traiter deux fois le même client dans deux écrans.
 */
const ENGINE_PIPELINE_SOURCES = ['landing_moteurs', 'landing_boites'];

/**
 * Sources qui ne représentent PAS un panier : la relance « votre commande en
 * cours » (emails panier 1/2/3) ne doit jamais leur être envoyée — ce sont des
 * demandes de devis/contact, déjà suivies par leur propre canal.
 * Doit rester aligné avec l'exclusion du cron (sendAbandonedCartReminders).
 */
const NON_CART_SOURCES = ['landing_moteurs', 'landing_boites', 'contact', 'devis', 'blog_cta'];

/** Statuts de commande = vraie vente (exclut brouillons/annulées/remboursées). */
const SALE_STATUSES = ['paid', 'processing', 'label_created', 'shipped', 'delivered', 'completed'];

/**
 * « 360° client » : pour un lot de leads {id, email, phone}, retrouve en
 * requêtes GROUPÉES (pas par lead) les commandes passées et les tickets SAV
 * du même client — matché par email (compte User / client SAV) ET par
 * téléphone (adresses de commande, regex tolérante aux formats).
 * Retourne Map(leadId → { orders: [...], tickets: [...] }).
 */
async function buildClientHistoryMaps(leadsLite) {
  const result = new Map();
  try {
    const User = require('../models/User');
    const Order = require('../models/Order');
    const SavTicket = require('../models/SavTicket');
    const { phoneLooseRegex } = require('../services/leadCapture');

    const items = (leadsLite || []).filter((l) => l && (l.email || l.phone));
    if (!items.length) return result;

    const emails = Array.from(new Set(items.map((l) => String(l.email || '').trim().toLowerCase()).filter(Boolean)));
    const phoneE164ByLead = new Map();
    items.forEach((l) => { const e = normalizePhoneFR(l.phone || ''); if (e) phoneE164ByLead.set(String(l.id), e); });
    const uniquePhones = Array.from(new Set(Array.from(phoneE164ByLead.values())));
    const phoneRegexes = uniquePhones.map((e) => phoneLooseRegex(e)).filter(Boolean);

    /* Comptes clients par email → userIds */
    const users = emails.length ? await User.find({ email: { $in: emails } }).select('_id email').lean() : [];
    const emailByUserId = new Map(users.map((u) => [String(u._id), String(u.email || '').toLowerCase()]));
    const userIds = users.map((u) => u._id);

    /* Commandes (par compte OU par téléphone d'adresse) */
    const orConds = [];
    if (userIds.length) orConds.push({ userId: { $in: userIds } });
    if (phoneRegexes.length) {
      orConds.push({ 'shippingAddress.phone': { $in: phoneRegexes } });
      orConds.push({ 'billingAddress.phone': { $in: phoneRegexes } });
    }
    const orders = orConds.length ? await Order.find({
      $or: orConds,
      status: { $in: SALE_STATUSES },
      deletedAt: null,
    })
      .select('_id number status createdAt totalCents userId items.name shippingAddress.phone billingAddress.phone')
      .sort({ createdAt: -1 })
      .limit(300)
      .lean() : [];

    const ordersByEmail = new Map();
    const ordersByPhone = new Map();
    for (const o of orders) {
      const em = emailByUserId.get(String(o.userId || ''));
      if (em) { if (!ordersByEmail.has(em)) ordersByEmail.set(em, []); ordersByEmail.get(em).push(o); }
      [o.shippingAddress && o.shippingAddress.phone, o.billingAddress && o.billingAddress.phone]
        .filter(Boolean)
        .forEach((p) => {
          const e = normalizePhoneFR(p);
          if (e) { if (!ordersByPhone.has(e)) ordersByPhone.set(e, []); ordersByPhone.get(e).push(o); }
        });
    }

    /* Tickets SAV (par email OU téléphone client) */
    const savOr = [];
    if (emails.length) savOr.push({ 'client.email': { $in: emails } });
    if (phoneRegexes.length) savOr.push({ 'client.telephone': { $in: phoneRegexes } });
    const tickets = savOr.length ? await SavTicket.find({ $or: savOr })
      .select('numero statut createdAt client.email client.telephone')
      .sort({ createdAt: -1 })
      .limit(200)
      .lean() : [];

    const ticketsByEmail = new Map();
    const ticketsByPhone = new Map();
    for (const t of tickets) {
      const em = String((t.client && t.client.email) || '').toLowerCase();
      if (em) { if (!ticketsByEmail.has(em)) ticketsByEmail.set(em, []); ticketsByEmail.get(em).push(t); }
      const e = normalizePhoneFR((t.client && t.client.telephone) || '');
      if (e) { if (!ticketsByPhone.has(e)) ticketsByPhone.set(e, []); ticketsByPhone.get(e).push(t); }
    }

    /* Attribution par lead (dédup par _id, tri récent d'abord) */
    for (const l of items) {
      const em = String(l.email || '').trim().toLowerCase();
      const pe = phoneE164ByLead.get(String(l.id)) || '';
      const dedup = (lists) => {
        const seen = new Set(); const out = [];
        lists.forEach((arr) => (arr || []).forEach((x) => { const k = String(x._id); if (!seen.has(k)) { seen.add(k); out.push(x); } }));
        out.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
        return out;
      };
      const myOrders = dedup([em && ordersByEmail.get(em), pe && ordersByPhone.get(pe)]);
      const myTickets = dedup([em && ticketsByEmail.get(em), pe && ticketsByPhone.get(pe)]);
      if (myOrders.length || myTickets.length) result.set(String(l.id), { orders: myOrders, tickets: myTickets });
    }
  } catch (err) {
    console.error('[leads] enrichissement 360° client échoué:', err && err.message ? err.message : err);
  }
  return result;
}

/** Un ticket SAV est « en cours » tant que son statut ne commence pas par clos/resolu/rembourse. */
function isSavTicketOpen(statut) {
  return !/^(clos|resolu|rembours)/.test(String(statut || ''));
}

/**
 * Badge de statut du pipeline devis moteur/boîte : sur ces leads, le statut
 * pertinent est engineQuote.status (pas le cycle « panier abandonné », qui
 * affichait « Abandonné » même après l'envoi d'un devis ou un acompte payé).
 */
function getEngineQuoteBadge(engineStatus) {
  const badges = {
    new: { label: 'Devis à traiter', className: 'bg-indigo-50 text-indigo-700' },
    analyzing: { label: 'En analyse', className: 'bg-blue-50 text-blue-700' },
    quote_sent: { label: 'Devis envoyé', className: 'bg-amber-50 text-amber-700' },
    acompte_recu: { label: 'Acompte reçu', className: 'bg-green-100 text-green-800' },
    won: { label: 'Gagné', className: 'bg-green-100 text-green-800' },
    lost: { label: 'Perdu', className: 'bg-slate-200 text-slate-600' },
  };
  return badges[engineStatus] || null;
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

    /* Vue « À traiter » (défaut) = file de travail : jamais contactés, cycle
       non terminé, HORS leads devis moteur/boîte (ils ont leur propre pipeline
       dans /admin/devis-moteurs — les afficher ici faisait traiter deux fois
       le même client). Un filtre explicitement incompatible (statut manuel,
       source moteur/boîte, statut recovered/expired) bascule sur « Tous ». */
    let view = req.query.view === 'all' ? 'all' : 'todo';
    if (manualStatusFilter && manualStatusFilter !== 'none') view = 'all';
    if (status && ['recovered', 'expired'].includes(status)) view = 'all';
    if (captureSource && ENGINE_PIPELINE_SOURCES.includes(captureSource)) view = 'all';

    const perPage = 30;
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);

    /* Query-string canonique (noms de paramètres = ceux lus ci-dessus) pour
       la pagination et les onglets — l'ancienne pagination sérialisait les
       clés internes (manualStatus/captureSource) que le serveur ne lisait pas. */
    const qsParams = {};
    if (q) qsParams.q = q;
    if (status) qsParams.status = status;
    if (manualStatusFilter) qsParams.manual = manualStatusFilter;
    if (captureSource) qsParams.source = captureSource;
    if (channel) qsParams.channel = channel;
    if (period && period !== '30d') qsParams.period = period;
    if (sort && sort !== 'recent') qsParams.sort = sort;
    const filtersQS = new URLSearchParams(Object.assign({}, qsParams, view === 'all' ? { view: 'all' } : {})).toString();
    /* Onglet « À traiter » : on retire les filtres incompatibles avec la vue */
    const todoParams = Object.assign({}, qsParams);
    delete todoParams.manual;
    if (todoParams.status && ['recovered', 'expired'].includes(todoParams.status)) delete todoParams.status;
    if (todoParams.source && ENGINE_PIPELINE_SOURCES.includes(todoParams.source)) delete todoParams.source;
    const todoQS = new URLSearchParams(todoParams).toString();
    const allQS = new URLSearchParams(Object.assign({}, qsParams, { view: 'all' })).toString();

    const baseRender = (overrides = {}) => res.render('admin/cart-activity', Object.assign({
      title: 'Admin - Leads à relancer',
      dbConnected,
      leads: [],
      kpis: { total: 0, uncontacted: 0, contacted: 0, converted: 0, pendingValueCents: 0, recoveryRate: '0' },
      filters: { status, manualStatus: manualStatusFilter, captureSource, channel, period, q, sort },
      view,
      filtersQS,
      tabs: { todoCount: 0, allCount: 0, todoUrl: '/admin/activite-panier' + (todoQS ? '?' + todoQS : ''), allUrl: '/admin/activite-panier?' + allQS },
      pagination: { page: 1, perPage, totalItems: 0, totalPages: 1, from: 0, to: 0, hasPrev: false, hasNext: false, prevPage: 1, nextPage: 1 },
      emailTemplates: EMAIL_TEMPLATES.map((t) => ({ key: t.key, label: t.label, subject: t.subject, body: t.body, forSource: t.forSource || [], defaultIncludeCta: t.defaultIncludeCta !== false })),
      smsTemplates: SMS_TEMPLATES.map((t) => ({ key: t.key, label: t.label, body: t.body, forSource: t.forSource || [] })),
    }, overrides));

    if (!dbConnected) return baseRender();

    /* Construction du filtre principal */
    const query = {};

    const allowedStatuses = new Set(['abandoned', 'reminded_1', 'reminded_2', 'reminded_3', 'recovered', 'expired']);
    if (status && allowedStatuses.has(status)) query.status = status;

    if (manualStatusFilter === 'none') query.manualStatus = null;
    else if (['contacted', 'converted', 'lost'].includes(manualStatusFilter)) query.manualStatus = manualStatusFilter;

    const allowedSources = new Set(['user', 'guest_checkout', 'newsletter', 'contact', 'devis', 'landing_moteurs', 'landing_boites', 'cart_activity', 'blog_cta', 'manual']);
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

    /* Filtres utilisateur seuls (pour compter les onglets), puis contraintes
       de la vue « À traiter » appliquées par-dessus. */
    const commonQuery = Object.assign({}, query);
    const todoOverlay = {
      manualStatus: null,
      status: commonQuery.status || { $nin: ['recovered', 'expired'] },
      captureSource: commonQuery.captureSource || { $nin: ENGINE_PIPELINE_SOURCES },
    };
    if (view === 'todo') Object.assign(query, todoOverlay);

    /* Tri */
    let sortSpec;
    if (sort === 'amount') sortSpec = { totalAmountCents: -1, lastActivityAt: -1 };
    else if (sort === 'oldest') sortSpec = { lastActivityAt: 1 };
    else sortSpec = { lastActivityAt: -1 };

    /* KPIs (toujours sur 30j, pas filtrés) — HORS leads devis moteur/boîte :
       ils ont leurs propres stats dans /admin/devis-moteurs, les compter ici
       gonflait « À contacter » avec des clients déjà en cours de devis. */
    const kpiSince = new Date();
    kpiSince.setDate(kpiSince.getDate() - 30);
    const kpiBase = { lastActivityAt: { $gte: kpiSince }, captureSource: { $nin: ENGINE_PIPELINE_SOURCES } };

    const [totalAll, uncontactedAll, contactedAll, convertedAll, pendingAggregate, todoCount, allCount] = await Promise.all([
      AbandonedCart.countDocuments(Object.assign({}, kpiBase)),
      AbandonedCart.countDocuments(Object.assign({}, kpiBase, { manualStatus: null, status: { $nin: ['recovered', 'expired'] } })),
      AbandonedCart.countDocuments(Object.assign({}, kpiBase, { manualStatus: 'contacted' })),
      AbandonedCart.countDocuments(Object.assign({}, kpiBase, { $or: [{ manualStatus: 'converted' }, { status: 'recovered' }] })),
      AbandonedCart.aggregate([
        { $match: Object.assign({}, kpiBase, { manualStatus: { $ne: 'converted' }, status: { $nin: ['recovered', 'expired'] } }) },
        { $group: { _id: null, total: { $sum: '$totalAmountCents' } } },
      ]),
      /* Compteurs des onglets (respectent les filtres actifs) */
      AbandonedCart.countDocuments(Object.assign({}, commonQuery, todoOverlay)),
      AbandonedCart.countDocuments(commonQuery),
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

    /* Nombre de relances AUTO déjà parties, déduit du statut du cycle */
    const REMINDERS_SENT_BY_STATUS = { abandoned: 0, reminded_1: 1, reminded_2: 2, reminded_3: 3, expired: 3, recovered: 0 };

    const leads = rawLeads.map((c) => {
      const items = Array.isArray(c.items) ? c.items : [];
      const phoneFR = normalizePhoneFR(c.phone || '');
      const fullName = ((c.firstName || '') + ' ' + (c.lastName || '')).trim();
      const requested = c.requested || {};
      /* Demande explicite = formulaires devis/contact ET tunnels moteur/boîte
         (leur `requested` est l'info primaire ; sans ça un lead moteur sans
         panier affichait « 0,00 € » au lieu de sa demande) */
      const isExplicitRequest = ['devis', 'contact', 'landing_moteurs', 'landing_boites'].includes(c.captureSource || '');
      const hasRequested = !!(requested.vehicle || requested.vin || requested.plate || requested.ref || requested.message);

      /* ── Données « suivi commercial » (timeline de la carte) ── */
      const notesArr = Array.isArray(c.notes) ? c.notes : [];
      const lastNoteRaw = notesArr.length ? notesArr[notesArr.length - 1] : null;
      const autoApplicable = !NON_CART_SOURCES.includes(c.captureSource || '') && items.length > 0;
      const neverTouched = !c.manualStatus && !(c.manualEmailsSent > 0) && !(c.manualSmsSent > 0) && !c.lastManualContactAt;
      /* Priorité visuelle : à appeler (rouge) > en cours (bleu) > gagné (vert) > perdu (gris) > relances auto seules (ambre).
         Leads moteur/boîte : dérivée du pipeline devis (un « Acompte reçu » est gagné, pas « à appeler »). */
      const engStatus = (ENGINE_PIPELINE_SOURCES.includes(c.captureSource || '') && c.engineQuote && c.engineQuote.status) ? c.engineQuote.status : '';
      let priority;
      if (engStatus) {
        priority = (engStatus === 'won' || engStatus === 'acompte_recu') ? 'won' : (engStatus === 'lost') ? 'lost' : 'inprogress';
      } else if (c.manualStatus === 'converted' || c.status === 'recovered') priority = 'won';
      else if (c.manualStatus === 'lost') priority = 'lost';
      else if (c.manualStatus === 'contacted' || !neverTouched) priority = 'inprogress';
      else if (REMINDERS_SENT_BY_STATUS[c.status] > 0) priority = 'auto';
      else priority = 'call';

      /* Construction d'un résumé "demande explicite" pour les leads devis/contact */
      const requestSummary = (() => {
        const parts = [];
        if (requested.ref) parts.push(requested.ref);
        if (requested.vehicle) parts.push(requested.vehicle);
        if (requested.vin) parts.push(`VIN ${requested.vin}`);
        else if (requested.plate) parts.push(requested.plate);
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
          vehicle: requested.vehicle || '',
          vin: requested.vin || '',
          plate: requested.plate || '',
          ref: requested.ref || '',
          message: requested.message || '',
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
        /* Leads devis moteur/boîte : le badge reflète le pipeline devis
           (Devis envoyé, Acompte reçu…) au lieu du cycle panier abandonné. */
        statusBadge: (ENGINE_PIPELINE_SOURCES.includes(c.captureSource || '') && c.engineQuote && c.engineQuote.status && getEngineQuoteBadge(c.engineQuote.status))
          || getStatusBadge(c.status, c.manualStatus),
        engineQuoteUrl: (ENGINE_PIPELINE_SOURCES.includes(c.captureSource || '') && c.engineQuote) ? ('/admin/devis-moteurs/' + String(c._id)) : '',
        lastActivityRel: formatRelative(c.lastActivityAt || c.abandonedAt),
        lastActivityAbsolute: formatDateTimeFR(c.lastActivityAt || c.abandonedAt),
        lastRemindedAt: formatDateTimeFR(c.lastRemindedAt),
        lastManualContactAt: formatDateTimeFR(c.lastManualContactAt),
        manualEmailsSent: c.manualEmailsSent || 0,
        manualSmsSent: c.manualSmsSent || 0,
        contextMessage: c.contextMessage || '',
        attribution: c.attribution || {},
        notes: notesArr,
        canRemind: ['abandoned', 'reminded_1', 'reminded_2'].includes(c.status) && !c.manualStatus
          && !NON_CART_SOURCES.includes(c.captureSource || '') && items.length > 0,
        recoveryToken: c.recoveryToken || '',

        /* ── Suivi commercial (timeline de la carte) ── */
        priority,                                     // 'call' | 'inprogress' | 'won' | 'lost' | 'auto'
        neverTouched,
        receivedRel: formatRelative(c.abandonedAt || c.createdAt),
        autoReminders: {
          applicable: autoApplicable,
          sent: REMINDERS_SENT_BY_STATUS[c.status] || 0,
          lastRel: c.lastRemindedAt ? formatRelative(c.lastRemindedAt) : '',
          cycleDone: c.status === 'expired',
        },
        lastManualContactRel: c.lastManualContactAt ? formatRelative(c.lastManualContactAt) : '',
        manualStatusByName: c.manualStatusByName || '',
        manualStatusAtRel: c.manualStatusAt ? formatRelative(c.manualStatusAt) : '',
        notesCount: notesArr.length,
        lastNote: lastNoteRaw ? {
          text: String(lastNoteRaw.text || '').slice(0, 110),
          by: lastNoteRaw.addedByName || 'Admin',
          atRel: lastNoteRaw.addedAt ? formatRelative(lastNoteRaw.addedAt) : '',
        } : null,
        nextReminderNumber: { abandoned: 1, reminded_1: 2, reminded_2: 3 }[c.status] || 0,
        /* Commande rapprochée automatiquement (badge « A commandé ») */
        recoveredOrderBadge: (c.recoveredOrder && c.recoveredOrder.orderId) ? {
          number: c.recoveredOrder.number || '',
          totalEuro: c.recoveredOrder.totalCents > 0 ? formatEuro(c.recoveredOrder.totalCents) : '',
          atRel: c.recoveredOrder.at ? formatRelative(c.recoveredOrder.at) : '',
          url: '/admin/commandes/' + String(c.recoveredOrder.orderId),
        } : null,
        repurchaseSentRel: (c.repurchaseReminder && c.repurchaseReminder.sentAt) ? formatRelative(c.repurchaseReminder.sentAt) : '',
      };
    });

    /* ── 360° client : commandes passées + tickets SAV du même client
       (email OU téléphone), en requêtes groupées pour toute la page ── */
    const historyMap = await buildClientHistoryMaps(leads.map((l) => ({ id: l.id, email: l.email, phone: l.phone })));
    leads.forEach((l) => {
      const h = historyMap.get(l.id);
      if (!h) return;
      if (h.orders.length) {
        const last = h.orders[0];
        l.clientHistory = {
          count: h.orders.length,
          lastRel: formatRelative(last.createdAt),
          lastUrl: '/admin/commandes/' + String(last._id),
          title: h.orders.slice(0, 4).map((o) => 'n°' + (o.number || '?') + ' · ' + formatDateTimeFR(o.createdAt) + ' · ' + formatEuro(o.totalCents)).join('\n')
            + (h.orders.length > 4 ? '\n… +' + (h.orders.length - 4) + ' autre(s)' : '')
            + '\n(cliquer = ouvrir la dernière commande · le détail complet est dans « Détail & notes »)',
        };
      }
      if (h.tickets.length) {
        const open = h.tickets.filter((t) => isSavTicketOpen(t.statut));
        const last = h.tickets[0];
        l.savHistory = {
          count: h.tickets.length,
          openCount: open.length,
          lastStatut: (last.statut || '').replace(/_/g, ' '),
          url: '/admin/sav/tickets/' + encodeURIComponent(last.numero || ''),
          title: h.tickets.slice(0, 4).map((t) => (t.numero || '?') + ' · ' + String(t.statut || '').replace(/_/g, ' ')).join('\n'),
        };
      }
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
      tabs: {
        todoCount,
        allCount,
        todoUrl: '/admin/activite-panier' + (todoQS ? '?' + todoQS : ''),
        allUrl: '/admin/activite-panier?' + allQS,
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

    /* 360° client : commandes + SAV de ce client (email OU téléphone) */
    const historyMap = await buildClientHistoryMaps([{ id: String(cart._id), email: cart.email, phone: cart.phone }]);
    const hist = historyMap.get(String(cart._id)) || { orders: [], tickets: [] };
    const ORDER_STATUS_FR = { paid: 'Payée', processing: 'En préparation', label_created: 'Étiquette créée', shipped: 'Expédiée', delivered: 'Livrée', completed: 'Terminée' };

    const requested = cart.requested || {};
    return res.json({
      ok: true,
      cart: {
        clientOrders: hist.orders.map((o) => ({
          number: o.number || '',
          url: '/admin/commandes/' + String(o._id),
          date: formatDateTimeFR(o.createdAt),
          totalEuro: formatEuro(o.totalCents),
          status: ORDER_STATUS_FR[o.status] || o.status || '',
          products: (o.items || []).map((i) => i && i.name).filter(Boolean).slice(0, 3).join(', ')
            + ((o.items || []).length > 3 ? ' +' + ((o.items || []).length - 3) : ''),
        })),
        savTickets: hist.tickets.map((t) => ({
          numero: t.numero || '',
          statut: String(t.statut || '').replace(/_/g, ' '),
          open: isSavTicketOpen(t.statut),
          date: formatDateTimeFR(t.createdAt),
          url: '/admin/sav/tickets/' + encodeURIComponent(t.numero || ''),
        })),
        id: String(cart._id),
        sessionId: cart.sessionId,
        email: cart.email,
        phone: cart.phone,
        firstName: cart.firstName,
        lastName: cart.lastName,
        captureSource: cart.captureSource,
        captureSourceLabel: getCaptureSourceLabel(cart.captureSource).label,
        requested: {
          vehicle: requested.vehicle || '',
          vin: requested.vin || '',
          plate: requested.plate || '',
          ref: requested.ref || '',
          message: requested.message || '',
        },
        hasRequested: !!(requested.vehicle || requested.vin || requested.plate || requested.ref || requested.message),
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

    // Garde-fou : ne PAS envoyer la relance PANIER (« votre commande en cours »)
    // à un lead qui n'en est pas un — devis moteur/boîte, formulaire
    // contact/devis, CTA blog — ni à un panier vide. Sinon le client reçoit un
    // mail absurde alors qu'il n'a jamais rien commandé. Même exclusion que le
    // cron (sendAbandonedCartReminders).
    if (NON_CART_SOURCES.includes(cart.captureSource) || !(cart.items && cart.items.length)) {
      return res.status(400).json({
        ok: false,
        error: 'Ce lead n’est pas un panier (demande de devis / panier vide) : la relance « commande en cours » n’est pas adaptée.',
      });
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

    /* Garde-fou anti-lien : l'expéditeur SMS est alphanumérique (« CarParts »),
       et les opérateurs FR jettent SILENCIEUSEMENT les SMS contenant une URL.
       Brevo répond 201 « envoyé » mais le client ne reçoit rien → on refuse
       l'envoi plutôt que de logger un faux « SMS envoyé ». Le lien part par email. */
    if (/https?:\/\/|www\.[a-z0-9-]+\.[a-z]{2,}|\b[a-z0-9-]{2,}\.(?:fr|com|net|org|eu|io|co|shop|store)\b/i.test(finalText)) {
      return res.status(400).json({ ok: false, error: 'Un lien dans un SMS « CarParts » est bloqué par les opérateurs (le client ne le recevrait pas). Retire le lien — envoie-le plutôt par email.' });
    }

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
    /* NB : on ne touche PAS lastActivityAt ici — ce champ trace l'activité du
       CLIENT (tri de la liste). Le bumper sur une action admin faisait
       remonter le lead en tête de liste à chaque changement de statut. */
    const update = {
      $set: {
        manualStatus: status,
        manualStatusBy: status ? admin.id : null,
        manualStatusByName: status ? admin.name : '',
        manualStatusAt: status ? now : null,
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
    /* Pas de bump lastActivityAt : une note interne ne doit pas faire
       remonter le lead en tête de liste (tri = activité CLIENT). */
    const result = await AbandonedCart.updateOne(
      { _id: id },
      { $push: { notes: { text, addedBy: admin.id, addedByName: admin.name, addedAt: now } } }
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
    email: EMAIL_TEMPLATES.map((t) => ({ key: t.key, label: t.label, subject: t.subject, body: t.body, forSource: t.forSource || [], defaultIncludeCta: t.defaultIncludeCta !== false })),
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
