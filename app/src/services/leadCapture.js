'use strict';

/**
 * Service unifié de capture de leads.
 *
 * Gère la création/upsert d'un AbandonedCart (= "Lead") quand un visiteur
 * laisse un canal de contact (email/téléphone) via :
 *   - formulaire /contact ou /devis
 *   - inscription newsletter
 *   - guest checkout
 *   - cron de détection de paniers abandonnés
 *
 * Toutes les fonctions sont non-bloquantes : si quoi que ce soit échoue,
 * on n'interrompt jamais le flow utilisateur.
 */

const mongoose = require('mongoose');

const AbandonedCart = require('../models/AbandonedCart');
const Product = require('../models/Product');

function trim(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeEmail(value) {
  const v = trim(value).toLowerCase();
  if (!v || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return '';
  return v;
}

function normalizePhone(value) {
  const v = trim(value);
  if (!v) return '';
  return v.replace(/[^+0-9]/g, '').slice(0, 24);
}

function readSessionId(req) {
  if (!req) return '';
  return String(req.sessionID || (req.session && req.session.id) || '');
}

function readUserId(req) {
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

function readCartFromSession(req) {
  if (!req || !req.session || !req.session.cart || typeof req.session.cart.items !== 'object') {
    return { items: [], totalCents: 0 };
  }
  return req.session.cart;
}

/**
 * Construit le tableau d'items + total à partir du panier en session.
 * Résout les noms/prix produits si nécessaire.
 */
async function buildCartSnapshot(sessionCart) {
  const rawItems = Object.values(sessionCart.items || {}).filter((it) => it && it.productId);
  if (rawItems.length === 0) return { items: [], totalAmountCents: 0 };

  const productIds = rawItems
    .filter((it) => mongoose.Types.ObjectId.isValid(it.productId))
    .map((it) => new mongoose.Types.ObjectId(it.productId));

  const products = await Product.find({ _id: { $in: productIds } })
    .select('_id name sku imageUrl galleryUrls priceCents')
    .lean();

  const pmap = new Map();
  products.forEach((p) => pmap.set(String(p._id), p));

  const items = [];
  let totalAmountCents = 0;
  for (const it of rawItems) {
    const p = pmap.get(String(it.productId));
    if (!p) continue;
    const priceCents = Number.isFinite(p.priceCents) ? p.priceCents : 0;
    const qty = Number(it.quantity) || 1;
    const gallery = Array.isArray(p.galleryUrls) ? p.galleryUrls : [];
    items.push({
      productId: p._id,
      name: p.name || 'Produit',
      sku: p.sku || '',
      price: priceCents,
      quantity: qty,
      image: p.imageUrl || gallery[0] || '',
      optionsSelection: it.optionsSelection || {},
      optionsSummary: it.optionsSummary || '',
    });
    totalAmountCents += priceCents * qty;
  }
  return { items, totalAmountCents };
}

/**
 * Capture un lead depuis un formulaire /contact ou /devis.
 *
 * @returns {Promise<{ leadId: string|null, created: boolean } | null>}
 */
async function captureContactLead({ req, mode, email, firstName, lastName, phone, message, productHints }) {
  try {
    if (mongoose.connection.readyState !== 1) return null;

    const cleanEmail = normalizeEmail(email);
    const cleanPhone = normalizePhone(phone);
    if (!cleanEmail && !cleanPhone) return null; // pas de canal de contact

    const sessionId = readSessionId(req);
    if (!sessionId) return null;

    const userId = readUserId(req);
    const attribution = readAttribution(req);
    const captureSource = mode === 'devis' ? 'devis' : 'contact';

    const cart = readCartFromSession(req);
    const { items, totalAmountCents } = await buildCartSnapshot(cart);

    const cleanFirst = trim(firstName);
    const cleanLast = trim(lastName);
    const cleanMessage = trim(message);

    /* Extraction structurée des hints produit */
    const hints = productHints || {};
    const requested = {
      vehicle: trim(hints.Vehicule || hints.vehicle).slice(0, 200),
      vin: trim(hints.VIN || hints.vin).toUpperCase().slice(0, 32),
      plate: trim(hints.Immat || hints.plate).toUpperCase().slice(0, 32), // 32 : ce champ reçoit aussi des VIN (17) via le formulaire moteur
      ref: trim(hints.Reference || hints.ref).slice(0, 200),
      message: cleanMessage.slice(0, 2000),
    };

    /* contextMessage gardé pour rétro-compat, mais ne sert qu'aux additions multi-touch */
    const contextMessage = '';

    const now = new Date();

    // 1. Cherche un lead existant pour cette session, ou pour cet email.
    //    Pour une demande de DEVIS portant sur un véhicule identifié (plaque /
    //    VIN / code moteur), on RESTREINT la dédup au MÊME véhicule : deux
    //    demandes pour deux véhicules différents = deux leads distincts (sinon
    //    elles fusionneraient sur un seul lead via la session/l'email). Un
    //    ré-envoi du MÊME véhicule retombe bien sur le même lead (anti-doublon
    //    + idempotence de l'auto-devis).
    const contactOr = [
      { sessionId },
      cleanEmail ? { email: cleanEmail, status: { $nin: ['recovered', 'expired'] } } : null,
    ].filter(Boolean);
    const existingFilter = (mode === 'devis' && requested.plate)
      ? { 'requested.plate': requested.plate, $or: contactOr }
      : { $or: contactOr };

    const existing = await AbandonedCart.findOne(existingFilter).sort({ createdAt: -1 }).lean();

    if (existing) {
      const update = {
        $set: {
          lastActivityAt: now,
        },
      };

      // N'écrase l'email/phone que s'ils sont vides actuellement.
      if (cleanEmail && !existing.email) update.$set.email = cleanEmail;
      if (cleanPhone && !existing.phone) update.$set.phone = cleanPhone;
      if (cleanFirst && !existing.firstName) update.$set.firstName = cleanFirst;
      if (cleanLast && !existing.lastName) update.$set.lastName = cleanLast;

      // EXCEPTION : sur une demande explicite (contact/devis), si le client
      // saisit un email DIFFÉRENT de celui déjà au dossier, il corrige
      // probablement une faute (ex: hmail.com → gmail.com) → on met à jour
      // l'email et on archive l'ancien en note (sinon le devis part à la
      // mauvaise adresse et le lead semble "perdu").
      const isExplicit = mode === 'devis' || mode === 'contact';
      const emailChanged = isExplicit && cleanEmail && existing.email && cleanEmail !== existing.email;
      if (emailChanged) {
        update.$set.email = cleanEmail;
      }

      // Promote captureSource: contact/devis prennent priorité sur cart_activity/guest_checkout
      const priority = ['', 'cart_activity', 'newsletter', 'guest_checkout', 'user', 'contact', 'devis', 'landing_moteurs', 'manual'];
      const currIdx = priority.indexOf(existing.captureSource || '');
      const newIdx = priority.indexOf(captureSource);
      if (newIdx > currIdx) update.$set.captureSource = captureSource;

      // Mise à jour de l'attribution si manquante
      if (attribution.source && !(existing.attribution && existing.attribution.source)) {
        update.$set.attribution = attribution;
      }

      /* Mise à jour des champs requested : on enrichit ce qui est vide,
         et si la nouvelle demande est différente, on archive l'ancienne dans contextMessage */
      const ex = existing.requested || {};
      const archivedDemands = [];
      // Si l'email a été corrigé, on garde une trace de l'ancien dans la note.
      if (emailChanged) {
        archivedDemands.push(`email corrigé (ancien: ${existing.email})`);
      }
      ['vehicle', 'vin', 'plate', 'ref', 'message'].forEach((k) => {
        if (requested[k] && !ex[k]) {
          update.$set[`requested.${k}`] = requested[k];
        } else if (requested[k] && ex[k] && requested[k] !== ex[k]) {
          archivedDemands.push(`${k}: ${requested[k]}`);
        }
      });
      if (archivedDemands.length > 0) {
        const dateTag = `[${now.toISOString().slice(0, 10)}]`;
        const addition = `${dateTag} Nouvelle demande — ${archivedDemands.join(' | ')}`;
        update.$set.contextMessage = (existing.contextMessage
          ? `${existing.contextMessage}\n---\n${addition}`
          : addition
        ).slice(0, 4000);
      }

      // Si pas d'items mais qu'on en a un nouveau snapshot, on enrichit
      if (items.length > 0 && (!existing.items || existing.items.length === 0)) {
        update.$set.items = items;
        update.$set.totalAmountCents = totalAmountCents;
      }

      await AbandonedCart.updateOne({ _id: existing._id }, update);
      return { leadId: String(existing._id), created: false };
    }

    // 2. Crée un nouveau lead
    const created = await AbandonedCart.create({
      sessionId,
      userId,
      email: cleanEmail,
      firstName: cleanFirst,
      lastName: cleanLast,
      phone: cleanPhone,
      isGuest: !userId,
      captureSource,
      items,
      totalAmountCents,
      requested,
      contextMessage,
      attribution,
      status: 'abandoned',
      abandonedAt: now,
      lastActivityAt: now,
    });

    return { leadId: String(created._id), created: true };
  } catch (err) {
    console.error('[leadCapture] captureContactLead error:', err && err.message ? err.message : err);
    return null;
  }
}

/**
 * Capture un lead depuis une inscription newsletter.
 * Si la session a déjà du cart activity → upgrade en lead avec les items.
 */
async function captureNewsletterLead({ req, email, source }) {
  try {
    if (mongoose.connection.readyState !== 1) return null;
    const cleanEmail = normalizeEmail(email);
    if (!cleanEmail) return null;
    const sessionId = readSessionId(req);
    if (!sessionId) return null;

    const cart = readCartFromSession(req);
    const { items, totalAmountCents } = await buildCartSnapshot(cart);

    // Si pas d'items dans le panier, pas la peine d'enregistrer comme "lead à relancer"
    // (la newsletter est déjà gérée par NewsletterSubscriber)
    if (items.length === 0) return null;

    const userId = readUserId(req);
    const attribution = readAttribution(req);
    const now = new Date();

    const existing = await AbandonedCart.findOne({
      $or: [{ sessionId }, { email: cleanEmail, status: { $nin: ['recovered', 'expired'] } }],
    }).sort({ createdAt: -1 }).lean();

    if (existing) {
      const update = { $set: { lastActivityAt: now } };
      if (!existing.email) update.$set.email = cleanEmail;
      if (!existing.captureSource || existing.captureSource === '') {
        update.$set.captureSource = 'newsletter';
      }
      if (items.length > 0 && (!existing.items || existing.items.length === 0)) {
        update.$set.items = items;
        update.$set.totalAmountCents = totalAmountCents;
      }
      await AbandonedCart.updateOne({ _id: existing._id }, update);
      return { leadId: String(existing._id), created: false };
    }

    const created = await AbandonedCart.create({
      sessionId,
      userId,
      email: cleanEmail,
      isGuest: !userId,
      captureSource: 'newsletter',
      items,
      totalAmountCents,
      attribution,
      contextMessage: source ? `Newsletter signup (source: ${source})` : 'Newsletter signup',
      status: 'abandoned',
      abandonedAt: now,
      lastActivityAt: now,
    });

    return { leadId: String(created._id), created: true };
  } catch (err) {
    console.error('[leadCapture] captureNewsletterLead error:', err && err.message ? err.message : err);
    return null;
  }
}

module.exports = {
  captureContactLead,
  captureNewsletterLead,
  buildCartSnapshot,
  normalizeEmail,
  normalizePhone,
};
