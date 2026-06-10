'use strict';

/**
 * Zones de livraison — frais de port par destination.
 *
 * 5 zones fixes, résolues automatiquement depuis l'adresse (pays + code postal) :
 *   - metropole     : France métropolitaine (défaut)
 *   - corse         : Corse (codes postaux 20xxx)
 *   - domtom        : DOM-TOM / COM (codes postaux 97xxx / 98xxx)
 *   - europe        : Europe (UE + AELE + proches)
 *   - international : reste du monde
 *
 * Le tarif réel par zone est porté par chaque classe d'expédition
 * (ShippingClass.zonePricesCents). Ici on ne fait QUE résoudre la zone.
 */

const ZONES = [
  { id: 'metropole', label: 'France métropolitaine' },
  { id: 'corse', label: 'Corse' },
  { id: 'domtom', label: 'DOM-TOM' },
  { id: 'europe', label: 'Europe' },
  { id: 'international', label: 'International' },
];

const ZONE_IDS = ZONES.map((z) => z.id);
const ZONE_LABEL = ZONES.reduce((acc, z) => { acc[z.id] = z.label; return acc; }, {});

// Europe = UE + AELE + voisins proches (codes ISO alpha-2).
const EUROPE_COUNTRY_CODES = new Set([
  'ES', 'PT', 'IT', 'DE', 'BE', 'NL', 'LU', 'AT', 'IE', 'DK', 'SE', 'FI',
  'PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'HR', 'SI', 'EE', 'LV', 'LT', 'GR',
  'CY', 'MT', 'CH', 'NO', 'GB', 'MC', 'AD', 'LI', 'SM', 'IS',
]);

// Libellés FR/EN/local fréquents → code ISO alpha-2.
const COUNTRY_NAME_TO_CODE = {
  france: 'FR', 'francia': 'FR', frankreich: 'FR',
  espagne: 'ES', spain: 'ES', 'españa': 'ES', espana: 'ES',
  belgique: 'BE', belgium: 'BE', 'belgië': 'BE', belgie: 'BE',
  allemagne: 'DE', germany: 'DE', deutschland: 'DE',
  italie: 'IT', italy: 'IT', italia: 'IT',
  portugal: 'PT',
  'pays-bas': 'NL', netherlands: 'NL', nederland: 'NL', 'pays bas': 'NL',
  luxembourg: 'LU',
  suisse: 'CH', switzerland: 'CH', schweiz: 'CH',
  autriche: 'AT', austria: 'AT',
  irlande: 'IE', ireland: 'IE',
  'royaume-uni': 'GB', 'royaume uni': 'GB', 'united kingdom': 'GB', angleterre: 'GB', uk: 'GB',
  monaco: 'MC', andorre: 'AD', andorra: 'AD',
  pologne: 'PL', poland: 'PL',
  danemark: 'DK', suede: 'SE', 'suède': 'SE', finlande: 'FI', norvege: 'NO', 'norvège': 'NO',
  'republique tcheque': 'CZ', 'république tchèque': 'CZ', slovaquie: 'SK', hongrie: 'HU',
  roumanie: 'RO', bulgarie: 'BG', croatie: 'HR', slovenie: 'SI', 'slovénie': 'SI',
  grece: 'GR', 'grèce': 'GR', malte: 'MT', chypre: 'CY',
};

/** Normalise un pays (code ou libellé libre) → code ISO alpha-2. Défaut : FR. */
function normalizeCountryCode(country) {
  const v = String(country == null ? '' : country).trim();
  if (!v) return 'FR';
  if (/^[A-Za-z]{2}$/.test(v)) return v.toUpperCase();
  const key = v
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
  return COUNTRY_NAME_TO_CODE[key] || COUNTRY_NAME_TO_CODE[v.toLowerCase()] || '';
}

/**
 * Résout la zone de livraison depuis une adresse.
 * @param {string} country  pays (code ou libellé)
 * @param {string} postalCode code postal
 * @returns {string} un id de zone (toujours valide)
 */
function resolveZone(country, postalCode) {
  const cc = normalizeCountryCode(country);
  const pc = String(postalCode == null ? '' : postalCode).replace(/\s+/g, '');

  if (cc === 'FR') {
    if (/^9[78]\d{3}/.test(pc)) return 'domtom'; // 97xxx / 98xxx → DOM-TOM/COM
    if (/^20\d{3}/.test(pc)) return 'corse'; // 20xxx → Corse
    return 'metropole';
  }
  if (EUROPE_COUNTRY_CODES.has(cc)) return 'europe';
  return 'international';
}

module.exports = {
  ZONES,
  ZONE_IDS,
  ZONE_LABEL,
  EUROPE_COUNTRY_CODES,
  normalizeCountryCode,
  resolveZone,
};
