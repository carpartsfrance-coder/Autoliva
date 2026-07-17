'use strict';

/**
 * Client Skeepers / Avis Vérifiés — **Purchase Events API**.
 *
 * Pousse des commandes (client + produits) vers Skeepers, qui envoie ensuite la
 * demande d'avis (avis SITE + avis PRODUIT selon purchase_event_type). Récupérer
 * de VRAIS avis permet de réafficher les étoiles en SERP légitimement (le bloc
 * JSON-LD AggregateRating conditionnel côté fiches est déjà prêt à les émettre).
 *
 * Contexte : l'ancien « connecteur » (plugin WooCommerce) ne collecte plus depuis
 * la migration vers le site custom → l'API est désormais le seul canal viable.
 *
 * Auth (OAuth2 client_credentials, Basic base64(clientId:clientSecret)) :
 *   POST https://auth.skeepers.io/realms/skeepers/protocol/openid-connect/token
 *        grant_type=client_credentials&scope=openid
 * Envoi (max 50 événements / requête) :
 *   POST https://api.skeepers.io/purchase-event/websites/{websiteId}/purchase_events/bulk_sync_insert
 *
 * `fetch` natif (Node 18+). 100 % piloté par variables d'env : si non configuré →
 * isConfigured() = false et tout no-op → SÛR à déployer avant l'onboarding.
 *
 * Variables d'env (Render) :
 *   SKEEPERS_CLIENT_ID                 identifiant client API (onglet API du dashboard)
 *   SKEEPERS_CLIENT_SECRET             secret client API
 *   SKEEPERS_WEBSITE_ID                uuid du site (ID du site)
 *   SKEEPERS_SOLICITATION_DELAY        jours avant l'email d'avis site (défaut 7)
 *   SKEEPERS_SOLICITATION_DELAY_PRODUCT  idem pour l'avis produit (défaut = DELAY)
 */

const OAUTH_URL = 'https://auth.skeepers.io/realms/skeepers/protocol/openid-connect/token';
const API_BASE = 'https://api.skeepers.io/purchase-event';
const MAX_EVENTS_PER_REQUEST = 50;

function env(k) { return typeof process.env[k] === 'string' ? process.env[k].trim() : ''; }
function intEnv(k, d) { const n = parseInt(env(k), 10); return Number.isFinite(n) && n >= 0 ? n : d; }
function trimStr(s, max) { const v = String(s == null ? '' : s).trim(); return max ? v.slice(0, max) : v; }

function config() {
  const delay = intEnv('SKEEPERS_SOLICITATION_DELAY', 7);
  return {
    clientId: env('SKEEPERS_CLIENT_ID'),
    clientSecret: env('SKEEPERS_CLIENT_SECRET'),
    websiteId: env('SKEEPERS_WEBSITE_ID'),
    delay,
    delayProduct: intEnv('SKEEPERS_SOLICITATION_DELAY_PRODUCT', delay),
  };
}

/** Configuration minimale présente ? (sans ça, tout no-op). */
function isConfigured() {
  const c = config();
  return !!(c.clientId && c.clientSecret && c.websiteId);
}

// Cache du token d'accès OAuth (client_credentials, ~5 min chez Skeepers).
let _token = { value: '', expiresAt: 0 };

async function getAccessToken() {
  const now = Date.now();
  if (_token.value && _token.expiresAt > now + 30000) return _token.value;
  const c = config();
  const basic = Buffer.from(`${c.clientId}:${c.clientSecret}`).toString('base64');
  const res = await fetch(OAUTH_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Basic ${basic}`,
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams({ grant_type: 'client_credentials', scope: 'openid' }),
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`Skeepers OAuth ${res.status}: ${t.slice(0, 300)}`);
  }
  const j = await res.json();
  _token = { value: j.access_token, expiresAt: now + (Number(j.expires_in || 300) * 1000) };
  return _token.value;
}

function toIso(date) {
  const d = (date instanceof Date) ? date : new Date(date || Date.now());
  return d.toISOString().replace(/\.\d{3}Z$/, 'Z'); // "yyyy-MM-ddTHH:mm:ssZ"
}

/**
 * Construit un purchase event Skeepers depuis une commande + son client.
 * L'email/nom vivent sur User (order.userId), PAS sur Order.
 * @param {Object} order  document Order (lean) : number, items[], createdAt, totalCents, shippingAddress
 * @param {Object} user   { email, firstName, lastName } résolu depuis order.userId
 * @returns {Object|null} l'événement, ou null si email client manquant (sollicitation impossible)
 */
function buildPurchaseEvent(order, user) {
  const c = config();
  const email = trimStr(user && user.email);
  if (!email) return null;

  const fullName = trimStr(order && order.shippingAddress && order.shippingAddress.fullName);
  const firstName = trimStr(user && user.firstName) || (fullName ? fullName.split(/\s+/)[0] : '') || 'Client';
  const lastName = trimStr(user && user.lastName)
    || (fullName ? fullName.split(/\s+/).slice(1).join(' ') : '') || '.';

  const products = (Array.isArray(order.items) ? order.items : [])
    .filter((it) => it && it.productId) // identifiant produit fiable requis (le sku est souvent vide)
    .map((it) => {
      const p = { name: trimStr(it.name, 200) || 'Pièce', product_ref: { reference: String(it.productId) } };
      const sku = trimStr(it.sku);
      if (sku) p.product_ref.sku = sku;
      if (typeof it.unitPriceCents === 'number') p.price = Math.round(it.unitPriceCents) / 100;
      return p;
    });

  // Avis produit ET marque si des produits sont liés ; sinon avis marque seul
  // (demander un avis PRODUIT sans produit = payload incohérent → rejeté par Skeepers).
  const purchaseEventType = products.length ? 'BRAND_AND_PRODUCT' : 'BRAND';
  const solicitation = { delay: c.delay, purchase_event_type: purchaseEventType };
  if (products.length) solicitation.delay_product = c.delayProduct;

  return {
    purchase_reference: trimStr(order.number, 50),
    purchase_date: toIso(order.createdAt),
    price: typeof order.totalCents === 'number' ? Math.round(order.totalCents) / 100 : 0,
    consumer: {
      first_name: firstName.slice(0, 100),
      last_name: lastName.slice(0, 100),
      email,
      language: 'fr',
      country: 'FR',
    },
    products,
    sales_channel: { channel: 'online', website_id: c.websiteId },
    solicitation_parameters: solicitation,
  };
}

/**
 * Pousse un lot d'événements (≤ 50) vers Skeepers. L'idempotence (ne pas pousser
 * deux fois la même commande) est gérée par l'appelant via un flag sur l'Order.
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string, status?:number, error?:any, response?:any, count?:number}>}
 */
async function pushPurchaseEvents(events) {
  if (!isConfigured()) return { ok: false, skipped: true, reason: 'not_configured' };
  const list = (Array.isArray(events) ? events : []).filter(Boolean);
  if (!list.length) return { ok: false, skipped: true, reason: 'no_events' };
  if (list.length > MAX_EVENTS_PER_REQUEST) return { ok: false, skipped: true, reason: 'too_many_events' };

  const c = config();
  const token = await getAccessToken();
  const url = `${API_BASE}/websites/${encodeURIComponent(c.websiteId)}/purchase_events/bulk_sync_insert`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(list),
  });
  const raw = await res.json().catch(() => ({}));
  if (!res.ok) {
    // Log serveur (Render) : le corps d'erreur Skeepers est indispensable au diagnostic.
    try { console.error('[skeepers] push HTTP ' + res.status + ' — ' + JSON.stringify(raw).slice(0, 800)); } catch (_) {}
    return { ok: false, status: res.status, error: raw };
  }
  return { ok: true, response: raw, count: list.length };
}

module.exports = {
  isConfigured,
  config,
  getAccessToken,
  buildPurchaseEvent,
  pushPurchaseEvents,
  MAX_EVENTS_PER_REQUEST,
};
