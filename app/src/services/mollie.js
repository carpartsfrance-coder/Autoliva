const MOLLIE_BASE_URL = 'https://api.mollie.com/v2';

const https = require('https');

const defaultTimeoutMs = 10000;

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getApiKeyFromEnv() {
  const key = getTrimmedString(process.env.MOLLIE_API_KEY);
  return key;
}

function formatAmountFromCents(cents) {
  const safe = Number.isFinite(cents) ? cents : 0;
  return (safe / 100).toFixed(2);
}

function buildHeaders(apiKey) {
  return {
    Authorization: `Bearer ${apiKey}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
  };
}

function requestJson(url, { method = 'GET', apiKey, body, timeoutMs = defaultTimeoutMs } = {}) {
  return new Promise((resolve, reject) => {
    if (!apiKey) {
      reject(new Error('MOLLIE_API_KEY manquant'));
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
            reject(new Error(`Réponse Mollie invalide (${res.statusCode})`));
            return;
          }

          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            const msg = json && json.detail ? json.detail : `HTTP ${res.statusCode}`;
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
      req.destroy(new Error('Timeout Mollie'));
    });

    if (payload) {
      req.write(payload);
    }

    req.end();
  });
}

async function createPayment({
  amountCents,
  currency = 'EUR',
  description,
  redirectUrl,
  webhookUrl,
  metadata,
  locale = 'fr_FR',
} = {}) {
  const apiKey = getApiKeyFromEnv();

  const desc = getTrimmedString(description);
  if (!desc) throw new Error('Description paiement manquante');

  const redirect = getTrimmedString(redirectUrl);
  if (!redirect) throw new Error('redirectUrl manquant');

  const body = {
    amount: {
      currency,
      value: formatAmountFromCents(amountCents),
    },
    description: desc,
    redirectUrl: redirect,
    locale,
    metadata: metadata && typeof metadata === 'object' ? metadata : undefined,
  };

  const webhook = getTrimmedString(webhookUrl);
  if (webhook) body.webhookUrl = webhook;

  const url = `${MOLLIE_BASE_URL}/payments`;
  return requestJson(url, { method: 'POST', apiKey, body });
}

async function getPayment(paymentId) {
  const apiKey = getApiKeyFromEnv();
  const id = getTrimmedString(paymentId);
  if (!id) throw new Error('paymentId manquant');

  const url = `${MOLLIE_BASE_URL}/payments/${encodeURIComponent(id)}`;
  return requestJson(url, { apiKey });
}

async function createRefund({ paymentId, amountCents, currency = 'EUR', description } = {}) {
  const apiKey = getApiKeyFromEnv();
  const id = getTrimmedString(paymentId);
  if (!id) throw new Error('paymentId manquant');
  if (!Number.isFinite(amountCents) || amountCents <= 0) throw new Error('amountCents invalide');

  const body = {
    amount: { currency, value: formatAmountFromCents(amountCents) },
  };
  const desc = getTrimmedString(description);
  if (desc) body.description = desc;

  const url = `${MOLLIE_BASE_URL}/payments/${encodeURIComponent(id)}/refunds`;
  return requestJson(url, { method: 'POST', apiKey, body });
}

module.exports = {
  formatAmountFromCents,
  createPayment,
  getPayment,
  createRefund,
};
