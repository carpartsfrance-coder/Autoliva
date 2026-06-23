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

// Europe = UE + AELE + voisins proches (codes ISO alpha-2). Sert à la LIVRAISON.
const EUROPE_COUNTRY_CODES = new Set([
  'ES', 'PT', 'IT', 'DE', 'BE', 'NL', 'LU', 'AT', 'IE', 'DK', 'SE', 'FI',
  'PL', 'CZ', 'SK', 'HU', 'RO', 'BG', 'HR', 'SI', 'EE', 'LV', 'LT', 'GR',
  'CY', 'MT', 'CH', 'NO', 'GB', 'MC', 'AD', 'LI', 'SM', 'IS',
]);

// UE au sens TVA = les 27 États membres MOINS la France (vendeur FR). À NE PAS
// confondre avec EUROPE_COUNTRY_CODES (livraison) qui inclut CH/NO/GB/MC/AD/LI/SM/IS
// — ces pays ne sont PAS dans l'UE-TVA, donc PAS éligibles à l'autoliquidation.
// (La Grèce a le code ISO 'GR' ; son préfixe TVA 'EL' est géré dans viesValidator.)
const EU_VAT_COUNTRY_CODES = new Set([
  'AT', 'BE', 'BG', 'HR', 'CY', 'CZ', 'DK', 'EE', 'FI', 'DE', 'GR', 'HU',
  'IE', 'IT', 'LV', 'LT', 'LU', 'MT', 'NL', 'PL', 'PT', 'RO', 'SK', 'SI',
  'ES', 'SE',
]);

/** true si le pays (code ou libellé) est un État membre UE AUTRE que la France. */
function isEuVatCountry(country) {
  return EU_VAT_COUNTRY_CODES.has(normalizeCountryCode(country));
}

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

// Territoires français reconnus par leur NOM (si le client choisit « La Réunion »
// plutôt que « France » dans le menu) → zone DOM-TOM directement.
const DOMTOM_NAME_KEYS = new Set([
  'guadeloupe', 'martinique', 'guyane', 'guyane francaise', 'la reunion', 'reunion',
  'mayotte', 'saint-pierre-et-miquelon', 'saint pierre et miquelon', 'saint-barthelemy',
  'saint barthelemy', 'saint-martin', 'saint martin', 'wallis-et-futuna', 'wallis et futuna',
  'nouvelle-caledonie', 'nouvelle caledonie', 'polynesie francaise', 'polynesie',
]);

/** Normalise un libellé pour comparaison : sans accents, minuscules, espaces compactés. */
function normName(s) {
  return String(s == null ? '' : s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Options du menu déroulant « Pays » au checkout (valeurs propres → zones fiables). */
const COUNTRY_OPTIONS = [
  { group: 'France & Outre-mer', items: [
    { value: 'France', label: 'France métropolitaine' },
    { value: 'Corse', label: 'Corse' },
    { value: 'Guadeloupe', label: 'Guadeloupe' },
    { value: 'Martinique', label: 'Martinique' },
    { value: 'Guyane', label: 'Guyane' },
    { value: 'La Réunion', label: 'La Réunion' },
    { value: 'Mayotte', label: 'Mayotte' },
  ] },
  { group: 'Europe', items: [
    { value: 'Espagne', label: 'Espagne' },
    { value: 'Belgique', label: 'Belgique' },
    { value: 'Allemagne', label: 'Allemagne' },
    { value: 'Italie', label: 'Italie' },
    { value: 'Portugal', label: 'Portugal' },
    { value: 'Pays-Bas', label: 'Pays-Bas' },
    { value: 'Luxembourg', label: 'Luxembourg' },
    { value: 'Suisse', label: 'Suisse' },
    { value: 'Autriche', label: 'Autriche' },
    { value: 'Irlande', label: 'Irlande' },
  ] },
  { group: 'International', items: [
    { value: 'Autre', label: 'Autre pays (international)' },
  ] },
];

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
  // 1) Territoire reconnu par son NOM (le client a choisi « La Réunion », « Corse »…).
  const nk = normName(country);
  if (DOMTOM_NAME_KEYS.has(nk)) return 'domtom';
  if (nk === 'corse') return 'corse';

  // 2) Sinon : code pays + code postal.
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
  EU_VAT_COUNTRY_CODES,
  isEuVatCountry,
  COUNTRY_OPTIONS,
  normalizeCountryCode,
  resolveZone,
};
