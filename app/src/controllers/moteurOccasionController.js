'use strict';

/**
 * Landing « Moteur d'occasion » : page publique de capture leads.
 *
 *   GET  /moteurs           → page de vente (form hero + final CTA)
 *   POST /moteurs/devis     → traitement du formulaire (sync, sans JS)
 *
 * Le lead est upserté dans AbandonedCart (= Lead) via le service
 * `leadCapture.captureContactLead` avec captureSource = 'landing_moteurs'.
 * L'attribution UTM/gclid est lue depuis `req.session.attribution`
 * (alimenté par le middleware `captureAttribution`).
 *
 * Le commercial voit les leads dans /admin/activite-panier (filtré sur
 * captureSource=landing_moteurs).
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

const LANDING_PATH = '/moteurs';
const RECOND_PATH = '/moteurs-reconditionnes';
const CAPTURE_SOURCE = 'landing_moteurs';

// Envoi automatique des devis fermes à la capture (OFF par défaut → inerte tant
// que la variable d'env n'est pas explicitement 'true').
const AUTO_DEVIS_ENABLED = String(process.env.AUTO_DEVIS_ENABLED || '').toLowerCase() === 'true';
// Sécurité 2 niveaux : ENABLED seul = DRY-RUN (génère les devis, logge, n'envoie
// RIEN). L'envoi réel (email/SMS/Mollie) exige EN PLUS AUTO_DEVIS_LIVE='true'.
const AUTO_DEVIS_LIVE = String(process.env.AUTO_DEVIS_LIVE || '').toLowerCase() === 'true';

/* Deux landing pages partagent la MÊME vue + le MÊME tunnel de devis, avec une
 * "copy" (message) adaptée à l'intention de recherche (message match Google Ads) :
 *  - /moteurs                → occasion (garantie 6 mois)
 *  - /moteurs-reconditionnes → reconditionné (garantie 1 an)
 * La variante est déduite de l'URL → tous les renderPage existants s'adaptent. */
function getVariant(req) {
  const p = String((req && (req.path || req.originalUrl)) || '');
  return p.indexOf('reconditionne') !== -1 ? 'reconditionne' : 'occasion';
}

const VARIANTS = {
  occasion: {
    path: LANDING_PATH,
    view: 'moteur-occasion/index',
    conditionLabel: "Moteur d'occasion",
    title: `Moteur d'occasion testé, certifié, garanti 6 mois — ${brand.NAME}`,
    metaDescription:
      "Moteurs d'occasion essence et diesel : banc d'essai obligatoire (compression, étanchéité, endoscopie), kilométrage certifié, garantie 6 mois sans franchise kilométrique, transférable. Devis en 24h.",
    jsonLdServiceType: "Vente de moteurs d'occasion testés et garantis",
    jsonLdDescription:
      "Moteurs d'occasion essence et diesel testés sur banc d'essai (compression, étanchéité, endoscopie), kilométrage certifié, garantie 6 mois sans franchise kilométrique transférable à la revente.",
    copy: {
      formAction: '/moteurs/devis',
      funnelName: 'moteur-occasion',
      // Affiche le champ « État » (recond / occasion / je ne sais pas) — la
      // landing /moteurs est généraliste. Sur /moteurs-reconditionnes l'état est
      // implicite (reconditionné) → champ masqué.
      showStateField: true,
      eyebrow: "Moteurs d'occasion premium",
      h1Html: 'Des moteurs testés,<br>garantis,<br><span class="text-brand-red">prêts à performer.</span>',
      sub: 'Tous nos moteurs sont testés sur banc, certifiés et prêts à être expédiés rapidement partout en Europe.',
      warrantyLabel: "Garantie 6 mois",
      qualitySubtitle: 'Un protocole en 7 étapes, pour une fiabilité maximale.',
      steps: [
        { n: '01', icon: 'doc', title: 'Identification', desc: 'Vérification de la référence et compatibilité' },
        { n: '02', icon: 'wrench', title: 'Démontage partiel', desc: 'Dépose réalisée avec soin par nos experts' },
        { n: '03', icon: 'clean', title: 'Nettoyage', desc: 'Nettoyage complet et dégraissage' },
        { n: '04', icon: 'gear', title: 'Tests & Contrôles', desc: 'Endoscopie, compression, étanchéité…', highlight: true },
        { n: '05', icon: 'cog', title: 'Remontage', desc: 'Remontage des éléments (cas échéant)' },
        { n: '06', icon: 'shield', title: 'Édition du rapport', desc: 'Rapport de test + attestation de conformité' },
        { n: '07', icon: 'truck', title: 'Expédition', desc: 'Emballage sécurisé et expédition rapide' },
      ],
    },
  },
  reconditionne: {
    path: RECOND_PATH,
    view: 'moteur-occasion/index',
    conditionLabel: 'Moteur reconditionné',
    title: `Moteur reconditionné, comme neuf, garantie 1 an — ${brand.NAME}`,
    metaDescription:
      "Moteurs reconditionnés essence et diesel : pièces d'usure remplacées, contrôles compression & endoscopie, garantie 1 an. Devis personnalisé sous 24h, livraison partout en Europe.",
    jsonLdServiceType: 'Vente de moteurs reconditionnés garantis 1 an',
    jsonLdDescription:
      "Moteurs reconditionnés essence et diesel : remise à neuf (pièces d'usure remplacées), contrôles compression et endoscopie, garantie 1 an. Devis personnalisé sous 24h.",
    copy: {
      formAction: '/moteurs-reconditionnes/devis',
      funnelName: 'moteur-reconditionne',
      showStateField: false,
      eyebrow: 'Moteurs reconditionnés premium',
      h1Html: 'Des moteurs reconditionnés,<br>comme neufs,<br><span class="text-brand-red">garantis 1 an.</span>',
      sub: "Pièces d'usure remplacées, contrôlés et testés, prêts à rouler — expédiés rapidement partout en Europe.",
      warrantyLabel: 'Garantie 1 an',
      qualitySubtitle: 'Une remise à neuf en 7 étapes, pour une fiabilité maximale.',
      steps: [
        { n: '01', icon: 'doc', title: 'Identification', desc: 'Vérification de la référence et compatibilité' },
        { n: '02', icon: 'wrench', title: 'Démontage complet', desc: 'Dépose intégrale du moteur par nos experts' },
        { n: '03', icon: 'clean', title: 'Nettoyage & contrôle', desc: 'Dégraissage et métrologie des pièces' },
        { n: '04', icon: 'gear', title: 'Remise à neuf', desc: "Rectification + remplacement des pièces d'usure", highlight: true },
        { n: '05', icon: 'cog', title: 'Remontage', desc: 'Remontage aux couples constructeur' },
        { n: '06', icon: 'shield', title: 'Tests & rapport', desc: 'Compression, endoscopie + attestation de conformité' },
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
function buildAckEmailHtml({ firstName, quoteRef, plate, engineTypeLabel, baseUrl, brandObj }) {
  const safeFirstName = firstName ? String(firstName).replace(/[<>&"]/g, '') : '';
  const safePlate = plate ? String(plate).replace(/[<>&"]/g, '') : '';
  const safeEngineType = engineTypeLabel || '—';
  const dateOnly = new Date().toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
  const timeOnly = new Date().toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
  // L'URL du logo et du site doivent être absolues (publiques) pour s'afficher dans les emails.
  // En dev local, baseUrl pointe sur localhost → on force autoliva.com pour les assets email.
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
              <p style="margin:0 0 4px;font-size:11px;color:#94a3b8;font-weight:500;">Type demandé</p>
              <p style="margin:0;font-size:14px;color:#0f172a;">${safeEngineType}</p>
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
              <p style="margin:0;font-size:14px;color:#1f2937;line-height:1.6;"><strong style="color:#0f172a;">Analyse de votre demande.</strong> On vérifie la disponibilité du moteur et on prépare votre devis personnalisé.</p>
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
                    <p style="margin:0;font-size:13px;color:#1f2937;line-height:1.55;"><strong style="color:#047857;">En stock atelier —</strong> moteur déjà testé, expédition sous <strong>48 à 72h</strong> après accord.</p>
                  </td>
                </tr>
              </table>

              <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin-top:6px;">
                <tr>
                  <td style="padding:11px 14px;background:#fafbfc;border-left:3px solid #3b82f6;border-radius:4px;">
                    <p style="margin:0;font-size:13px;color:#1f2937;line-height:1.55;"><strong style="color:#1d4ed8;">Sourcing réseau —</strong> on trouve le moteur, on le réceptionne, banc d'essai obligatoire, puis expédition. <strong>Délai confirmé dans votre devis</strong>.</p>
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
              <p style="margin:0;font-size:14px;color:#1f2937;line-height:1.6;"><strong style="color:#0f172a;">Aucun moteur n'est expédié sans banc d'essai.</strong> Compression, étanchéité, endoscopie — même quand on doit sourcer le moteur pour vous.</p>
            </td>
          </tr>
        </table>
      </td></tr>

      <!-- TRUST STRIP : une ligne discrète au lieu d'un gros bloc -->
      <tr><td style="padding:24px 32px 8px;">
        <p style="margin:0;padding:14px 18px;background:#fafbfc;border:1px solid #eef0f3;border-radius:8px;font-size:13px;color:#475569;text-align:center;line-height:1.5;">
          Banc d'essai obligatoire · Kilométrage certifié · Garantie incluse sans franchise
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
          Autoliva — Spécialiste moteurs d'occasion testés et garantis.<br>
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
 * Centralisé ici pour pouvoir ajuster sans toucher l'EJS.
 *
 * Stats marketing : « Plus de 1 000 moteurs livrés depuis 2019 » a été
 * validé par carparts.france@gmail.com (mai 2026). Les autres valeurs
 * sont à confirmer (marqueurs TODO ci-dessous). */
const LANDING_DATA = {
  stockReady: 247,         // TODO confirmer
  networkRefs: 2000,       // TODO confirmer
  deliveredSince2019: 1000, // validé
  workshop: {
    city: 'Lille',
    department: '59',
    surfaceM2: 480,        // TODO confirmer
    benchCount: 3,         // TODO confirmer
    technicianCount: 7,    // TODO confirmer
    sinceYear: 2019,
  },
  garages: 247,            // TODO confirmer
  installers: [
    // TODO remplacer par les vrais partenaires
    { mono: 'PO', name: 'Centre Porsche', cat: 'Concessionnaire' },
    { mono: 'ME', name: 'Concession Mercedes', cat: 'Concessionnaire' },
    { mono: 'VW', name: 'Centre Volkswagen', cat: 'Concessionnaire' },
    { mono: 'RE', name: 'Concession Renault', cat: 'Concessionnaire' },
    { mono: 'MA', name: 'Mougins Auto Sport', cat: 'Spécialiste Porsche' },
    { mono: 'F44', name: 'Flat 44', cat: 'Indépendant Porsche' },
  ],
  recentDeliveries: [
    { brand: 'Volkswagen', model: 'Golf V · 1.9 TDI', power: '105 ch', code: 'BKD' },
    { brand: 'Peugeot', model: '308 · 2.0 HDi', power: '136 ch', code: 'DW10' },
    { brand: 'Audi', model: 'A6 · 3.0 V6 TDI', power: '218 ch', code: 'BMK' },
    { brand: 'Volkswagen', model: 'Polo · 1.6 TDI', power: '90 ch', code: 'CAYC' },
    { brand: 'Audi', model: 'A3 · 2.0 TSI', power: '200 ch', code: 'CAVB' },
    { brand: 'BMW', model: 'Série 3 · 2.0d', power: '177 ch', code: 'N47' },
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
  // Le champ accepte plaque (~9), code moteur (~10) OU VIN/n° de châssis (17 car.).
  // L'ancienne limite à 16 tronquait le 17ᵉ caractère des VIN → on élargit à 32.
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

function buildInitialForm(req) {
  const q = (req && req.query && typeof req.query === 'object') ? req.query : {};
  const engineTypeRaw = trim(q.engineType).toLowerCase();
  return {
    plate: trim(q.plate || q.immat),
    fullName: trim(q.fullName),
    email: trim(q.email),
    phone: trim(q.phone),
    message: '',
    engineType: engineTypeRaw === 'complet' || engineTypeRaw === 'nu' ? engineTypeRaw : '',
    website: '', // honeypot
  };
}

function renderPage(res, req, opts) {
  const variant = opts.variant || getVariant(req);
  const v = VARIANTS[variant] || VARIANTS.occasion;
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
    return renderPage(res, req, { form: buildInitialForm(req) });
  } catch (err) {
    return next(err);
  }
}

async function postDevis(req, res, next) {
  try {
    const variant = getVariant(req);
    const isReconVariant = variant === 'reconditionne';
    const body = (req.body && typeof req.body === 'object') ? req.body : {};

    // État choisi par le client (champ « État » sur /moteurs). Sur la landing
    // /moteurs-reconditionnes, l'état est implicite → forcé à reconditionné.
    const etatRaw = trim(body.etat).toLowerCase();
    let etat;
    if (isReconVariant) etat = 'reconditionne';
    else if (etatRaw === 'reconditionne' || etatRaw === 'occasion' || etatRaw === 'je_sais_pas') etat = etatRaw;
    else etat = '';
    // Libellé condition → requested.vehicle → deriveCondition côté back-office
    // (reconditionné / occasion / « à préciser » = à vérifier par le commercial).
    const conditionLabel = etat === 'reconditionne' ? 'Moteur reconditionné'
      : etat === 'occasion' ? "Moteur d'occasion"
      : etat === 'je_sais_pas' ? 'Moteur (état à préciser)'
      : (VARIANTS[variant] || VARIANTS.occasion).conditionLabel;

    // Complet / Nu : sans objet pour un moteur reconditionné (toujours complet) →
    // ignoré dans ce cas, même si le champ est transmis.
    const engineTypeRaw = trim(body.engineType).toLowerCase();
    const engineType = (etat !== 'reconditionne' && (engineTypeRaw === 'complet' || engineTypeRaw === 'nu')) ? engineTypeRaw : '';
    const engineTypeLabel = engineType === 'complet'
      ? 'Moteur complet (avec accessoires)'
      : engineType === 'nu' ? 'Moteur nu (sans accessoires)' : '';
    const composedMessage = engineTypeLabel ? `Type demandé : ${engineTypeLabel}` : '';

    const form = {
      plate: normalizePlate(body.plate || body.immat),
      fullName: trim(body.fullName).slice(0, 120),
      email: trim(body.email).slice(0, 160),
      phone: trim(body.phone).slice(0, 24),
      message: composedMessage,
      engineType,
      etat,
      website: trim(body.website), // honeypot
    };

    // Honeypot : faux succès silencieux
    if (form.website) {
      return renderPage(res, req, {
        form: buildInitialForm({ query: {} }),
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

    // Validation : plaque/châssis/code moteur + téléphone obligatoires
    const cleanEmail = normalizeEmail(form.email);
    // Stocke le numéro au format canonique E.164 (+33…) dès la capture : garantit
    // que TOUS les SMS ultérieurs (accusé + devis) partent (Brevo exige E.164).
    // Si le numéro n'est pas normalisable, on garde la saisie nettoyée (lead non perdu).
    const cleanPhone = normalizePhoneFR(form.phone) || normalizePhone(form.phone);

    if (!form.plate) {
      return renderPage(res, req, {
        form,
        statusCode: 400,
        errorMessage: 'Merci d’indiquer votre plaque, N° de châssis ou code moteur.',
      });
    }
    if (!cleanPhone) {
      return renderPage(res, req, {
        form,
        statusCode: 400,
        errorMessage: 'Merci d’indiquer un numéro de téléphone pour qu’on puisse vous rappeler.',
      });
    }
    if (!cleanEmail) {
      return renderPage(res, req, {
        form,
        statusCode: 400,
        errorMessage: form.email
          ? 'L’email ne semble pas valide.'
          : 'Merci d’indiquer votre email pour recevoir votre devis.',
      });
    }

    // Split nom complet → firstName / lastName
    // Important : si le client n'a saisi qu'un mot court (probablement un nom seul),
    // on évite l'effet "Bonjour belabbes" en utilisant seulement les prénoms plausibles.
    const nameParts = form.fullName.split(/\s+/).filter(Boolean);
    const firstNameRaw = nameParts.shift() || '';
    const lastName = nameParts.join(' ');
    // Si le client tape un seul mot, on ne sait pas si c'est prénom ou nom → on n'utilise PAS comme prénom dans le ACK
    const firstName = (firstNameRaw && lastName) ? firstNameRaw : '';
    const displayName = form.fullName || cleanEmail || cleanPhone;

    // Numéro de devis unique pour cette demande
    const quoteRef = generateQuoteRef();

    // 1) Email interne (notification commercial)
    const internalSubject = `[Moteur occasion] ${quoteRef} — ${displayName}${form.plate ? ` — ${form.plate}` : ''}`.slice(0, 180);
    const internalHtml = `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827;">
        <h2 style="margin:0 0 8px 0;">Nouveau lead — Moteur d'occasion</h2>
        <p style="margin:0 0 12px 0;"><strong>N° de dossier :</strong> <code style="background:#f3f4f6;padding:2px 6px;border-radius:4px;">${escapeHtml(quoteRef)}</code></p>
        <p style="margin:0 0 12px 0;"><strong>Source :</strong> ${CAPTURE_SOURCE} (landing /moteurs)</p>
        <p style="margin:0 0 12px 0;"><strong>Nom :</strong> ${escapeHtml(displayName)}</p>
        ${cleanEmail ? `<p style="margin:0 0 12px 0;"><strong>Email :</strong> <a href="mailto:${escapeHtml(cleanEmail)}">${escapeHtml(cleanEmail)}</a></p>` : ''}
        ${cleanPhone ? `<p style="margin:0 0 12px 0;"><strong>Téléphone :</strong> <a href="tel:${escapeHtml(cleanPhone)}">${escapeHtml(cleanPhone)}</a></p>` : ''}
        ${form.plate ? `<p style="margin:0 0 12px 0;"><strong>Immat/châssis/code :</strong> ${escapeHtml(form.plate)}</p>` : ''}
        ${engineTypeLabel ? `<p style="margin:0 0 12px 0;"><strong>Type demandé :</strong> ${escapeHtml(engineTypeLabel)}</p>` : ''}
        ${form.message ? `<hr/><p style="margin:0 0 8px 0;"><strong>Message :</strong></p><div style="font-size:14px;">${escapeHtml(form.message).replace(/\r?\n/g, '<br/>')}</div>` : ''}
        <p style="margin-top:16px;color:#6b7280;font-size:12px;">Détails complets dans /admin/activite-panier (filtre: Moteur occasion).</p>
      </div>`.trim();

    const internalText = [
      `Nouveau lead — Moteur d'occasion`,
      `N° de dossier: ${quoteRef}`,
      `Source: ${CAPTURE_SOURCE} (landing /moteurs)`,
      `Nom: ${displayName}`,
      cleanEmail ? `Email: ${cleanEmail}` : '',
      cleanPhone ? `Téléphone: ${cleanPhone}` : '',
      form.plate ? `Immat/châssis/code: ${form.plate}` : '',
      engineTypeLabel ? `Type demandé: ${engineTypeLabel}` : '',
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
      console.error('[moteur-occasion] internal email failed:', err && err.message);
    }

    // 2) ACK utilisateur (best-effort) — template HTML brandé Autoliva
    if (cleanEmail) {
      try {
        const baseUrl = getPublicBaseUrlFromReq(req);
        const ackHtml = buildAckEmailHtml({
          firstName,
          quoteRef,
          plate: form.plate,
          engineTypeLabel,
          baseUrl,
          brandObj: brand,
        });
        const ackText = [
          `Votre demande de devis Autoliva est bien reçue.`,
          ``,
          `N° de dossier : ${quoteRef}`,
          form.plate ? `Véhicule : ${form.plate}` : '',
          engineTypeLabel ? `Type demandé : ${engineTypeLabel}` : '',
          ``,
          `Un technicien vous recontacte sous 24h ouvrées par email ou téléphone.`,
          ``,
          `Selon le stock :`,
          `• En stock atelier → expédition 48-72h après accord`,
          `• Sourcing réseau → réception atelier, banc d'essai obligatoire, expédition. Délai confirmé dans votre devis.`,
          ``,
          `Aucun moteur n'est expédié sans passer par notre banc d'essai.`,
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
        console.error('[moteur-occasion] ack email failed:', err && err.message);
      }
    }

    // 2b) SMS de confirmation immédiat (best-effort) — le client vient de donner
    // son numéro, un SMS instantané rassure fortement et réduit l'anxiété d'attente.
    let ackSmsResult = null;
    if (cleanPhone) {
      try {
        const { enabled: smsOn, text: smsText } = await resolveSms('moteur_ack', { quoteRef, phoneMoteur: brand.PHONE_MOTEUR });
        if (smsOn && smsText) {
          const r = await sendSms({ to: cleanPhone, text: smsText });
          ackSmsResult = { status: r && r.ok ? 'sent' : 'failed', reason: (r && r.reason) || '', message: (r && r.message) || '', at: new Date(), phone: cleanPhone };
          if (r && r.ok === false) console.warn('[moteur-ack] SMS non envoyé à', cleanPhone, '→', r.reason, r.message || '');
        } else {
          ackSmsResult = { status: 'disabled', reason: 'disabled', message: 'Template SMS « accusé de réception » désactivé.', at: new Date(), phone: cleanPhone };
        }
      } catch (err) {
        ackSmsResult = { status: 'failed', reason: 'exception', message: (err && err.message) || 'Erreur', at: new Date(), phone: cleanPhone };
        console.error('[moteur-occasion] ack SMS failed:', err && err.message);
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
        // requested.vehicle = libellé moteur (occasion + type complet/nu)
        Vehicule: `${conditionLabel}${engineTypeLabel ? ' · ' + engineTypeLabel : ''}`,
      },
    }).then((result) => {
      // Override captureSource → 'landing_moteurs' pour la segmentation admin.
      // captureContactLead met 'devis' par défaut ; on bump si on a un leadId.
      if (result && result.leadId && mongoose.connection.readyState === 1) {
        const AbandonedCart = require('../models/AbandonedCart');
        // engineQuote a `default: null` → on l'initialise AVANT d'y écrire ackSms
        // (sinon « Cannot create field 'ackSms' in element {engineQuote:null} »,
        // ce qui ferait aussi échouer le captureSource — flux cassé).
        return AbandonedCart.updateOne(
          { _id: result.leadId, engineQuote: null },
          { $set: { engineQuote: {} } },
        ).catch(() => {}).then(() => {
          const _set = { captureSource: CAPTURE_SOURCE };
          if (ackSmsResult) _set['engineQuote.ackSms'] = ackSmsResult;
          // Enrichissement « devis instantané » : moteur détecté + offres (champs
          // cachés remplis par le JS de la landing). Pré-remplit l'identification
          // moteur pour le commercial + trace une note. Données client-fournies →
          // on borne la taille.
          // On ne garde la détection que si la plaque détectée == plaque envoyée
          // (sinon détection périmée : le client a changé de plaque après coup).
          const _normPlate = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
          const _detPlate = String(body.detectedPlate || '');
          const _plateOk = _detPlate && _normPlate(_detPlate) === _normPlate(form.plate);
          const detCode = _plateOk ? String(body.detectedEngineCode || '').trim().slice(0, 40) : '';
          const detVeh = _plateOk ? String(body.detectedVehicle || '').trim().slice(0, 140) : '';
          const detOff = _plateOk ? String(body.detectedOffers || '').trim().slice(0, 300) : '';
          if (detCode) _set['engineQuote.identifiedEngine.code'] = detCode;
          if (detVeh) _set['engineQuote.identifiedEngine.model'] = detVeh;
          const _update = { $set: _set };
          if (detCode || detVeh) {
            const noteText = `Détection plaque automatique — ${detVeh}${detCode ? ' [' + detCode + ']' : ''}${detOff ? ' · ' + detOff : ''}`.trim();
            _update.$push = { notes: { text: noteText, addedByName: 'Détection plaque', addedAt: new Date() } };
          }
          return AbandonedCart.updateOne({ _id: result.leadId }, _update).then(async () => {
            // Envoi AUTOMATIQUE des devis fermes (derrière flag) — le serveur
            // re-matche le code détecté (source de vérité), 2 devis séparés.
            if (!AUTO_DEVIS_ENABLED || !_plateOk || !detCode) return;
            try {
              const { matchOffers } = require('../services/instantEngineQuote');
              const engineQuoteAdmin = require('./engineQuoteAdminController');
              const offers = matchOffers(detCode);
              const freshCart = await AbandonedCart.findById(result.leadId);
              if (!freshCart || !freshCart.email) return; // un devis par email exige une adresse
              const _dry = !AUTO_DEVIS_LIVE;
              const _offers = [];
              if (offers.occasion) _offers.push({ kind: 'occasion', sellPrice: offers.occasion.prix, mileage: offers.occasion.km, stockLabel: 'Sourcé à la commande', delay: '7 à 10 jours', createMollie: true });
              if (offers.reman) _offers.push({ kind: 'reman', sellPrice: offers.reman.pvp, consigne: offers.reman.consigne, stockLabel: 'En stock', delay: offers.reman.dispo || 'Livraison sous 3-5 jours ouvrés', equip: offers.reman.equip || '' });
              if (_offers.length) {
                // 1 SEUL email + 1 SEUL SMS, avec 1 ou 2 devis (PDF) selon les offres dispo.
                const r = await engineQuoteAdmin.sendInstantDevis(freshCart, { offers: _offers, dryRun: _dry });
                console.log(`[auto-devis] ${_dry ? 'DRY-RUN (non envoyé)' : 'ENVOYÉ'} → ${freshCart.email} · ${_offers.length} devis / 1 email · ${(r.devis || []).map((d) => d.kind + ' ' + d.sellTtc + '€').join(' + ')} · ok=${r.ok}`);
              }
            } catch (e) { console.error('[auto-devis] échec:', e && e.message); }
          });
        }).catch(() => {});
      }
    }).catch(() => {});

    if (req.session && typeof req.session === 'object') {
      req.session.moteurFormTs = Date.now();
    }

    return renderPage(res, req, {
      form: buildInitialForm({ query: {} }),
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
  _internal: { LANDING_DATA, CAPTURE_SOURCE, LANDING_PATH },
};
