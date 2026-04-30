'use strict';

/**
 * Brand sanitizer — filet de sécurité côté rendu.
 *
 * Le rebranding Car Parts France → Autoliva s'est fait via la variable
 * d'environnement BRAND, mais :
 *   1. siteSettings.aboutText (DB) a été saisi à l'époque "Car Parts France"
 *      et sert de meta description sur la HP.
 *   2. products.seo.metaTitle / seo.metaDescription (DB) ont parfois été
 *      enrichis manuellement avec un suffix " | CarParts France".
 *   3. category.name peut contenir " > " (chevron de navigation)
 *      qui se retrouve tel quel dans le H1 et le title.
 *
 * Plutôt qu'attendre un cleanup DB, on filtre à la volée toute occurrence du
 * legacy brand → brand.NAME courant. Sans effet quand BRAND=carpartsfrance.
 */

const brand = require('../config/brand');

/* Variantes du legacy brand qu'on remplace par brand.NAME courant.
   On va du plus spécifique au plus générique pour éviter les collisions. */
const LEGACY_VARIANTS = [
  'CarParts France',
  'Carparts France',
  'CARPARTS FRANCE',
  'Car Parts France',
  'Car parts France',
  'CAR PARTS FRANCE',
];

const LEGACY_DOMAINS = [
  'https://www.carpartsfrance.fr',
  'https://carpartsfrance.fr',
  'http://www.carpartsfrance.fr',
  'http://carpartsfrance.fr',
  'www.carpartsfrance.fr',
  'carpartsfrance.fr',
];

const LEGACY_EMAIL_RE = /\b([a-z0-9._-]+)@carpartsfrance\.fr\b/gi;

/**
 * Remplace les occurrences "Car Parts France" / "CarParts France" / domaine /
 * email legacy par leur équivalent brand courant.
 *
 * No-op quand brand.KEY === 'carpartsfrance' (déploiement legacy).
 */
function sanitizeBrandLeak(text) {
  if (typeof text !== 'string' || !text) return text;
  if (brand.KEY === 'carpartsfrance') return text;

  let out = text;

  for (const variant of LEGACY_VARIANTS) {
    if (out.indexOf(variant) === -1) continue;
    out = out.split(variant).join(brand.NAME);
  }

  for (const domain of LEGACY_DOMAINS) {
    if (out.indexOf(domain) === -1) continue;
    const replacement = domain.startsWith('http') ? brand.SITE_URL : brand.DOMAIN;
    out = out.split(domain).join(replacement);
  }

  out = out.replace(LEGACY_EMAIL_RE, (_match, local) => {
    const lower = String(local).toLowerCase();
    if (lower === 'sav') return brand.EMAIL_SAV;
    if (lower === 'noreply' || lower === 'no-reply') return brand.EMAIL_NOREPLY;
    return brand.EMAIL_CONTACT;
  });

  return out;
}

/**
 * Nettoie un nom de catégorie pour l'affichage (H1, title, og:title).
 *
 * En base, certaines catégories sont nommées "Moteur > Bloc moteur" avec un
 * chevron qui matérialise la hiérarchie parent > enfant. Ce chevron pollue
 * le H1 et le <title>. On garde uniquement le segment terminal et on remplace
 * le séparateur par un tiret cadratin pour les rares cas où on veut afficher
 * la hiérarchie.
 *
 * @param {string} name - Nom brut tel que stocké en DB.
 * @param {Object} [options]
 * @param {boolean} [options.keepHierarchy=false] - Si true, conserve le parent
 *   en remplaçant " > " par " — " (utile pour le breadcrumb textuel).
 * @returns {string}
 */
function formatCategoryDisplayName(name, options = {}) {
  if (typeof name !== 'string') return '';
  const trimmed = name.trim();
  if (!trimmed) return '';

  if (options.keepHierarchy) {
    return trimmed.replace(/\s*>\s*/g, ' — ');
  }

  /* Par défaut on ne garde que le dernier segment : "Moteur > Bloc moteur"
     → "Bloc moteur". C'est suffisant car le breadcrumb au-dessus du H1
     rappelle déjà la hiérarchie. */
  const idx = trimmed.lastIndexOf('>');
  if (idx === -1) return trimmed;
  return trimmed.slice(idx + 1).trim() || trimmed;
}

module.exports = {
  sanitizeBrandLeak,
  formatCategoryDisplayName,
  LEGACY_VARIANTS,
  LEGACY_DOMAINS,
};
