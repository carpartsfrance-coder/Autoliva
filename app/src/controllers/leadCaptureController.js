'use strict';

/**
 * Endpoints publics de capture de lead côté visiteur :
 *   - POST /api/lead/save-cart       (widget "sauvegarder mon panier")
 *   - POST /api/lead/product-quote   (bouton "recevoir un devis par email")
 *   - POST /api/lead/exit-intent     (popup d'intention de sortie)
 *
 * Tous écrivent dans AbandonedCart (= Lead) avec un captureSource adapté.
 * Le visiteur reçoit un email de confirmation. Le commercial le voit
 * apparaître dans /admin/activite-panier dans la foulée.
 */

const mongoose = require('mongoose');

const AbandonedCart = require('../models/AbandonedCart');
const Product = require('../models/Product');
const emailService = require('../services/emailService');
const { track: trackEvent, rememberEmail } = require('../services/eventTracker');
const {
  buildCartSnapshot,
  normalizeEmail,
  normalizePhone,
} = require('../services/leadCapture');
const brand = require('../config/brand');

function trim(v) { return typeof v === 'string' ? v.trim() : ''; }

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function getSessionId(req) {
  if (!req) return '';
  return String(req.sessionID || (req.session && req.session.id) || '');
}

function getUserId(req) {
  if (!req || !req.session || !req.session.user) return null;
  const u = req.session.user;
  if (u._id && mongoose.Types.ObjectId.isValid(u._id)) return u._id;
  return null;
}

function readAttribution(req) {
  const s = (req && req.session && req.session.attribution) || {};
  const last = s.lastTouch || s.firstTouch || {};
  return {
    source: trim(last.utmSource),
    medium: trim(last.utmMedium),
    campaign: trim(last.utmCampaign),
    referrer: trim(last.referrer),
    gclid: trim(last.gclid),
  };
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Rate limiting léger anti-spam (par IP, en mémoire)                      */
/* ──────────────────────────────────────────────────────────────────────── */

const RATE_BUCKETS = new Map();

function isRateLimited(req, max = 8, windowMs = 10 * 60 * 1000) {
  const xfwd = req && req.headers ? req.headers['x-forwarded-for'] : null;
  const fromHeader = Array.isArray(xfwd) ? xfwd[0] : (typeof xfwd === 'string' ? xfwd.split(',')[0] : '');
  const ip = trim(fromHeader) || (req && req.ip ? String(req.ip) : 'unknown');

  const now = Date.now();
  const entry = RATE_BUCKETS.get(ip);
  if (!entry || entry.resetAt <= now) {
    RATE_BUCKETS.set(ip, { count: 1, resetAt: now + windowMs });
    return false;
  }
  entry.count += 1;
  return entry.count > max;
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Builders                                                                */
/* ──────────────────────────────────────────────────────────────────────── */

async function buildItemFromProductId(productId) {
  if (!productId || !mongoose.Types.ObjectId.isValid(productId)) return null;
  const p = await Product.findById(productId)
    .select('_id name sku imageUrl galleryUrls priceCents')
    .lean();
  if (!p) return null;
  const priceCents = Number.isFinite(p.priceCents) ? p.priceCents : 0;
  const gallery = Array.isArray(p.galleryUrls) ? p.galleryUrls : [];
  return {
    productId: p._id,
    name: p.name || 'Produit',
    sku: p.sku || '',
    price: priceCents,
    quantity: 1,
    image: p.imageUrl || gallery[0] || '',
    optionsSelection: {},
    optionsSummary: '',
  };
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Email confirmation pour le visiteur                                     */
/* ──────────────────────────────────────────────────────────────────────── */

function buildPublicBaseUrl(req) {
  const fromEnv = trim(process.env.PUBLIC_BASE_URL);
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  if (req && req.protocol && req.headers && req.headers.host) {
    return `${req.protocol}://${req.headers.host}`.replace(/\/$/, '');
  }
  return 'https://autoliva.com';
}

async function sendVisitorAck({ req, kind, email, firstName, productName, recoveryToken }) {
  try {
    const baseUrl = buildPublicBaseUrl(req);
    const recoveryUrl = recoveryToken
      ? `${baseUrl}/panier/recuperer/${encodeURIComponent(recoveryToken)}`
      : `${baseUrl}/panier`;

    let subject;
    let intro;
    let cta;
    if (kind === 'save_cart') {
      subject = `Votre panier ${brand.NAME} est sauvegardé`;
      intro = 'Votre panier est bien sauvegardé. Vous pouvez le retrouver à tout moment en cliquant sur le bouton ci-dessous.';
      cta = 'Reprendre mon panier';
    } else if (kind === 'product_quote') {
      subject = `Votre demande de devis ${brand.NAME}`;
      intro = `Nous avons bien reçu votre demande${productName ? ` concernant ${productName}` : ''}. Notre équipe vous répond sous 24h ouvrées avec une proposition adaptée à votre véhicule.`;
      cta = '';
    } else if (kind === 'exit_intent') {
      subject = `Votre code promo ${brand.NAME}`;
      intro = `Merci pour votre confiance ! Voici votre code promo de bienvenue : <strong>BIENVENUE3</strong> , à utiliser sur votre prochaine commande (valable 30 jours).`;
      cta = 'Reprendre ma visite';
    } else {
      return;
    }

    const ctaBlock = cta ? `
      <div style="margin:24px 0;text-align:center;">
        <a href="${escapeHtml(recoveryUrl)}" style="display:inline-block;background:#dc2626;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;">${escapeHtml(cta)}</a>
      </div>` : '';

    const html = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;color:#111827;line-height:1.6;">
    <p style="margin:0 0 16px 0;font-size:15px;">Bonjour${firstName ? ' ' + escapeHtml(firstName) : ''},</p>
    <p style="margin:0 0 12px 0;font-size:14px;color:#374151;">${intro}</p>
    ${ctaBlock}
    <p style="margin:24px 0 0 0;font-size:13px;color:#6b7280;">Une question ? Répondez à cet email ou appelez le <a href="tel:${escapeHtml(brand.PHONE)}" style="color:#dc2626;">${escapeHtml(brand.PHONE)}</a>.</p>
    <p style="margin:8px 0 0 0;font-size:13px;color:#6b7280;">— L'équipe ${escapeHtml(brand.NAME)}</p>
  </div>
</body></html>`.trim();

    await emailService.sendEmail({
      toEmail: email,
      subject,
      html,
      text: `Bonjour${firstName ? ' ' + firstName : ''},\n\n${intro.replace(/<[^>]+>/g, '')}\n\n${cta ? recoveryUrl : ''}\n\n— L'équipe ${brand.NAME}`,
    });
  } catch (err) {
    console.error('[leadCapture] sendVisitorAck error:', err && err.message ? err.message : err);
  }
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Création / mise à jour du Lead                                          */
/* ──────────────────────────────────────────────────────────────────────── */

async function upsertLead({ req, email, phone, firstName, captureSource, productItem, message, vin, plate, vehicle }) {
  const sessionId = getSessionId(req);
  if (!sessionId) return null;

  const userId = getUserId(req);
  const now = new Date();
  const attribution = readAttribution(req);

  /* Snapshot du panier en session si présent */
  let items = [];
  let totalAmountCents = 0;
  if (req.session && req.session.cart) {
    const snap = await buildCartSnapshot(req.session.cart);
    items = snap.items;
    totalAmountCents = snap.totalAmountCents;
  }

  /* Si productItem fourni (ex: bouton devis sur fiche), on l'ajoute aux items
     s'il n'y est pas déjà */
  if (productItem) {
    const exists = items.some((it) => String(it.productId) === String(productItem.productId));
    if (!exists) {
      items.push(productItem);
      totalAmountCents += productItem.price * (productItem.quantity || 1);
    }
  }

  const requested = {
    vehicle: trim(vehicle).slice(0, 200),
    vin: trim(vin).toUpperCase().slice(0, 32),
    plate: trim(plate).toUpperCase().slice(0, 16),
    ref: productItem ? productItem.name.slice(0, 200) : '',
    message: trim(message).slice(0, 2000),
  };

  /* Cherche un lead existant par session ou email */
  const filter = {
    $or: [
      { sessionId },
      email ? { email, status: { $nin: ['recovered', 'expired'] } } : null,
    ].filter(Boolean),
  };
  const existing = await AbandonedCart.findOne(filter).sort({ createdAt: -1 }).lean();

  if (existing) {
    const update = { $set: { lastActivityAt: now } };
    if (email && !existing.email) update.$set.email = email;
    if (phone && !existing.phone) update.$set.phone = phone;
    if (firstName && !existing.firstName) update.$set.firstName = firstName;

    /* Promote captureSource selon priorité (devis/contact prennent priorité sur cart_activity) */
    const priority = ['', 'cart_activity', 'newsletter', 'guest_checkout', 'user', 'contact', 'devis', 'landing_moteurs', 'manual'];
    const currIdx = priority.indexOf(existing.captureSource || '');
    const newIdx = priority.indexOf(captureSource);
    if (newIdx > currIdx) update.$set.captureSource = captureSource;

    /* Enrichir requested */
    const ex = existing.requested || {};
    ['vehicle', 'vin', 'plate', 'ref', 'message'].forEach((k) => {
      if (requested[k] && !ex[k]) update.$set[`requested.${k}`] = requested[k];
    });

    if (items.length > 0 && (!existing.items || existing.items.length === 0)) {
      update.$set.items = items;
      update.$set.totalAmountCents = totalAmountCents;
    } else if (productItem && existing.items && !existing.items.some((it) => String(it.productId) === String(productItem.productId))) {
      // Ajoute le produit si pas déjà dans le lead
      update.$push = { items: productItem };
      update.$inc = { totalAmountCents: productItem.price * (productItem.quantity || 1) };
    }

    if (attribution.source && !(existing.attribution && existing.attribution.source)) {
      update.$set.attribution = attribution;
    }

    await AbandonedCart.updateOne({ _id: existing._id }, update);
    return { leadId: String(existing._id), recoveryToken: existing.recoveryToken, created: false };
  }

  /* Nouveau lead */
  const created = await AbandonedCart.create({
    sessionId,
    userId,
    email,
    firstName,
    phone,
    isGuest: !userId,
    captureSource,
    items,
    totalAmountCents,
    requested,
    attribution,
    status: 'abandoned',
    abandonedAt: now,
    lastActivityAt: now,
  });

  return { leadId: String(created._id), recoveryToken: created.recoveryToken, created: true };
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  Endpoints                                                               */
/* ──────────────────────────────────────────────────────────────────────── */

async function postSaveCart(req, res) {
  try {
    if (isRateLimited(req)) return res.status(429).json({ ok: false, error: 'too_many_requests' });
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ ok: false, error: 'db_down' });

    const email = normalizeEmail(req.body && req.body.email);
    const firstName = trim(req.body && req.body.firstName).slice(0, 80);
    if (!email) return res.status(400).json({ ok: false, error: 'invalid_email' });

    const result = await upsertLead({
      req,
      email,
      firstName,
      captureSource: 'cart_activity',
      message: 'Demande de sauvegarde panier',
    });

    if (!result) return res.status(500).json({ ok: false, error: 'create_failed' });

    rememberEmail(req, email);
    trackEvent(req, 'lead_capture', { meta: { kind: 'save_cart' }, target: email });

    /* Email de confirmation au visiteur */
    sendVisitorAck({
      req, kind: 'save_cart',
      email, firstName,
      recoveryToken: result.recoveryToken,
    }).catch(() => {});

    return res.json({ ok: true, leadId: result.leadId });
  } catch (err) {
    console.error('[leadCaptureController] save-cart error:', err && err.message ? err.message : err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
}

async function postProductQuote(req, res) {
  try {
    if (isRateLimited(req)) return res.status(429).json({ ok: false, error: 'too_many_requests' });
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ ok: false, error: 'db_down' });

    const email = normalizeEmail(req.body && req.body.email);
    const phone = normalizePhone(req.body && req.body.phone);
    const firstName = trim(req.body && req.body.firstName).slice(0, 80);
    const message = trim(req.body && req.body.message).slice(0, 1000);
    const vin = trim(req.body && req.body.vin).slice(0, 32);
    const plate = trim(req.body && req.body.plate).slice(0, 16);
    const productId = trim(req.body && req.body.productId);

    if (!email && !phone) return res.status(400).json({ ok: false, error: 'no_contact' });
    if (email && !email.includes('@')) return res.status(400).json({ ok: false, error: 'invalid_email' });

    const productItem = await buildItemFromProductId(productId);

    const result = await upsertLead({
      req,
      email,
      phone,
      firstName,
      captureSource: 'devis',
      productItem,
      message,
      vin,
      plate,
    });

    if (!result) return res.status(500).json({ ok: false, error: 'create_failed' });

    if (email) rememberEmail(req, email);
    trackEvent(req, 'lead_capture', { meta: { kind: 'product_quote' }, productId, target: email || phone });

    if (email) {
      sendVisitorAck({
        req, kind: 'product_quote',
        email, firstName,
        productName: productItem ? productItem.name : '',
        recoveryToken: result.recoveryToken,
      }).catch(() => {});
    }

    return res.json({ ok: true, leadId: result.leadId });
  } catch (err) {
    console.error('[leadCaptureController] product-quote error:', err && err.message ? err.message : err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
}

async function postBlogCta(req, res) {
  try {
    if (isRateLimited(req)) return res.status(429).json({ ok: false, error: 'too_many_requests' });
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ ok: false, error: 'db_down' });

    const email = normalizeEmail(req.body && req.body.email);
    const phone = normalizePhone(req.body && req.body.phone);
    const firstName = trim(req.body && req.body.firstName).slice(0, 80);
    const message = trim(req.body && req.body.message).slice(0, 1000);
    const vin = trim(req.body && req.body.vin).slice(0, 32);
    const plate = trim(req.body && req.body.plate).slice(0, 16);
    const vehicle = trim(req.body && req.body.vehicle).slice(0, 200);
    const articleSlug = trim(req.body && req.body.articleSlug).slice(0, 200);
    const articleTitle = trim(req.body && req.body.articleTitle).slice(0, 200);
    const productId = trim(req.body && req.body.productId);

    if (!email && !phone) return res.status(400).json({ ok: false, error: 'no_contact' });
    if (email && !email.includes('@')) return res.status(400).json({ ok: false, error: 'invalid_email' });

    const productItem = await buildItemFromProductId(productId);

    /* Le contexte ajoute l'origine article pour que le commercial sache
       quel sujet intéresse le visiteur (= ce qui a déclenché la demande) */
    const articleContext = articleTitle
      ? `Demande issue de l'article : "${articleTitle}"${articleSlug ? ` (/blog/${articleSlug})` : ''}`
      : 'Demande issue d\'un article du blog';
    const fullMessage = [articleContext, message].filter(Boolean).join('\n');

    const result = await upsertLead({
      req,
      email,
      phone,
      firstName,
      captureSource: 'blog_cta',
      productItem,
      message: fullMessage,
      vin,
      plate,
      vehicle,
    });

    if (!result) return res.status(500).json({ ok: false, error: 'create_failed' });

    if (email) rememberEmail(req, email);
    trackEvent(req, 'lead_capture', { meta: { kind: 'blog_cta', articleSlug }, productId, target: email || phone });

    if (email) {
      sendVisitorAck({
        req, kind: 'product_quote',
        email, firstName,
        productName: productItem ? productItem.name : '',
        recoveryToken: result.recoveryToken,
      }).catch(() => {});
    }

    return res.json({ ok: true, leadId: result.leadId });
  } catch (err) {
    console.error('[leadCaptureController] blog-cta error:', err && err.message ? err.message : err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
}

async function postExitIntent(req, res) {
  try {
    if (isRateLimited(req, 12, 30 * 60 * 1000)) return res.status(429).json({ ok: false, error: 'too_many_requests' });
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ ok: false, error: 'db_down' });

    const email = normalizeEmail(req.body && req.body.email);
    const productId = trim(req.body && req.body.productId);
    if (!email) return res.status(400).json({ ok: false, error: 'invalid_email' });

    const productItem = await buildItemFromProductId(productId);

    const result = await upsertLead({
      req,
      email,
      captureSource: 'cart_activity',
      productItem,
      message: 'Email saisi via popup d\'intention de sortie (BIENVENUE3)',
    });

    if (!result) return res.status(500).json({ ok: false, error: 'create_failed' });

    rememberEmail(req, email);
    trackEvent(req, 'lead_capture', { meta: { kind: 'exit_intent' }, productId, target: email });

    sendVisitorAck({
      req, kind: 'exit_intent',
      email,
      productName: productItem ? productItem.name : '',
      recoveryToken: result.recoveryToken,
    }).catch(() => {});

    return res.json({ ok: true, leadId: result.leadId, code: 'BIENVENUE3' });
  } catch (err) {
    console.error('[leadCaptureController] exit-intent error:', err && err.message ? err.message : err);
    return res.status(500).json({ ok: false, error: 'server_error' });
  }
}

module.exports = {
  postSaveCart,
  postProductQuote,
  postBlogCta,
  postExitIntent,
};
