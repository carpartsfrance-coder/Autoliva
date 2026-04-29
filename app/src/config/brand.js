'use strict';

/**
 * Configuration centralisée de la marque (single source of truth).
 *
 * Toutes les chaînes liées au branding sont chargées ici, depuis les variables
 * d'environnement (.env) avec fallback sur les valeurs par défaut de la marque
 * sélectionnée.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 *  COMMENT BASCULER LA MARQUE :
 *  Pour faire tourner le site sous "Autoliva", il suffit de définir
 *  BRAND=autoliva dans le .env du déploiement (et de surcharger les COMPANY_*
 *  qui sont propres à la société).
 *
 *  Pour le déploiement carpartsfrance.fr, on met BRAND=carpartsfrance (ou rien,
 *  c'est le défaut) et on garde les valeurs actuelles.
 * ─────────────────────────────────────────────────────────────────────────────
 *
 *  USAGE :
 *    - Dans le code Node.js :
 *        const brand = require('./config/brand');
 *        console.log(brand.NAME);
 *
 *    - Dans les vues EJS (déjà exposé via app.locals.brand) :
 *        <%= brand.NAME %>
 *        <a href="mailto:<%= brand.EMAIL_CONTACT %>"><%= brand.EMAIL_CONTACT %></a>
 */

const BRAND = (process.env.BRAND || 'carpartsfrance').toLowerCase();

// ─── Préréglages par marque ──────────────────────────────────────────────────
const PRESETS = {
  carpartsfrance: {
    NAME: 'CarParts France',
    NAME_LEGACY: 'Car Parts France',
    NAME_SHORT: 'CarParts',
    LEGAL_NAME: 'Car Parts France',
    DOMAIN: 'carpartsfrance.fr',
    SITE_URL: 'https://carpartsfrance.fr',
    EMAIL_CONTACT: 'contact@carpartsfrance.fr',
    EMAIL_SAV: 'sav@carpartsfrance.fr',
    EMAIL_NOREPLY: 'noreply@carpartsfrance.fr',
    PHONE: '04 65 84 54 88',
    PHONE_INTL: '+33465845488',
    SMS_SENDER_ID: 'CarParts',
    TAGLINE: 'Pièces auto reconditionnées, expertise et garantie',
    LOGO_URL: '/images/logo-v2.png',
    LOGO_FAB_URL: '/images/logo-fab.png',
    FAVICON_URL: '/images/favicon.png',
    APPLE_TOUCH_ICON_URL: '/images/favicon.png',
    PRIMARY_COLOR: '#0F172A',
    ACCENT_COLOR: '#E10613',
    SOCIAL: {
      FACEBOOK: 'https://www.facebook.com/carpartsfrance',
      INSTAGRAM: 'https://www.instagram.com/carpartsfrance',
      YOUTUBE: '',
      TIKTOK: '',
      LINKEDIN: '',
    },
  },
  autoliva: {
    NAME: 'Autoliva',
    NAME_LEGACY: 'Car Parts France', // utilisé pour mention "anciennement Car Parts France"
    NAME_SHORT: 'Autoliva',
    LEGAL_NAME: 'Car Parts France',  // raison sociale inchangée
    DOMAIN: 'autoliva.com',
    SITE_URL: 'https://autoliva.com',
    EMAIL_CONTACT: 'contact@autoliva.com',
    EMAIL_SAV: 'sav@autoliva.com',
    EMAIL_NOREPLY: 'noreply@autoliva.com',
    PHONE: '04 65 84 54 88',
    PHONE_INTL: '+33465845488',
    SMS_SENDER_ID: 'AUTOLIVA',
    TAGLINE: 'Pièces automobiles reconditionnées premium',
    LOGO_URL: '/images/logo-autoliva.png',
    LOGO_FAB_URL: '/images/logo-autoliva-fab.png',
    FAVICON_URL: '/images/favicon-autoliva.png',
    APPLE_TOUCH_ICON_URL: '/images/apple-touch-icon-autoliva.png',
    PRIMARY_COLOR: '#0B1220',
    ACCENT_COLOR: '#E10613',
    SOCIAL: {
      FACEBOOK: 'https://www.facebook.com/autoliva',
      INSTAGRAM: 'https://www.instagram.com/autoliva',
      YOUTUBE: 'https://www.youtube.com/@autoliva',
      TIKTOK: 'https://www.tiktok.com/@autoliva',
      LINKEDIN: 'https://www.linkedin.com/company/autoliva',
    },
  },
};

const preset = PRESETS[BRAND] || PRESETS.carpartsfrance;

// Helper : env var avec fallback sur le preset
function env(key, fallback) {
  const value = process.env[key];
  return (typeof value === 'string' && value.trim() !== '') ? value.trim() : fallback;
}

// ─── Objet brand exposé ──────────────────────────────────────────────────────
const brand = {
  KEY: BRAND,

  // Identité
  NAME: env('BRAND_NAME', preset.NAME),
  NAME_LEGACY: env('BRAND_NAME_LEGACY', preset.NAME_LEGACY),
  NAME_SHORT: env('BRAND_NAME_SHORT', preset.NAME_SHORT),
  TAGLINE: env('BRAND_TAGLINE', preset.TAGLINE),

  // URLs
  DOMAIN: env('BRAND_DOMAIN', preset.DOMAIN),
  SITE_URL: env('SITE_URL', preset.SITE_URL),

  // Contacts
  EMAIL_CONTACT: env('BRAND_EMAIL_CONTACT', preset.EMAIL_CONTACT),
  EMAIL_SAV: env('BRAND_EMAIL_SAV', preset.EMAIL_SAV),
  EMAIL_NOREPLY: env('BRAND_EMAIL_NOREPLY', preset.EMAIL_NOREPLY),
  PHONE: env('BRAND_PHONE', preset.PHONE),
  PHONE_INTL: env('BRAND_PHONE_INTL', preset.PHONE_INTL),
  SMS_SENDER_ID: env('SMS_SENDER_ID', preset.SMS_SENDER_ID),

  // Visuels
  LOGO_URL: env('BRAND_LOGO_URL', preset.LOGO_URL),
  LOGO_FAB_URL: env('BRAND_LOGO_FAB_URL', preset.LOGO_FAB_URL),
  FAVICON_URL: env('BRAND_FAVICON_URL', preset.FAVICON_URL),
  APPLE_TOUCH_ICON_URL: env('BRAND_APPLE_TOUCH_ICON_URL', preset.APPLE_TOUCH_ICON_URL),
  PRIMARY_COLOR: env('BRAND_PRIMARY_COLOR', preset.PRIMARY_COLOR),
  ACCENT_COLOR: env('BRAND_ACCENT_COLOR', preset.ACCENT_COLOR),

  // Réseaux sociaux (override possible avec SOCIAL_*_URL existants)
  SOCIAL: {
    FACEBOOK:  env('SOCIAL_FACEBOOK_URL',  preset.SOCIAL.FACEBOOK),
    INSTAGRAM: env('SOCIAL_INSTAGRAM_URL', preset.SOCIAL.INSTAGRAM),
    YOUTUBE:   env('SOCIAL_YOUTUBE_URL',   preset.SOCIAL.YOUTUBE),
    TIKTOK:    env('SOCIAL_TIKTOK_URL',    preset.SOCIAL.TIKTOK),
    LINKEDIN:  env('SOCIAL_LINKEDIN_URL',  preset.SOCIAL.LINKEDIN),
  },

  // Société (raison sociale, RCS, SIRET, etc.) — viennent du .env existant
  COMPANY: {
    LEGAL_NAME:  env('COMPANY_LEGAL_NAME',  preset.LEGAL_NAME),
    LEGAL_FORM:  env('COMPANY_LEGAL_FORM',  ''),
    RCS:         env('COMPANY_RCS',         ''),
    SIRET:       env('COMPANY_SIRET',       ''),
    VAT:         env('COMPANY_VAT',         ''),
    ADDRESS:     env('COMPANY_ADDRESS',     ''),
    CAPITAL:     env('COMPANY_CAPITAL',     ''),
    APE:         env('COMPANY_APE',         ''),
    WEBSITE_URL: env('COMPANY_WEBSITE_URL', preset.SITE_URL),
    LOGO_URL:    env('COMPANY_LOGO_URL',    preset.LOGO_URL),
  },

  // Drapeaux pratiques
  isAutoliva: BRAND === 'autoliva',
  isCarPartsFrance: BRAND === 'carpartsfrance',
};

module.exports = brand;
