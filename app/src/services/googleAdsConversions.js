'use strict';

/**
 * Client CONVERSIONS HORS-LIGNE → Google Ads via la **Data Manager API**.
 *
 * Contexte : depuis mi-2026 Google a FERMÉ l'ancienne
 * `ConversionUploadService.UploadClickConversions` aux nouveaux comptes
 * (erreur CUSTOMER_NOT_ALLOWLISTED_FOR_THIS_FEATURE). La voie officielle pour
 * une nouvelle intégration est la Data Manager API :
 *   POST https://datamanager.googleapis.com/v1/events:ingest
 * cf. https://developers.google.com/data-manager/api/devguides/events/google-ads/offline
 *
 * But inchangé : remonter les VRAIES conversions du tunnel (lead devis, vente
 * gagnée avec sa marge, achat e-commerce avec son panier) à partir du `gclid`
 * déjà capté (AbandonedCart.attribution.gclid / Order.attribution.lastTouch.gclid),
 * pour que l'algo optimise vers de vrais clients rentables.
 *
 * Différences clés vs l'ancienne API :
 *   - endpoint datamanager.googleapis.com/v1/events:ingest (et non googleads…:uploadClickConversions)
 *   - scope OAuth `https://www.googleapis.com/auth/datamanager` (et NON `…/adwords`)
 *     → le refresh token DOIT être généré avec ce scope.
 *   - PAS de developer-token, PAS de login-customer-id.
 *   - l'action de conversion (créée côté Ads) devient `productDestinationId`.
 *
 * `fetch` natif (Node 18+). OAuth2 refresh-token → access token (cache ~1h).
 * 100 % piloté par variables d'env : si non configuré → `isConfigured()` = false
 * et tout no-op → SÛR à déployer avant d'avoir fini l'onboarding.
 *
 * Variables d'env (Render) :
 *   GOOGLE_ADS_CLIENT_ID        OAuth2 client id
 *   GOOGLE_ADS_CLIENT_SECRET    OAuth2 client secret
 *   GOOGLE_ADS_REFRESH_TOKEN    OAuth2 refresh token — scope `datamanager` (à régénérer !)
 *   GOOGLE_ADS_CUSTOMER_ID      id du compte Ads, chiffres sans tirets (ex 9562598225)
 *   GOOGLE_ADS_LEAD_ACTION      id de l'action de conversion "Lead - Devis"
 *   GOOGLE_ADS_SALE_ACTION      id de l'action de conversion "Vente devis"
 *   GOOGLE_ADS_PURCHASE_ACTION  id de l'action de conversion "Achat site" (e-commerce)
 *   GOOGLE_ADS_DEVELOPER_TOKEN  (héritage — plus utilisé par Data Manager, ignoré)
 */

const OAUTH_URL = 'https://oauth2.googleapis.com/token';
const INGEST_URL = 'https://datamanager.googleapis.com/v1/events:ingest';

function env(k) { return typeof process.env[k] === 'string' ? process.env[k].trim() : ''; }
function digitsOnly(s) { return String(s || '').replace(/\D/g, ''); }

function config() {
  return {
    clientId: env('GOOGLE_ADS_CLIENT_ID'),
    clientSecret: env('GOOGLE_ADS_CLIENT_SECRET'),
    refreshToken: env('GOOGLE_ADS_REFRESH_TOKEN'),
    customerId: digitsOnly(env('GOOGLE_ADS_CUSTOMER_ID')),
    leadAction: env('GOOGLE_ADS_LEAD_ACTION'),
    saleAction: env('GOOGLE_ADS_SALE_ACTION'),
    purchaseAction: env('GOOGLE_ADS_PURCHASE_ACTION'),
  };
}

/** Configuration minimale présente ? (sans ça, tout no-op). */
function isConfigured() {
  const c = config();
  return !!(c.clientId && c.clientSecret && c.refreshToken && c.customerId
    && (c.leadAction || c.saleAction || c.purchaseAction));
}

/** ID d'action de conversion (Data Manager `productDestinationId`) — accepte id brut ou resource name. */
function conversionActionId(actionEnv) {
  const s = String(actionEnv || '');
  // Resource name "customers/123/conversionActions/456" → garder le dernier segment.
  const m = s.match(/conversionActions\/(\d+)/);
  if (m) return m[1];
  return digitsOnly(s);
}

/** Format Data Manager (Timestamp JSON) : RFC 3339 UTC "yyyy-MM-ddTHH:mm:ssZ". */
function formatConversionDateTime(date) {
  const d = (date instanceof Date) ? date : new Date(date);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`
    + `T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}Z`;
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
 * Remonte UNE conversion (idempotence gérée par l'appelant) via events:ingest.
 * @param {Object} p
 * @param {string} p.gclid       identifiant de clic Google Ads
 * @param {'lead'|'sale'|'purchase'} p.action  type → choisit l'action de conversion
 * @param {number} [p.value]      valeur (€), omise/0 → conversion sans valeur
 * @param {string} [p.currency]   défaut 'EUR'
 * @param {Date|string} [p.dateTime]  date de la conversion (postérieure au clic)
 * @param {boolean} [p.dryRun]    true → validateOnly (Google valide sans enregistrer)
 * @returns {Promise<{ok:boolean, skipped?:boolean, reason?:string, status?:number, error?:any, validateOnly?:boolean, response?:any}>}
 */
async function uploadConversion({ gclid, action, value, currency, dateTime, dryRun = false }) {
  if (!isConfigured()) return { ok: false, skipped: true, reason: 'not_configured' };
  const g = String(gclid || '').trim();
  if (!g) return { ok: false, skipped: true, reason: 'no_gclid' };

  const c = config();
  const actionEnv = action === 'sale' ? c.saleAction
    : action === 'purchase' ? c.purchaseAction
    : c.leadAction;
  const destId = conversionActionId(actionEnv);
  if (!destId) return { ok: false, skipped: true, reason: `no_action_for_${action}` };

  const ev = {
    adIdentifiers: { gclid: g },
    // Requis par events:ingest (REQUIRED_FIELD_MISSING sinon). Toutes nos
    // conversions naissent d'un clic web (le gclid est web) → WEB.
    eventSource: 'WEB',
    eventTimestamp: dateTime
      ? (typeof dateTime === 'string' ? dateTime : formatConversionDateTime(dateTime))
      : formatConversionDateTime(new Date()),
  };
  if (typeof value === 'number' && isFinite(value) && value > 0) {
    ev.conversionValue = value;
    ev.currency = currency || 'EUR';
  }

  const payload = {
    destinations: [{
      reference: 'gads',
      operatingAccount: { accountType: 'GOOGLE_ADS', accountId: c.customerId },
      productDestinationId: destId,
    }],
    events: [ev],
    validateOnly: !!dryRun,
  };

  const token = await getAccessToken();
  const res = await fetch(INGEST_URL, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const raw = await res.json().catch(() => ({}));
  if (!res.ok) {
    return { ok: false, status: res.status, error: raw };
  }
  return { ok: true, validateOnly: !!dryRun, response: raw };
}

module.exports = {
  isConfigured,
  config,
  uploadConversion,
  getAccessToken,
  conversionActionId,
  formatConversionDateTime,
};
