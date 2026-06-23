'use strict';
/**
 * Validation d'un numéro de TVA intracommunautaire via le service officiel VIES
 * (Commission européenne). Sert à l'autoliquidation B2B UE (reverse charge).
 *
 * Garde-fou clé : si VIES est indisponible/timeout, on NE valide PAS
 * (status 'unavailable') → l'appelant doit retomber en TTC. On ne facture jamais
 * HT sur la seule base d'un format correct (décision par défaut, à confirmer Keobiz).
 */

const { normalizeCountryCode } = require('../config/shippingZones');

const VIES_BASE = 'https://ec.europa.eu/taxation_customs/vies/rest-api/ms';
const TIMEOUT_MS = 5000;
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24h — la validité d'un n° bouge peu
const _cache = new Map(); // 'DE123456789' → { result, at }

// La Grèce utilise le préfixe TVA 'EL' (code ISO pays = 'GR').
function vatPrefixForCountry(isoCode) { return isoCode === 'GR' ? 'EL' : isoCode; }
function countryFromVatPrefix(prefix) { return prefix === 'EL' ? 'GR' : prefix; }

/** Découpe « DE 123.456-789 » → { prefix:'DE', number:'123456789', full:'DE123456789' } ; null si format invalide. */
function parseVatNumber(raw) {
  const cleaned = String(raw || '').toUpperCase().replace(/[\s.\-]/g, '');
  const m = /^([A-Z]{2})([0-9A-Z]{2,12})$/.exec(cleaned);
  if (!m) return null;
  return { prefix: m[1], number: m[2], full: cleaned };
}

/**
 * Valide un n° de TVA intracommunautaire.
 * @param {string} rawVatNumber ex: 'DE123456789'
 * @param {string} [expectedCountry] code ou libellé du pays de facturation (ex: 'DE' ou 'Allemagne')
 * @returns {Promise<{valid:boolean,status:'valid'|'invalid'|'format'|'mismatch'|'unavailable',countryCode:string,vatNumber:string,name?:string,address?:string,checkedAt:Date,error?:string}>}
 */
async function validateVat(rawVatNumber, expectedCountry) {
  const checkedAt = new Date();
  const parsed = parseVatNumber(rawVatNumber);
  if (!parsed) {
    return { valid: false, status: 'format', countryCode: '', vatNumber: String(rawVatNumber || ''), checkedAt };
  }
  const isoCountry = countryFromVatPrefix(parsed.prefix);

  // Cohérence préfixe TVA ↔ pays de facturation (si connu) : un n° DE pour une
  // adresse ES est suspect → refus immédiat.
  if (expectedCountry) {
    const exp = normalizeCountryCode(expectedCountry);
    if (exp && exp !== isoCountry) {
      return { valid: false, status: 'mismatch', countryCode: isoCountry, vatNumber: parsed.full, checkedAt };
    }
  }

  const cached = _cache.get(parsed.full);
  if (cached && (Date.now() - cached.at) < CACHE_TTL_MS) return cached.result;

  let result;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    const url = `${VIES_BASE}/${parsed.prefix}/vat/${parsed.number}`;
    const resp = await fetch(url, { signal: ctrl.signal, headers: { Accept: 'application/json' } });
    clearTimeout(timer);
    if (!resp.ok) throw new Error('VIES HTTP ' + resp.status);
    const data = await resp.json();
    const ok = !!(data && (data.isValid === true || data.valid === true));
    result = {
      valid: ok,
      status: ok ? 'valid' : 'invalid',
      countryCode: isoCountry,
      vatNumber: parsed.full,
      name: (data && (data.name || data.traderName)) || '',
      address: (data && (data.address || data.traderAddress)) || '',
      checkedAt,
    };
  } catch (err) {
    // Indisponible / timeout → pas de validation (l'appelant retombe en TTC).
    return { valid: false, status: 'unavailable', countryCode: isoCountry, vatNumber: parsed.full, checkedAt, error: err && err.message };
  }
  _cache.set(parsed.full, { result, at: Date.now() });
  return result;
}

module.exports = { validateVat, parseVatNumber, vatPrefixForCountry, countryFromVatPrefix };
