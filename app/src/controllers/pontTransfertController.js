'use strict';

/**
 * Landing « Pont / différentiel / boîte de transfert » : page publique de capture leads.
 *
 *   GET  /ponts-differentiels          → page de vente (variante ponts & différentiels)
 *   POST /ponts-differentiels/devis    → traitement du formulaire (sync, sans JS)
 *   GET  /boites-de-transfert          → même page, copy « boîte de transfert » (message match Ads)
 *   POST /boites-de-transfert/devis    → traitement du formulaire
 *
 * Le lead est upserté dans AbandonedCart (= Lead) via le service
 * `leadCapture.captureContactLead` avec captureSource = 'landing_ponts'.
 * L'attribution UTM/gclid est lue depuis `req.session.attribution`
 * (alimenté par le middleware `captureAttribution`).
 *
 * Le commercial voit les leads dans /admin/devis-moteurs (badge Pont/Transfert)
 * et /admin/activite-panier (filtre captureSource=landing_ponts).
 */

const mongoose = require('mongoose');
const crypto = require('crypto');

const emailService = require('../services/emailService');
const { sendSms, normalizePhoneFR } = require('../services/smsService');
const { resolveSms } = require('../services/smsSettings');
const { captureContactLead } = require('../services/leadCapture');
const { track: trackEvent, rememberEmail } = require('../services/eventTracker');
const { getPublicBaseUrlFromReq } = require('../services/productPublic');
const { buildHreflangSet } = require('../services/i18n');
const brand = require('../config/brand');

const LANDING_PATH = '/ponts-differentiels';
const TRANSFERT_PATH = '/boites-de-transfert';
const CAPTURE_SOURCE = 'landing_ponts';

/* Types de pièce proposés dans le formulaire (remplace « complet/nu » des moteurs).
 * La valeur remonte dans requested.vehicle → visible directement par le commercial. */
const PART_TYPES = {
  pont_avant: 'Pont avant',
  pont_arriere: 'Pont arrière',
  differentiel: 'Différentiel',
  boite_transfert: 'Boîte de transfert',
};

/* Deux landing pages partagent la MÊME vue + le MÊME tunnel de devis, avec une
 * "copy" (message) adaptée à l'intention de recherche (message match Google Ads) :
 *  - /ponts-differentiels → ponts & différentiels (campagne « Ponts & Différentiels »)
 *  - /boites-de-transfert → boîtes de transfert  (campagne « Boîtes de Transfert »)
 * La variante est déduite de l'URL → tous les renderPage existants s'adaptent. */
function getVariant(req) {
  const p = String((req && (req.path || req.originalUrl)) || '');
  return p.indexOf('transfert') !== -1 ? 'transfert' : 'ponts';
}

const VARIANTS = {
  ponts: {
    path: LANDING_PATH,
    view: 'pont-transfert/index',
    conditionLabel: 'Pont / différentiel',
    title: `Pont & différentiel reconditionnés, échange standard garanti — ${brand.NAME}`,
    metaDescription:
      'Ponts avant/arrière et différentiels reconditionnés en échange standard : roulements et joints neufs, contrôle jeu/denture, garantie jusqu’à 2 ans. Devis sous 24h, livraison rapide.',
    jsonLdServiceType: 'Vente de ponts et différentiels reconditionnés en échange standard',
    jsonLdDescription:
      'Ponts avant/arrière et différentiels reconditionnés (roulements, joints et pièces d’usure remplacés), contrôlés avant expédition, garantie jusqu’à 2 ans. Échange standard. Devis personnalisé sous 24h.',
    copy: {
      formAction: '/ponts-differentiels/devis',
      funnelName: 'pont-differentiel',
      showStateField: true,
      defaultPartType: '',
      eyebrow: 'Ponts & différentiels reconditionnés',
      h1Html: 'Des ponts et différentiels<br>reconditionnés,<br><span class="text-brand-red">prêts à reprendre la route.</span>',
      sub: 'Ponts avant/arrière et différentiels reconditionnés en échange standard : roulements et joints neufs, contrôle complet, expédition rapide partout en Europe.',
      warrantyLabel: 'Garantie jusqu’à 2 ans',
      qualitySubtitle: 'Un reconditionnement en 7 étapes, pour une fiabilité maximale.',
      steps: [
        { n: '01', icon: 'doc', title: 'Identification', desc: 'Vérification de la référence et compatibilité' },
        { n: '02', icon: 'wrench', title: 'Démontage complet', desc: 'Ouverture et inspection du carter' },
        { n: '03', icon: 'clean', title: 'Nettoyage & contrôle', desc: 'Dégraissage et métrologie des pièces' },
        { n: '04', icon: 'gear', title: 'Remise à neuf', desc: 'Roulements, joints et pièces d’usure remplacés', highlight: true },
        { n: '05', icon: 'cog', title: 'Réglages', desc: 'Précharge et jeu de denture aux tolérances constructeur' },
        { n: '06', icon: 'shield', title: 'Tests & rapport', desc: 'Contrôle jeu/denture/étanchéité + attestation' },
        { n: '07', icon: 'truck', title: 'Expédition', desc: 'Emballage sécurisé et expédition rapide' },
      ],
    },
  },
  transfert: {
    path: TRANSFERT_PATH,
    view: 'pont-transfert/index',
    conditionLabel: 'Boîte de transfert',
    title: `Boîte de transfert reconditionnée, échange standard garanti — ${brand.NAME}`,
    metaDescription:
      'Boîtes de transfert reconditionnées en échange standard (BMW xDrive ATC, Mercedes 4MATIC, 4x4 & SUV) : chaîne, roulements et joints contrôlés, garantie jusqu’à 2 ans. Devis sous 24h.',
    jsonLdServiceType: 'Vente de boîtes de transfert reconditionnées en échange standard',
    jsonLdDescription:
      'Boîtes de transfert reconditionnées (chaîne, roulements, actuateur et pièces d’usure contrôlés ou remplacés), testées avant expédition, garantie jusqu’à 2 ans. Échange standard. Devis personnalisé sous 24h.',
    copy: {
      formAction: '/boites-de-transfert/devis',
      funnelName: 'boite-transfert',
      showStateField: true,
      defaultPartType: 'boite_transfert',
      eyebrow: 'Boîtes de transfert reconditionnées',
      h1Html: 'Des boîtes de transfert<br>reconditionnées,<br><span class="text-brand-red">testées et garanties.</span>',
      sub: 'BMW xDrive (ATC), Mercedes 4MATIC, 4x4 et SUV : boîtes de transfert reconditionnées en échange standard, contrôlées avant expédition, livrées rapidement partout en Europe.',
      warrantyLabel: 'Garantie jusqu’à 2 ans',
      qualitySubtitle: 'Un reconditionnement en 7 étapes, pour une fiabilité maximale.',
      steps: [
        { n: '01', icon: 'doc', title: 'Identification', desc: 'Vérification de la référence et compatibilité' },
        { n: '02', icon: 'wrench', title: 'Démontage complet', desc: 'Ouverture et inspection du carter' },
        { n: '03', icon: 'clean', title: 'Nettoyage & contrôle', desc: 'Chaîne, pignons et actuateur inspectés' },
        { n: '04', icon: 'gear', title: 'Remise à neuf', desc: 'Chaîne, roulements et joints remplacés si usés', highlight: true },
        { n: '05', icon: 'cog', title: 'Remontage', desc: 'Remontage aux couples constructeur' },
        { n: '06', icon: 'shield', title: 'Tests & rapport', desc: 'Contrôle rotation/étanchéité + attestation' },
        { n: '07', icon: 'truck', title: 'Expédition', desc: 'Emballage sécurisé et expédition rapide' },
      ],
    },
  },
};

/* Génère un numéro de devis unique au format AUT-2026-05-A1B2C3
 * (6 hex chars random → collision proba ≈ 0 pour <1000 leads/mois). */
function generateQuoteRef() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `AUT-${year}-${month}-${suffix}`;
}

/* Template HTML brandé pour l'accusé réception client.
 * Utilise des tables inline (compat email client maximale). */
function buildAckEmailHtml({ firstName, quoteRef, plate, partTypeLabel, brandObj }) {
  const safeFirstName = firstName ? String(firstName).replace(/[<>&"]/g, '') : '';
  const safePlate = plate ? String(plate).replace(/[<>&"]/g, '') : '';
  const safePartType = partTypeLabel || '—';
  const dateOnly = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  const timeOnly = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  // L'URL du logo et du site doivent être absolues (publiques) pour s'afficher dans les emails.
  const publicSite = 'https://autoliva.com';
  const logoUrl = publicSite + '/images/logo-autoliva.png';
  const phoneIntl = brandObj.PHONE_MOTEUR_INTL || '+33465848539';
  const phoneDisplay = brandObj.PHONE_MOTEUR || '04 65 84 85 39';
  const greeting = safeFirstName ? `Bonjour ${safeFirstName},` : 'Bonjour,';

  return `<!DOCTYPE html>
<html lang="fr">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Votre demande de devis — Autoliva</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,'Helvetica Neue',Arial,sans-serif;color:#1f2937;">
<!-- Preheader -->
<div style="display:none;font-size:1px;color:#f4f5f7;line-height:1px;max-height:0;max-width:0;opacity:0;overflow:hidden;">Demande ${quoteRef} bien reçue · Retour d'un technicien sous 24h ouvrées.</div>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f5f7;padding:32px 12px;">
  <tr><td align="center">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="680" style="max-width:680px;width:100%;background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb;">

      <!-- HEADER : logo image à gauche, tag dossier à droite -->
      <tr><td style="padding:24px 32px;border-bottom:1px solid #f1f2f4;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr>
            <td style="vertical-align:middle;">
              <img src="${logoUrl}" alt="Autoliva" width="160" height="auto" style="display:block;border:0;outline:none;text-decoration:none;height:auto;width:160px;">
            </td>
            <td align="right" style="vertical-align:middle;">
              <span style="display:inline-block;background:#f4f5f7;color:#475569;font-size:11px;font-weight:600;padding:6px 10px;border-radius:6px;font-family:'SF Mono','Monaco','Consolas',monospace;">Dossier ${quoteRef}</span>
            </td>
          </tr>
        </table>
      </td></tr>

      <!-- HERO : titre + intro, gauche-aligné -->
      <tr><td style="padding:36px 32px 24px;">
        <p style="margin:0 0 6px;font-size:13px;color:#10b981;font-weight:600;letter-spacing:0.02em;">Demande reçue le ${dateOnly} à ${timeOnly}</p>
        <h1 style="margin:0 0 14px;font-size:26px;line-height:1.2;font-weight:700;letter-spacing:-0.02em;color:#0f172a;">${greeting}</h1>
        <p style="margin:0;font-size:15px;color:#374151;line-height:1.6;">Merci pour votre demande. Un technicien Autoliva va analyser votre véhicule et vous recontacter <strong>sous 24 heures ouvrées</strong>, par email ou téléphone.</p>
      </td></tr>

      <!-- RÉCAP 2 COLONNES (4 fields, 2 par ligne) -->
      <tr><td style="padding:8px 32px 24px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fafbfc;border:1px solid #eef0f3;border-radius:10px;">
          <tr>
            <td style="padding:18px 20px;border-bottom:1px solid #eef0f3;width:50%;border-right:1px solid #eef0f3;">
              <p style="margin:0 0 4px;font-size:11px;color:#94a3b8;font-weight:500;">Numéro de dossier</p>
              <p style="margin:0;font-size:14px;font-weight:700;color:#0f172a;font-family:'SF Mono','Monaco','Consolas',monospace;">${quoteRef}</p>
            </td>
            <td style="padding:18px 20px;border-bottom:1px solid #eef0f3;width:50%;">
              <p style="margin:0 0 4px;font-size:11px;color:#94a3b8;font-weight:500;">Véhicule</p>
              <p style="margin:0;font-size:14px;font-weight:600;color:#0f172a;font-family:'SF Mono','Monaco','Consolas',monospace;">${safePlate || '—'}</p>
            </td>
          </tr>
          <tr>
            <td style="padding:18px 20px;width:50%;border-right:1px solid #eef0f3;">
              <p style="margin:0 0 4px;font-size:11px;color:#94a3b8;font-weight:500;">Pièce demandée</p>
              <p style="margin:0;font-size:14px;color:#0f172a;">${safePartType}</p>
            </td>
            <td style="padding:18px 20px;width:50%;">
              <p style="margin:0 0 4px;font-size:11px;color:#94a3b8;font-weight:500;">Délai de retour</p>
              <p style="margin:0;font-size:14px;color:#0f172a;">24h ouvrées max.</p>
            </td>
          </tr>
        </table>
      </td></tr>

      <!-- LES PROCHAINES ÉTAPES -->
      <tr><td style="padding:8px 32px 8px;">
        <h2 style="margin:0 0 16px;font-size:14px;font-weight:600;color:#475569;letter-spacing:-0.01em;">Comment ça se passe maintenant</h2>

        <!-- Étape 1 -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:14px;">
          <tr>
            <td valign="top" width="28" style="padding-right:14px;">
              <div style="width:24px;height:24px;border-radius:50%;background:#0f172a;color:#ffffff;text-align:center;line-height:24px;font-weight:700;font-size:12px;">1</div>
            </td>
            <td valign="top">
              <p style="margin:0;font-size:14px;color:#1f2937;line-height:1.6;"><strong style="color:#0f172a;">Analyse de votre demande.</strong> On vérifie la disponibilité de la pièce et on prépare votre devis personnalisé.</p>
            </td>
          </tr>
        </table>

        <!-- Étape 2 -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:14px;">
          <tr>
            <td valign="top" width="28" style="padding-right:14px;">
              <div style="width:24px;height:24px;border-radius:50%;background:#0f172a;color:#ffffff;text-align:center;line-height:24px;font-weight:700;font-size:12px;">2</div>
            </td>
            <td valign="top">
              <p style="margin:0 0 10px;font-size:14px;color:#1f2937;line-height:1.6;"><strong style="color:#0f172a;">Retour par email ou téléphone.</strong> Selon le stock, 2 cas possibles :</p>

              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-bottom:6px;">
                <tr>
                  <td style="padding:11px 14px;background:#fafbfc;border-left:3px solid #10b981;border-radius:4px;">
                    <p style="margin:0;font-size:13px;color:#1f2937;line-height:1.55;"><strong style="color:#047857;">En stock atelier —</strong> pièce déjà contrôlée, expédition sous <strong>48 à 72h</strong> après accord.</p>
                  </td>
                </tr>
              </table>

              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:6px;">
                <tr>
                  <td style="padding:11px 14px;background:#fafbfc;border-left:3px solid #3b82f6;border-radius:4px;">
                    <p style="margin:0;font-size:13px;color:#1f2937;line-height:1.55;"><strong style="color:#1d4ed8;">Sourcing réseau —</strong> on trouve la pièce, on la réceptionne, contrôle obligatoire, puis expédition. <strong>Délai confirmé dans votre devis</strong>.</p>
                  </td>
                </tr>
              </table>
            </td>
          </tr>
        </table>

        <!-- Étape 3 -->
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
          <tr>
            <td valign="top" width="28" style="padding-right:14px;">
              <div style="width:24px;height:24px;border-radius:50%;background:#0f172a;color:#ffffff;text-align:center;line-height:24px;font-weight:700;font-size:12px;">3</div>
            </td>
            <td valign="top">
              <p style="margin:0;font-size:14px;color:#1f2937;line-height:1.6;"><strong style="color:#0f172a;">Aucune pièce n'est expédiée sans contrôle.</strong> Jeu, denture, étanchéité — même quand on doit sourcer la pièce pour vous.</p>
            </td>
          </tr>
        </table>
      </td></tr>

      <!-- TRUST STRIP : une ligne discrète au lieu d'un gros bloc -->
      <tr><td style="padding:24px 32px 8px;">
        <p style="margin:0;padding:14px 18px;background:#fafbfc;border:1px solid #eef0f3;border-radius:8px;font-size:13px;color:#475569;text-align:center;line-height:1.5;">
          Contrôle complet · Échange standard · Garantie incluse sans franchise
        </p>
      </td></tr>

      <!-- Aide / urgence (transactionnel, sans CTA marketing) -->
      <tr><td style="padding:18px 32px 28px;">
        <p style="margin:0;font-size:13px;color:#64748b;line-height:1.6;">
          Une question ou c'est urgent ? Appelez-nous au <a href="tel:${phoneIntl}" style="color:#0f172a;font-weight:700;text-decoration:none;">${phoneDisplay}</a> — on vous répond directement.
        </p>
      </td></tr>

      <!-- SIGNATURE -->
      <tr><td style="padding:24px 32px 8px;border-top:1px solid #f1f2f4;">
        <p style="margin:0;font-size:14px;color:#1f2937;line-height:1.6;">À très vite,<br><strong>L'équipe technique Autoliva</strong></p>
      </td></tr>

      <!-- FOOTER -->
      <tr><td style="padding:18px 32px 28px;">
        <p style="margin:0;font-size:11px;color:#94a3b8;line-height:1.5;">
          Autoliva — Spécialiste transmission : ponts, différentiels et boîtes de transfert testés et garantis.<br>
          <a href="mailto:contact@autoliva.com" style="color:#94a3b8;text-decoration:underline;">contact@autoliva.com</a> · <a href="tel:${phoneIntl}" style="color:#94a3b8;text-decoration:none;">${phoneDisplay}</a> · <a href="${publicSite}" style="color:#94a3b8;text-decoration:underline;">autoliva.com</a><br>
          Vos données sont confidentielles et traitées conformément au RGPD. Référence à conserver : <strong style="color:#475569;font-family:'SF Mono',monospace;">${quoteRef}</strong>
        </p>
      </td></tr>

    </table>
  </td></tr>
</table>

</body>
</html>`;
}

/* Données paramétriques affichées dans la vue.
 * Réutilise les mêmes preuves/partenaires que les landings moteurs & boîtes
 * (mêmes photos réelles, mêmes partenaires — l'atelier est le même). */
const LANDING_DATA = {
  deliveredSince2019: 1000, // validé (toutes pièces confondues)
  installers: [
    { mono: 'PO', name: 'Centre Porsche', cat: 'Concessionnaire' },
    { mono: 'ME', name: 'Concession Mercedes', cat: 'Concessionnaire' },
    { mono: 'VW', name: 'Centre Volkswagen', cat: 'Concessionnaire' },
    { mono: 'RE', name: 'Concession Renault', cat: 'Concessionnaire' },
    { mono: 'MA', name: 'Mougins Auto Sport', cat: 'Spécialiste Porsche' },
    { mono: 'F44', name: 'Flat 44', cat: 'Indépendant Porsche' },
  ],
};

/* ─── Helpers ─────────────────────────────────────────────────────────── */

function trim(value) {
  return typeof value === 'string' ? value.trim() : value ? String(value).trim() : '';
}

function normalizeEmail(value) {
  const v = trim(value).toLowerCase();
  if (!v) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return '';
  return v;
}

function normalizePhone(value) {
  return trim(value).replace(/[^+0-9]/g, '').slice(0, 24);
}

function normalizePlate(value) {
  // Le champ accepte plaque (~9), référence OEM (~12) OU VIN/n° de châssis (17 car.).
  return trim(value).toUpperCase().replace(/\s+/g, '').slice(0, 32);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function getClientIp(req) {
  const xfwd = req && req.headers ? req.headers['x-forwarded-for'] : null;
  const fromHeader = Array.isArray(xfwd)
    ? xfwd[0]
    : typeof xfwd === 'string' ? xfwd.split(',')[0] : '';
  return trim(fromHeader) || (req && req.ip ? String(req.ip) : 'unknown');
}

// Rate-limit IP : 8 leads max / 10 min (en mémoire, anti-spam léger)
const RATE_BUCKETS = new Map();
function isRateLimited(req) {
  const now = Date.now();
  const ip = getClientIp(req);
  const entry = RATE_BUCKETS.get(ip);
  if (!entry || now >= entry.resetAt) {
    RATE_BUCKETS.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000 });
    return false;
  }
  entry.count += 1;
  return entry.count > 8;
}

function getInternalToEmail() {
  const fromEnv = trim(process.env.LEAD_FORM_TO_EMAIL || process.env.CONTACT_FORM_TO_EMAIL);
  return fromEnv || brand.EMAIL_CONTACT;
}

function buildServiceJsonLd({ baseUrl, v }) {
  const safeBase = trim(baseUrl).replace(/\/$/, '');
  const url = safeBase ? `${safeBase}${v.path}` : v.path;
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Service',
    serviceType: v.jsonLdServiceType,
    provider: {
      '@type': 'Organization',
      name: brand.NAME,
      url: brand.SITE_URL,
      telephone: brand.PHONE_MOTEUR_INTL,
      email: brand.EMAIL_CONTACT,
    },
    areaServed: { '@type': 'Country', name: 'France' },
    url,
    description: v.jsonLdDescription,
    offers: {
      '@type': 'Offer',
      url,
      availability: 'https://schema.org/InStock',
      priceCurrency: 'EUR',
    },
  });
}

function buildInitialForm(req, variant) {
  const q = (req && req.query && typeof req.query === 'object') ? req.query : {};
  const v = VARIANTS[variant] || VARIANTS.ponts;
  const partTypeRaw = trim(q.partType).toLowerCase();
  return {
    plate: trim(q.plate || q.immat),
    fullName: trim(q.fullName),
    email: trim(q.email),
    phone: trim(q.phone),
    message: '',
    partType: PART_TYPES[partTypeRaw] ? partTypeRaw : (v.copy.defaultPartType || ''),
    etat: '',
    website: '', // honeypot
  };
}

function renderPage(res, req, opts) {
  const variant = opts.variant || getVariant(req);
  const v = VARIANTS[variant] || VARIANTS.ponts;
  const baseUrl = getPublicBaseUrlFromReq(req);
  const langPrefix = req.lang === 'en' ? '/en' : '';
  const pathWithoutLang = res.locals.currentPathWithoutLang || req.path;
  const hreflang = buildHreflangSet(baseUrl, pathWithoutLang);

  const title = v.title;
  const metaDescription = v.metaDescription;
  const canonicalUrl = baseUrl ? `${baseUrl}${langPrefix}${v.path}` : `${langPrefix}${v.path}`;

  return res.status(opts.statusCode || 200).render(v.view, {
    title,
    metaDescription,
    canonicalUrl,
    ...hreflang,
    ogTitle: title,
    ogDescription: metaDescription,
    ogUrl: canonicalUrl,
    ogType: 'website',
    jsonLd: buildServiceJsonLd({ baseUrl, v }),
    landing: LANDING_DATA,
    copy: v.copy,
    partTypes: PART_TYPES,
    form: opts.form,
    errorMessage: opts.errorMessage || null,
    successMessage: opts.successMessage || null,
    conversion: opts.conversion || null, // données pour le tag de conversion Google Ads (lead)
    dbConnected: mongoose.connection.readyState === 1,
  });
}

/* ─── Handlers ────────────────────────────────────────────────────────── */

async function getLanding(req, res, next) {
  try {
    if (req.session && typeof req.session === 'object') {
      req.session.moteurFormTs = Date.now();
    }
    return renderPage(res, req, { form: buildInitialForm(req, getVariant(req)) });
  } catch (err) {
    return next(err);
  }
}

async function postDevis(req, res, next) {
  try {
    const variant = getVariant(req);
    const v = VARIANTS[variant] || VARIANTS.ponts;
    const body = (req.body && typeof req.body === 'object') ? req.body : {};

    // État choisi par le client (reconditionné / occasion / je ne sais pas).
    const etatRaw = trim(body.etat).toLowerCase();
    const etat = (etatRaw === 'reconditionne' || etatRaw === 'occasion' || etatRaw === 'je_sais_pas') ? etatRaw : '';

    // Type de pièce (pont AV / pont AR / différentiel / boîte de transfert).
    const partTypeRaw = trim(body.partType).toLowerCase();
    const partType = PART_TYPES[partTypeRaw] ? partTypeRaw : '';
    const partTypeLabel = partType ? PART_TYPES[partType] : '';

    // Libellé condition → requested.vehicle → deriveCondition côté back-office.
    const baseLabel = partTypeLabel || v.conditionLabel;
    const conditionLabel = etat === 'reconditionne' ? `${baseLabel} reconditionné(e)`
      : etat === 'occasion' ? `${baseLabel} d'occasion`
      : etat === 'je_sais_pas' ? `${baseLabel} (état à préciser)`
      : baseLabel;

    const composedMessage = partTypeLabel ? `Pièce demandée : ${partTypeLabel}` : '';

    const form = {
      plate: normalizePlate(body.plate || body.immat),
      fullName: trim(body.fullName).slice(0, 120),
      email: trim(body.email).slice(0, 160),
      phone: trim(body.phone).slice(0, 24),
      message: composedMessage,
      partType,
      etat,
      website: trim(body.website), // honeypot
    };

    // Honeypot : faux succès silencieux
    if (form.website) {
      return renderPage(res, req, {
        form: buildInitialForm({ query: {} }, variant),
        successMessage: 'Merci ! Votre demande a bien été envoyée. Un technicien vous recontacte sous 24h.',
      });
    }

    if (isRateLimited(req)) {
      return renderPage(res, req, {
        form,
        statusCode: 429,
        errorMessage: 'Trop de tentatives. Merci de réessayer dans quelques minutes.',
      });
    }

    // Anti double-submit session (800ms)
    const sessionTs = req.session && typeof req.session.moteurFormTs === 'number' ? req.session.moteurFormTs : 0;
    if (sessionTs && Date.now() - sessionTs < 800) {
      return renderPage(res, req, {
        form,
        statusCode: 400,
        errorMessage: 'Merci de patienter une seconde puis de renvoyer le formulaire.',
      });
    }

    // Validation : plaque/châssis/référence + téléphone obligatoires
    const cleanEmail = normalizeEmail(form.email);
    // Stocke le numéro au format canonique E.164 (+33…) dès la capture : garantit
    // que TOUS les SMS ultérieurs (accusé + devis) partent (Brevo exige E.164).
    const cleanPhone = normalizePhoneFR(form.phone) || normalizePhone(form.phone);

    if (!form.plate) {
      return renderPage(res, req, {
        form,
        statusCode: 400,
        errorMessage: 'Merci d’indiquer votre plaque, N° de châssis ou référence.',
      });
    }
    if (!cleanPhone) {
      return renderPage(res, req, {
        form,
        statusCode: 400,
        errorMessage: 'Merci d’indiquer un numéro de téléphone pour qu’on puisse vous rappeler.',
      });
    }
    if (form.email && !cleanEmail) {
      return renderPage(res, req, {
        form,
        statusCode: 400,
        errorMessage: 'L’email ne semble pas valide.',
      });
    }

    // Split nom complet → firstName / lastName
    const nameParts = form.fullName.split(/\s+/).filter(Boolean);
    const firstNameRaw = nameParts.shift() || '';
    const lastName = nameParts.join(' ');
    // Si le client tape un seul mot, on ne sait pas si c'est prénom ou nom → pas de « Bonjour <nom> »
    const firstName = (firstNameRaw && lastName) ? firstNameRaw : '';
    const displayName = form.fullName || cleanEmail || cleanPhone;

    // Numéro de devis unique pour cette demande
    const quoteRef = generateQuoteRef();

    // 1) Email interne (notification commercial)
    const internalSubject = `[Pont/Transfert] ${quoteRef} — ${displayName}${form.plate ? ` — ${form.plate}` : ''}`.slice(0, 180);
    const internalHtml = `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827;">
        <h2 style="margin:0 0 8px 0;">Nouveau lead — Pont / Transfert (${escapeHtml(conditionLabel)})</h2>
        <p style="margin:0 0 12px 0;"><strong>N° de dossier :</strong> <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;">${escapeHtml(quoteRef)}</code></p>
        <p style="margin:0 0 12px 0;"><strong>Source :</strong> ${CAPTURE_SOURCE} (landing ${escapeHtml(v.path)})</p>
        <p style="margin:0 0 12px 0;"><strong>Nom :</strong> ${escapeHtml(displayName)}</p>
        ${cleanEmail ? `<p style="margin:0 0 12px 0;"><strong>Email :</strong> <a href="mailto:${escapeHtml(cleanEmail)}">${escapeHtml(cleanEmail)}</a></p>` : ''}
        ${cleanPhone ? `<p style="margin:0 0 12px 0;"><strong>Téléphone :</strong> <a href="tel:${escapeHtml(cleanPhone)}">${escapeHtml(cleanPhone)}</a></p>` : ''}
        ${form.plate ? `<p style="margin:0 0 12px 0;"><strong>Immat/châssis/réf :</strong> ${escapeHtml(form.plate)}</p>` : ''}
        ${partTypeLabel ? `<p style="margin:0 0 12px 0;"><strong>Pièce demandée :</strong> ${escapeHtml(partTypeLabel)}</p>` : ''}
        ${form.message ? `<hr/><p style="margin:0 0 8px 0;"><strong>Message :</strong></p><div style="font-size:14px;">${escapeHtml(form.message).replace(/\r?\n/g, '<br/>')}</div>` : ''}
        <p style="margin-top:16px;color:#6b7280;font-size:12px;">Détails complets dans /admin/devis-moteurs (badge : Pont/Transfert).</p>
      </div>`.trim();

    const internalText = [
      `Nouveau lead — Pont / Transfert (${conditionLabel})`,
      `N° de dossier: ${quoteRef}`,
      `Source: ${CAPTURE_SOURCE} (landing ${v.path})`,
      `Nom: ${displayName}`,
      cleanEmail ? `Email: ${cleanEmail}` : '',
      cleanPhone ? `Téléphone: ${cleanPhone}` : '',
      form.plate ? `Immat/châssis/réf: ${form.plate}` : '',
      partTypeLabel ? `Pièce demandée: ${partTypeLabel}` : '',
      form.message ? `\nMessage:\n${form.message}` : '',
    ].filter(Boolean).join('\n');

    try {
      await emailService.sendEmail({
        toEmail: getInternalToEmail(),
        subject: internalSubject,
        html: internalHtml,
        text: internalText,
        replyTo: cleanEmail || undefined,
      });
    } catch (err) {
      console.error('[pont-transfert] internal email failed:', err && err.message);
    }

    // 2) ACK utilisateur (best-effort) — template HTML brandé Autoliva
    if (cleanEmail) {
      try {
        const ackHtml = buildAckEmailHtml({
          firstName,
          quoteRef,
          plate: form.plate,
          partTypeLabel,
          brandObj: brand,
        });
        const ackText = [
          `Votre demande de devis Autoliva est bien reçue.`,
          ``,
          `N° de dossier : ${quoteRef}`,
          form.plate ? `Véhicule : ${form.plate}` : '',
          partTypeLabel ? `Pièce demandée : ${partTypeLabel}` : '',
          ``,
          `Un technicien vous recontacte sous 24h ouvrées par email ou téléphone.`,
          ``,
          `Selon le stock :`,
          `• En stock atelier → expédition 48-72h après accord`,
          `• Sourcing réseau → réception atelier, contrôle obligatoire, expédition. Délai confirmé dans votre devis.`,
          ``,
          `Aucune pièce n'est expédiée sans contrôle complet.`,
          ``,
          `Besoin urgent ? ${brand.PHONE_MOTEUR}`,
          ``,
          `L'équipe Autoliva`,
        ].filter(Boolean).join('\n');
        await emailService.sendEmail({
          toEmail: cleanEmail,
          subject: `Demande de devis ${quoteRef} bien reçue — Autoliva`,
          html: ackHtml,
          text: ackText,
        });
      } catch (err) {
        console.error('[pont-transfert] ack email failed:', err && err.message);
      }
    }

    // 2b) SMS de confirmation immédiat (best-effort) — même template générique
    // « moteur_ack » que les autres landings (texte neutre : « demande de devis »).
    let ackSmsResult = null;
    if (cleanPhone) {
      try {
        const { enabled: smsOn, text: smsText } = await resolveSms('moteur_ack', { quoteRef, phoneMoteur: brand.PHONE_MOTEUR });
        if (smsOn && smsText) {
          const r = await sendSms({ to: cleanPhone, text: smsText });
          ackSmsResult = { status: r && r.ok ? 'sent' : 'failed', reason: (r && r.reason) || '', message: (r && r.message) || '', at: new Date(), phone: cleanPhone };
          if (r && r.ok === false) console.warn('[pont-ack] SMS non envoyé à', cleanPhone, '→', r.reason, r.message || '');
        } else {
          ackSmsResult = { status: 'disabled', reason: 'disabled', message: 'Template SMS « accusé de réception » désactivé.', at: new Date(), phone: cleanPhone };
        }
      } catch (err) {
        ackSmsResult = { status: 'failed', reason: 'exception', message: (err && err.message) || 'Erreur', at: new Date(), phone: cleanPhone };
        console.error('[pont-transfert] ack SMS failed:', err && err.message);
      }
    }

    // 3) Timeline visiteur + lead capture (AbandonedCart) — non bloquants
    if (cleanEmail) rememberEmail(req, cleanEmail);
    trackEvent(req, 'quote_request', {
      meta: { mode: 'devis', source: CAPTURE_SOURCE, hasPlate: !!form.plate, hasMessage: !!form.message },
      target: cleanEmail || cleanPhone,
    });

    captureContactLead({
      req,
      mode: 'devis',
      email: cleanEmail,
      firstName,
      lastName,
      phone: cleanPhone,
      message: form.message,
      productHints: {
        Immat: form.plate,
        // requested.ref = numéro de devis unique (visible en back office)
        Reference: quoteRef,
        // requested.vehicle = libellé pièce (type + état)
        Vehicule: conditionLabel,
      },
    }).then((result) => {
      // Override captureSource → 'landing_ponts' pour la segmentation admin.
      // captureContactLead met 'devis' par défaut ; on bump si on a un leadId.
      if (result && result.leadId && mongoose.connection.readyState === 1) {
        const AbandonedCart = require('../models/AbandonedCart');
        // engineQuote a `default: null` → on l'initialise AVANT d'y écrire ackSms
        return AbandonedCart.updateOne(
          { _id: result.leadId, engineQuote: null },
          { $set: { engineQuote: {} } },
        ).catch(() => {}).then(() => {
          const _set = { captureSource: CAPTURE_SOURCE };
          if (ackSmsResult) _set['engineQuote.ackSms'] = ackSmsResult;
          return AbandonedCart.updateOne({ _id: result.leadId }, { $set: _set });
        }).catch(() => {});
      }
    }).catch(() => {});

    if (req.session && typeof req.session === 'object') {
      req.session.moteurFormTs = Date.now();
    }

    return renderPage(res, req, {
      form: buildInitialForm({ query: {} }, variant),
      successMessage: `Merci ${firstName || ''} ! Votre demande est bien reçue. Un technicien ${brand.NAME} vous recontacte sous 24h.`,
      // Conversion Google Ads (lead) — déclenchée sur la page de succès. ref = dédoublonnage,
      // email/phone (E.164) = suivi avancé des conversions (matching sans cookie).
      conversion: { ref: quoteRef, email: cleanEmail || '', phone: cleanPhone || '', value: 1 },
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getLanding,
  postDevis,
  buildAckEmailHtml,
  _internal: { LANDING_DATA, CAPTURE_SOURCE, LANDING_PATH, TRANSFERT_PATH, PART_TYPES },
};
