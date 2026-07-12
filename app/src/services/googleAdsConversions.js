'use strict';

/**
 * Client minimal Google Ads API — Import de CONVERSIONS HORS-LIGNE
 * (offline click conversions) à partir du `gclid` déjà capté par
 * `captureAttribution.js` (→ AbandonedCart.attribution.gclid).
 *
 * But : remonter à Google Ads les VRAIES conversions de ton tunnel moteur
 * (demande de devis = lead, puis vente gagnée = sale avec sa valeur), pour que
 * l'algo optimise vers de vrais clients et plus vers le faux « Achats ».
 *
 * Aucune dépendance lourde : `fetch` natif (Node 18+). OAuth2 refresh-token →
 * access token (mis en cache ~1h).
 *
 * 100 % piloté par variables d'environnement. Si non configuré →
 * `isConfigured()` renvoie false et tout no-op → SÛR à déployer avant même
 * d'avoir l'accès API (le cron ne fait rien tant que les variables sont vides).
 *
 * Variables d'env (à poser dans Render une fois l'accès API obtenu) :
 *   GOOGLE_ADS_DEVELOPER_TOKEN     jeton développeur (Google Ads API Center)
 *   GOOGLE_ADS_CLIENT_ID           OAuth2 client id
 *   GOOGLE_ADS_CLIENT_SECRET       OAuth2 client secret
 *   GOOGLE_ADS_REFRESH_TOKEN       OAuth2 refresh token (accès "offline")
 *   GOOGLE_ADS_CUSTOMER_ID         id du compte Ads, chiffres sans tirets (ex 9562598225)
 *   GOOGLE_ADS_LOGIN_CUSTOMER_ID   (optionnel) id du compte manager/MCC si accès via manager
 *   GOOGLE_ADS_LEAD_ACTION         id (ou resource name) de l'action de conversion "Lead - Devis"
 *   GOOGLE_ADS_SALE_ACTION         id (ou resource name) de l'action de conversion "Vente moteur"
 *   GOOGLE_ADS_API_VERSION         (optionnel) défaut "v18"
 */

const OAUTH_URL = 'https://oauth2.googleapis.com/token';

function env(k) { return typeof process.env[k] === 'string' ? process.env[k].trim() : ''; }
function digitsOnly(s) { return String(s || '').replace(/\D/g, ''); }

function config() {
  return {
    devToken: env('GOOGLE_ADS_DEVELOPER_TOKEN'),
    clientId: env('GOOGLE_ADS_CLIENT_ID'),
    clientSecret: env('GOOGLE_ADS_CLIENT_SECRET'),
    refreshToken: env('GOOGLE_ADS_REFRESH_TOKEN'),
    customerId: digitsOnly(env('GOOGLE_ADS_CUSTOMER_ID')),
    loginCustomerId: digitsOnly(env('GOOGLE_ADS_LOGIN_CUSTOMER_ID')),
    leadAction: env('GOOGLE_ADS_LEAD_ACTION'),
    saleAction: env('GOOGLE_ADS_SALE_ACTION'),
    // v18 est morte (404) — versions vivantes vérifiées le 11/07/2026 : v20 à v23.
    apiVersion: env('GOOGLE_ADS_API_VERSION') || 'v23',
  };
}

/** Configuration minimale présente ? (sans ça, tout no-op). */
function isConfigured() {
  const c = config();
  return !!(c.devToken && c.clientId && c.clientSecret && c.refreshToken && c.customerId && (c.leadAction || c.saleAction));
}

/** Resource name complet de l'action de conversion (accepte id brut ou resource name). */
function conversionActionResource(actionEnv) {
  if (!actionEnv) return '';
  if (String(actionEnv).startsWith('customers/')) return String(actionEnv);
  const c = config();
  return `customers/${c.customerId}/conversionActions/${digitsOnly(actionEnv)}`;
}

/** Format attendu par Google : "yyyy-MM-dd HH:mm:ss+00:00" (UTC). */
function formatConversionDateTime(date) {
  const d = (date instanceof Date) ? date : new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} `
    + `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}+00:00`;
}

// Cache du token d'accès OAuth (valable ~1h).
let _token = { value: '', expiresAt: 0 };

async function getAccessToken() {
  const now = Date.now();
  if (_token.value && _token.expiresAt > now + 60000) return _token.value;
  const c = config();
  const body = new URLSearchParams({
    client_id: c.clientId,
    client_secret: c.clientSecret,
    refresh_token: c.refreshToken,
    grant_type: 'refresh_token',
  });
  const res = await fetch(OAUTH_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
  });
  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`OAuth token error ${res.status}: ${t.slice(0, 300)}`);
  }
  const j = await res.json();
  _token = { value: j.access_token, expiresAt: now + (Number(j.expires_in || 3600) * 1000) };
  return _token.value;
}

/**
 * Remonte UNE conversion clic (idempotence gérée par l'appelant).
 * @param {Object} p
 * @param {string} p.gclid       identifiant de clic Google Ads
 * @param {'lead'|'sale'} p.action  type → choisit l'action de conversion
 * @param {number} [p.value]      valeur (€), omise/0 → conversion sans valeur
 * @param {string} [p.currency]   défaut 'EUR'
 * @param {Date|string} [p.dateTime]  date de la conversion (postérieure au clic)
 * @param {boolean} [p.dryRun]    true → validateOnly (Google valide sans enregistrer)
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string, status?:number, error?:any, partialFailureError?:any, validateOnly?:boolean}>}
 */
async function uploadConversion({ gclid, action, value, currency, dateTime, dryRun = false }) {
  if (!isConfigured()) return { ok: false, skipped: true, reason: 'not_configured' };
  const g = String(gclid || '').trim();
  if (!g) return { ok: false, skipped: true, reason: 'no_gclid' };

  const c = config();
  const resource = conversionActionResource(action === 'sale' ? c.saleAction : c.leadAction);
  if (!resource) return { ok: false, skipped: true, reason: `no_action_for_${action}` };

  const conv = {
    gclid: g,
    conversionAction: resource,
    conversionDateTime: dateTime
      ? (typeof dateTime === 'string' ? dateTime : formatConversionDateTime(dateTime))
      : formatConversionDateTime(new Date()),
  };
  if (typeof value === 'number' && isFinite(value) && value > 0) {
    conv.conversionValue = value;
    conv.currencyCode = currency || 'EUR';
  }

  const token = await getAccessToken();
  const url = `https://googleads.googleapis.com/${c.apiVersion}/customers/${c.customerId}:uploadClickConversions`;
  const headers = {
    'Authorization': `Bearer ${token}`,
    'developer-token': c.devToken,
    'Content-Type': 'application/json',
  };
  if (c.loginCustomerId) headers['login-customer-id'] = c.loginCustomerId;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ conversions: [conv], partialFailure: true, validateOnly: !!dryRun }),
  });
  const raw = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, status: res.status, error: raw };
  }
  // En partial-failure, une conversion rejetée apparaît dans partialFailureError.
  if (raw.partialFailureError) {
    return { ok: false, partialFailureError: raw.partialFailureError };
  }
  return { ok: true, validateOnly: !!dryRun };
}

module.exports = {
  isConfigured,
  config,
  uploadConversion,
  getAccessToken,
  conversionActionResource,
  formatConversionDateTime,
};
