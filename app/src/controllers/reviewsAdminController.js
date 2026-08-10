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
  /* Skeepers ne sollicite pas au-delà de 6 mois après l'achat. On le dit ICI
     plutôt que de laisser partir la requête : l'API accepte l'événement sans
     broncher et n'envoie jamais l'e-mail — une panne silencieuse qui nous a
     déjà coûté du temps sur CP2026-000199. */
  const age = skeepers.ageEnJours(order);
  if (age > skeepers.AGE_MAX_JOURS) {
    return `commande de ${age} jours — Skeepers ne sollicite pas au-delà de 6 mois`;
  }
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
    // Surface le corps d'erreur Skeepers (et pas seulement le code HTTP) pour diagnostic.
    const detail = r.error == null ? '' : (typeof r.error === 'string' ? r.error : JSON.stringify(r.error));
    const base = r.reason || (r.status ? `Skeepers a répondu HTTP ${r.status}` : 'échec Skeepers');
    return { ok: false, sent: 0, skipped, error: base + (detail && detail !== '{}' ? ` — ${detail.slice(0, 400)}` : '') };
  }

  await Order.updateMany(
    { _id: { $in: acceptedIds } },
    { $set: { 'notifications.skeepersReviewRequestedAt': new Date() } }
  );

  /* La réponse de Skeepers était jetée. C'est pourtant LA SEULE chose qu'ils
     nous disent de ce qu'ils vont faire de l'événement — un endpoint de bulk
     rapporte en général ce qui a été retenu et ce qui a été écarté.
     Sans elle, « envoyé » ne prouve que le HTTP 200, et on se retrouve à
     chercher pourquoi aucun e-mail n'arrive sans le moindre indice.
     Journalisée côté serveur ET renvoyée à l'admin. */
  try {
    console.log('[skeepers] push OK (' + events.length + ' évènement(s)) — réponse : '
      + JSON.stringify(r.response).slice(0, 1000));
  } catch (_) { /* la journalisation ne doit jamais faire échouer l'envoi */ }

  return { ok: true, sent: events.length, skipped, reponseSkeepers: r.response };
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
    if (result.ok) {
      /* On annonce la date d'envoi CALCULÉE et le destinataire. Sans ça,
         « Demande d'avis envoyée » laisse croire que le client reçoit un e-mail
         dans la seconde — alors que c'est Skeepers qui l'expédie, à la date
         programmée. C'est cette confusion qui a fait chercher une panne
         inexistante. Et c'est le seul moyen de comparer avec la date affichée
         dans leur dashboard. */
      const o = orders[0];
      const u = o && userMap[String(o.userId)];
      const quand = skeepers.dateEnvoiPrevue(o);
      const jour = quand.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
      const imminent = skeepers.delaiPourCommande(o) - skeepers.ageEnJours(o) === 0;
      return res.json({
        ok: true,
        /* « Acceptée par Skeepers » et non « envoyée » : on ne constate qu'un
           HTTP 200 sur l'événement d'achat. L'e-mail part de chez eux, à la
           date programmée, et rien de notre côté ne peut le confirmer. Dire
           « envoyée » a déjà fait chercher une panne inexistante. */
        message: 'Acceptée par Skeepers. Envoi prévu ' + (imminent ? "aujourd'hui" : 'le ' + jour)
          + (u && u.email ? ' à ' + u.email : '') + '.',
        envoiPrevu: quand.toISOString(),
        /* Ce que Skeepers a répondu, mot pour mot : la seule information dont
           on dispose sur ce qu'ils comptent faire de l'événement. */
        reponseSkeepers: result.reponseSkeepers,
      });
    }
    const why = (result.skipped && result.skipped[0] && result.skipped[0].reason) || result.error || result.reason;
    return res.status(400).json({ ok: false, error: why || 'Échec.' });
  } catch (e) {
    return res.status(500).json({ ok: false, error: String((e && e.message) || e).slice(0, 300) });
  }
}

/** Diagnostic lecture seule : config présente ? auth Skeepers OK ? (jamais les secrets). */
/**
 * Masque une valeur sensible en gardant de quoi la RECONNAÎTRE.
 * Une clé secrète ne doit pas s'afficher, mais un simple `true` ne permet pas
 * de repérer une valeur tronquée au copier-coller ou un espace parasite — la
 * panne la plus banale sur une variable d'environnement.
 */
function empreinte(v) {
  const s = String(v || '');
  if (!s) return null;
  return { longueur: s.length, debut: s.slice(0, 4) + '…', fin: '…' + s.slice(-2) };
}

async function getReviewsDiagnostic(req, res) {
  const c = skeepers.config();
  const out = {
    configured: skeepers.isConfigured(),
    /* `websiteId` et `shopId` ne sont PAS des secrets : le premier est affiché
       en clair sur la page « Accès API » de Skeepers, le second est la clé de
       boutique choisie par nous. Les montrer en entier permet de les comparer
       d'un coup d'œil au dashboard — c'est tout l'intérêt de ce diagnostic. */
    websiteId: c.websiteId || null,
    shopId: c.shopId || null,
    clientId: empreinte(c.clientId),
    clientSecret: empreinte(c.clientSecret),
    env: { clientId: !!c.clientId, clientSecret: !!c.clientSecret, websiteId: !!c.websiteId },
    solicitationDelayDays: c.delay,
    auth: { ok: false },
  };
  const alertes = [];
  if (c.websiteIdCorrige) {
    alertes.push('SKEEPERS_WEBSITE_ID contient une URL entière au lieu de l\'identifiant seul. '
      + 'L\'identifiant a été extrait automatiquement (' + c.websiteId + ') et les envois fonctionnent, '
      + 'mais corrige la variable sur Render : c\'est cette valeur brute qui provoquait la 500 '
      + '« fetch Shop of website ».');
  }
  if (!c.shopId) {
    alertes.push('SKEEPERS_SHOP_ID absent : Skeepers devra résoudre la boutique lui-même '
      + '(« fetch Shop of website »), ce qui a déjà échoué par le passé.');
  }
  if (alertes.length) out.avertissements = alertes;
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
