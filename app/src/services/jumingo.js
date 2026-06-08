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

module.exports = {
  BASE_URL,
  isEnabled,
  mapJumingoStatus,
  getTrackingStatus,
  // exportés pour le probe / les tests
  _internal: { extractList, extractRawStatus, extractTrackingNumber, extractId, apiGet },
};
