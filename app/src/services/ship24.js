const https = require('https');

const SHIP24_BASE_URL = 'https://api.ship24.com';

const defaultTimeoutMs = 65000;

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTrackingNumber(value) {
  return getTrimmedString(value).replace(/\s+/g, '');
}

function fetchJson(path, { method = 'GET', apiKey, body, timeoutMs = defaultTimeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const key = getTrimmedString(apiKey);
    if (!key) {
      reject(new Error('SHIP24_API_KEY manquant'));
      return;
    }

    const payload = body ? JSON.stringify(body) : null;

    const headers = {
      'content-type': 'application/json',
      Authorization: `Bearer ${key}`,
    };

    if (payload) {
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = https.request(
      {
        protocol: 'https:',
        hostname: 'api.ship24.com',
        port: 443,
        path,
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
            reject(new Error(`Réponse Ship24 invalide (${res.statusCode})`));
            return;
          }

          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            const errors = json && Array.isArray(json.errors) ? json.errors : [];
            const msg = errors && errors[0] && errors[0].message
              ? String(errors[0].message)
              : `HTTP ${res.statusCode}`;
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
      req.destroy(new Error('Timeout Ship24'));
    });

    if (payload) {
      req.write(payload);
    }

    req.end();
  });
}

function extractTrackingsFromResponse(json) {
  if (!json || typeof json !== 'object') return [];
  const data = json.data;
  if (data && typeof data === 'object' && Array.isArray(data.trackings)) {
    return data.trackings;
  }
  return [];
}

function guessCourierCodesFromCarrierLabel(carrierLabel, trackingNumber) {
  const tn = normalizeTrackingNumber(trackingNumber);
  const carrier = getTrimmedString(carrierLabel).toLowerCase();
  if (!tn && !carrier) return [];

  if ((tn && tn.toUpperCase().startsWith('1Z')) || carrier.includes('ups')) {
    return ['ups'];
  }

  return [];
}

async function createTracker(apiKey, { trackingNumber, carrierLabel } = {}) {
  const tn = normalizeTrackingNumber(trackingNumber);
  if (!tn) return null;

  const courierCode = guessCourierCodesFromCarrierLabel(carrierLabel, tn);

  const body = { trackingNumber: tn };
  if (courierCode.length) {
    body.courierCode = courierCode;
    body.settings = { restrictTrackingToCourierCode: true };
  }

  return fetchJson('/public/v1/trackers', {
    method: 'POST',
    apiKey,
    body,
    timeoutMs: 8000,
  });
}

async function getTrackerResultsByTrackingNumber(apiKey, trackingNumber) {
  const tn = normalizeTrackingNumber(trackingNumber);
  if (!tn) return [];

  try {
    const json = await fetchJson(`/public/v1/trackers/search/${encodeURIComponent(tn)}/results`, {
      method: 'GET',
      apiKey,
      timeoutMs: 8000,
    });

    return extractTrackingsFromResponse(json);
  } catch (err) {
    const msg = err && err.message ? String(err.message).toLowerCase() : '';
    if (msg.includes('tracker not found')) {
      return [];
    }
    throw err;
  }
}

async function createTrackerAndGetResults(apiKey, trackingNumber) {
  const tn = normalizeTrackingNumber(trackingNumber);
  if (!tn) return null;

  const json = await fetchJson('/public/v1/trackers/track', {
    method: 'POST',
    apiKey,
    body: { trackingNumber: tn },
  });

  return extractTrackingsFromResponse(json);
}

function mapShip24MilestoneToStatusCode(milestone) {
  const raw = typeof milestone === 'string' ? milestone.toLowerCase() : '';
  if (!raw) return null;

  if (raw === 'delivered') return 0;
  if (raw === 'out_for_delivery') return 4;
  if (raw === 'exception' || raw === 'failed' || raw === 'error') return 6;
  if (raw === 'info_received' || raw === 'created') return 8;
  if (raw === 'in_transit' || raw === 'pickup' || raw === 'available_for_pickup') return 2;

  return 3;
}

function normalizeShip24Events(events) {
  const list = Array.isArray(events) ? events : [];
  return list
    .filter(Boolean)
    .map((ev) => {
      const status = ev && ev.status ? String(ev.status) : '';
      const date = ev && ev.occurrenceDatetime ? String(ev.occurrenceDatetime) : '';
      const location = ev && ev.location ? String(ev.location) : '';

      return {
        event: status || 'Mise à jour',
        date,
        location,
        additional: '',
      };
    });
}

function normalizeShip24ToParcelDelivery(trackings, preferredTrackingNumber) {
  const preferred = normalizeTrackingNumber(preferredTrackingNumber);
  const list = Array.isArray(trackings) ? trackings.filter(Boolean) : [];

  const chosen = preferred
    ? list.find((t) => {
        const tn = t && t.tracker && t.tracker.trackingNumber ? String(t.tracker.trackingNumber) : '';
        return normalizeTrackingNumber(tn) === preferred;
      })
    : null;

  const item = chosen || list[0] || null;
  if (!item) return null;

  const eventsRaw = Array.isArray(item.events) ? item.events : [];
  const eventsSorted = eventsRaw.slice().sort((a, b) => {
    const orderA = a && Number.isFinite(a.order) ? a.order : 0;
    const orderB = b && Number.isFinite(b.order) ? b.order : 0;
    return orderB - orderA;
  });

  const latest = eventsSorted[0] || null;
  const milestone = latest && latest.statusMilestone ? String(latest.statusMilestone) : '';
  const statusCode = mapShip24MilestoneToStatusCode(milestone);

  const events = normalizeShip24Events(eventsRaw);

  return {
    status_code: Number.isFinite(statusCode) ? statusCode : null,
    events,
    timestamp_expected: null,
    timestamp_expected_end: null,
  };
}

module.exports = {
  SHIP24_BASE_URL,
  normalizeTrackingNumber,
  guessCourierCodesFromCarrierLabel,
  createTracker,
  getTrackerResultsByTrackingNumber,
  createTrackerAndGetResults,
  normalizeShip24ToParcelDelivery,
};
