'use strict';

/**
 * Demandes d'avis Skeepers / Avis Vérifiés (admin) — actions manuelles.
 *   POST /admin/commandes/demande-avis-multi     (bulk, body { orderIds: [...] })
 *   POST /admin/commandes/:orderId/demande-avis   (unitaire)
 *   GET  /admin/api/reviews/diagnostic            (config + auth, lecture seule)
 *
 * Pousse les commandes éligibles à Skeepers (Purchase Events API) → email d'avis
 * envoyé au client. Idempotent : pose notifications.skeepersReviewRequestedAt
 * UNIQUEMENT après un envoi réussi (jamais avant l'appel).
 */

const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const skeepers = require('../services/skeepersReviews');

const PAID_STATUSES = new Set(['paid', 'processing', 'label_created', 'shipped', 'delivered', 'completed']);

function eligibilityReason(order) {
  if (!order) return 'introuvable';
  if (order.archived === true) return 'archivée';
  if (order.deletedAt) return 'corbeille';
  if (!PAID_STATUSES.has(order.status)) return `statut « ${order.status} »`;
  return null;
}

async function loadOrdersWithUsers(orderIds) {
  const ids = (Array.isArray(orderIds) ? orderIds : [])
    .filter((id) => mongoose.Types.ObjectId.isValid(id))
    .map((id) => new mongoose.Types.ObjectId(id));
  if (!ids.length) return { orders: [], userMap: {} };
  const orders = await Order.find({ _id: { $in: ids } }).lean();
  const userIds = [...new Set(orders.map((o) => String(o.userId)).filter(Boolean))];
  const users = userIds.length
    ? await User.find({ _id: { $in: userIds } }).select('email firstName lastName').lean()
    : [];
  const userMap = {};
  users.forEach((u) => { userMap[String(u._id)] = u; });
  return { orders, userMap };
}

/** Filtre → build → push → flag. Retourne un rapport structuré (jamais throw sur données). */
async function processOrders(orders, userMap) {
  const events = [];
  const acceptedIds = [];
  const skipped = [];

  for (const o of orders) {
    const reason = eligibilityReason(o);
    if (reason) { skipped.push({ number: o.number || String(o._id), reason }); continue; }
    const ev = skeepers.buildPurchaseEvent(o, userMap[String(o.userId)]);
    if (!ev) { skipped.push({ number: o.number, reason: 'email client manquant' }); continue; }
    events.push(ev);
    acceptedIds.push(o._id);
  }

  if (!events.length) return { ok: false, sent: 0, skipped, reason: 'aucune commande éligible' };

  const r = await skeepers.pushPurchaseEvents(events);
  if (!r.ok) {
    return { ok: false, sent: 0, skipped, error: r.reason || (r.status ? `HTTP ${r.status}` : 'échec Skeepers') };
  }

  await Order.updateMany(
    { _id: { $in: acceptedIds } },
    { $set: { 'notifications.skeepersReviewRequestedAt': new Date() } }
  );
  return { ok: true, sent: events.length, skipped };
}

async function postRequestReviewBulk(req, res) {
  if (!skeepers.isConfigured()) {
    return res.status(400).json({ ok: false, error: 'Skeepers non configuré (variables SKEEPERS_* manquantes sur le serveur).' });
  }
  let ids = req.body && req.body.orderIds;
  if (typeof ids === 'string') ids = [ids];
  if (!Array.isArray(ids) || !ids.length) {
    return res.status(400).json({ ok: false, error: 'Aucune commande sélectionnée.' });
  }
  if (ids.length > skeepers.MAX_EVENTS_PER_REQUEST) {
    return res.status(400).json({ ok: false, error: `Maximum ${skeepers.MAX_EVENTS_PER_REQUEST} commandes par envoi.` });
  }
  try {
    const { orders, userMap } = await loadOrdersWithUsers(ids);
    return res.json(await processOrders(orders, userMap));
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e).slice(0, 300) });
  }
}

async function postRequestReviewSingle(req, res) {
  if (!skeepers.isConfigured()) {
    return res.status(400).json({ ok: false, error: 'Skeepers non configuré.' });
  }
  const id = req.params.orderId;
  if (!mongoose.Types.ObjectId.isValid(id)) {
    return res.status(400).json({ ok: false, error: 'Commande invalide.' });
  }
  try {
    const { orders, userMap } = await loadOrdersWithUsers([id]);
    const result = await processOrders(orders, userMap);
    if (result.ok) return res.json({ ok: true, message: "Demande d'avis envoyée." });
    const why = (result.skipped && result.skipped[0] && result.skipped[0].reason) || result.error || result.reason;
    return res.status(400).json({ ok: false, error: why || 'Échec.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e).slice(0, 300) });
  }
}

/** Diagnostic lecture seule : config présente ? auth Skeepers OK ? (jamais les secrets). */
async function getReviewsDiagnostic(req, res) {
  const c = skeepers.config();
  const out = {
    configured: skeepers.isConfigured(),
    env: { clientId: !!c.clientId, clientSecret: !!c.clientSecret, websiteId: !!c.websiteId },
    solicitationDelayDays: c.delay,
    auth: { ok: false },
  };
  if (!out.configured) {
    out.reason = 'Variables SKEEPERS_* incomplètes — les boutons « Demander un avis » restent inertes.';
    return res.json(out);
  }
  try {
    await skeepers.getAccessToken();
    out.auth.ok = true;
  } catch (e) {
    out.auth.error = String((e && e.message) || e).slice(0, 300);
  }
  return res.json(out);
}

module.exports = { postRequestReviewBulk, postRequestReviewSingle, getReviewsDiagnostic };
