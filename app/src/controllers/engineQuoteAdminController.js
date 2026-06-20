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

const crypto = require('crypto');
const mongoose = require('mongoose');
const AbandonedCart = require('../models/AbandonedCart');
const storage = require('../services/savFileStorage');
const emailService = require('../services/emailService');
const { buildQuotePdf } = require('../services/engineQuotePdf');
const { buildQuoteEmailHtml, buildShipmentEmailHtml } = require('../services/engineQuoteEmail');
const { sendSms, normalizePhoneFR } = require('../services/smsService');
const { resolveSms } = require('../services/smsSettings');
const { compressImage } = require('../services/imageCompress');
const mollie = require('../services/mollie');
const brand = require('../config/brand');

const MOLLIE_ENABLED = String(process.env.ENGINE_QUOTE_MOLLIE_ENABLED || '').toLowerCase() === 'true';

// Alphabet sans caractères ambigus (0/O, 1/I/l) pour les liens courts SMS.
const SHORT_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789';
function randomShortCode(len) {
  const bytes = crypto.randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i += 1) out += SHORT_CODE_ALPHABET[bytes[i] % SHORT_CODE_ALPHABET.length];
  return out;
}
/** Génère un shortCode unique pour le lien SMS de marque (autoliva.com/d/<code>). */
async function generateUniqueShortCode() {
  for (let i = 0; i < 5; i += 1) {
    const code = randomShortCode(7);
    // eslint-disable-next-line no-await-in-loop
    const exists = await AbandonedCart.exists({ 'engineQuote.sentQuotes.shortCode': code });
    if (!exists) return code;
  }
  return randomShortCode(10); // collision quasi impossible
}

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

/* Régime de TVA effectif (true = TVA sur marge, false = régime normal 20%).
 * Reconditionné : régime normal IMPÉRATIF — un moteur remis à neuf n'est pas
 * éligible à la TVA sur marge (art. 297 A CGI réservé à l'occasion). On ignore
 * donc le défaut schéma 'margin'. Occasion : TVA sur marge par défaut, sauf
 * choix « normal » explicite du commercial. */
function isMarginScheme(pricing, isReconditionne) {
  if (isReconditionne) return false;
  return !pricing || pricing.vatScheme !== 'normal';
}

/* TVA réellement due selon le régime.
 * - marge : (vente − achat) × taux/(100+taux), uniquement si marge positive
 * - normal : sur la marge aussi côté trésorerie, mais ici on ne calcule que ce
 *   qui grève la marge nette du vendeur → en normal la TVA se neutralise (HT). */
function vatOnMargin(pricing, isReconditionne) {
  const sell = Number(pricing && pricing.sellPrice) || 0;
  const purchase = Number(pricing && pricing.purchasePrice) || 0;
  const vatRate = Number(pricing && pricing.vatRate) || 20;
  if (!isMarginScheme(pricing, isReconditionne)) return 0;
  return sell > purchase ? (sell - purchase) * vatRate / (100 + vatRate) : 0;
}

/* Prix payé par le client + TVA, selon le régime. Source unique pour le devis,
 * l'email et le paiement. */
function computeQuoteTotals(pricing, isReconditionne) {
  const sell = Number(pricing && pricing.sellPrice) || 0;
  const purchase = Number(pricing && pricing.purchasePrice) || 0;
  const vatRate = Number(pricing && pricing.vatRate) || 20;
  const margin = isMarginScheme(pricing, isReconditionne);
  let clientTotal;
  let vatAmount;
  if (margin) {
    clientTotal = sell; // prix TOUT COMPRIS — pas de +20%
    vatAmount = sell > purchase ? (sell - purchase) * vatRate / (100 + vatRate) : 0; // TVA sur marge (non détaillée au client)
  } else {
    vatAmount = sell * vatRate / 100;
    clientTotal = sell + vatAmount;
  }
  return { sell, purchase, vatRate, isMargin: margin, vatAmount, clientTotal };
}

function calcMargin(p, isReconditionne) {
  if (!p) return { marginEur: 0, marginPct: 0 };
  const purchase = Number(p.purchasePrice) || 0;
  const fees = Number(p.additionalFees) || 0;
  const sell = Number(p.sellPrice) || 0;
  // Coûts de contrôle (port test + MO de banc) inclus pour l'OCCASION dès qu'un
  // moteur est chiffré → la marge affichée (liste/funnel/détail) est la VRAIE
  // marge. Reconditionné : pas de banc d'essai → aucun coût de contrôle.
  const control = (purchase > 0 && !isReconditionne) ? CONTROL_COST_TOTAL : 0;
  // En régime de la marge, la TVA sur marge grève directement la marge nette
  // (reconditionné = régime normal → TVA neutre, tvaMarge = 0).
  const tvaMarge = vatOnMargin(p, isReconditionne);
  const cost = purchase + fees + control + tvaMarge;
  const marginEur = sell - cost;
  const marginPct = sell > 0 ? (marginEur / sell) * 100 : 0;
  return { marginEur, marginPct };
}

function getMarginColor(pct) {
  if (pct >= 25) return 'text-emerald-700';
  if (pct >= 15) return 'text-amber-700';
  return 'text-rose-700';
}

// Coûts de CONTRÔLE absorbés par moteur (port test fournisseur→atelier + MO
// de test). Servent à pré-remplir les « frais annexes » du calculateur pour
// afficher la VRAIE marge. La livraison finale (refacturée au client) n'y est
// PAS — ce n'est pas un coût. Valeurs Killian (2026-06) ; modifiables ici.
const CONTROL_COST_DEFAULTS = { portTest: 140, hourlyRate: 100, testHours: 2 };
const CONTROL_COST_TOTAL = CONTROL_COST_DEFAULTS.portTest + CONTROL_COST_DEFAULTS.hourlyRate * CONTROL_COST_DEFAULTS.testHours;

function safeNumber(value, fallback = 0) {
  const n = Number(String(value || '').replace(',', '.'));
  return isNaN(n) ? fallback : n;
}

/**
 * Résout le pourcentage d'acompte à partir du body du formulaire.
 * Le champ libre `depositPctCustom` est PRIORITAIRE sur les presets radio
 * `depositPct` dès qu'il est renseigné (> 0). Résultat borné à [0, 100].
 */
function resolveDepositPct(b) {
  const custom = safeNumber((b || {}).depositPctCustom, 0);
  const raw = custom > 0 ? custom : safeNumber((b || {}).depositPct, 0);
  return Math.max(0, Math.min(100, raw));
}

function getAdminInfo(req) {
  const a = req && req.session && req.session.admin ? req.session.admin : {};
  return {
    id: a.adminUserId ? new mongoose.Types.ObjectId(a.adminUserId) : null,
    name: a.displayName || a.email || 'Admin',
  };
}

/* ─── PAGE LISTE ──────────────────────────────────────────────────────── */

/* Condition (intention captée depuis la landing), déduite du libellé véhicule :
 * « Moteur reconditionné » → reconditionne ; « Moteur d'occasion » → occasion. */
const CONDITION_BADGES = {
  reconditionne: { label: 'Reconditionné', className: 'bg-red-100 text-red-700' },
  occasion: { label: 'Occasion', className: 'bg-emerald-100 text-emerald-700' },
};
function deriveCondition(vehicle) {
  const v = String(vehicle || '').toLowerCase();
  if (v.indexOf('recondition') !== -1) return 'reconditionne';
  if (v.indexOf('occasion') !== -1) return 'occasion';
  return '';
}

/* Clé de condition par défaut déduite de la source du lead, quand le commercial
 * n'a PAS explicitement choisi l'état. Garantit qu'un lead « reconditionné »
 * (page /moteurs-reconditionnes) produit un devis reconditionné (badge rouge,
 * garantie 1 an, « pièces d'usure remplacées ») et un lead « occasion » un devis
 * occasion — au lieu du fallback occasion générique. Le commercial peut toujours
 * forcer l'état en 1 clic dans le dossier. */
function defaultConditionFromLead(cart) {
  const d = deriveCondition(cart && cart.requested && cart.requested.vehicle);
  if (d === 'reconditionne') return 'reconditionne_complet';
  if (d === 'occasion') return 'occasion';
  return '';
}

/* État effectif reconditionné ? — choix commercial s'il existe, sinon déduction
 * de la source du lead. Pilote toute la cohérence du devis reconditionné :
 * TVA normale 20 %, pas de coûts de banc d'essai, marge cible 25 %, garantie 1 an. */
function leadIsReconditionne(eq, cart) {
  const k = (eq && eq.identifiedEngine && eq.identifiedEngine.condition) || defaultConditionFromLead(cart);
  return String(k).startsWith('reconditionne');
}

/**
 * Source d'acquisition d'un lead, déduite de l'attribution captée
 * (middleware captureAttribution.js → req.session.attribution → AbandonedCart.attribution).
 * Le `gclid` est LE signal fiable Google Ads : l'auto-tagging Google ne pose
 * PAS d'utm_source, donc on ne peut pas se baser sur `source` seul.
 */
function classifyLeadSource(attr) {
  const a = attr || {};
  const gclid = String(a.gclid || '').trim();
  const src = String(a.source || '').trim();
  const med = String(a.medium || '').trim().toLowerCase();
  const ref = String(a.referrer || '').trim();
  const campaign = String(a.campaign || '').trim();
  if (gclid || med === 'cpc' || med === 'ppc' || med === 'paid' || src.toLowerCase() === 'google_ads') {
    return { label: 'Google Ads', kind: 'ads', isAds: true, gclid, campaign };
  }
  if (src) {
    const s = src.toLowerCase();
    if (s.includes('google')) return { label: 'Google (SEO)', kind: 'seo', isAds: false, gclid: '', campaign };
    if (s === 'fb' || s === 'meta' || s.includes('facebook') || s.includes('instagram')) {
      return { label: src, kind: 'social', isAds: false, gclid: '', campaign };
    }
    return { label: src, kind: 'other', isAds: false, gclid: '', campaign };
  }
  if (ref) {
    let host = ref;
    try { host = new URL(/^https?:\/\//i.test(ref) ? ref : 'https://' + ref).hostname.replace(/^www\./, ''); } catch (_) { /* ref libre */ }
    if (host.toLowerCase().includes('google')) return { label: 'Google (SEO)', kind: 'seo', isAds: false, gclid: '', campaign: '' };
    return { label: host, kind: 'referral', isAds: false, gclid: '', campaign: '' };
  }
  return { label: 'Direct / SEO', kind: 'direct', isAds: false, gclid: '', campaign: '' };
}

async function getEngineQuotesList(req, res, next) {
  try {
    const statusFilter = typeof req.query.status === 'string' ? req.query.status.trim() : '';
    const q = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    const conditionFilter = (req.query.condition === 'reconditionne' || req.query.condition === 'occasion') ? req.query.condition : '';
    // Vue active (défaut) ou archivés. Les archivés sont sortis de la liste
    // active pour la désencombrer, mais restent consultables via le toggle.
    const view = req.query.view === 'archived' ? 'archived' : 'active';

    const query = { captureSource: 'landing_moteurs' };
    query.archived = view === 'archived' ? true : { $ne: true };
    if (statusFilter && STATUS_LABELS[statusFilter]) {
      query['engineQuote.status'] = statusFilter;
    }
    if (conditionFilter) {
      // Couvre les leads récents (libellé exact) ET anciens (« …occasion · complet »).
      query['requested.vehicle'] = conditionFilter === 'reconditionne' ? /recondition/i : /occasion/i;
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
        { 'requested.vehicle': rx },
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
      const margin = calcMargin(eq.pricing, leadIsReconditionne(eq, c));
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
        source: classifyLeadSource(c.attribution),
        ref: (c.requested && c.requested.ref) || '',
        plate: (c.requested && c.requested.plate) || '',
        vehicle: (c.requested && c.requested.vehicle) || '',
        conditionBadge: CONDITION_BADGES[deriveCondition(c.requested && c.requested.vehicle)] || null,
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
      fromAds: items.filter(i => i.source && i.source.isAds).length,
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
      filters: { status: statusFilter, q, condition: conditionFilter },
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
    const isReconditionneLead = leadIsReconditionne(eq, cart);
    const margin = calcMargin(eq.pricing, isReconditionneLead);
    const status = eq.status || 'new';

    const displayName = (cart.firstName + ' ' + cart.lastName).trim() || cart.email || cart.phone || '—';

    return res.render('admin/engine-quote-detail', {
      title: `Devis ${cart.requested && cart.requested.ref || ''} · Admin`,
      activeKey: 'engine-quotes',
      // Reconditionné : régime normal (TVA 20%), pas de coûts de banc d'essai,
      // marge cible 25%. La vue pré-règle le formulaire en conséquence.
      isReconditionne: isReconditionneLead,
      controlCostDefaults: isReconditionneLead ? { portTest: 0, hourlyRate: 0, testHours: 0 } : CONTROL_COST_DEFAULTS,
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
        // Pré-sélectionne l'état déduit de la source du lead quand le commercial
        // ne l'a pas encore choisi (recond → reconditionne_complet, occasion →
        // occasion) : le radio + l'aperçu du message du devis partent du bon état.
        identifiedEngine: (() => {
          const ie = Object.assign({}, eq.identifiedEngine || {});
          if (!ie.condition) ie.condition = defaultConditionFromLead(cart);
          return ie;
        })(),
        stock: eq.stock || {},
        pricing: eq.pricing || { purchasePrice: 0, additionalFees: 0, sellPrice: 0, vatRate: 20 },
        photos: eq.photos || { engine: [], kmReading: [] },
        margin,
        marginColor: getMarginColor(margin.marginPct),
        updatedAt: eq.updatedAt,
        updatedByName: eq.updatedByName,
        ackSms: eq.ackSms || null,
        sentQuotes: (eq.sentQuotes || []).slice().sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt)),
        remindersSent: eq.remindersSent || [],
        payment: eq.payment || null,
        shipment: (eq.shipment && eq.shipment.shippedAt) ? eq.shipment : null,
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

/* ─── CRÉATION MANUELLE D'UN DEVIS ───────────────────────────────────────
 * Permet au commercial de créer un dossier devis moteur de zéro (lead reçu
 * par téléphone/email), sans passer par le formulaire public. */

function generateManualQuoteRef() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const suffix = crypto.randomBytes(4).toString('hex').toUpperCase().slice(0, 6);
  return `AUT-${year}-${month}-${suffix}`;
}

async function getEngineQuoteNew(req, res) {
  return res.render('admin/engine-quote-new', {
    title: 'Nouveau devis · Admin',
    activeKey: 'engine-quotes',
    form: {},
    errorMessage: null,
  });
}

async function postCreateEngineQuote(req, res, next) {
  try {
    const renderForm = (status, errorMessage, form) =>
      res.status(status).render('admin/engine-quote-new', {
        title: 'Nouveau devis · Admin', activeKey: 'engine-quotes', form: form || {}, errorMessage,
      });

    if (mongoose.connection.readyState !== 1) {
      return renderForm(503, 'Base de données indisponible.', req.body);
    }

    const b = req.body || {};
    const trim = (v, n = 200) => (typeof v === 'string' ? v.trim().slice(0, n) : '');
    const firstName = trim(b.firstName, 80);
    const lastName = trim(b.lastName, 80);
    const email = trim(b.email, 160).toLowerCase();
    const phone = normalizePhoneFR(b.phone) || trim(b.phone, 24);
    const plate = trim(b.plate, 16).toUpperCase();
    const vehicle = trim(b.vehicle, 120);
    const message = trim(b.message, 2000);

    if (!email && !phone) {
      return renderForm(400, 'Indique au moins un email OU un téléphone pour pouvoir recontacter le client.', b);
    }
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return renderForm(400, 'Adresse email invalide.', b);
    }

    // Case « Prévenir le client » (cochée par défaut). Les cases non cochées ne
    // sont pas envoyées par le navigateur → on regarde simplement la présence.
    const notify =
      b.notifyClient === 'on' || b.notifyClient === 'true' || b.notifyClient === '1' || b.notifyClient === true;

    const ref = generateManualQuoteRef();
    const now = new Date();
    const created = await AbandonedCart.create({
      sessionId: 'manual-' + crypto.randomBytes(8).toString('hex'),
      abandonedAt: now,
      lastActivityAt: now,
      captureSource: 'landing_moteurs',
      email,
      firstName,
      lastName,
      phone,
      requested: { ref, plate, vehicle, message },
      engineQuote: { status: 'new' },
    });

    // Optionnel : accusé immédiat « votre dossier est bien reçu, on revient vers
    // vous ». Best-effort — un échec d'envoi ne doit JAMAIS bloquer la création
    // du dossier ni la redirection (chaque envoi est isolé dans son try/catch).
    if (notify) {
      const baseUrl = String(process.env.PUBLIC_BASE_URL || brand.SITE_URL || 'https://autoliva.com')
        .trim().replace(/\/+$/, '');

      // a) Email d'accusé — réutilise le template brandé du formulaire public.
      if (email) {
        try {
          const { buildAckEmailHtml } = require('./moteurOccasionController');
          const ackHtml = buildAckEmailHtml({
            firstName, quoteRef: ref, plate, engineTypeLabel: '', baseUrl, brandObj: brand,
          });
          const ackText = [
            `Votre dossier Autoliva est bien enregistré.`,
            ``,
            `N° de dossier : ${ref}`,
            plate ? `Véhicule : ${plate}` : '',
            vehicle ? `Moteur : ${vehicle}` : '',
            ``,
            `Notre équipe revient vers vous rapidement avec votre devis.`,
            ``,
            `Besoin urgent ? ${brand.PHONE_MOTEUR}`,
            ``,
            `L'équipe Autoliva`,
          ].filter(Boolean).join('\n');
          await emailService.sendEmail({
            toEmail: email,
            subject: `Votre dossier ${ref} bien reçu — Autoliva`,
            html: ackHtml,
            text: ackText,
          });
        } catch (err) {
          console.error('[devis-manuel] ack email failed:', err && err.message);
        }
      }

      // b) SMS d'accusé — même template « moteur_ack » que le formulaire public.
      // On persiste le résultat dans engineQuote.ackSms → le badge SMS s'affiche
      // dans la fiche détail, comme pour un lead venu du formulaire.
      if (phone) {
        let ackSmsResult;
        try {
          const { enabled: smsOn, text: smsText } = await resolveSms('moteur_ack', { quoteRef: ref, phoneMoteur: brand.PHONE_MOTEUR });
          if (smsOn && smsText) {
            const r = await sendSms({ to: phone, text: smsText });
            ackSmsResult = { status: r && r.ok ? 'sent' : 'failed', reason: (r && r.reason) || '', message: (r && r.message) || '', at: new Date(), phone };
            if (r && r.ok === false) console.warn('[devis-manuel] ack SMS non envoyé à', phone, '→', r.reason, r.message || '');
          } else {
            ackSmsResult = { status: 'disabled', reason: 'disabled', message: 'Template SMS « accusé de réception » désactivé.', at: new Date(), phone };
          }
        } catch (err) {
          ackSmsResult = { status: 'failed', reason: 'exception', message: (err && err.message) || 'Erreur', at: new Date(), phone };
          console.error('[devis-manuel] ack SMS failed:', err && err.message);
        }
        try {
          await AbandonedCart.updateOne({ _id: created._id }, { $set: { 'engineQuote.ackSms': ackSmsResult } });
        } catch (e) { /* persistance non bloquante */ }
      }
    }

    return res.redirect('/admin/devis-moteurs/' + created._id);
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
          'engineQuote.pricing.vatScheme': b.vatScheme === 'normal' ? 'normal' : 'margin',
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

/* ─── EXPÉDITION ──────────────────────────────────────────────────────── */

/**
 * Marque le moteur expédié + envoie au client l'email (et SMS) de suivi.
 * Tient la promesse de la confirmation d'acompte ("email à l'expédition").
 */
async function postShipment(req, res, next) {
  try {
    const id = req.params.id;
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).send('Not found');
    const cart = await AbandonedCart.findOne({ _id: id, captureSource: 'landing_moteurs' });
    if (!cart) return res.status(404).send('Not found');

    const b = req.body || {};
    const carrier = String(b.carrier || '').trim().slice(0, 80);
    const trackingNumber = String(b.trackingNumber || '').trim().slice(0, 120);
    let trackingUrl = String(b.trackingUrl || '').trim().slice(0, 500);
    if (trackingUrl && !/^https?:\/\//i.test(trackingUrl)) trackingUrl = ''; // n'accepte qu'une URL http(s)
    if (!carrier && !trackingNumber) {
      return res.status(400).send('Renseigne au moins le transporteur ou le n° de suivi');
    }

    const admin = getAdminInfo(req);
    const quoteRef = (cart.requested && cart.requested.ref) || '';
    const firstNameForEmail = (cart.firstName && cart.lastName) ? cart.firstName : '';
    const plate = (cart.requested && cart.requested.plate) || '';

    // Email client (best-effort)
    let emailSentAt = null;
    if (cart.email) {
      const html = buildShipmentEmailHtml({
        firstName: firstNameForEmail, quoteRef, carrier, trackingNumber, trackingUrl, plate,
        brandPhone: brand.PHONE_MOTEUR, brandPhoneIntl: brand.PHONE_MOTEUR_INTL,
      });
      const text = `Bonjour,\n\nVotre moteur (dossier ${quoteRef}) vient d'etre expedie.\nTransporteur : ${carrier}\n${trackingNumber ? 'N° de suivi : ' + trackingNumber + '\n' : ''}${trackingUrl ? 'Suivi : ' + trackingUrl + '\n' : ''}\nLe solde sera a regler une fois le moteur recu, teste conforme et l'attestation transmise.\n\nL'equipe Autoliva\n${brand.PHONE_MOTEUR}`;
      try {
        const r = await emailService.sendEmail({
          toEmail: cart.email,
          subject: `Votre moteur ${quoteRef} est expédié — Autoliva`,
          html, text,
          replyTo: { email: brand.EMAIL_CONTACT, name: brand.NAME },
        });
        if (r && r.ok !== false) emailSentAt = new Date();
      } catch (err) { console.error('[engine-quote] shipment email failed:', err && err.message); }
    }

    // SMS client (best-effort)
    if (cart.phone) {
      try {
        const trackingPart = `${trackingNumber ? ' Suivi ' + carrier + ' : ' + trackingNumber : ''}${trackingUrl ? ' ' + trackingUrl : ''}`;
        const { enabled: smsOn, text: smsBody } = await resolveSms('moteur_expedition', { quoteRef, trackingPart, phoneMoteur: brand.PHONE_MOTEUR });
        if (smsOn && smsBody) await sendSms({ to: cart.phone, text: smsBody.slice(0, 320) });
      } catch (err) { console.warn('[engine-quote] shipment SMS failed:', err && err.message); }
    }

    await ensureEngineQuote(id);
    await AbandonedCart.updateOne(
      { _id: id, captureSource: 'landing_moteurs' },
      {
        $set: {
          'engineQuote.shipment': {
            carrier, trackingNumber, trackingUrl,
            shippedAt: new Date(), shippedByName: admin.name, emailSentAt,
          },
          ...buildUpdate(req),
        },
        $push: {
          notes: {
            text: `Moteur marqué expédié (${carrier}${trackingNumber ? ' · ' + trackingNumber : ''})${emailSentAt ? ' — email client envoyé' : ''}.`,
            addedBy: admin.id, addedByName: admin.name, addedAt: new Date(),
          },
        },
      }
    );

    return res.redirect('/admin/devis-moteurs/' + id + '#expedition');
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

  // Reconditionné → régime normal (TVA 20%) par défaut ; occasion → TVA sur marge.
  const isReconditionneLead = leadIsReconditionne(eq, cart);
  const totals = computeQuoteTotals(pricing, isReconditionneLead);
  const vatRate = totals.vatRate;
  const sellTtc = totals.clientTotal; // marge : prix tout compris · normal : HT + TVA
  const vatScheme = totals.isMargin ? 'margin' : 'normal';

  const b = req.body || {};
  const customMessage = String(b.customMessage || '').trim().slice(0, 2000);
  const depositPct = resolveDepositPct(b);
  const depositTtc = depositPct > 0 ? (sellTtc * depositPct / 100) : 0;
  const depositCents = Math.round(depositTtc * 100);
  const createMollie = String(b.createMollie || '').toLowerCase() === 'on' && MOLLIE_ENABLED && depositCents > 0;

  const quoteRef = (cart.requested && cart.requested.ref) || '';
  const stockLocation = (eq.stock && eq.stock.location) || '';
  const stockLabelClient = STOCK_CLIENT_LABELS[stockLocation] || '';
  const delay = (eq.stock && eq.stock.estimatedDelay) || '';

  const conditionKey = (eq.identifiedEngine && eq.identifiedEngine.condition) || defaultConditionFromLead(cart);
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
    cart, eq, sellHt, vatRate, sellTtc, vatScheme,
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
      pricing: { sellPrice: d.sellHt, vatRate: d.vatRate, vatScheme: d.vatScheme, purchasePrice: (d.eq.pricing || {}).purchasePrice, additionalFees: (d.eq.pricing || {}).additionalFees },
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
      vatScheme: d.vatScheme,
      stockLocation: d.stockLocation,
      mollieUrl: d.createMollie ? 'https://example.com/preview-mollie' : '',
      customMessage: d.customMessage,
      photoCount: d.allPhotos.length,
      brandPhone: brand.PHONE_MOTEUR,
      brandPhoneIntl: brand.PHONE_MOTEUR_INTL,
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

/* ─── APERÇU DES MAILS AUTOMATIQUES (back-office) ───────────────────────── */

const PREVIEW_LABELS = {
  ack: 'Accusé de réception', j3: 'Relance J+3', j7: 'Relance J+7',
  j14: 'Relance J+14', winback: 'Win-back J+30', acompte: 'Confirmation acompte',
  expedition: 'Expédition',
};

/**
 * Rend l'aperçu (non envoyé) d'un mail automatique du tunnel moteur, avec les
 * vraies données du dossier. Permet au commercial de voir ce que reçoit le
 * client (accusé, relances J+3/J+7/J+14, win-back, acompte, expédition).
 */
async function getPreviewMail(req, res, next) {
  try {
    const id = req.params.id;
    const type = String(req.params.type || '').trim();
    if (!mongoose.Types.ObjectId.isValid(id)) return res.status(404).render('errors/404');
    if (!PREVIEW_LABELS[type]) return res.status(400).send('Type de mail inconnu');

    const cart = await AbandonedCart.findOne({ _id: id, captureSource: 'landing_moteurs' }).lean();
    if (!cart) return res.status(404).render('errors/404');

    const eq = cart.engineQuote || {};
    const quoteRef = (cart.requested && cart.requested.ref) || '';
    const plate = (cart.requested && cart.requested.plate) || '';
    const firstName = (cart.firstName && cart.lastName) ? cart.firstName : '';
    const pricing = eq.pricing || {};
    const sellTtc = computeQuoteTotals(pricing, leadIsReconditionne(eq, cart)).clientTotal;
    const lastSent = (eq.sentQuotes || []).slice().sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt))[0] || null;
    const phoneOpts = { brandPhone: brand.PHONE_MOTEUR, brandPhoneIntl: brand.PHONE_MOTEUR_INTL };
    const base = (process.env.PUBLIC_BASE_URL || brand.SITE_URL || 'https://autoliva.com').replace(/\/$/, '');

    const { buildReminderEmailHtml, buildShipmentEmailHtml: buildShip, buildAcompteConfirmationHtml } = require('../services/engineQuoteEmail');

    let html;
    if (type === 'ack') {
      const { buildAckEmailHtml } = require('./moteurOccasionController');
      html = buildAckEmailHtml({ firstName, quoteRef, plate, engineTypeLabel: (cart.requested && cart.requested.vehicle) || '', baseUrl: base, brandObj: brand });
    } else if (['j3', 'j7', 'j14', 'winback'].includes(type)) {
      const pdfUrl = lastSent ? `${base}/api/devis-moteurs/track-pdf/${cart._id}/${lastSent._id}` : '';
      // Lien de paiement STABLE (/track-pay) — régénère un checkout Mollie frais
      // si l'ancien a expiré. Jamais l'URL Mollie brute.
      const mollieUrl = (!lastSent || !lastSent.mollieUrl) ? '' : `${base}/api/devis-moteurs/track-pay/${cart._id}/${lastSent._id}`;
      html = buildReminderEmailHtml({ type, quoteRef, firstName, plate, sellTtc: (lastSent && lastSent.sellPriceTtc) || sellTtc, pdfUrl, mollieUrl, ...phoneOpts });
    } else if (type === 'acompte') {
      const amountEur = (eq.payment && eq.payment.amountCents) ? eq.payment.amountCents / 100
        : (lastSent && lastSent.depositCents) ? lastSent.depositCents / 100
          : sellTtc * 0.3;
      html = buildAcompteConfirmationHtml({ firstName, quoteRef, amountEur, ...phoneOpts });
    } else if (type === 'expedition') {
      const sh = eq.shipment || {};
      html = buildShip({ firstName, quoteRef, plate, carrier: sh.carrier || 'DPD', trackingNumber: sh.trackingNumber || '(n° de suivi)', trackingUrl: sh.trackingUrl || '', ...phoneOpts });
    }

    const banner = `<div style="background:#fef3c7;border-bottom:2px solid #f59e0b;padding:10px 20px;font-family:-apple-system,sans-serif;font-size:13px;color:#78350f;text-align:center;">
      <strong>🔍 APERÇU — ${PREVIEW_LABELS[type]}</strong> · dossier ${quoteRef || cart._id} · destinataire prévu : <strong>${cart.email || '(pas d\'email)'}</strong> · <em>non envoyé</em>
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
    if (sellHt <= 0) return res.status(400).send('Renseigne d\'abord le prix de vente');

    // Reconditionné → régime normal (TVA 20%) par défaut ; occasion → TVA sur marge.
    const isReconditionneLead = leadIsReconditionne(eq, cart);
    const _totals = computeQuoteTotals(pricing, isReconditionneLead);
    const vatRate = _totals.vatRate;
    const sellTtc = _totals.clientTotal; // marge : prix tout compris · normal : HT + TVA
    const vatScheme = _totals.isMargin ? 'margin' : 'normal';

    const b = req.body || {};
    const customMessage = String(b.customMessage || '').trim().slice(0, 2000);
    const depositPct = resolveDepositPct(b);
    const depositTtc = depositPct > 0 ? (sellTtc * depositPct / 100) : 0;
    const depositCents = Math.round(depositTtc * 100);
    const createMollie = String(b.createMollie || '').toLowerCase() === 'on' && MOLLIE_ENABLED && depositCents > 0;

    const quoteRef = (cart.requested && cart.requested.ref) || '';
    const admin = getAdminInfo(req);

    const stockLocation = (eq.stock && eq.stock.location) || '';
    const stockLabelClient = STOCK_CLIENT_LABELS[stockLocation] || '';
    const delay = (eq.stock && eq.stock.estimatedDelay) || '';

    // État du moteur (occasion vs reconditionné) → libellés client-facing.
    // Fallback déduit de la source du lead si le commercial n'a pas choisi
    // l'état : garantit recond → devis recond, occasion → devis occasion.
    const conditionKey = (eq.identifiedEngine && eq.identifiedEngine.condition) || defaultConditionFromLead(cart);
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
    let publicBase = String(process.env.PUBLIC_BASE_URL || brand.SITE_URL || 'https://autoliva.com').trim().replace(/\/+$/, '');
    // Garde-fou : un lien SMS sans protocole (ex. « autoliva.com/d/X ») n'est pas
    // cliquable / non reconnu comme URL → on force https:// si absent.
    if (!/^https?:\/\//i.test(publicBase)) publicBase = 'https://' + publicBase;
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
      pricing: { sellPrice: sellHt, vatRate, vatScheme, purchasePrice: pricing.purchasePrice, additionalFees: pricing.additionalFees },
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
      vatScheme,
      stockLocation,
      mollieUrl,
      customMessage,
      photoCount: photoAttachments.length,
      brandPhone: brand.PHONE_MOTEUR,
      brandPhoneIntl: brand.PHONE_MOTEUR_INTL,
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

    // Lien court de marque pour le SMS (autoliva.com/d/<code>) : bien plus
    // lisible et rassurant que la longue URL /api/devis-moteurs/track-pdf/…
    // qui débordait sur 4 lignes. Enregistre la vue "PDF" comme le lien tracké.
    const shortCode = await generateUniqueShortCode();
    const pdfShortUrl = publicBase + '/d/' + shortCode;

    // 6bis) SMS "devis prêt" (best-effort) — garantit que le client VOIT son
    // devis (~98% d'ouverture) même si l'email passe en spam. Le lien court
    // amène droit au devis ET enregistre "PDF vu" → ce qui déclenche l'alerte
    // "lead chaud" → le commercial rappelle au bon moment.
    let devisSmsResult = null;
    if (cart.phone) {
      try {
        // Format GSM-7 (évite l'espace insécable de toLocaleString qui forcerait
        // l'encodage Unicode → segments de 70 car. au lieu de 160).
        const totalTtcFmt = sellTtc.toFixed(2).replace('.', ',') + ' €';
        const { enabled: smsOn, text: smsBody } = await resolveSms('moteur_devis', {
          quoteRef,
          totalTtc: totalTtcFmt,
          pdfUrl: pdfShortUrl,
          phoneMoteur: brand.PHONE_MOTEUR,
        });
        if (smsOn && smsBody) {
          const r = await sendSms({ to: cart.phone, text: smsBody });
          devisSmsResult = { status: r && r.ok ? 'sent' : 'failed', reason: (r && r.reason) || '', message: (r && r.message) || '', at: new Date(), phone: cart.phone };
          if (r && r.ok === false) console.warn('[engine-quote] devis SMS non envoyé à', cart.phone, '→', r.reason, r.message || '');
        } else {
          devisSmsResult = { status: 'disabled', reason: 'disabled', message: 'Template SMS « devis envoyé » désactivé.', at: new Date(), phone: cart.phone };
        }
      } catch (err) {
        devisSmsResult = { status: 'failed', reason: 'exception', message: (err && err.message) || 'Erreur', at: new Date(), phone: cart.phone };
        console.warn('[engine-quote] devis SMS failed:', err && err.message);
      }
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
            version: (Array.isArray(eq.sentQuotes) ? eq.sentQuotes.length : 0) + 1,
            pdfId: pdfSaved.id,
            pdfUrl: pdfSaved.url,
            shortCode,
            sellPriceHt: sellHt,
            sellPriceTtc: sellTtc,
            depositCents,
            mollieUrl,
            mollieId,
            customMessage,
            sentByName: admin.name,
            sms: devisSmsResult,
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

/* ─── TABLEAU DE CONVERSION (FUNNEL) ─────────────────────────────────────
 * Agrège le tunnel devis moteur sur une période : leads → chiffrés → PDF
 * consulté → converti (acompte/gagné), avec temps de réponse et fuite n°1.
 * NB : l'ouverture email (pixel) est volontairement reléguée en métrique
 * secondaire — elle est peu fiable (Apple Mail/Gmail bloquent les pixels) et
 * le canal SMS n'« ouvre » jamais l'email. Le vrai signal d'engagement est
 * « PDF consulté » (clic sur le lien email OU SMS). */
const FUNNEL_MS_DAY = 24 * 60 * 60 * 1000;

function fmtDelay(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const minutes = ms / (60 * 1000);
  if (minutes < 60) return Math.round(minutes) + ' min';
  const hours = ms / (60 * 60 * 1000);
  if (hours < 48) return String(Math.round(hours * 10) / 10).replace('.', ',') + ' h';
  return String(Math.round((hours / 24) * 10) / 10).replace('.', ',') + ' j';
}

function median(arr) {
  if (!arr.length) return NaN;
  const s = arr.slice().sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

async function getEngineQuoteFunnel(req, res, next) {
  try {
    const period = ['30d', 'month', '90d', 'all'].includes(req.query.period) ? req.query.period : '30d';
    const periodLabels = { '30d': '30 derniers jours', month: 'Ce mois-ci', '90d': '90 derniers jours', all: 'Depuis le début' };
    const now = new Date();
    let since = null;
    if (period === 'month') since = new Date(now.getFullYear(), now.getMonth(), 1);
    else if (period === '90d') since = new Date(now.getTime() - 90 * FUNNEL_MS_DAY);
    else if (period === '30d') since = new Date(now.getTime() - 30 * FUNNEL_MS_DAY);

    const query = { captureSource: 'landing_moteurs' };
    if (since) query.createdAt = { $gte: since };

    const carts = await AbandonedCart.find(query)
      .select('createdAt engineQuote.status engineQuote.sentQuotes')
      .lean();

    let leads = carts.length;
    let quoted = 0, opened = 0, pdfViewed = 0, payClicked = 0, converted = 0, won = 0, lost = 0, unquoted = 0;
    const responseTimes = [];

    for (const c of carts) {
      const eq = c.engineQuote || {};
      const sq = Array.isArray(eq.sentQuotes) ? eq.sentQuotes : [];
      const status = eq.status || 'new';

      if (sq.length) {
        quoted += 1;
        let firstSent = null;
        for (const s of sq) {
          if (s && s.sentAt && (!firstSent || new Date(s.sentAt) < new Date(firstSent))) firstSent = s.sentAt;
        }
        if (firstSent && c.createdAt) {
          const dt = new Date(firstSent).getTime() - new Date(c.createdAt).getTime();
          if (dt >= 0) responseTimes.push(dt);
        }
        if (sq.some((s) => s && s.openedAt)) opened += 1;
        if (sq.some((s) => s && s.pdfViewedAt)) pdfViewed += 1;
        if (sq.some((s) => s && s.payClickedAt)) payClicked += 1;
      } else if (status === 'new' || status === 'analyzing') {
        unquoted += 1;
      }

      if (status === 'acompte_recu' || status === 'won') converted += 1;
      if (status === 'won') won += 1;
      if (status === 'lost') lost += 1;
    }

    const pct = (n) => (leads > 0 ? Math.round((n / leads) * 1000) / 10 : 0);
    const step = (n, prev) => (prev > 0 ? Math.round((n / prev) * 1000) / 10 : null);

    const stages = [
      { key: 'leads', label: 'Leads reçus', hint: 'demandes de devis', count: leads, ofLeads: 100, fromPrev: null },
      { key: 'quoted', label: 'Devis chiffrés', hint: 'tu as envoyé un devis', count: quoted, ofLeads: pct(quoted), fromPrev: step(quoted, leads) },
      { key: 'pdf', label: 'PDF consulté', hint: 'le client a vu le devis', count: pdfViewed, ofLeads: pct(pdfViewed), fromPrev: step(pdfViewed, quoted) },
      { key: 'converted', label: 'Acompte / gagné', hint: 'le client a payé', count: converted, ofLeads: pct(converted), fromPrev: step(converted, pdfViewed) },
    ];

    // Fuite n°1 = transition avec la plus grosse perte absolue
    let biggestDrop = null;
    for (let i = 1; i < stages.length; i += 1) {
      const lossN = stages[i - 1].count - stages[i].count;
      if (lossN > 0 && (!biggestDrop || lossN > biggestDrop.lossN)) {
        const lossPct = stages[i - 1].count > 0 ? Math.round((lossN / stages[i - 1].count) * 100) : 0;
        biggestDrop = { fromKey: stages[i - 1].key, from: stages[i - 1].label, to: stages[i].label, lossN, lossPct };
      }
    }

    // Conseil contextuel selon la fuite n°1
    const adviceByStage = {
      quoted: 'Tu ne chiffres pas tous tes leads (ou pas assez vite). Sur le moteur, le premier qui chiffre gagne : vise un devis < 2 h. Regarde le « temps de réponse » ci-dessous.',
      pdf: 'Tes devis partent mais le client ne les ouvre pas. Soit le canal ne passe pas (email en spam → le SMS lien court aide), soit l\'objet/le SMS ne donne pas envie de cliquer.',
      converted: 'Le client VOIT le devis mais ne paie pas. C\'est du prix, de la confiance (photos, garantie, avis) ou de la relance/closing. C\'est le levier le plus rentable à travailler.',
    };
    const advice = biggestDrop ? (adviceByStage[biggestDrop.to === 'Devis chiffrés' ? 'quoted' : biggestDrop.to === 'PDF consulté' ? 'pdf' : 'converted'] || '') : '';

    const respMedian = median(responseTimes);
    const respAvg = responseTimes.length ? responseTimes.reduce((a, b) => a + b, 0) / responseTimes.length : NaN;

    return res.render('admin/engine-quote-funnel', {
      title: 'Conversion devis · Admin',
      activeKey: 'engine-quotes',
      period,
      periodLabel: periodLabels[period],
      stages,
      biggestDrop,
      advice,
      unquoted,
      opened,
      payClicked,
      won,
      lost,
      leads,
      conversionGlobalPct: pct(converted),
      respMedianLabel: fmtDelay(respMedian),
      respAvgLabel: fmtDelay(respAvg),
      respSample: responseTimes.length,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getEngineQuotesList,
  getEngineQuoteFunnel,
  getEngineQuoteNew,
  postCreateEngineQuote,
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
  postShipment,
  postSendQuote,
  postPreviewPdf,
  postPreviewEmail,
  getPreviewMail,
};
