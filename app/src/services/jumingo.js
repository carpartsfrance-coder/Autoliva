'use strict';
/* Client API JUMiNGO (plateforme d'expédition multi-transporteurs).
 * Doc : https://developers.jumingo.com  (OpenAPI sur SwaggerHub).
 *
 * On s'en sert UNIQUEMENT pour lire le statut de suivi d'un envoi à partir de
 * son numéro de suivi, afin de détecter le DÉPART RÉEL (premier scan
 * transporteur) et faire avancer la commande « Étiquette créée » → « Expédiée »
 * automatiquement (cf. src/jobs/syncShipmentTracking.js).
 *
 * Auth : header `X-AUTH-TOKEN: <clé>`  ·  Base : https://api.jumingo.com/v1
 * Clé attendue dans process.env.JUMINGO_API_KEY (à définir sur Render).
 *
 * Parsing DÉFENSIF : la forme exacte de la réponse n'a pas pu être testée en
 * live — on tente plusieurs chemins de champs et on log le brut en cas de doute
 * (utiliser scripts/jumingo-probe.js pour valider sur un vrai numéro de suivi).
 */
const BASE_URL = (process.env.JUMINGO_BASE_URL || 'https://api.jumingo.com/v1').replace(/\/+$/, '');

function getApiKey() {
  return String(process.env.JUMINGO_API_KEY || '').trim();
}
function isEnabled() {
  return getApiKey().length > 0;
}

/* Statuts JUMiNGO connus → notre concept de statut de commande.
 *   new / notfound        → étiquette créée, pas encore prise en charge
 *   pickup / transit      → DÉPART RÉEL (scanné) → expédiée
 *   delivered             → livrée
 *   exception/undelivered/expired → anomalie : on ne change rien automatiquement
 */
function mapJumingoStatus(raw) {
  switch (String(raw || '').trim().toLowerCase()) {
    case 'pickup':
    case 'transit':
    case 'out_for_delivery':
      return 'shipped';
    case 'delivered':
      return 'delivered';
    case 'new':
    case 'notfound':
    case 'pending':
    case 'pre_transit':
      return 'label_created';
    case 'exception':
    case 'undelivered':
    case 'expired':
    case 'failure':
      return 'problem';
    default:
      return 'unknown';
  }
}

const norm = (v) => String(v == null ? '' : v).replace(/\s+/g, '').toUpperCase();

/* Extrait l'array d'envois d'une réponse liste, quelle que soit l'enveloppe. */
function extractList(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  if (Array.isArray(body.data)) return body.data;
  if (body.data && Array.isArray(body.data.items)) return body.data.items;
  if (Array.isArray(body.items)) return body.items;
  if (Array.isArray(body.shipments)) return body.shipments;
  return [];
}

/* Extrait le VRAI statut de suivi d'un objet envoi.
 * ⚠️ Piège (confirmé sur la réponse réelle) : `tracking.status` vaut "success"
 * = statut de l'APPEL API, PAS du colis. Le statut du colis est dans
 * `tracking.data.status` (ex. "new", "transit", "delivered"). On le lit en
 * priorité, puis on retombe sur des signaux de progression fiables. */
function extractRawStatus(shipment) {
  if (!shipment || typeof shipment !== 'object') return '';
  const t = shipment.tracking || {};
  if (t.data && t.data.status) return String(t.data.status);

  // Fallbacks robustes (si data.status manque) :
  const pts = (t.progress && t.progress.points) || {};
  if (pts.completed) return 'delivered';
  if (pts.in_delivery || pts.in_transit) return 'transit';
  if (pts.undelivered) return 'undelivered';
  if (shipment.picked_up === true) return 'pickup';
  if (pts.in_system) return 'new';
  return '';
}
function extractTrackingNumber(shipment) {
  if (!shipment || typeof shipment !== 'object') return '';
  const t = shipment.tracking || {};
  return (t.data && t.data.tracking_number) || shipment.tracking_number || shipment.trackingNumber || '';
}
function extractId(shipment) {
  if (!shipment || typeof shipment !== 'object') return '';
  return shipment.id || shipment.uuid || shipment.shipment_id || '';
}

async function apiGet(path) {
  const res = await fetch(BASE_URL + path, {
    method: 'GET',
    headers: { 'X-AUTH-TOKEN': getApiKey(), Accept: 'application/json' },
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
  return { ok: res.ok, httpStatus: res.status, body, rawText: text };
}

async function apiSend(method, path, payload) {
  const res = await fetch(BASE_URL + path, {
    method,
    headers: { 'X-AUTH-TOKEN': getApiKey(), Accept: 'application/json', 'Content-Type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  });
  const text = await res.text();
  let body = null;
  try { body = text ? JSON.parse(text) : null; } catch (_) { body = null; }
  return { ok: res.ok, httpStatus: res.status, body, rawText: text };
}

/* Message d'erreur lisible extrait d'une réponse Jumingo. */
function apiError(r) {
  const b = r && r.body;
  if (b && typeof b === 'object') {
    if (b.message) return String(b.message);
    if (b.error) return String(b.error);
    if (b.errors) { try { return JSON.stringify(b.errors).slice(0, 300); } catch (_) { /* noop */ } }
    if (b.warnings && b.warnings.messages) { try { return JSON.stringify(b.warnings.messages).slice(0, 300); } catch (_) { /* noop */ } }
  }
  return 'HTTP ' + (r && r.httpStatus) + ' ' + ((r && r.rawText) || '').slice(0, 200);
}

/**
 * Statut de suivi d'un numéro de tracking.
 * @returns {Promise<{ok, found, rawStatus, status, trackingPage, httpStatus, raw?}>}
 *   status ∈ 'label_created' | 'shipped' | 'delivered' | 'problem' | 'unknown'
 */
async function getTrackingStatus(trackingNumber) {
  const tn = String(trackingNumber || '').trim();
  if (!getApiKey() || !tn) return { ok: false, found: false, status: 'unknown' };

  const list = await apiGet('/shipments?search=' + encodeURIComponent(tn));
  if (!list.ok) return { ok: false, found: false, status: 'unknown', httpStatus: list.httpStatus };

  const items = extractList(list.body);
  let match = items.find((s) => norm(extractTrackingNumber(s)) === norm(tn)) || items[0] || null;
  if (!match) return { ok: true, found: false, status: 'unknown' };

  let rawStatus = extractRawStatus(match);
  let trackingPage = (match.tracking && match.tracking.carrierTrackingPage) || '';

  // Si la liste ne porte pas le statut, on va chercher le détail de l'envoi.
  if (!rawStatus) {
    const id = extractId(match);
    if (id) {
      const detail = await apiGet('/shipments/' + encodeURIComponent(id));
      if (detail.ok && detail.body) {
        const sh = (detail.body && detail.body.data) ? detail.body.data : detail.body;
        rawStatus = extractRawStatus(sh) || rawStatus;
        trackingPage = (sh.tracking && sh.tracking.carrierTrackingPage) || trackingPage;
      }
    }
  }

  return {
    ok: true,
    found: true,
    rawStatus: String(rawStatus || ''),
    status: mapJumingoStatus(rawStatus),
    trackingPage,
    httpStatus: list.httpStatus,
  };
}

// ───────────────────────────────────────────────────────────────────────────
// CRÉATION D'ÉTIQUETTE (flux en 2 temps : brouillon+tarifs GRATUITS, achat payant)
// ───────────────────────────────────────────────────────────────────────────

/* La création d'étiquette est gardée derrière un flag SÉPARÉ du suivi : tant
 * que JUMINGO_LABELS_ENABLED !== 'true', les routes refusent (sécurité argent). */
function labelsEnabled() {
  return isEnabled() && String(process.env.JUMINGO_LABELS_ENABLED || '').trim().toLowerCase() === 'true';
}

/* Adresse expéditeur (CPF) — surchargée par env, défauts = valeurs réelles vues
 * dans l'API Jumingo. */
function getSenderAddress() {
  const e = process.env;
  return {
    company: e.JUMINGO_SENDER_COMPANY || 'Car parts france',
    name: e.JUMINGO_SENDER_NAME || 'Car parts france',
    street: e.JUMINGO_SENDER_STREET || '515 Av. Lavoisier',
    street2: e.JUMINGO_SENDER_STREET2 || '',
    zip: e.JUMINGO_SENDER_ZIP || '13340',
    city: e.JUMINGO_SENDER_CITY || 'Rognac',
    country: e.JUMINGO_SENDER_COUNTRY || 'FR',
    phone: e.JUMINGO_SENDER_PHONE || '+33756850126',
    email: e.JUMINGO_SENDER_EMAIL || 'contact@carpartsfrance.fr',
  };
}

/* Map un nom de pays FR → code ISO alpha-2 (Jumingo exige le code). */
function toCountryCode(c) {
  const v = String(c || '').trim();
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase();
  const map = { france: 'FR', allemagne: 'DE', germany: 'DE', belgique: 'BE', belgium: 'BE',
    espagne: 'ES', spain: 'ES', italie: 'IT', italy: 'IT', luxembourg: 'LU', suisse: 'CH',
    'pays-bas': 'NL', netherlands: 'NL', portugal: 'PT', autriche: 'AT', austria: 'AT' };
  return map[v.toLowerCase()] || 'FR';
}

/* Adresse expéditeur CPF au format adresse Jumingo (email dans settings). */
function senderJumingoAddress() {
  const s = getSenderAddress();
  return {
    company: s.company, name: s.name, street: s.street, street2: s.street2,
    zip: s.zip, city: s.city, country: s.country, phone: s.phone,
    settings: s.email ? { email: s.email } : {},
  };
}

/* Construit l'objet adresse Jumingo depuis un snapshot d'adresse de commande. */
function buildToAddress(shippingAddress, email) {
  const a = shippingAddress || {};
  return {
    company: '',
    name: String(a.fullName || '').slice(0, 35) || 'Client',
    street: String(a.line1 || '').slice(0, 35),
    street2: String(a.line2 || '').slice(0, 35),
    zip: String(a.postalCode || '').trim().slice(0, 10),
    city: String(a.city || '').slice(0, 30),
    country: toCountryCode(a.country),
    phone: String(a.phone || '').slice(0, 35),
    settings: email ? { email: String(email) } : {},
  };
}

/* 1) Crée un brouillon d'envoi (GRATUIT, non payé). → { ok, shipmentId }
 * fromAddress / toAddress au format adresse Jumingo. Pour un ENVOI : from=CPF,
 * to=client. Pour une COLLECTE : from=client, to=CPF (inversion). */
async function createDraftShipment({ fromAddress, toAddress, email, weightKg, length, width, height, contentDescription, valueAmount, reference }) {
  if (!labelsEnabled()) return { ok: false, error: 'JUMINGO_LABELS_ENABLED != true' };
  const payload = {
    from_address: fromAddress || senderJumingoAddress(),
    to_address: toAddress,
    details: {
      content_description: String(contentDescription || 'Pièce auto').slice(0, 35),
      value_amount: Math.max(1, Math.min(9999999, Math.round(Number(valueAmount) || 1))),
      value_currency: 'EUR',
      reference_number: String(reference || '').slice(0, 35),
      email: String(email || getSenderAddress().email),
      packaging_type: 'parcel',
    },
    packages: [{
      weight: Math.max(0.1, Number(weightKg) || 1),
      length: Math.max(1, Math.round(Number(length) || 1)),
      width: Math.max(1, Math.round(Number(width) || 1)),
      height: Math.max(1, Math.round(Number(height) || 1)),
    }],
  };
  const r = await apiSend('POST', '/shipments', payload);
  if (!r.ok) return { ok: false, error: apiError(r), httpStatus: r.httpStatus };
  const shipmentId = (r.body && (r.body.shipment_id || r.body.id)) || '';
  if (!shipmentId) return { ok: false, error: 'Réponse sans shipment_id', raw: r.body };
  return { ok: true, shipmentId, warnings: r.body && r.body.warnings };
}

/* 2) Récupère les tarifs disponibles pour un brouillon (GRATUIT).
 *    → { ok, rates: [{ tariffId, carrier, service, priceTotal, currency, transit, shippingType }] } */
async function getShipmentRates({ shipmentId, pickupDate, deliveryDate }) {
  if (!labelsEnabled()) return { ok: false, error: 'JUMINGO_LABELS_ENABLED != true' };
  const payload = {
    shipmentId,
    pickupDate: pickupDate,
    deliveryDate: deliveryDate,
    settings: { mode: 'm' },
  };
  const r = await apiSend('POST', '/shipment-rates', payload);
  if (!r.ok) return { ok: false, error: apiError(r), httpStatus: r.httpStatus };
  // Les tarifs réels sont dans body.tariffs (pas un tableau racine).
  const tariffs = (r.body && Array.isArray(r.body.tariffs)) ? r.body.tariffs : [];
  const rates = tariffs.map((t) => {
    const transit = (t.dates && t.dates.transit_time_range && t.dates.transit_time_range.days != null)
      ? String(t.dates.transit_time_range.days)
      : ((t.transit_time_min && t.transit_time_max) ? (t.transit_time_min + '-' + t.transit_time_max) : '');
    return {
      tariffId: String(t.id),
      carrier: (t.shipper && t.shipper.ShipperGroupName) || t.ShipperGroupName || '',
      service: t.name || '',
      // price_brutto = prix TTC (ce qu'on paie). Fallback price_total.
      priceTotal: (t.price_brutto != null) ? Number(t.price_brutto) : (t.price_total != null ? Number(t.price_total) : null),
      currency: t.currency || 'EUR',
      transit,
      // shippingType 2 = dépôt point relais (shop) ; 1 = enlèvement à domicile (pickup).
      shippingType: (Number(t.shippingType) === 1) ? 'pickup' : 'shop',
    };
  })
    .filter((x) => x.tariffId && x.tariffId !== 'undefined' && x.priceTotal != null && x.shippingType === 'shop')
    .sort((a, b) => a.priceTotal - b.priceTotal);
  return { ok: true, rates, raw: r.body };
}

/* 3) Attache le tarif choisi au brouillon (GRATUIT). */
async function attachRate(shipmentId, { tariffId, shippingType, pickupDate, pickupMinTime, pickupMaxTime }) {
  if (!labelsEnabled()) return { ok: false, error: 'JUMINGO_LABELS_ENABLED != true' };
  const stype = shippingType || 'shop';
  const isShop = stype === 'shop';
  // Le conteneur "rate" exige TOUS ces champs (guide d'intégration p.8) :
  // shipper_tariff_id (id "s-…" pour un relais), shipping_type, pickup_date
  // (future), pickup_min/max_time (= '00:00:00' pour un dépôt en point relais).
  // PATCH = mise à jour partielle (PUT remplace tout et écrase email/colis).
  const rate = {
    shipper_tariff_id: String(tariffId),
    shipping_type: stype,
    pickup_date: pickupDate,
    pickup_min_time: isShop ? '00:00:00' : (pickupMinTime || '09:00:00'),
    pickup_max_time: isShop ? '00:00:00' : (pickupMaxTime || '18:00:00'),
  };
  const r = await apiSend('PATCH', '/shipments/' + encodeURIComponent(shipmentId), { rate });
  if (!r.ok) return { ok: false, error: apiError(r), httpStatus: r.httpStatus };
  // Vérifie que le brouillon est passé en "ready" (tarif accepté).
  const check = await apiGet('/shipments/' + encodeURIComponent(shipmentId));
  const status = (check.body && (check.body.import_status || check.body.status)) || '';
  if (status !== 'ready') {
    let why = '';
    try { why = JSON.stringify((check.body && (check.body.import_messages_text || check.body.import_messages)) || {}).slice(0, 300); } catch (_) { /* noop */ }
    return { ok: false, error: 'Tarif non accepté (statut ' + (status || '?') + ') ' + why, status };
  }
  return { ok: true, ready: true, status };
}

/* 4) ⚠️ ACHÈTE l'étiquette (DÉBIT). À n'appeler que sur confirmation explicite. */
async function purchaseLabel({ shipmentIds, method }) {
  if (!labelsEnabled()) return { ok: false, error: 'JUMINGO_LABELS_ENABLED != true' };
  const payload = { shipmentIds: Array.isArray(shipmentIds) ? shipmentIds : [shipmentIds] };
  // Modes valides (guide p.14) : lastschrift, rechnung, sammelrechnung.
  // 'rechnung' (facture) par défaut = aucune donnée bancaire, Jumingo facture.
  const m = method || process.env.JUMINGO_PAYMENT_METHOD || 'rechnung';
  payload.method = m;
  const r = await apiSend('POST', '/orders', payload);
  if (!r.ok) return { ok: false, error: apiError(r), httpStatus: r.httpStatus };
  const orderNumber = (r.body && (r.body.orderNumber || r.body.number)) || '';
  // returnUrl = page de paiement externe (PayPal/CB). Si présent → paiement à
  // finaliser par l'admin ; sinon paiement direct (SEPA) déjà passé.
  const returnUrl = (r.body && (r.body.returnUrl || r.body.return_url || r.body.url)) || '';
  if (!orderNumber) return { ok: false, error: 'Commande Jumingo sans numéro', raw: r.body };
  return { ok: true, orderNumber, returnUrl, token: (r.body && r.body.token) || '' };
}

/* 5) Récupère le PDF de l'étiquette (base64) après achat. */
async function getLabelPdf(orderNumber) {
  const r = await apiGet('/orders/' + encodeURIComponent(orderNumber) + '/documents');
  if (!r.ok) return { ok: false, error: apiError(r) };
  const labels = (r.body && Array.isArray(r.body.labels)) ? r.body.labels : [];
  const label = labels.find((l) => l && l.file) || labels[0];
  return { ok: true, base64: (label && label.file) || '', name: (label && label.name) || 'etiquette.pdf' };
}

/* 6) Détail d'un envoi (pour récupérer le numéro de suivi après achat). */
async function getShipmentDetail(shipmentId) {
  const r = await apiGet('/shipments/' + encodeURIComponent(shipmentId));
  if (!r.ok) return { ok: false, error: apiError(r) };
  const sh = (r.body && r.body.data) ? r.body.data : r.body;
  return { ok: true, trackingNumber: extractTrackingNumber(sh), carrier: (sh && sh.rate && sh.rate.carrier && (sh.rate.carrier.shipper_group_name)) || '', raw: sh };
}

module.exports = {
  BASE_URL,
  isEnabled,
  labelsEnabled,
  mapJumingoStatus,
  getTrackingStatus,
  getSenderAddress,
  senderJumingoAddress,
  toCountryCode,
  buildToAddress,
  createDraftShipment,
  getShipmentRates,
  attachRate,
  purchaseLabel,
  getLabelPdf,
  getShipmentDetail,
  // exportés pour le probe / les tests
  _internal: { extractList, extractRawStatus, extractTrackingNumber, extractId, apiGet, apiSend, apiError },
};
