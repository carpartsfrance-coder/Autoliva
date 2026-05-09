'use strict';

// Normalise les données client au format Enhanced Conversions de Google.
// Référence : https://support.google.com/google-ads/answer/13262500
//
// Google attend des valeurs en clair (le tag GTM hashe en sha256). Nous
// normalisons quand même côté serveur pour maximiser le taux de match :
//   - email lowercase + trim
//   - téléphone E.164 (préfixe + et indicatif pays)
//   - prénom/nom lowercase + trim, sans accents diacritiques
//   - pays en code ISO-3166 alpha-2 ('FR' au lieu de 'France')
//
// Si un champ n'est pas exploitable, on l'omet — Google ignore les valeurs
// vides et fait au mieux avec ce qu'il reçoit.

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const COUNTRY_TO_ISO = {
  'france': 'FR',
  'belgium': 'BE',
  'belgique': 'BE',
  'switzerland': 'CH',
  'suisse': 'CH',
  'germany': 'DE',
  'allemagne': 'DE',
  'italy': 'IT',
  'italie': 'IT',
  'spain': 'ES',
  'espagne': 'ES',
  'luxembourg': 'LU',
  'monaco': 'MC',
  'netherlands': 'NL',
  'pays-bas': 'NL',
  'portugal': 'PT',
  'united kingdom': 'GB',
  'royaume-uni': 'GB',
};

function stripAccents(s) {
  return String(s).normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function normalizeEmail(value) {
  if (typeof value !== 'string') return '';
  const v = value.trim().toLowerCase();
  return EMAIL_RE.test(v) ? v : '';
}

// Convertit en E.164. Si le téléphone est en format FR (commence par 0 ou +33),
// on assume FR. Si déjà préfixé +XX, on garde tel quel après nettoyage.
function normalizePhone(value, defaultCountry = 'FR') {
  if (typeof value !== 'string') return '';
  // Garde uniquement chiffres et le + initial.
  const cleaned = value.trim().replace(/[\s().\- ]/g, '');
  if (!cleaned) return '';

  if (cleaned.startsWith('+')) {
    const digits = cleaned.slice(1).replace(/\D/g, '');
    if (digits.length < 6 || digits.length > 15) return '';
    return '+' + digits;
  }

  const digits = cleaned.replace(/\D/g, '');
  if (!digits) return '';

  if (defaultCountry === 'FR') {
    // 0XXXXXXXXX -> +33XXXXXXXXX
    if (digits.length === 10 && digits.startsWith('0')) {
      return '+33' + digits.slice(1);
    }
    // 33XXXXXXXXX -> +33XXXXXXXXX
    if (digits.length === 11 && digits.startsWith('33')) {
      return '+' + digits;
    }
    // 9 chiffres après l'indicatif (cas d'un mobile sans 0)
    if (digits.length === 9) {
      return '+33' + digits;
    }
  }

  // Sinon, on n'invente pas d'indicatif — on rejette.
  return '';
}

function normalizeName(value) {
  if (typeof value !== 'string') return '';
  return stripAccents(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

function splitFullName(fullName) {
  const cleaned = typeof fullName === 'string' ? fullName.trim() : '';
  if (!cleaned) return { firstName: '', lastName: '' };
  const parts = cleaned.split(/\s+/);
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return {
    firstName: parts[0],
    lastName: parts.slice(1).join(' '),
  };
}

function normalizeCountry(value) {
  if (typeof value !== 'string') return '';
  const v = value.trim();
  if (!v) return '';
  if (/^[A-Z]{2}$/i.test(v)) return v.toUpperCase();
  const key = stripAccents(v).toLowerCase();
  return COUNTRY_TO_ISO[key] || '';
}

function normalizePostalCode(value) {
  if (typeof value !== 'string') return '';
  return value.trim().replace(/\s+/g, '');
}

function normalizeStreet(value) {
  if (typeof value !== 'string') return '';
  return stripAccents(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

function normalizeCity(value) {
  if (typeof value !== 'string') return '';
  return stripAccents(value).trim().toLowerCase().replace(/\s+/g, ' ');
}

// Construit le payload `user_data` poussé dans dataLayer.
// Toutes les clés non utilisables sont omises, jamais string vide.
//
// @param {Object} input
// @param {string} [input.email]
// @param {string} [input.phone]
// @param {Object} [input.address] - shape addressSnapshot d'Order:
//        { fullName, line1, line2, postalCode, city, country, phone }
// @returns {Object} - safe à JSON.stringify côté EJS
function buildUserData(input) {
  if (!input || typeof input !== 'object') return {};

  const out = {};

  const email = normalizeEmail(input.email);
  if (email) out.email = email;

  // Le téléphone peut venir directement ou depuis address.phone.
  const rawPhone = input.phone
    || (input.address && input.address.phone)
    || '';
  const phone = normalizePhone(rawPhone);
  if (phone) out.phone_number = phone;

  const addr = input.address || {};
  const country = normalizeCountry(addr.country);
  const { firstName, lastName } = splitFullName(addr.fullName);
  const street = normalizeStreet([addr.line1, addr.line2].filter(Boolean).join(' '));
  const city = normalizeCity(addr.city);
  const postalCode = normalizePostalCode(addr.postalCode);
  const fn = normalizeName(firstName);
  const ln = normalizeName(lastName);

  // Google demande au moins un champ d'adresse pour qu'elle soit utile.
  // On envoie l'objet seulement si on a country + (postal OU city OU street).
  if (country && (postalCode || city || street || fn || ln)) {
    const address = { country };
    if (fn) address.first_name = fn;
    if (ln) address.last_name = ln;
    if (street) address.street = street;
    if (city) address.city = city;
    if (postalCode) address.postal_code = postalCode;
    out.address = address;
  }

  return out;
}

module.exports = {
  buildUserData,
  // exports utiles pour tests / réutilisation
  normalizeEmail,
  normalizePhone,
  normalizeName,
  normalizeCountry,
  splitFullName,
};
