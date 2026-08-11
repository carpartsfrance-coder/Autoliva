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
 *   SKEEPERS_SOLICITATION_DELAY        jours d'attente APRÈS LE CLIC avant l'email
 *                                      d'avis site (défaut 0 = tout de suite).
 *                                      ⚠ Ce n'est PAS un délai après l'achat :
 *                                      voir delaiPourCommande(), qui le recalcule
 *                                      selon l'âge de la commande.
 *   SKEEPERS_SOLICITATION_DELAY_PRODUCT  idem pour l'avis produit (défaut = DELAY)
 *   SKEEPERS_SHOP_ID                   clé de la boutique (Gestion du compte > Boutiques).
 *                                      Sans elle, Skeepers tente de résoudre la boutique du
 *                                      site lui-même et peut échouer en « fetch Shop of website ».
 */

const OAUTH_URL = 'https://auth.skeepers.io/realms/skeepers/protocol/openid-connect/token';
const API_BASE = 'https://api.skeepers.io/purchase-event';
const MAX_EVENTS_PER_REQUEST = 50;

function env(k) { return typeof process.env[k] === 'string' ? process.env[k].trim() : ''; }
function intEnv(k, d) { const n = parseInt(env(k), 10); return Number.isFinite(n) && n >= 0 ? n : d; }
function trimStr(s, max) { const v = String(s == null ? '' : s).trim(); return max ? v.slice(0, max) : v; }

const UUID_RX = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/**
 * Extrait l'identifiant de site, même si une URL entière a été collée.
 *
 * ⚠ VÉCU. `SKEEPERS_WEBSITE_ID` a contenu pendant des semaines
 * `https://apis.cxr.skeepers.io/certificate-api/certificates/websites/<uuid>/link`
 * au lieu du seul `<uuid>`.
 *
 * Le symptôme était indéchiffrable : Skeepers répondait 500
 * « [VALIDATION SERVICE]: An error occurred on fetch Shop of website: … » en
 * citant cette URL. On y a lu un défaut de provisionnement CHEZ EUX pendant
 * deux semaines — alors que l'URL du message était simplement la valeur qu'on
 * leur envoyait.
 *
 * On récupère donc l'UUID où qu'il se trouve, et on le signale une fois au
 * démarrage : la variable reste à corriger proprement, mais les demandes
 * d'avis repartent sans attendre.
 */
let _urlSignalee = false;
function normaliserWebsiteId(brut) {
  const v = trimStr(brut);
  const m = v.match(UUID_RX);
  if (!m) return v;              // vide, ou format inattendu : on ne touche à rien
  if (m[0] === v) return v;      // déjà un identifiant nu
  if (!_urlSignalee) {
    _urlSignalee = true;
    console.warn('[skeepers] SKEEPERS_WEBSITE_ID contient une URL entière au lieu de l\'identifiant. '
      + 'Identifiant extrait : ' + m[0] + '. À corriger sur Render — envoyée telle quelle, '
      + 'Skeepers rejette la valeur avec une 500 « fetch Shop of website ».');
  }
  return m[0];
}

function config() {
  /* Défaut 0 : le délai se compte désormais après le CLIC, pas après l'achat
     (voir delaiPourCommande). L'envoi étant manuel, « tout de suite » est le
     comportement attendu — un défaut de 7 ferait patienter le client une
     semaine après que Killian a décidé de le solliciter. */
  const delay = intEnv('SKEEPERS_SOLICITATION_DELAY', 0);
  const websiteIdBrut = env('SKEEPERS_WEBSITE_ID');
  const websiteId = normaliserWebsiteId(websiteIdBrut);
  return {
    clientId: env('SKEEPERS_CLIENT_ID'),
    clientSecret: env('SKEEPERS_CLIENT_SECRET'),
    websiteId,
    /* Conservé pour que le diagnostic puisse signaler la variable mal remplie
       même si l'envoi, lui, fonctionne grâce à l'extraction ci-dessus. */
    websiteIdBrut,
    websiteIdCorrige: !!websiteIdBrut && websiteId !== websiteIdBrut,
    shopId: env('SKEEPERS_SHOP_ID'),
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

/** Skeepers n'accepte pas de solliciter au-delà de 6 mois après l'achat. */
const AGE_MAX_JOURS = 180;

/** Âge de la commande en jours pleins. */
function ageEnJours(order) {
  const t = new Date((order && order.createdAt) || Date.now()).getTime();
  if (!Number.isFinite(t)) return 0;
  return Math.max(0, Math.floor((Date.now() - t) / 86400000));
}

/**
 * Combien de jours après l'ACHAT Skeepers doit-il envoyer la sollicitation ?
 *
 * ── POURQUOI CE N'EST PAS UNE CONSTANTE ─────────────────────────────────────
 *
 * Skeepers programme l'envoi à `purchase_date + delay`. Avec un délai figé à 7
 * jours, une commande vieille de 85 jours se voit programmer une date deux mois
 * dans le PASSÉ : rien ne part, sans le moindre message d'erreur. C'est
 * exactement ce qui s'est produit sur CP2026-000199.
 *
 * Or les demandes d'avis sont envoyées À LA MAIN, une par une, au moment où
 * Killian sait que le client a reçu sa pièce. Le moment, c'est le clic — pas
 * une date calculée depuis l'achat. On recalcule donc le délai pour que
 * l'échéance tombe MAINTENANT, quel que soit l'âge de la commande.
 *
 * `SKEEPERS_SOLICITATION_DELAY` garde un sens, mais change de référentiel :
 * c'est désormais le décalage APRÈS LE CLIC (0 = tout de suite, 2 = dans deux
 * jours), et non plus après l'achat.
 *
 * ⚠ HYPOTHÈSE À CONFIRMER AU PREMIER ENVOI : que `delay` se compte bien depuis
 * `purchase_date`. C'est la lecture cohérente avec le plafond de 6 mois annoncé
 * par Skeepers, mais elle n'est pas écrite noir sur blanc. Le message de retour
 * du bouton affiche la date d'envoi calculée : si le dashboard Skeepers annonce
 * la même, la lecture est bonne ; s'il annonce une date bien plus lointaine,
 * c'est que le délai part de la réception de l'événement et il faut alors
 * renvoyer simplement `c.delay`.
 */
function delaiPourCommande(order) {
  const c = config();
  const achat = new Date((order && order.createdAt) || Date.now()).getTime();
  const maintenant = Date.now();

  /* ⚠ ARRONDI VERS LE HAUT, et échéance vérifiée.
     `ageEnJours` arrondit vers le BAS. Sur CP2026-000199, achetée à 19h22 et
     poussée à 20h09, l'âge valait 85 jours pleins → échéance à achat + 85 j,
     soit 19h22 le même jour : 47 MINUTES AVANT le clic. On reprogrammait donc
     encore une fois dans le passé, en croyant viser « maintenant ». C'est ce
     qui explique l'absence d'e-mail après le premier correctif.
     Le délai étant un nombre entier de JOURS, on ne peut pas viser l'instant
     présent : on prend la plus petite échéance strictement future. Elle tombe
     à l'heure d'achat, dans les 24 heures. */
  let jours = Math.max(0, Math.ceil((maintenant - achat) / 86400000));
  while (achat + jours * 86400000 <= maintenant) jours += 1;

  return jours + c.delay;
}

/** Date à laquelle Skeepers enverra la sollicitation, pour l'afficher à l'admin. */
function dateEnvoiPrevue(order) {
  const d = new Date((order && order.createdAt) || Date.now());
  d.setDate(d.getDate() + delaiPourCommande(order));
  return d;
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

  /* Avis marque ET produit quand des produits sont liés ; sinon avis marque seul.
     ⚠ La valeur est `PURCHASE_ONLY`, PAS `BRAND` : l'énumération documentée est
     BRAND_AND_PRODUCT | PURCHASE_ONLY | PRODUCT_ONLY (Swagger « Submit Purchase
     Event »). On envoyait `BRAND`, qui n'existe pas — latent aujourd'hui
     (aucune commande sans produit lié en base), mais qui aurait échoué sur la
     première, typiquement une vente issue d'un devis moteur. */
  const purchaseEventType = products.length ? 'BRAND_AND_PRODUCT' : 'PURCHASE_ONLY';
  /* Le délai est calculé À PARTIR DE L'ÂGE DE LA COMMANDE, pas figé.
     Voir `delaiPourCommande()` : c'est ce qui rend l'envoi manuel utilisable
     sur une commande ancienne. */
  const delai = delaiPourCommande(order);
  const solicitation = { delay: delai, purchase_event_type: purchaseEventType };
  if (products.length) solicitation.delay_product = delai + (c.delayProduct - c.delay);

  // Désigne explicitement la boutique : sans shop_id, le service de validation
  // Skeepers résout la boutique du site lui-même (« fetch Shop of website »), ce
  // qui échoue tant que l'association site↔boutique n'est pas provisionnée chez eux.
  const salesChannel = { channel: 'online', website_id: c.websiteId };
  if (c.shopId) salesChannel.shop_id = c.shopId;

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
    sales_channel: salesChannel,
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

  /* ⚠ HTTP 206 « Partial content » : Skeepers a retenu une partie du lot et
     REJETÉ le reste, en détaillant dans `error_description`. `res.ok` est vrai
     de 200 à 299 — on considérait donc un rejet partiel comme un succès plein,
     on marquait la commande « demande envoyée » et on annonçait que tout allait
     bien. Une commande écartée devenait invisible pour toujours.
     Voir le Swagger « Submit Purchase Event », réponse 206. */
  const rejets = (Array.isArray(raw) ? raw : [])
    .filter((e) => e && (e.error_description || e.error))
    .map((e) => (e.purchase_reference ? e.purchase_reference + ' : ' : '')
      + (e.error_description || e.error));

  if (!res.ok || res.status === 206 || rejets.length) {
    const niveau = res.ok ? 'partiel' : 'HTTP ' + res.status;
    try {
      console.error('[skeepers] push ' + niveau + ' — ' + JSON.stringify(raw).slice(0, 800));
    } catch (_) {}
    return {
      ok: false,
      status: res.status,
      error: rejets.length ? rejets.join(' · ') : raw,
      partiel: res.ok,
    };
  }
  return { ok: true, response: raw, count: list.length };
}

module.exports = {
  isConfigured,
  config,
  getAccessToken,
  buildPurchaseEvent,
  pushPurchaseEvents,
  ageEnJours,
  delaiPourCommande,
  dateEnvoiPrevue,
  AGE_MAX_JOURS,
  MAX_EVENTS_PER_REQUEST,
};
