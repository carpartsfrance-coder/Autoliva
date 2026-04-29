const https = require('https');

const TRACK17_BASE_URL = 'https://api.17track.net/track/v1';

const defaultTimeoutMs = 8000;

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeTrackingNumber(value) {
  return getTrimmedString(value).replace(/\s+/g, '');
}

function buildApiError(json, statusCode) {
  const message = json && typeof json.message === 'string' && json.message.trim()
    ? json.message.trim()
    : '';

  const rejected = json && json.data && Array.isArray(json.data.rejected)
    ? json.data.rejected
    : [];

  const rejectedMessage = rejected.length && rejected[0] && rejected[0].error && rejected[0].error.message
    ? String(rejected[0].error.message)
    : '';

  if (message) return message;
  if (rejectedMessage) return rejectedMessage;
  if (statusCode) return `HTTP ${statusCode}`;
  return 'Erreur 17Track';
}

function fetchJson(path, { method = 'POST', apiKey, body, timeoutMs = defaultTimeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    const key = getTrimmedString(apiKey);
    if (!key) {
      reject(new Error('17TRACK_API_KEY manquant'));
      return;
    }

    const payload = body ? JSON.stringify(body) : null;

    const headers = {
      '17token': key,
      'Content-Type': 'application/json',
    };

    if (payload) {
      headers['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = https.request(
      {
        protocol: 'https:',
        hostname: 'api.17track.net',
        port: 443,
        path: `/track/v1${path}`,
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
            reject(new Error(`Réponse 17Track invalide (${res.statusCode})`));
            return;
          }

          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            reject(new Error(buildApiError(json, res.statusCode)));
            return;
          }

          if (json && typeof json.code === 'number' && json.code !== 0) {
            reject(new Error(buildApiError(json, res.statusCode)));
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
      req.destroy(new Error('Timeout 17Track'));
    });

    if (payload) {
      req.write(payload);
    }

    req.end();
  });
}

function normalizeAcceptedList(json) {
  return json && json.data && Array.isArray(json.data.accepted)
    ? json.data.accepted
    : [];
}

function translateEventToFrench(rawEvent) {
  const raw = typeof rawEvent === 'string' ? rawEvent.trim() : '';
  if (!raw) return '';

  const v = raw.toLowerCase();

  if (v.includes('delivered') || v.includes('distribu') || v.includes('livr')) return 'Livré';
  if (v.includes('out for delivery') || v.includes('en cours de livraison')) return 'En cours de livraison';
  if (v.includes('delivery attempt') || v.includes('attempted') || v.includes('tentative')) return 'Tentative de livraison';

  if (v.includes('arrived at facility') || v.includes('arrived at') || v.includes('arriv')) return 'Arrivé au centre de tri';
  if (v.includes('departed from facility') || v.includes('departed') || v.includes('départ') || v.includes('depart')) {
    return 'Départ du centre de tri';
  }

  if (v.includes('processed') || v.includes('processing') || v.includes('traitement')) return 'Traitement en cours';

  if (v.includes('label created') || v.includes('shipping label created') || v.includes('étiquette')) {
    return 'Étiquette créée';
  }
  if (v.includes('shipment information received') || v.includes('information received') || v.includes("informations d")) {
    return 'Informations d’expédition reçues';
  }

  if (v.includes('picked up') || v.includes('pickup') || v.includes('prise en charge')) return 'Colis pris en charge';
  if (v.includes('in transit') || v.includes('transit') || v.includes('en transit')) return 'En transit';
  if (v.includes('customs') || v.includes('douane')) return 'Contrôle douanier';
  if (v.includes('return') || v.includes('returned') || v.includes('exception') || v.includes('failed') || v.includes('undeliverable')) {
    return 'Incident de livraison';
  }

  return 'Mise à jour du transporteur';
}

function isFranceLocation(rawLocation) {
  const v = typeof rawLocation === 'string' ? rawLocation.trim().toLowerCase() : '';
  if (!v) return false;

  if (v.includes('france')) return true;
  if (/(^|[\s,])fr($|[\s,])/.test(v)) return true;
  if (v.includes('(fr)')) return true;

  return false;
}

function maskLocationIfNotFrance(rawLocation) {
  const loc = typeof rawLocation === 'string' ? rawLocation.trim() : '';
  if (!loc) return '';
  if (isFranceLocation(loc)) return loc;
  return 'Plateforme logistique';
}

async function registerTracking(apiKey, trackingNumber, { carrierCode } = {}) {
  const tn = normalizeTrackingNumber(trackingNumber);
  if (!tn) return null;

  const body = [
    {
      number: tn,
      auto_detection: !Number.isFinite(carrierCode),
    },
  ];

  if (Number.isFinite(carrierCode)) {
    body[0].carrier = carrierCode;
  }

  const json = await fetchJson('/register', { apiKey, body });
  return json;
}

async function getTrackInfo(apiKey, items = []) {
  if (!Array.isArray(items) || items.length === 0) return null;
  const json = await fetchJson('/gettrackinfo', { apiKey, body: items });
  return json;
}

async function getTrackList(apiKey, filters = {}) {
  const body = {
    page_no: 1,
    ...filters,
  };
  const json = await fetchJson('/gettracklist', { apiKey, body });
  return json;
}

function normalizeEventList(list) {
  return (Array.isArray(list) ? list : [])
    .filter(Boolean)
    .map((ev) => {
      const date = ev && ev.a ? String(ev.a) : '';
      const location = ev && ev.c ? String(ev.c) : '';
      const description = ev && ev.z ? String(ev.z) : '';
      const eventFr = translateEventToFrench(description);
      const locationMasked = maskLocationIfNotFrance(location);

      return {
        event: eventFr || 'Mise à jour',
        date,
        location: locationMasked,
        additional: '',
      };
    });
}

function buildEventsFromTrack(track) {
  const events = [];

  if (track && track.z0) {
    events.push(...normalizeEventList([track.z0]));
  }

  events.push(...normalizeEventList(track && track.z1));
  events.push(...normalizeEventList(track && track.z2));
  events.push(...normalizeEventList(track && track.z9));

  const seen = new Set();
  const unique = [];
  for (const ev of events) {
    if (!ev) continue;
    const key = [ev.event || '', ev.date || '', ev.location || '', ev.additional || '']
      .map((v) => String(v).trim())
      .join('|');

    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(ev);
  }

  return unique;
}

function isDeliveredFromEvents(events) {
  const list = Array.isArray(events) ? events : [];
  return list.some((ev) => {
    const label = ev && ev.event ? String(ev.event).trim().toLowerCase() : '';
    if (!label) return false;
    return label === 'delivered' || label.includes('delivered') || label.includes('livr');
  });
}

function mapTrack17PackageStatusToParcelStatusCode(packageStatus) {
  const e = Number(packageStatus);
  if (!Number.isFinite(e)) return null;

  if (e === 40) return 0;
  if (e === 30) return 4;
  if (e === 20) return 2;
  if (e === 10) return 8;

  return null;
}

function normalizeTrackToDelivery(track) {
  if (!track || typeof track !== 'object') return null;

  const events = buildEventsFromTrack(track);

  const deliveredFromEvents = isDeliveredFromEvents(events);
  const statusFromPackageState = mapTrack17PackageStatusToParcelStatusCode(track.e);

  let statusCode = null;
  if (deliveredFromEvents) {
    statusCode = 0;
  } else if (Number.isFinite(statusFromPackageState)) {
    statusCode = statusFromPackageState;
  } else if (events.length) {
    statusCode = 2;
  }

  return {
    status_code: statusCode,
    events,
    timestamp_expected: null,
    timestamp_expected_end: null,
  };
}

function normalizeTrackingInfo(acceptedList, preferredNumber) {
  const list = Array.isArray(acceptedList) ? acceptedList.filter(Boolean) : [];
  const preferred = normalizeTrackingNumber(preferredNumber);

  const chosen = preferred
    ? list.find((item) => normalizeTrackingNumber(item && item.number) === preferred)
    : null;

  const item = chosen || list[0] || null;
  if (!item || !item.track) return null;

  return normalizeTrackToDelivery(item.track);
}

async function getTrackingByNumber(apiKey, trackingNumber) {
  const tn = normalizeTrackingNumber(trackingNumber);
  if (!tn) return null;

  const registerJson = await registerTracking(apiKey, tn);
  const registerAccepted = normalizeAcceptedList(registerJson);
  const registerRejected = registerJson && registerJson.data && Array.isArray(registerJson.data.rejected)
    ? registerJson.data.rejected
    : [];

  const rejectedMessage = registerRejected[0] && registerRejected[0].error && registerRejected[0].error.message
    ? String(registerRejected[0].error.message)
    : '';

  const acceptedItem = registerAccepted.find((item) => normalizeTrackingNumber(item && item.number) === tn)
    || registerAccepted[0]
    || null;

  let carrierCode = acceptedItem && Number.isFinite(acceptedItem.carrier) ? acceptedItem.carrier : null;

  if (!carrierCode && registerRejected.length) {
    const msgLower = rejectedMessage.toLowerCase();

    const alreadyRegistered = msgLower.includes('has been registered') || msgLower.includes("don't need to repeat");

    if (!alreadyRegistered) {
      throw new Error(rejectedMessage || 'Numéro de suivi invalide.');
    }

    const listJson = await getTrackList(apiKey, { number: tn, page_no: 1 });
    const listAccepted = normalizeAcceptedList(listJson);
    const listItem = listAccepted.find((item) => normalizeTrackingNumber(item && item.number) === tn)
      || listAccepted[0]
      || null;

    const w1 = listItem && Number.isFinite(listItem.w1) ? listItem.w1 : null;
    const w2 = listItem && Number.isFinite(listItem.w2) ? listItem.w2 : null;
    carrierCode = w1 || w2 || null;
  }

  if (!carrierCode) {
    return null;
  }

  const infoJson = await getTrackInfo(apiKey, [{ number: tn, carrier: carrierCode }]);
  const infoAccepted = normalizeAcceptedList(infoJson);
  return normalizeTrackingInfo(infoAccepted, tn);
}

module.exports = {
  TRACK17_BASE_URL,
  normalizeTrackingNumber,
  registerTracking,
  getTrackList,
  getTrackInfo,
  getTrackingByNumber,
  normalizeTrackToDelivery,
};
