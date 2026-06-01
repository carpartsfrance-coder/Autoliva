'use strict';

/**
 * Controller pour /admin/devis-moteurs — page dédiée au workflow commercial
 * sur les leads "Moteur d'occasion" (captureSource = 'landing_moteurs').
 *
 * Permet de :
 *   - Lister les devis avec statut, marge prévisionnelle, photos
 *   - Voir le détail d'un devis
 *   - Saisir : identification moteur, stock, tarification (marge auto)
 *   - Uploader photos (moteur, relevé km, banc d'essai)
 *   - Ajouter notes internes
 *   - Changer le statut workflow
 */

const mongoose = require('mongoose');
const AbandonedCart = require('../models/AbandonedCart');
const storage = require('../services/savFileStorage');
const emailService = require('../services/emailService');
const { buildQuotePdf } = require('../services/engineQuotePdf');
const { buildQuoteEmailHtml } = require('../services/engineQuoteEmail');
const { compressImage } = require('../services/imageCompress');
const mollie = require('../services/mollie');
const brand = require('../config/brand');

const MOLLIE_ENABLED = String(process.env.ENGINE_QUOTE_MOLLIE_ENABLED || '').toLowerCase() === 'true';

const STATUS_LABELS = {
  new:          { label: 'Nouveau',       className: 'bg-blue-50 text-blue-700 border border-blue-200' },
  analyzing:    { label: 'En analyse',    className: 'bg-amber-50 text-amber-700 border border-amber-200' },
  quote_sent:   { label: 'Devis envoyé',  className: 'bg-violet-50 text-violet-700 border border-violet-200' },
  acompte_recu: { label: 'Acompte reçu',  className: 'bg-teal-50 text-teal-700 border border-teal-200' },
  won:          { label: 'Gagné',         className: 'bg-emerald-50 text-emerald-700 border border-emerald-200' },
  lost:         { label: 'Perdu',         className: 'bg-rose-50 text-rose-700 border border-rose-200' },
};

const STOCK_LABELS = {
  atelier:       { label: 'En stock atelier',  className: 'bg-emerald-50 text-emerald-700' },
  sourcing:      { label: 'Sourcing réseau',   className: 'bg-blue-50 text-blue-700' },
  indisponible:  { label: 'Indisponible',      className: 'bg-rose-50 text-rose-700' },
};

// Libellé client-facing (utilisé dans email + PDF du devis)
// "Sourcing" interne devient "Sur commande" côté client (plus rassurant)
const STOCK_CLIENT_LABELS = {
  atelier:       'En stock dans notre atelier',
  sourcing:      'Sur commande',
  indisponible:  '',
};

// État du moteur — admin + client-facing
const CONDITION_LABELS = {
  '':                              { admin: 'Non spécifié',                client: '',                                short: '' },
  occasion:                        { admin: 'Occasion testé',              client: 'Moteur d\'occasion testé',         short: 'Occasion' },
  reconditionne_chemise_fonte:     { admin: 'Reconditionné chemisé fonte', client: 'Moteur reconditionné chemisé fonte', short: 'Reconditionné' },
  reconditionne_complet:           { admin: 'Reconditionné complet',       client: 'Moteur reconditionné complet',     short: 'Reconditionné' },
};

function fmt(n) {
  return new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0);
}

function calcMargin(p) {
  if (!p) return { marginEur: 0, marginPct: 0 };
  const sell = Number(p.sellPrice) || 0;
  const cost = (Number(p.purchasePrice) || 0) + (Number(p.additionalFees) || 0);
  const marginEur = sell - cost;
  const marginPct = sell > 0 ? (marginEur / sell) * 100 : 0;
  return { marginEur, marginPct };
}

function getMarginColor(pct) {
  if (pct >= 25) return 'text-emerald-700';
  if (pct >= 15) return 'text-amber-700';
  return 'text-rose-700';
}

function safeNumber(value, fallback = 0) {
  const n = Number(String(value || '').replace(',', '.'));
  return isNaN(n) ? fallback : n;
}

function getAdminInfo(req) {
  const a = req && req.session && req.session.admin ? req.session.admin : {};
  return {
    id: a.adminUserId ? new mongoose.Types.ObjectId(a.adminUserId) : null,
    name: a.displayName || a.email || 'Admin',
  };
}

/* ─── PAGE LISTE ──────────────────────────────────────────────────────── */

async function getEngineQuotesList(req, res, next) {
  try {
    const statusFilter = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    // Vue active (défaut) ou archivés. Les archivés sont sortis de la liste
    // active pour la désencombrer, mais restent consultables via le toggle.
    const view = req.query.view === 'archived' ? 'archived' : 'active';

    const query = { captureSource: 'landing_moteurs' };
    query.archived = view === 'archived' ? true : { $ne: true };
    if (statusFilter && STATUS_LABELS[statusFilter]) {
      query['engineQuote.status'] = statusFilter;
    }
    if (q) {
      const rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      query.$or = [
        { email: rx },
        { firstName: rx },
        { lastName: rx },
        { phone: rx },
        { 'requested.plate': rx },
        { 'requested.ref': rx },
        { 'engineQuote.identifiedEngine.code': rx },
        { 'engineQuote.identifiedEngine.model': rx },
      ];
    }

    const carts = await AbandonedCart.find(query)
      .sort({ lastActivityAt: -1 })
      .limit(200)
      .lean();

    const now = Date.now();
    const MS_DAY = 24 * 60 * 60 * 1000;

    const items = carts.map(c => {
      const eq = c.engineQuote || {};
      const margin = calcMargin(eq.pricing);
      const status = eq.status || 'new';
      const stock = (eq.stock && eq.stock.location) || '';
      const displayName = (c.firstName + ' ' + c.lastName).trim() || c.email || c.phone || '—';
      const receivedAt = c.lastActivityAt || c.createdAt;
      const ageDays = (now - new Date(receivedAt).getTime()) / MS_DAY;

      // Hot/Cold prioritization
      // Hot   = nouveau lead < 24h avec email + téléphone
      // Warm  = en analyse ou < 3j
      // Cold  = > 7j sans suivi (status new ou analyzing)
      let priority = '';
      if (status === 'new' && ageDays < 1 && c.email && c.phone) {
        priority = 'hot';
      } else if ((status === 'new' || status === 'analyzing') && ageDays > 7) {
        priority = 'cold';
      }

      return {
        id: String(c._id),
        ref: (c.requested && c.requested.ref) || '',
        plate: (c.requested && c.requested.plate) || '',
        vehicle: (c.requested && c.requested.vehicle) || '',
        displayName,
        email: c.email,
        phone: c.phone,
        receivedAt,
        ageDays,
        priority,
        status,
        statusBadge: STATUS_LABELS[status] || STATUS_LABELS.new,
        stockLabel: stock ? STOCK_LABELS[stock].label : '',
        stockClass: stock ? STOCK_LABELS[stock].className : '',
        identifiedEngineCode: (eq.identifiedEngine && eq.identifiedEngine.code) || '',
        identifiedEngineModel: (eq.identifiedEngine && eq.identifiedEngine.model) || '',
        marginEur: margin.marginEur,
        marginPct: margin.marginPct,
        marginColor: getMarginColor(margin.marginPct),
        sellPrice: (eq.pricing && eq.pricing.sellPrice) || 0,
        photoCount: ((eq.photos && eq.photos.engine) || []).length
          + ((eq.photos && eq.photos.kmReading) || []).length,
        sentQuoteCount: (eq.sentQuotes || []).length,
        lastSentAt: (eq.sentQuotes || []).length ? eq.sentQuotes[eq.sentQuotes.length - 1].sentAt : null,
        // Engagement du dernier devis envoyé (tracking ouverture / PDF / clic paiement)
        lastSentOpened: (eq.sentQuotes || []).length ? !!eq.sentQuotes[eq.sentQuotes.length - 1].openedAt : false,
        lastSentOpenCount: (eq.sentQuotes || []).length ? (eq.sentQuotes[eq.sentQuotes.length - 1].openCount || 0) : 0,
        lastSentPdfViewed: (eq.sentQuotes || []).length ? !!eq.sentQuotes[eq.sentQuotes.length - 1].pdfViewedAt : false,
        lastSentPayClicked: (eq.sentQuotes || []).length ? !!eq.sentQuotes[eq.sentQuotes.length - 1].payClickedAt : false,
      };
    });

    // Tri : hot en premier, puis par date desc
    items.sort((a, b) => {
      if (a.priority === 'hot' && b.priority !== 'hot') return -1;
      if (b.priority === 'hot' && a.priority !== 'hot') return 1;
      return new Date(b.receivedAt) - new Date(a.receivedAt);
    });

    // Aggrégats KPI
    const stats = {
      total: items.length,
      newCount: items.filter(i => i.status === 'new').length,
      analyzing: items.filter(i => i.status === 'analyzing').length,
      quoteSent: items.filter(i => i.status === 'quote_sent').length,
      won: items.filter(i => i.status === 'won').length,
      caExpected: items.filter(i => i.status === 'quote_sent').reduce((s, i) => s + i.sellPrice, 0),
      marginExpected: items.filter(i => i.status === 'quote_sent').reduce((s, i) => s + i.marginEur, 0),
    };

    // Compteur d'archivés (pour le badge du toggle), indépendant des filtres.
    const archivedCount = await AbandonedCart.countDocuments({
      captureSource: 'landing_moteurs',
      archived: true,
    });

    return res.render('admin/engine-quotes', {
      title: 'Devis moteurs · Admin',
      activeKey: 'engine-quotes',
      items,
      stats,
      filters: { status: statusFilter, q },
      view,
      archivedCount,
      statusLabels: STATUS_LABELS,
      fmt,
    });
  } catch (err) {
    return next(err);
  }
}

/* ─── PAGE DÉTAIL ─────────────────────────────────────────────────────── */

async function getEngineQuoteDetail(req, res, next) {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).render('errors/404');

    const cart = await AbandonedCart.findById(id).lean();
    if (!cart || cart.captureSource !== 'landing_moteurs') return res.status(404).render('errors/404');

    const eq = cart.engineQuote || {};
    const margin = calcMargin(eq.pricing);
    const status = eq.status || 'new';

    const displayName = (cart.firstName + ' ' + cart.lastName).trim() || cart.email || cart.phone || '—';

    return res.render('admin/engine-quote-detail', {
      title: `Devis ${cart.requested && cart.requested.ref || ''} · Admin`,
      activeKey: 'engine-quotes',
      cart: {
        id: String(cart._id),
        displayName,
        email: cart.email,
        phone: cart.phone,
        firstName: cart.firstName,
        lastName: cart.lastName,
        receivedAt: cart.lastActivityAt || cart.createdAt,
        archived: !!cart.archived,
        archivedAt: cart.archivedAt || null,
        archivedByName: cart.archivedByName || '',
        ref: (cart.requested && cart.requested.ref) || '',
        plate: (cart.requested && cart.requested.plate) || '',
        vehicle: (cart.requested && cart.requested.vehicle) || '',
        message: (cart.requested && cart.requested.message) || '',
        attribution: cart.attribution || {},
        notes: (cart.notes || []).slice().sort((a, b) => new Date(b.addedAt) - new Date(a.addedAt)),
      },
      engineQuote: {
        status,
        statusBadge: STATUS_LABELS[status] || STATUS_LABELS.new,
        identifiedEngine: eq.identifiedEngine || {},
        stock: eq.stock || {},
        pricing: eq.pricing || { purchasePrice: 0, additionalFees: 0, sellPrice: 0, vatRate: 20 },
        photos: eq.photos || { engine: [], kmReading: [] },
        margin,
        marginColor: getMarginColor(margin.marginPct),
        updatedAt: eq.updatedAt,
        updatedByName: eq.updatedByName,
        sentQuotes: (eq.sentQuotes || []).slice().sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt)),
        remindersSent: eq.remindersSent || [],
        payment: eq.payment || null,
      },
      mollieEnabled: MOLLIE_ENABLED,
      statusLabels: STATUS_LABELS,
      stockLabels: STOCK_LABELS,
      conditionLabels: CONDITION_LABELS,
      fmt,
    });
  } catch (err) {
    return next(err);
  }
}

/* ─── MUTATIONS ───────────────────────────────────────────────────────── */

function buildUpdate(req) {
  const admin = getAdminInfo(req);
  return {
    'engineQuote.updatedAt': new Date(),
    'engineQuote.updatedByName': admin.name,
  };
}

/**
 * Initialise engineQuote en sous-document vide s'il est null.
 * Indispensable : le schéma a `default: null`, donc sur les leads dont le
 * devis n'a jamais été touché (ou créés avant la feature), un
 * `$set: { 'engineQuote.x.y': ... }` échoue avec
 * « Cannot create field 'x' in element {engineQuote: null} » → 500.
 * On ne crée le sous-doc que s'il est null (idempotent, ne touche rien sinon).
 */
async function ensureEngineQuote(id) {
  await AbandonedCart.updateOne(
    { _id: id, captureSource: 'landing_moteurs', engineQuote: null },
    { $set: { engineQuote: {} } }
  );
}

function isAjax(req) {
  return req.xhr || req.get('X-Requested-With') === 'XMLHttpRequest' || req.get('Accept') === 'application/json';
}

function respondMutation(req, res, leadId) {
  if (isAjax(req)) return res.json({ ok: true, savedAt: new Date().toISOString() });
  return res.redirect('/admin/devis-moteurs/' + leadId);
}

async function postChangeStatus(req, res, next) {
  try {
    const id = req.params.id;
    const newStatus = String(req.body.status || '').trim();
    if (!STATUS_LABELS[newStatus]) return res.status(400).send('Statut invalide');
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).send('Not found');

    await ensureEngineQuote(id);
    await AbandonedCart.updateOne(
      { _id: id, captureSource: 'landing_moteurs' },
      {
        $set: {
          'engineQuote.status': newStatus,
          ...buildUpdate(req),
        },
      },
      { upsert: false }
    );

    return respondMutation(req, res, id);
  } catch (err) {
    return next(err);
  }
}

async function postUpdateEngine(req, res, next) {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).send('Not found');
    const b = req.body || {};
    await ensureEngineQuote(id);
    await AbandonedCart.updateOne(
      { _id: id, captureSource: 'landing_moteurs' },
      {
        $set: {
          'engineQuote.identifiedEngine.code': String(b.code || '').trim().slice(0, 80),
          'engineQuote.identifiedEngine.model': String(b.model || '').trim().slice(0, 200),
          'engineQuote.identifiedEngine.year': String(b.year || '').trim().slice(0, 10),
          'engineQuote.identifiedEngine.mileage': safeNumber(b.mileage),
          'engineQuote.identifiedEngine.condition': (() => {
            const c = String(b.condition || '').trim();
            return CONDITION_LABELS[c] ? c : '';
          })(),
          ...buildUpdate(req),
        },
      }
    );
    return respondMutation(req, res, id);
  } catch (err) {
    return next(err);
  }
}

async function postUpdateStock(req, res, next) {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).send('Not found');
    const b = req.body || {};
    const loc = String(b.location || '').trim();
    if (loc && !STOCK_LABELS[loc]) return res.status(400).send('Stock invalide');
    await ensureEngineQuote(id);
    await AbandonedCart.updateOne(
      { _id: id, captureSource: 'landing_moteurs' },
      {
        $set: {
          'engineQuote.stock.location': loc,
          'engineQuote.stock.estimatedDelay': String(b.estimatedDelay || '').trim().slice(0, 80),
          ...buildUpdate(req),
        },
      }
    );
    return respondMutation(req, res, id);
  } catch (err) {
    return next(err);
  }
}

async function postUpdatePricing(req, res, next) {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).send('Not found');
    const b = req.body || {};
    await ensureEngineQuote(id);
    await AbandonedCart.updateOne(
      { _id: id, captureSource: 'landing_moteurs' },
      {
        $set: {
          'engineQuote.pricing.purchasePrice': safeNumber(b.purchasePrice),
          'engineQuote.pricing.additionalFees': safeNumber(b.additionalFees),
          'engineQuote.pricing.sellPrice': safeNumber(b.sellPrice),
          'engineQuote.pricing.vatRate': safeNumber(b.vatRate, 20),
          ...buildUpdate(req),
        },
      }
    );
    return respondMutation(req, res, id);
  } catch (err) {
    return next(err);
  }
}

async function postAddNote(req, res, next) {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).send('Not found');
    const text = String((req.body || {}).text || '').trim();
    if (!text) return res.redirect('/admin/devis-moteurs/' + id);

    const admin = getAdminInfo(req);
    await ensureEngineQuote(id);
    await AbandonedCart.updateOne(
      { _id: id, captureSource: 'landing_moteurs' },
      {
        $push: {
          notes: {
            text: text.slice(0, 4000),
            addedBy: admin.id,
            addedByName: admin.name,
            addedAt: new Date(),
          },
        },
        $set: buildUpdate(req),
      }
    );
    return res.redirect('/admin/devis-moteurs/' + id + '#notes');
  } catch (err) {
    return next(err);
  }
}

/* ─── ARCHIVAGE / SUPPRESSION ─────────────────────────────────────────── */

/**
 * Valide une URL de retour : doit rester dans /admin/devis-moteurs
 * (anti open-redirect). Sinon on retombe sur le fallback fourni.
 */
function safeReturnTo(value, fallback) {
  const v = String(value || '');
  return /^\/admin\/devis-moteurs(\/|\?|$)/.test(v) ? v : fallback;
}

/**
 * Archive ou désarchive un lead (body.archived = '1' pour archiver, '0' pour
 * désarchiver). Réversible — ne supprime rien.
 */
async function postSetArchive(req, res, next) {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).send('Not found');
    const archive = String((req.body || {}).archived) === '1';
    const admin = getAdminInfo(req);

    await AbandonedCart.updateOne(
      { _id: id, captureSource: 'landing_moteurs' },
      archive
        ? { $set: { archived: true, archivedAt: new Date(), archivedByName: admin.name } }
        : { $set: { archived: false, archivedAt: null, archivedByName: '' } }
    );

    if (isAjax(req)) return res.json({ ok: true, archived: archive });
    return res.redirect(safeReturnTo((req.body || {}).returnTo, '/admin/devis-moteurs'));
  } catch (err) {
    return next(err);
  }
}

/**
 * Supprime DÉFINITIVEMENT un lead devis-moteur (spam, test, doublon).
 * Irréversible. Nettoie aussi les fichiers GridFS associés (photos + PDF
 * envoyés) pour ne pas laisser d'orphelins. Réservé aux landing_moteurs.
 */
async function postDelete(req, res, next) {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).send('Not found');

    const cart = await AbandonedCart.findOne({ _id: id, captureSource: 'landing_moteurs' }).lean();
    if (!cart) return res.status(404).send('Not found');

    // Collecte les fichiers GridFS rattachés (photos moteur/km + PDF envoyés)
    const eq = cart.engineQuote || {};
    const fileIds = [];
    ((eq.photos && eq.photos.engine) || []).forEach((p) => { if (p && p.id) fileIds.push(p.id); });
    ((eq.photos && eq.photos.kmReading) || []).forEach((p) => { if (p && p.id) fileIds.push(p.id); });
    (eq.sentQuotes || []).forEach((s) => { if (s && s.pdfId) fileIds.push(s.pdfId); });
    for (const fid of fileIds) {
      try { await storage.deleteFile(fid); } catch (_) {}
    }

    await AbandonedCart.deleteOne({ _id: id, captureSource: 'landing_moteurs' });

    return res.redirect('/admin/devis-moteurs');
  } catch (err) {
    return next(err);
  }
}

/* ─── PHOTOS ──────────────────────────────────────────────────────────── */

const ALLOWED_CATEGORIES = new Set(['engine', 'kmReading']);

async function postUploadPhoto(req, res, next) {
  try {
    const id = req.params.id;
    const category = String((req.body || {}).category || req.params.category || '').trim();
    if (!ALLOWED_CATEGORIES.has(category)) return res.status(400).send('Catégorie invalide');
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).send('Not found');

    // Multer.array → req.files est un tableau. Si single → req.file.
    const files = Array.isArray(req.files) && req.files.length
      ? req.files
      : (req.file ? [req.file] : []);
    if (!files.length) return res.redirect('/admin/devis-moteurs/' + id + '#photos');

    const cart = await AbandonedCart.findOne({ _id: id, captureSource: 'landing_moteurs' });
    if (!cart) return res.status(404).send('Not found');

    const admin = getAdminInfo(req);
    const photoDocs = [];
    for (const f of files) {
      if (!f.buffer) continue;
      const saved = await storage.saveBuffer({
        buffer: f.buffer,
        filename: f.originalname || 'photo.jpg',
        mime: f.mimetype || 'image/jpeg',
        metadata: {
          kind: 'engine_quote_photo',
          category,
          engineQuoteId: String(cart._id),
          uploadedBy: 'admin',
        },
      });
      photoDocs.push({
        id: saved.id,
        url: saved.url,
        filename: f.originalname || 'photo.jpg',
        mime: f.mimetype || '',
        size: saved.size,
        uploadedAt: new Date(),
        uploadedByName: admin.name,
      });
    }

    await ensureEngineQuote(id);
    await AbandonedCart.updateOne(
      { _id: id },
      {
        $push: { [`engineQuote.photos.${category}`]: { $each: photoDocs } },
        $set: buildUpdate(req),
      }
    );

    return res.redirect('/admin/devis-moteurs/' + id + '#photos');
  } catch (err) {
    return next(err);
  }
}

async function postDeletePhoto(req, res, next) {
  try {
    const id = req.params.id;
    const category = req.params.category;
    const photoId = req.params.photoId;
    if (!ALLOWED_CATEGORIES.has(category)) return res.status(400).send('Catégorie invalide');
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).send('Not found');

    await ensureEngineQuote(id);
    await AbandonedCart.updateOne(
      { _id: id, captureSource: 'landing_moteurs' },
      {
        $pull: { [`engineQuote.photos.${category}`]: { id: photoId } },
        $set: buildUpdate(req),
      }
    );

    // Best-effort : supprime le fichier GridFS
    try { await storage.deleteFile(photoId); } catch (_) {}

    return res.redirect('/admin/devis-moteurs/' + id + '#photos');
  } catch (err) {
    return next(err);
  }
}

/* ─── PRÉPARATION DONNÉES DEVIS (factorisée pour preview + envoi) ───── */

/**
 * Lit le cart, valide les pré-requis, normalise les inputs commerciaux
 * (message, acompte). Renvoie les données nécessaires pour générer
 * PDF / email — sans rien envoyer ni persister.
 */
async function prepareQuoteData(req, opts) {
  opts = opts || {};
  const requireEmail = opts.requireEmail !== false;

  const id = req.params.id;
  if (!mongoose.Types.ObjectId.isValid(id)) return { error: { code: 404, msg: 'Not found' } };

  const cart = await AbandonedCart.findOne({ _id: id, captureSource: 'landing_moteurs' });
  if (!cart) return { error: { code: 404, msg: 'Not found' } };
  if (requireEmail && !cart.email) return { error: { code: 400, msg: 'Le client n\'a pas d\'email — impossible d\'envoyer le devis' } };

  const eq = cart.engineQuote || {};
  const pricing = eq.pricing || {};
  const sellHt = Number(pricing.sellPrice) || 0;
  if (sellHt <= 0) return { error: { code: 400, msg: 'Renseigne d\'abord le prix de vente HT' } };

  const vatRate = Number(pricing.vatRate) || 20;
  const sellTtc = sellHt * (1 + vatRate / 100);

  const b = req.body || {};
  const customMessage = String(b.customMessage || '').trim().slice(0, 2000);
  const depositPct = Math.max(0, Math.min(100, Number(b.depositPct) || 0));
  const depositTtc = depositPct > 0 ? (sellTtc * depositPct / 100) : 0;
  const depositCents = Math.round(depositTtc * 100);
  const createMollie = String(b.createMollie || '').toLowerCase() === 'on' && MOLLIE_ENABLED && depositCents > 0;

  const quoteRef = (cart.requested && cart.requested.ref) || '';
  const stockLocation = (eq.stock && eq.stock.location) || '';
  const stockLabelClient = STOCK_CLIENT_LABELS[stockLocation] || '';
  const delay = (eq.stock && eq.stock.estimatedDelay) || '';

  const conditionKey = (eq.identifiedEngine && eq.identifiedEngine.condition) || '';
  const conditionInfo = CONDITION_LABELS[conditionKey] || CONDITION_LABELS[''];

  const allPhotos = [
    ...(eq.photos && eq.photos.engine ? eq.photos.engine.map(p => ({ ...p.toObject ? p.toObject() : p, category: 'engine' })) : []),
    ...(eq.photos && eq.photos.kmReading ? eq.photos.kmReading.map(p => ({ ...p.toObject ? p.toObject() : p, category: 'kmReading' })) : []),
  ].slice(0, 6);

  // Photos PDF (compressées) : optionnellement chargées pour la preview
  let pdfPhotos = [];
  if (opts.loadPhotoBuffers) {
    for (const p of allPhotos) {
      try {
        const raw = await storage.readBuffer(p.id);
        if (raw && Buffer.isBuffer(raw)) {
          const { buffer } = await compressImage(raw, p.mime);
          pdfPhotos.push({ buffer, category: p.category });
        }
      } catch (_) {}
    }
  }

  const firstNameForEmail = (cart.firstName && cart.lastName) ? cart.firstName : '';

  return {
    cart, eq, sellHt, vatRate, sellTtc,
    depositPct, depositTtc, depositCents, createMollie,
    customMessage, quoteRef,
    stockLocation, stockLabelClient, delay,
    conditionKey, conditionInfo,
    allPhotos, pdfPhotos, firstNameForEmail,
  };
}

/* ─── APERÇUS (preview email / PDF avant envoi) ─────────────────────── */

async function postPreviewPdf(req, res, next) {
  try {
    const d = await prepareQuoteData(req, { requireEmail: false, loadPhotoBuffers: true });
    if (d.error) return res.status(d.error.code).send(d.error.msg);

    const pdfBuffer = await buildQuotePdf({
      quoteRef: d.quoteRef,
      customerName: ((d.cart.firstName || '') + ' ' + (d.cart.lastName || '')).trim() || d.cart.email || '—',
      customerEmail: d.cart.email,
      customerPhone: d.cart.phone,
      plate: (d.cart.requested && d.cart.requested.plate) || '',
      engine: d.eq.identifiedEngine || {},
      pricing: { sellPrice: d.sellHt, vatRate: d.vatRate, purchasePrice: (d.eq.pricing || {}).purchasePrice, additionalFees: (d.eq.pricing || {}).additionalFees },
      stockLabel: d.stockLabelClient,
      delay: d.delay,
      depositCents: d.depositCents,
      mollieUrl: d.createMollie ? 'https://example.com/preview-mollie' : '',  // placeholder pour preview
      customMessage: d.customMessage,
      conditionLabel: d.conditionInfo.client,
      conditionBadge: d.conditionInfo.short,
      isReconditionne: d.conditionKey.startsWith('reconditionne'),
      photos: d.pdfPhotos,
    });

    res.set('Content-Type', 'application/pdf');
    res.set('Content-Disposition', 'inline; filename="apercu-devis.pdf"');
    return res.send(pdfBuffer);
  } catch (err) {
    return next(err);
  }
}

async function postPreviewEmail(req, res, next) {
  try {
    const d = await prepareQuoteData(req, { requireEmail: false });
    if (d.error) return res.status(d.error.code).send(d.error.msg);

    const html = buildQuoteEmailHtml({
      quoteRef: d.quoteRef,
      firstName: d.firstNameForEmail,
      plate: (d.cart.requested && d.cart.requested.plate) || '',
      engine: d.eq.identifiedEngine || {},
      stockLabel: d.stockLabelClient,
      delay: d.delay,
      sellHt: d.sellHt,
      sellTtc: d.sellTtc,
      depositTtc: d.depositTtc,
      vatRate: d.vatRate,
      stockLocation: d.stockLocation,
      mollieUrl: d.createMollie ? 'https://example.com/preview-mollie' : '',
      customMessage: d.customMessage,
      photoCount: d.allPhotos.length,
      brandPhone: brand.PHONE,
      brandPhoneIntl: brand.PHONE_INTL,
      conditionLabel: d.conditionInfo.client,
      conditionBadge: d.conditionInfo.short,
      isReconditionne: d.conditionKey.startsWith('reconditionne'),
    });

    // Bandeau preview au-dessus de l'email pour bien signaler que c'est un aperçu
    const banner = `<div style="background:#fef3c7;border-bottom:2px solid #f59e0b;padding:12px 24px;font-family:-apple-system,sans-serif;font-size:13px;color:#78350f;text-align:center;">
      <strong>🔍 APERÇU EMAIL — non envoyé.</strong>
      Destinataire prévu : <strong>${d.cart.email || '(pas d\'email)'}</strong>
      · Sujet : <strong>Votre devis ${d.quoteRef} est prêt — Autoliva</strong>
      · ${d.allPhotos.length} photo(s) seront jointes
    </div>`;

    res.set('Content-Type', 'text/html; charset=utf-8');
    return res.send(banner + html);
  } catch (err) {
    return next(err);
  }
}

/* ─── ENVOI DU DEVIS AU CLIENT ────────────────────────────────────────── */

async function postSendQuote(req, res, next) {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).send('Not found');

    const cart = await AbandonedCart.findOne({ _id: id, captureSource: 'landing_moteurs' });
    if (!cart) return res.status(404).send('Not found');
    if (!cart.email) return res.status(400).send('Le client n\'a pas d\'email — impossible d\'envoyer le devis');

    const eq = cart.engineQuote || {};
    const pricing = eq.pricing || {};
    const sellHt = Number(pricing.sellPrice) || 0;
    if (sellHt <= 0) return res.status(400).send('Renseigne d\'abord le prix de vente HT');

    const vatRate = Number(pricing.vatRate) || 20;
    const sellTtc = sellHt * (1 + vatRate / 100);

    const b = req.body || {};
    const customMessage = String(b.customMessage || '').trim().slice(0, 2000);
    const depositPct = Math.max(0, Math.min(100, Number(b.depositPct) || 0));
    const depositTtc = depositPct > 0 ? (sellTtc * depositPct / 100) : 0;
    const depositCents = Math.round(depositTtc * 100);
    const createMollie = String(b.createMollie || '').toLowerCase() === 'on' && MOLLIE_ENABLED && depositCents > 0;

    const quoteRef = (cart.requested && cart.requested.ref) || '';
    const admin = getAdminInfo(req);

    const stockLocation = (eq.stock && eq.stock.location) || '';
    const stockLabelClient = STOCK_CLIENT_LABELS[stockLocation] || '';
    const delay = (eq.stock && eq.stock.estimatedDelay) || '';

    // État du moteur (occasion vs reconditionné) → libellés client-facing
    const conditionKey = (eq.identifiedEngine && eq.identifiedEngine.condition) || '';
    const conditionInfo = CONDITION_LABELS[conditionKey] || CONDITION_LABELS[''];

    // 0) Lit les buffers photos depuis GridFS (réutilisés pour PDF + pièces jointes)
    const allPhotos = [
      ...(eq.photos && eq.photos.engine ? eq.photos.engine.map(p => ({ ...p.toObject ? p.toObject() : p, category: 'engine' })) : []),
      ...(eq.photos && eq.photos.kmReading ? eq.photos.kmReading.map(p => ({ ...p.toObject ? p.toObject() : p, category: 'kmReading' })) : []),
    ].slice(0, 6);

    // Lit + COMPRESSE chaque photo (resize 1400px + JPEG q78) pour rester
    // sous la limite MailerSend de 25 MB (photos iPhone = 10+ MB sinon).
    const photosWithBuffers = [];
    for (const p of allPhotos) {
      try {
        const raw = await storage.readBuffer(p.id);
        if (raw && Buffer.isBuffer(raw)) {
          const { buffer, mime } = await compressImage(raw, p.mime);
          photosWithBuffers.push({ ...p, buffer, mime });
        }
      } catch (err) {
        console.warn('[engine-quote] photo read failed:', p.id, err && err.message);
      }
    }

    // Photos pour le PDF (compressées → JPEG, supporté par pdfkit)
    const pdfPhotos = photosWithBuffers.map(p => ({ buffer: p.buffer, category: p.category }));

    // 1) Prépare l'ID du sentQuote + URLs de tracking AVANT le PDF : le PDF
    //    doit pouvoir embarquer le bouton de paiement cliquable, donc le lien
    //    Mollie + le lien tracké doivent exister avant de générer le PDF.
    const sentQuoteObjectId = new mongoose.Types.ObjectId();
    const publicBase = (process.env.PUBLIC_BASE_URL || brand.SITE_URL || 'https://autoliva.com').replace(/\/$/, '');
    const trackBase = publicBase + '/api/devis-moteurs';
    const trackSuffix = '/' + String(cart._id) + '/' + String(sentQuoteObjectId);
    const trackPixelUrl = trackBase + '/track-open' + trackSuffix;
    // Lien "voir le PDF en ligne" tracké (vue PDF) — PDF stocké en GridFS
    const pdfTrackUrl = trackBase + '/track-pdf' + trackSuffix;

    // 2) Crée le lien de paiement Mollie (acompte) AVANT le PDF, pour que le
    //    bouton "Payer en ligne" du PDF puisse y pointer (via le lien tracké).
    let mollieUrl = '';
    let mollieId = '';
    if (createMollie) {
      try {
        const payment = await mollie.createPayment({
          amountCents: depositCents,
          description: `Acompte devis ${quoteRef} — Autoliva`,
          redirectUrl: publicBase + '/devis/merci?ref=' + encodeURIComponent(quoteRef),
          webhookUrl: publicBase + '/api/devis-moteurs/mollie-webhook',
          metadata: { kind: 'engine_quote_deposit', quoteRef, engineQuoteId: String(cart._id) },
        });
        if (payment && payment._links && payment._links.checkout) {
          mollieUrl = payment._links.checkout.href;
          mollieId = payment.id;
        }
      } catch (err) {
        console.error('[engine-quote] Mollie payment creation failed:', err && err.message);
      }
    }
    // Lien paiement tracké (clic) — seulement si un lien Mollie existe.
    // Utilisé à la fois dans l'email ET le PDF → un clic depuis l'un ou l'autre
    // est compté comme "paiement cliqué".
    const payTrackUrl = mollieUrl ? (trackBase + '/track-pay' + trackSuffix) : '';

    // 3) Génère le PDF (photos intégrées + bouton de paiement cliquable si un
    //    lien Mollie a été créé ; sinon mollieUrl vide → aucun bouton, inchangé)
    const pdfBuffer = await buildQuotePdf({
      quoteRef,
      customerName: ((cart.firstName || '') + ' ' + (cart.lastName || '')).trim() || cart.email,
      customerEmail: cart.email,
      customerPhone: cart.phone,
      plate: (cart.requested && cart.requested.plate) || '',
      engine: eq.identifiedEngine || {},
      pricing: { sellPrice: sellHt, vatRate, purchasePrice: pricing.purchasePrice, additionalFees: pricing.additionalFees },
      stockLabel: stockLabelClient,
      delay,
      depositCents,
      mollieUrl: payTrackUrl || mollieUrl,
      customMessage,
      conditionLabel: conditionInfo.client,
      conditionBadge: conditionInfo.short,
      isReconditionne: conditionKey.startsWith('reconditionne'),
      photos: pdfPhotos,
    });

    // 4) Persiste le PDF dans GridFS
    const pdfSaved = await storage.saveBuffer({
      buffer: pdfBuffer,
      filename: `Devis-${quoteRef || cart._id}.pdf`,
      mime: 'application/pdf',
      metadata: { kind: 'engine_quote_pdf', engineQuoteId: String(cart._id), quoteRef },
    });

    // 5) Prépare les photos à joindre à l'email (buffers compressés en JPEG)
    const photoAttachments = photosWithBuffers.map((p, i) => {
      const catLabel = p.category === 'engine' ? 'moteur' : 'km';
      return {
        filename: `${catLabel}-${i + 1}.jpg`,
        content: p.buffer.toString('base64'),
        disposition: 'attachment',
      };
    });

    // 6) Envoie l'email avec PDF + photos en pièces jointes
    const firstNameForEmail = (cart.firstName && cart.lastName) ? cart.firstName : '';
    const html = buildQuoteEmailHtml({
      quoteRef,
      firstName: firstNameForEmail,
      plate: (cart.requested && cart.requested.plate) || '',
      engine: eq.identifiedEngine || {},
      stockLabel: stockLabelClient,
      delay,
      sellHt,
      sellTtc,
      depositTtc,
      vatRate,
      stockLocation,
      mollieUrl,
      customMessage,
      photoCount: photoAttachments.length,
      brandPhone: brand.PHONE,
      brandPhoneIntl: brand.PHONE_INTL,
      conditionLabel: conditionInfo.client,
      conditionBadge: conditionInfo.short,
      isReconditionne: conditionKey.startsWith('reconditionne'),
      trackPixelUrl,
      payTrackUrl,
      pdfTrackUrl,
    });
    const text = [
      `Bonjour,`,
      ``,
      `Votre devis Autoliva ${quoteRef} est prêt.`,
      ``,
      `Véhicule : ${(cart.requested && cart.requested.plate) || ''}`,
      eq.identifiedEngine && eq.identifiedEngine.model ? `Moteur : ${eq.identifiedEngine.model}` : '',
      `Prix HT : ${sellHt.toFixed(2)} €`,
      `Total TTC : ${sellTtc.toFixed(2)} €`,
      depositTtc > 0 ? `Acompte : ${depositTtc.toFixed(2)} €` : '',
      mollieUrl ? `Lien acompte : ${mollieUrl}` : '',
      ``,
      `Détail complet en pièce jointe.`,
      `L'équipe Autoliva`,
    ].filter(Boolean).join('\n');

    const sendResult = await emailService.sendEmail({
      toEmail: cart.email,
      subject: `Votre devis ${quoteRef} est prêt — Autoliva`,
      html,
      text,
      attachments: [
        {
          filename: `Devis-${quoteRef || cart._id}.pdf`,
          content: pdfBuffer.toString('base64'),
          disposition: 'attachment',
        },
        ...photoAttachments,
      ],
    });

    if (!sendResult || sendResult.ok === false) {
      console.error('[engine-quote] Email envoi devis échoué:', sendResult);
    }

    // 7) Persiste l'historique (avec snapshot photos) + change statut
    const photoSnapshot = allPhotos.map(p => ({
      id: p.id,
      url: p.url,
      filename: p.filename,
      category: p.category,
    }));

    await AbandonedCart.updateOne(
      { _id: cart._id },
      {
        $push: {
          'engineQuote.sentQuotes': {
            _id: sentQuoteObjectId,
            sentAt: new Date(),
            pdfId: pdfSaved.id,
            pdfUrl: pdfSaved.url,
            sellPriceHt: sellHt,
            sellPriceTtc: sellTtc,
            depositCents,
            mollieUrl,
            mollieId,
            customMessage,
            sentByName: admin.name,
            attachedPhotos: photoSnapshot,
          },
        },
        $set: {
          'engineQuote.status': 'quote_sent',
          ...buildUpdate(req),
        },
      }
    );

    return res.redirect('/admin/devis-moteurs/' + cart._id + '#history');
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getEngineQuotesList,
  getEngineQuoteDetail,
  postChangeStatus,
  postUpdateEngine,
  postUpdateStock,
  postUpdatePricing,
  postAddNote,
  postUploadPhoto,
  postDeletePhoto,
  postSetArchive,
  postDelete,
  postSendQuote,
  postPreviewPdf,
  postPreviewEmail,
};
