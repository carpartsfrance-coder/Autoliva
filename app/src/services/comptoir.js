'use strict';

/**
 * Connecteur **Comptoir** (getcomptoir.fr) — « Vendez partout. Comptez ici. »
 *
 * Pousse chaque commande encaissée vers Comptoir, qui sert de tableau de bord
 * unique des ventes toutes places de marché confondues.
 *
 * Guide officiel : https://getcomptoir.fr/guide-connecteur.html
 *
 *   POST <endpoint>              (défaut https://getcomptoir.fr/api/ingest/orders)
 *   Authorization: Bearer <clé>
 *   { externalId, amount, status, date, customerName, productName }
 *
 * Seul `amount` est obligatoire côté Comptoir ; on envoie tout ce qu'on a.
 *
 * ── DEUX PROPRIÉTÉS DE LEUR API QUI DICTENT TOUTE LA CONCEPTION ICI ─────────
 *
 * 1. ANTI-DOUBLON par `externalId` : renvoyer la même commande est sans effet
 *    (réponse 200 avec `duplicate: true`). Un réessai est donc TOUJOURS sûr —
 *    d'où le rattrapage périodique (src/jobs/syncComptoirOrders.js) plutôt
 *    qu'un envoi « au fil de l'eau » qu'un incident réseau perdrait en silence.
 *
 * 2. CRÉATION SEULEMENT : cette même protection empêche de METTRE À JOUR une
 *    commande déjà envoyée. Le statut transmis est donc figé à l'instant de
 *    l'envoi. On envoie au PAIEMENT (statut `preparation`) : une commande
 *    livrée plus tard n'apparaîtra pas « livree » côté Comptoir, mais elle
 *    sera comptée — ce qui est l'objet de l'outil. Un renvoi ultérieur ne
 *    corrigerait rien, inutile d'essayer.
 *
 * ── ACTIVATION ─────────────────────────────────────────────────────────────
 * Tant que `COMPTOIR_API_KEY` est absente, TOUT est no-op : aucun appel,
 * aucune écriture, aucune erreur. Déployable avant même d'avoir créé le
 * connecteur côté Comptoir.
 *
 * Variables d'env (Render) :
 *   COMPTOIR_API_KEY    clé affichée UNE SEULE FOIS à la création du connecteur
 *                       (app Comptoir → Connecteurs → + Connecteur personnalisé)
 *   COMPTOIR_ENDPOINT   URL complète, si Comptoir en affiche une autre que le défaut
 *   COMPTOIR_TIMEOUT_MS délai d'attente réseau (défaut 8000)
 */

const DEFAULT_ENDPOINT = 'https://getcomptoir.fr/api/ingest/orders';
const DEFAULT_TIMEOUT_MS = 8000;

function env(k) {
  return typeof process.env[k] === 'string' ? process.env[k].trim() : '';
}

function getApiKey() {
  return env('COMPTOIR_API_KEY');
}

function getEndpoint() {
  return env('COMPTOIR_ENDPOINT') || DEFAULT_ENDPOINT;
}

function getTimeoutMs() {
  const n = parseInt(env('COMPTOIR_TIMEOUT_MS'), 10);
  return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_TIMEOUT_MS;
}

/** Sans clé API, le connecteur n'existe pas : tout no-op. */
function isConfigured() {
  return getApiKey().length > 0;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Statuts
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Statuts Autoliva → les trois seuls statuts de Comptoir.
 *
 * `draft` et `pending_payment` n'y figurent pas volontairement : une commande
 * non payée n'a rien à faire dans un compteur de ventes (cf. isEncaissee).
 */
const STATUS_MAP = {
  paid: 'preparation',
  processing: 'preparation',
  label_created: 'preparation',
  shipped: 'livree',
  delivered: 'livree',
  completed: 'livree',
  cancelled: 'retour',
  refunded: 'retour',
  partially_refunded: 'retour',
};

function mapStatus(status) {
  return STATUS_MAP[String(status || '').trim()] || 'preparation';
}

/** Statuts de paiement qui valent « argent encaissé » (cf. adminController). */
const PAID_PAYMENT_STATUSES = new Set(['paid', 'captured', 'completed']);

/**
 * La commande représente-t-elle une vente réellement encaissée ?
 *
 * On se fie à `paymentStatus` (posé par Mollie/Scalapay/l'admin) et non au
 * statut commercial : un brouillon passé en « processing » à la main sans
 * encaissement ne doit pas gonfler le compteur.
 */
function isEncaissee(order) {
  if (!order) return false;
  const p = String(order.paymentStatus || '').trim().toLowerCase();
  return PAID_PAYMENT_STATUSES.has(p);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Payload
 * ────────────────────────────────────────────────────────────────────────── */

function trimStr(v, max) {
  const s = String(v == null ? '' : v).trim();
  return max ? s.slice(0, max) : s;
}

/** Libellé produit : le premier article, en signalant qu'il y en a d'autres. */
function buildProductName(order) {
  const items = Array.isArray(order && order.items) ? order.items.filter(Boolean) : [];
  if (!items.length) return '';
  const first = trimStr(items[0].name, 180);
  if (items.length === 1) return first;
  return trimStr(`${first} (+${items.length - 1} autre${items.length > 2 ? 's' : ''})`, 200);
}

/** Date de la vente : l'encaissement s'il est connu, sinon la création. */
function saleDate(order) {
  const d = (order && (order.molliePaidAt || order.scalapayCapturedAt || order.createdAt)) || null;
  const dt = d ? new Date(d) : null;
  return dt && !Number.isNaN(dt.getTime()) ? dt : new Date();
}

/**
 * Construit le corps de la requête. Pur (aucun accès réseau ni base) : c'est
 * ce que les tests unitaires vérifient.
 */
function buildPayload(order) {
  const payload = {
    externalId: trimStr(order && order.number, 120),
    amount: Math.round(Number((order && order.totalCents) || 0)) / 100,
    status: mapStatus(order && order.status),
    date: saleDate(order).toISOString(),
  };

  const customerName = trimStr(
    (order && order.billingAddress && order.billingAddress.fullName)
      || (order && order.shippingAddress && order.shippingAddress.fullName)
      || '',
    160
  );
  if (customerName) payload.customerName = customerName;

  const productName = buildProductName(order);
  if (productName) payload.productName = productName;

  /* Quantité du PREMIER article — celui qui donne son nom à la fiche côté
     Comptoir. Envoyer la somme de toutes les lignes associerait la quantité
     d'articles qu'on ne nomme pas au produit qu'on nomme. */
  const first = Array.isArray(order && order.items) ? order.items.filter(Boolean)[0] : null;
  const qty = first ? Math.round(Number(first.quantity)) : NaN;
  if (Number.isFinite(qty) && qty > 0) payload.quantity = qty;

  return payload;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Envoi HTTP (aucune écriture en base — voir syncOrder)
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * @returns {Promise<{ok:boolean, skipped?:boolean, status?:number, duplicate?:boolean,
 *                     note?:string, error?:string}>}
 * Ne jette jamais : un incident Comptoir ne doit pas casser un encaissement.
 */
async function pushOrder(order) {
  if (!isConfigured()) return { ok: false, skipped: true, error: 'COMPTOIR_API_KEY absente' };
  if (!order) return { ok: false, error: 'commande absente' };

  const payload = buildPayload(order);
  if (!Number.isFinite(payload.amount) || payload.amount <= 0) {
    /* Comptoir répond 400 sur un montant nul : autant ne pas l'appeler, et
       surtout ne pas empiler des réessais qui échoueront toujours. */
    return { ok: false, error: `montant invalide (${payload.amount})`, permanent: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getTimeoutMs());

  try {
    const res = await fetch(getEndpoint(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const raw = await res.text();
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch (_) { /* réponse non JSON */ }

    if (res.status >= 200 && res.status < 300) {
      return {
        ok: true,
        status: res.status,
        duplicate: !!(body && body.duplicate),
        note: trimStr(body && body.note, 300),
      };
    }

    /* 400 (montant/date invalides) et 401 (clé morte) ne passeront jamais en
       réessayant : on le dit, le rattrapage arrêtera de les reprendre. */
    const permanent = res.status === 400 || res.status === 401;
    const message = trimStr((body && (body.error || body.message)) || raw, 300)
      || `HTTP ${res.status}`;
    return { ok: false, status: res.status, error: message, permanent };
  } catch (err) {
    const message = err && err.name === 'AbortError'
      ? `délai dépassé (${getTimeoutMs()} ms)`
      : trimStr(err && err.message, 300) || 'erreur réseau';
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * Envoi + marquage en base
 * ────────────────────────────────────────────────────────────────────────── */

const MAX_ATTEMPTS = 5;

/**
 * Envoie une commande à Comptoir et trace le résultat sur la commande
 * (`order.comptoir`), de sorte qu'elle ne soit jamais envoyée deux fois et
 * qu'un échec reste visible dans `lastError` — pas avalé par un `.catch()`.
 *
 * Idempotent : appelable depuis le paiement ET depuis le rattrapage.
 *
 * @param {string|object} orderOrId commande ou identifiant
 * @param {{force?:boolean}} [options] force : renvoyer même si déjà marquée envoyée
 */
async function syncOrder(orderOrId, options = {}) {
  if (!isConfigured()) return { ok: false, skipped: true, reason: 'non_configure' };

  const Order = require('../models/Order');
  const id = orderOrId && orderOrId._id ? orderOrId._id : orderOrId;
  if (!id) return { ok: false, skipped: true, reason: 'id_absent' };

  const order = await Order.findById(id).lean();
  if (!order) return { ok: false, skipped: true, reason: 'introuvable' };

  const state = order.comptoir || {};
  if (state.sentAt && !options.force) return { ok: true, skipped: true, reason: 'deja_envoyee' };
  if (!isEncaissee(order)) return { ok: false, skipped: true, reason: 'non_encaissee' };
  if (order.deletedAt) return { ok: false, skipped: true, reason: 'supprimee' };

  const result = await pushOrder(order);

  if (result.ok) {
    await Order.updateOne({ _id: order._id }, {
      $set: {
        'comptoir.sentAt': new Date(),
        'comptoir.externalId': buildPayload(order).externalId,
        'comptoir.duplicate': !!result.duplicate,
        'comptoir.lastAttemptAt': new Date(),
        'comptoir.lastError': '',
        /* Un envoi qui passe efface le verdict « définitif » d'un échec
           antérieur : sans ça, une commande poussée après une clé corrigée
           gardait `permanentError: true` et sortait du rattrapage pour de bon
           (vécu le 09/09/2026 — backfill lancé une première fois avec un
           placeholder de clé, donc 251 commandes en 401 puis renvoyées). */
        'comptoir.permanentError': false,
      },
      $inc: { 'comptoir.attempts': 1 },
    });
    console.log(`[comptoir] ${order.number} envoyée${result.duplicate ? ' (déjà connue de Comptoir)' : ''}`);
    return { ok: true, duplicate: !!result.duplicate, note: result.note };
  }

  if (result.skipped) return { ok: false, skipped: true, reason: 'non_configure' };

  await Order.updateOne({ _id: order._id }, {
    $set: {
      'comptoir.lastAttemptAt': new Date(),
      'comptoir.lastError': trimStr(result.error, 300),
      'comptoir.permanentError': !!result.permanent,
    },
    $inc: { 'comptoir.attempts': 1 },
  });
  console.error(`[comptoir] échec ${order.number} : ${result.error}`);
  return { ok: false, error: result.error, permanent: !!result.permanent };
}

/**
 * Déclenche un envoi sans attendre — pour les chemins de paiement, où l'on ne
 * veut pas faire patienter le client derrière un appel à Comptoir.
 *
 * Le rattrapage horaire reprendra la commande si l'appel échoue : rien n'est
 * perdu, contrairement à un `.catch(() => {})` muet.
 */
function syncOrderInBackground(orderOrId) {
  if (!isConfigured()) return;
  Promise.resolve()
    .then(() => syncOrder(orderOrId))
    .catch((err) => {
      console.error('[comptoir] erreur inattendue :', err && err.message ? err.message : err);
    });
}

module.exports = {
  DEFAULT_ENDPOINT,
  isConfigured,
  getEndpoint,
  mapStatus,
  isEncaissee,
  buildPayload,
  buildProductName,
  pushOrder,
  syncOrder,
  syncOrderInBackground,
  MAX_ATTEMPTS,
};
