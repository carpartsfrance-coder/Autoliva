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

async function getPayment(paymentId, { embedRefunds = false } = {}) {
  const apiKey = getApiKeyFromEnv();
  const id = getTrimmedString(paymentId);
  if (!id) throw new Error('paymentId manquant');

  /* ?embed=refunds → la réponse inclut `_embedded.refunds[]` avec
   * toutes les opérations de remboursement (API ou dashboard Mollie).
   * Indispensable pour détecter dans le webhook les refunds créés
   * directement depuis le back-office Mollie sans passer par notre site. */
  const qs = embedRefunds ? '?embed=refunds' : '';
  const url = `${MOLLIE_BASE_URL}/payments/${encodeURIComponent(id)}${qs}`;
  return requestJson(url, { apiKey });
}

/**
 * Liste les remboursements d'un paiement (alternative à embed=refunds quand
 * on a besoin de pagination ou qu'on veut isoler les refunds du payment).
 *
 * Retourne le _embedded.refunds[] directement, ou [] si aucun.
 */
async function listRefunds(paymentId) {
  const apiKey = getApiKeyFromEnv();
  const id = getTrimmedString(paymentId);
  if (!id) throw new Error('paymentId manquant');

  const url = `${MOLLIE_BASE_URL}/payments/${encodeURIComponent(id)}/refunds`;
  const resp = await requestJson(url, { apiKey });
  if (resp && resp._embedded && Array.isArray(resp._embedded.refunds)) {
    return resp._embedded.refunds;
  }
  return [];
}

/**
 * Liste les "settlements" Mollie = virements groupés que Mollie effectue
 * vers ton compte bancaire (1x/jour ou 1x/semaine selon ta config).
 *
 * Un settlement contient plusieurs paiements (les ventes encaissées de la
 * période). C'est l'objet de référence pour la réconciliation comptable :
 * tu vois 4 327 € arriver sur ton compte → quels paiements le composent ?
 *
 * Pagination : Mollie pagine 50 par défaut, max 250. On suit `_links.next`.
 *
 * @returns {Promise<Array>} settlements triés du plus récent au plus ancien
 */
async function listSettlements({ from, to, limit = 250 } = {}) {
  const apiKey = getApiKeyFromEnv();
  const out = [];
  let url = `${MOLLIE_BASE_URL}/settlements?limit=${Math.min(250, Math.max(1, limit))}`;

  while (url) {
    const resp = await requestJson(url, { apiKey });
    const items = resp && resp._embedded && Array.isArray(resp._embedded.settlements)
      ? resp._embedded.settlements
      : [];

    /* Filtre date locale : si from/to sont passés, on garde uniquement les
     * settlements dont settledAt tombe dans l'intervalle. Mollie ne supporte
     * pas de filtre date côté serveur, donc on tronque côté client. */
    for (const s of items) {
      if (from || to) {
        const d = s.settledAt ? new Date(s.settledAt) : null;
        if (!d) continue;
        if (from && d < from) {
          /* settlements triés du plus récent au plus ancien : on peut break */
          return out;
        }
        if (to && d >= to) continue;
      }
      out.push(s);
    }

    const next = resp && resp._links && resp._links.next && resp._links.next.href ? resp._links.next.href : null;
    url = next;
  }

  return out;
}

/**
 * Liste les paiements inclus dans un settlement Mollie.
 *
 * @param {string} settlementId  ex: "stl_jDk30akdN"
 * @returns {Promise<Array>}     payments avec id, amount, status, settlementAmount, refunds, etc.
 */
async function listSettlementPayments(settlementId) {
  const apiKey = getApiKeyFromEnv();
  const id = getTrimmedString(settlementId);
  if (!id) throw new Error('settlementId manquant');

  const out = [];
  let url = `${MOLLIE_BASE_URL}/settlements/${encodeURIComponent(id)}/payments?limit=250`;

  while (url) {
    const resp = await requestJson(url, { apiKey });
    const items = resp && resp._embedded && Array.isArray(resp._embedded.payments)
      ? resp._embedded.payments
      : [];
    out.push(...items);
    url = resp && resp._links && resp._links.next && resp._links.next.href ? resp._links.next.href : null;
  }

  return out;
}

/**
 * Liste les refunds inclus dans un settlement Mollie (s'il y en a).
 * Utile pour expliquer pourquoi un payout est inférieur à la somme des
 * paiements bruts (refunds soustraits).
 */
async function listSettlementRefunds(settlementId) {
  const apiKey = getApiKeyFromEnv();
  const id = getTrimmedString(settlementId);
  if (!id) throw new Error('settlementId manquant');

  const out = [];
  let url = `${MOLLIE_BASE_URL}/settlements/${encodeURIComponent(id)}/refunds?limit=250`;

  while (url) {
    const resp = await requestJson(url, { apiKey });
    const items = resp && resp._embedded && Array.isArray(resp._embedded.refunds)
      ? resp._embedded.refunds
      : [];
    out.push(...items);
    url = resp && resp._links && resp._links.next && resp._links.next.href ? resp._links.next.href : null;
  }

  return out;
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
  listRefunds,
  createRefund,
  listSettlements,
  listSettlementPayments,
  listSettlementRefunds,
};
