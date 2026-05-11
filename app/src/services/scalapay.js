const https = require('https');

const defaultTimeoutMs = 10000;

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getApiKeyFromEnv() {
  return getTrimmedString(process.env.SCALAPAY_API_KEY);
}

function getBaseUrlFromEnv() {
  const baseUrl = getTrimmedString(process.env.SCALAPAY_BASE_URL);
  if (baseUrl) return baseUrl.replace(/\/+$/, '');

  const env = getTrimmedString(process.env.SCALAPAY_ENV).toLowerCase();
  if (env === 'production' || env === 'prod' || env === 'live') {
    return 'https://api.scalapay.com';
  }
  if (env === 'sandbox' || env === 'test' || env === 'integration') {
    return 'https://integration.api.scalapay.com';
  }

  return process.env.NODE_ENV === 'production'
    ? 'https://api.scalapay.com'
    : 'https://integration.api.scalapay.com';
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
      reject(new Error('SCALAPAY_API_KEY manquant'));
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
          if (raw) {
            try {
              json = JSON.parse(raw);
            } catch (err) {
              json = null;
            }
          }

          const status = res.statusCode || 0;

          if (!status || status < 200 || status >= 300) {
            const fromJson = json && (json.message || json.error || json.error_message);
            const rawSnippet = raw ? raw.slice(0, 200).replace(/\s+/g, ' ').trim() : '';
            const msg = fromJson
              ? String(fromJson)
              : rawSnippet
                ? `HTTP ${status} - ${rawSnippet}`
                : `HTTP ${status}`;
            reject(new Error(msg));
            return;
          }

          if (!json) {
            reject(new Error(`Réponse Scalapay invalide (${status})`));
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
      req.destroy(new Error('Timeout Scalapay'));
    });

    if (payload) {
      req.write(payload);
    }

    req.end();
  });
}

async function createOrder({ body } = {}) {
  const apiKey = getApiKeyFromEnv();
  const baseUrl = getBaseUrlFromEnv();

  if (!body || typeof body !== 'object') {
    throw new Error('Body Scalapay manquant');
  }

  const url = `${baseUrl}/v2/orders`;
  return requestJson(url, { method: 'POST', apiKey, body });
}

async function getPayment(token) {
  const apiKey = getApiKeyFromEnv();
  const baseUrl = getBaseUrlFromEnv();

  const t = getTrimmedString(token);
  if (!t) throw new Error('token Scalapay manquant');

  const url = `${baseUrl}/v2/payments/${encodeURIComponent(t)}`;
  return requestJson(url, { apiKey });
}

async function capturePayment({ token, merchantReference, amountCents, currency = 'EUR' } = {}) {
  const apiKey = getApiKeyFromEnv();
  const baseUrl = getBaseUrlFromEnv();

  const t = getTrimmedString(token);
  if (!t) throw new Error('token Scalapay manquant');

  const body = {
    token: t,
  };

  const ref = getTrimmedString(merchantReference);
  if (ref) body.merchantReference = ref;

  if (Number.isFinite(amountCents)) {
    body.amount = {
      amount: formatAmountFromCents(amountCents),
      currency,
    };
  }

  const url = `${baseUrl}/v2/payments/capture`;
  return requestJson(url, { method: 'POST', apiKey, body });
}

/**
 * Refund Scalapay — appelle POST /v2/payments/{token}/refunds.
 * Supporte le partiel (passer amountCents) ; sans montant = total.
 *
 * Doc Scalapay : https://developers.scalapay.com/reference/refundpayment
 *
 * @param {object} args
 * @param {string} args.token          - Order token Scalapay
 * @param {number} [args.amountCents]  - montant partiel (€ * 100). Si omis : refund total
 * @param {string} [args.refundId]     - identifiant marchand idempotent (sinon : auto-généré)
 * @param {string} [args.reason]       - motif (visible côté Scalapay)
 * @param {string} [args.currency='EUR']
 * @returns {Promise<object>} réponse Scalapay
 */
async function refundPayment({ token, amountCents, refundId, reason, currency = 'EUR' } = {}) {
  const apiKey = getApiKeyFromEnv();
  const baseUrl = getBaseUrlFromEnv();

  const t = getTrimmedString(token);
  if (!t) throw new Error('token Scalapay manquant');

  const body = {};

  if (Number.isFinite(amountCents) && amountCents > 0) {
    body.amount = {
      amount: formatAmountFromCents(amountCents),
      currency,
    };
  }

  /* refundId idempotent : Scalapay garantit qu'un même refundId ne crée pas
   * un doublon. Si l'admin re-clique, on bloque côté serveur (anti-spam).
   * Si non fourni, on génère un UUID-like à partir du timestamp + random. */
  const id = getTrimmedString(refundId) || `cpf-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  body.refundId = id;

  const reasonText = getTrimmedString(reason);
  if (reasonText) body.reason = reasonText;

  const url = `${baseUrl}/v2/payments/${encodeURIComponent(t)}/refunds`;
  return requestJson(url, { method: 'POST', apiKey, body });
}

module.exports = {
  formatAmountFromCents,
  createOrder,
  getPayment,
  capturePayment,
  refundPayment,
};
