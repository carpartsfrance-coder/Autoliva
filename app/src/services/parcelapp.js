const PARCELAPP_BASE_URL = 'https://api.parcel.app/external';

const https = require('https');

const cache = {
  active: { fetchedAt: 0, deliveries: null },
  recent: { fetchedAt: 0, deliveries: null },
};

const defaultTimeoutMs = 8000;
const deliveriesCacheTtlMs = 2 * 60 * 1000;

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTrackingNumber(value) {
  return getTrimmedString(value).replace(/\s+/g, '');
}

function buildHeaders(apiKey) {
  return {
    'content-type': 'application/json',
    'api-key': apiKey,
  };
}

function fetchJson(url, { method = 'GET', apiKey, body, timeoutMs = defaultTimeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    if (!apiKey) {
      reject(new Error('PARCELAPP_API_KEY manquant'));
      return;
    }

    const parsed = new URL(url);
    const payload = body ? JSON.stringify(body) : null;

    const headers = buildHeaders(apiKey);
    if (payload) {
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = https.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || 443,
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers,
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');

        res.on('data', (chunk) => {
          raw += chunk;
        });

        res.on('end', () => {
          let json = null;
          try {
            json = raw ? JSON.parse(raw) : null;
          } catch (err) {
            reject(new Error(`Réponse ParcelApp invalide (${res.statusCode})`));
            return;
          }

          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            const msg = json && json.error_message ? json.error_message : `HTTP ${res.statusCode}`;
            reject(new Error(msg));
            return;
          }

          resolve(json);
        });
      }
    );

    req.on('error', (err) => {
      reject(err);
    });

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Timeout ParcelApp'));
    });

    if (payload) {
      req.write(payload);
    }

    req.end();
  });
}

async function listDeliveries(apiKey, filterMode = 'active') {
  const mode = filterMode === 'recent' ? 'recent' : 'active';
  const now = Date.now();

  if (cache[mode].deliveries && now - cache[mode].fetchedAt < deliveriesCacheTtlMs) {
    return cache[mode].deliveries;
  }

  const url = `${PARCELAPP_BASE_URL}/deliveries/?filter_mode=${encodeURIComponent(mode)}`;
  const json = await fetchJson(url, { apiKey });

  if (!json || json.success !== true) {
    const msg = json && json.error_message ? json.error_message : 'Erreur ParcelApp';
    throw new Error(msg);
  }

  const deliveries = Array.isArray(json.deliveries) ? json.deliveries : [];
  cache[mode] = { fetchedAt: now, deliveries };
  return deliveries;
}

function guessCarrierCode(carrierLabel) {
  const raw = getTrimmedString(carrierLabel).toLowerCase();
  if (!raw) return '';

  if (raw.includes('colissimo') || raw.includes('la poste') || raw.includes('laposte')) return 'lp';
  if (raw.includes('chronopost')) return 'chrono';
  if (raw.includes('mondial') || raw.includes('relay')) return 'relay';
  if (raw.includes('relais colis')) return 'relais';
  if (raw.includes('colis privé') || raw.includes('colis prive') || raw.includes('colisprive')) return 'adrexo';
  if (raw.includes('dhl')) return 'dhl';
  if (raw.includes('ups')) return 'ups';
  if (raw.includes('fedex') || raw.includes('fed ex')) return 'fedex';
  if (raw.includes('gls')) return 'gls';
  if (raw.includes('dpd')) return 'dpdgroup';
  if (raw.includes('tnt')) return 'tnt';

  return '';
}

async function addDelivery(apiKey, { trackingNumber, carrierCode, description, language = 'fr' } = {}) {
  const tracking = normalizeTrackingNumber(trackingNumber);
  const carrier = getTrimmedString(carrierCode);
  const desc = getTrimmedString(description);

  if (!tracking) throw new Error('Numéro de suivi manquant');
  if (!carrier) throw new Error('carrier_code manquant');
  if (!desc) throw new Error('description manquante');

  const url = `${PARCELAPP_BASE_URL}/add-delivery/`;
  const json = await fetchJson(url, {
    method: 'POST',
    apiKey,
    body: {
      tracking_number: tracking,
      carrier_code: carrier,
      description: desc,
      language,
      send_push_confirmation: false,
    },
  });

  if (!json || json.success !== true) {
    const msg = json && json.error_message ? json.error_message : 'Erreur ParcelApp';
    throw new Error(msg);
  }

  cache.active = { fetchedAt: 0, deliveries: null };
  cache.recent = { fetchedAt: 0, deliveries: null };

  return true;
}

async function findDeliveryByTrackingNumber(apiKey, trackingNumber) {
  const tracking = normalizeTrackingNumber(trackingNumber);
  if (!tracking) return null;

  const active = await listDeliveries(apiKey, 'active');
  const fromActive = active.find((d) => d && normalizeTrackingNumber(d.tracking_number) === tracking);
  if (fromActive) return fromActive;

  const recent = await listDeliveries(apiKey, 'recent');
  const fromRecent = recent.find((d) => d && normalizeTrackingNumber(d.tracking_number) === tracking);
  return fromRecent || null;
}

module.exports = {
  normalizeTrackingNumber,
  listDeliveries,
  findDeliveryByTrackingNumber,
  addDelivery,
  guessCarrierCode,
};
