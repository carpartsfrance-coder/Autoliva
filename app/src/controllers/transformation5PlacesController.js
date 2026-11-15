'use strict';

/**
 * Landing « Transformation 2 → 5 places » (test commercial, nov. 2026).
 *
 *   GET  /transformation-5-places        → page de présentation + formulaire
 *   POST /transformation-5-places/devis  → traitement du formulaire (sync, sans JS)
 *
 * Service : repasser en 5 places une voiture de société immatriculée en
 * 2 places (carte grise « dérivé VP », VASP ou CTTE). Prix de lancement :
 * 1 500 € TTC (1 250 € HT) + grille dégressive pour les professionnels.
 *
 * Choix voulus par Killian :
 *  - AUCUN numéro de téléphone affiché sur cette page (pas d'appels) :
 *    contact par WhatsApp uniquement (`hidePhone` masque le téléphone dans
 *    l'en-tête et le pied de page du site sur cette page).
 *  - Pas de SMS automatique (le template SMS commun invite à appeler).
 *
 * Le lead est enregistré dans AbandonedCart (= Lead) via
 * `leadCapture.captureContactLead`, avec captureSource = 'landing_5places'.
 * Il apparaît dans /admin/activite-panier (filtre « Landing 2 → 5 places »).
 * Ce n'est PAS une pièce : il reste hors du pipeline /admin/devis-moteurs.
 *
 * Suivi : événement dataLayer dédié `lead_transformation_5places` (distinct
 * de `lead_submitted` pour ne pas compter ces demandes dans les conversions
 * des pièces Autoliva). La conversion Google Ads n'est envoyée que si la
 * variable d'environnement ADS_CONV_5PLACES (ex. « AW-123/abc ») est définie.
 */

const formTimestamp = require('../services/formTimestamp');
const mongoose = require('mongoose');
const crypto = require('crypto');

const emailService = require('../services/emailService');
const { normalizePhoneFR } = require('../services/smsService');
const { captureContactLead } = require('../services/leadCapture');
const { track: trackEvent, rememberEmail } = require('../services/eventTracker');
const { getPublicBaseUrlFromReq } = require('../services/productPublic');
const brand = require('../config/brand');

const LANDING_PATH = '/transformation-5-places';
const FORM_ACTION = '/transformation-5-places/devis';
const CAPTURE_SOURCE = 'landing_5places';

const WHATSAPP_TEXT = 'Bonjour, je souhaite un devis pour repasser ma voiture de société en 5 places.';
const WHATSAPP_URL = `/go/whatsapp?text=${encodeURIComponent(WHATSAPP_TEXT)}`;

/* Tarifs de lancement (validés par Killian le 15/11/2026). TVA 20 %. */
const PRICING = {
  unitTtc: 1500,
  unitHt: 1250,
  tiers: [
    { key: 'ponctuel', label: 'Besoin ponctuel', range: '1 à 2 véhicules', ht: 1250, ttc: 1500, saving: '' },
    { key: 'lot', label: 'Tarif par lot', range: '3 à 5 véhicules', ht: 1190, ttc: 1428, saving: '60 € HT de moins par véhicule', featured: true },
    { key: 'volume', label: 'Volume renforcé', range: '6 véhicules et plus', ht: 1090, ttc: 1308, saving: '160 € HT de moins par véhicule' },
  ],
};

const PROFILES = { particulier: 'Particulier', pro: 'Professionnel' };

const FLEET_SIZES = { '1-2': '1 à 2 véhicules', '3-5': '3 à 5 véhicules', '6+': '6 véhicules et plus' };

const REG_TYPES = {
  deriv_vp: 'Dérivé VP (« DERIV VP »)',
  vasp: 'VASP',
  ctte: 'CTTE (camionnette)',
  inconnu: 'Je ne sais pas',
};

const MAKES = ['Renault', 'Peugeot', 'Citroën', 'Dacia', 'Volkswagen', 'Ford', 'Toyota', 'Opel', 'Fiat', 'Skoda', 'Seat', 'Hyundai', 'Kia', 'Nissan', 'Autre'];

const TIMINGS = { asap: 'Dès que possible', '3m': 'Dans les 3 mois', later: 'Plus tard / je me renseigne' };

const FAQ = [
  {
    q: 'Quelles voitures peuvent repasser en 5 places ?',
    a: 'Les voitures de société vendues en 2 places à partir d’un modèle 5 places : carte grise « DERIV VP », VASP ou CTTE (Clio, 208, C3, Polo, Sandero, SUV…). L’éligibilité dépend de la version exacte : on la vérifie avant tout devis, à partir de votre carte grise.',
  },
  {
    q: 'Que comprend le forfait de 1 500 € TTC ?',
    a: 'La banquette arrière, les ceintures et les fixations nécessaires (pièces d’origine d’occasion), le montage, et la préparation du dossier de conformité pour la carte grise. Les taxes et redevances de carte grise ne sont pas comprises. Le détail exact est écrit sur votre devis.',
  },
  {
    q: 'Les pièces sont-elles neuves ?',
    a: 'Non : ce sont des pièces d’origine d’occasion, choisies pour votre modèle. C’est ce qui permet ce prix. Leur provenance est indiquée dans le dossier.',
  },
  {
    q: 'Vous vous occupez de la carte grise ?',
    a: 'Oui, on vous accompagne jusqu’à la mise à jour du nombre de places sur la carte grise. La carte grise est délivrée par l’administration ; ses taxes restent à part.',
  },
  {
    q: 'Qui atteste la transformation ?',
    a: 'Nous-mêmes : Autoliva est opérateur qualifié UTAC pour la transformation DERIV VP. Nous réalisons la transformation et établissons les documents de conformité pour la carte grise. La référence de notre qualification figure sur votre devis.',
  },
  {
    q: 'Comment fonctionnent les tarifs professionnels ?',
    a: 'Garages, négociants et gestionnaires de parc : le prix par véhicule baisse quand plusieurs véhicules sont commandés ensemble (3 à 5, puis 6 et plus). Chaque lot fait l’objet d’un devis détaillé.',
  },
  {
    q: 'Combien de temps faut-il prévoir ?',
    a: 'Le délai dépend du modèle et de la disponibilité des pièces. Il est indiqué sur votre devis.',
  },
];

function generateQuoteRef() {
  const now = new Date();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const suffix = crypto.randomBytes(3).toString('hex').toUpperCase();
  return `T5P-${now.getFullYear()}-${month}-${suffix}`;
}

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
  return trim(value).toUpperCase().replace(/[\s-]+/g, '').slice(0, 17);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function getClientIp(req) {
  const xfwd = req && req.headers ? req.headers['x-forwarded-for'] : null;
  const fromHeader = Array.isArray(xfwd) ? xfwd[0] : typeof xfwd === 'string' ? xfwd.split(',')[0] : '';
  return trim(fromHeader) || (req && req.ip ? String(req.ip) : 'unknown');
}

// Anti-spam léger : 8 demandes max / 10 min par IP (en mémoire).
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

function pick(map, value) {
  const v = trim(value);
  return Object.prototype.hasOwnProperty.call(map, v) ? v : '';
}

function emptyForm() {
  return {
    profile: 'particulier', fleetSize: '', make: '', model: '', year: '', regType: '',
    plate: '', postcode: '', timing: '', fullName: '', phone: '', email: '', message: '', website: '',
  };
}

function buildInitialForm(req) {
  const q = (req && req.query && typeof req.query === 'object') ? req.query : {};
  const form = emptyForm();
  if (pick(PROFILES, q.profil || q.profile)) form.profile = pick(PROFILES, q.profil || q.profile);
  return form;
}

function readForm(body) {
  const year = trim(body.year).replace(/[^0-9]/g, '').slice(0, 4);
  return {
    profile: pick(PROFILES, body.profile) || 'particulier',
    fleetSize: pick(FLEET_SIZES, body.fleetSize),
    make: MAKES.includes(trim(body.make)) ? trim(body.make) : '',
    model: trim(body.model).slice(0, 60),
    year,
    regType: pick(REG_TYPES, body.regType),
    plate: normalizePlate(body.plate),
    postcode: trim(body.postcode).replace(/[^0-9]/g, '').slice(0, 5),
    timing: pick(TIMINGS, body.timing),
    fullName: trim(body.fullName).slice(0, 120),
    phone: trim(body.phone).slice(0, 24),
    email: trim(body.email).slice(0, 160),
    message: trim(body.message).slice(0, 1500),
    website: trim(body.website), // honeypot
  };
}

function vehicleLabel(form) {
  return [form.make, form.model, form.year].filter(Boolean).join(' ');
}

function buildServiceJsonLd(baseUrl) {
  const safeBase = trim(baseUrl).replace(/\/$/, '');
  const url = safeBase ? `${safeBase}${LANDING_PATH}` : LANDING_PATH;
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'Service',
    serviceType: 'Transformation de véhicule 2 places en 5 places (dérivé VP, VASP, CTTE)',
    provider: { '@type': 'Organization', name: brand.NAME, url: brand.SITE_URL, email: brand.EMAIL_CONTACT },
    areaServed: [
      { '@type': 'AdministrativeArea', name: 'Bouches-du-Rhône' },
      { '@type': 'City', name: 'Rognac' },
      { '@type': 'City', name: 'Marseille' },
      { '@type': 'City', name: 'Aix-en-Provence' },
    ],
    url,
    description: 'Transformation de voitures de société 2 places en 5 places : banquette, ceintures, montage et accompagnement jusqu’à la carte grise. Forfait 1 500 € TTC, tarifs dégressifs pour les professionnels.',
    offers: { '@type': 'Offer', url, price: String(PRICING.unitTtc), priceCurrency: 'EUR' },
  });
}

function buildFaqJsonLd() {
  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: FAQ.map((f) => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })),
  });
}

function renderPage(res, req, opts) {
  const baseUrl = getPublicBaseUrlFromReq(req);
  const title = `Transformation 2 places en 5 places (dérivé VP, VASP) – Rognac, Marseille, Aix | ${brand.NAME}`;
  const metaDescription = 'Voiture de société en 2 places ? On la repasse en 5 places : banquette, ceintures, montage et carte grise. Dérivé VP, VASP, CTTE. Forfait 1 500 € TTC. Devis gratuit, Bouches-du-Rhône.';
  const canonicalUrl = baseUrl ? `${baseUrl}${LANDING_PATH}` : LANDING_PATH;
  return res.status(opts.statusCode || 200).render('transformation-5-places/index', {
    title,
    metaDescription,
    canonicalUrl,
    ogTitle: title,
    ogDescription: metaDescription,
    ogUrl: canonicalUrl,
    ogType: 'website',
    jsonLd: buildServiceJsonLd(baseUrl),
    faqJsonLd: buildFaqJsonLd(),
    hidePhone: true,
    hideMobileNav: true,
    hideContactWidget: true,
    landingHeader: true,
    pricing: PRICING,
    profiles: PROFILES,
    fleetSizes: FLEET_SIZES,
    regTypes: REG_TYPES,
    makes: MAKES,
    timings: TIMINGS,
    faq: FAQ,
    whatsappUrl: WHATSAPP_URL,
    formAction: FORM_ACTION,
    form: opts.form,
    errorMessage: opts.errorMessage || null,
    successMessage: opts.successMessage || null,
    conversion: opts.conversion || null,
    adsConversionSendTo: trim(process.env.ADS_CONV_5PLACES) || '',
  });
}

function buildAckEmailHtml({ firstName, quoteRef, vehicle }) {
  const greeting = firstName ? `Bonjour ${escapeHtml(firstName)},` : 'Bonjour,';
  const site = 'https://autoliva.com';
  const wa = `${site}${WHATSAPP_URL}`;
  return `<!DOCTYPE html><html lang="fr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Votre demande — Autoliva</title></head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1f2937;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f7;padding:32px 12px;"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:14px;border:1px solid #e5e7eb;">
<tr><td style="padding:24px 32px;border-bottom:1px solid #f1f2f4;"><img src="${site}/images/logo-autoliva.png" alt="Autoliva" width="150" style="display:block;border:0;width:150px;height:auto;"></td></tr>
<tr><td style="padding:32px;">
<h1 style="margin:0 0 12px;font-size:22px;color:#0f172a;">${greeting}</h1>
<p style="margin:0 0 16px;font-size:15px;line-height:1.6;">Merci, votre demande pour repasser votre véhicule en 5 places est bien reçue. Nous étudions votre véhicule et revenons vers vous <strong>sous 24 heures ouvrées</strong>, par e-mail ou WhatsApp.</p>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#fafbfc;border:1px solid #eef0f3;border-radius:10px;"><tr>
<td style="padding:14px 18px;font-size:13px;"><span style="color:#94a3b8;">Dossier</span><br><strong style="font-family:monospace;">${escapeHtml(quoteRef)}</strong></td>
<td style="padding:14px 18px;font-size:13px;"><span style="color:#94a3b8;">Véhicule</span><br><strong>${escapeHtml(vehicle || '—')}</strong></td>
</tr></table>
<p style="margin:20px 0 8px;font-size:15px;line-height:1.6;"><strong>Pour aller plus vite :</strong> envoyez-nous une photo de votre carte grise (recto) sur WhatsApp. C’est elle qui permet de vérifier l’éligibilité.</p>
<p style="margin:16px 0 0;"><a href="${wa}" style="display:inline-block;background:#25D366;color:#ffffff;font-weight:700;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:14px;">Envoyer ma carte grise sur WhatsApp</a></p>
</td></tr>
<tr><td style="padding:20px 32px 28px;border-top:1px solid #f1f2f4;font-size:11px;color:#94a3b8;line-height:1.5;">Autoliva · <a href="mailto:${brand.EMAIL_CONTACT}" style="color:#94a3b8;">${brand.EMAIL_CONTACT}</a> · <a href="${site}" style="color:#94a3b8;">autoliva.com</a><br>Vos données servent uniquement à traiter votre demande (RGPD). Référence : ${escapeHtml(quoteRef)}</td></tr>
</table></td></tr></table></body></html>`;
}

async function getLanding(req, res, next) {
  try {
    formTimestamp.poser(res);
    return renderPage(res, req, { form: buildInitialForm(req) });
  } catch (err) {
    return next(err);
  }
}

async function postDevis(req, res, next) {
  try {
    const body = (req.body && typeof req.body === 'object') ? req.body : {};
    const form = readForm(body);

    if (form.website) {
      return renderPage(res, req, {
        form: emptyForm(),
        successMessage: 'Merci ! Votre demande a bien été envoyée. Nous revenons vers vous sous 24h ouvrées.',
      });
    }

    if (isRateLimited(req)) {
      return renderPage(res, req, { form, statusCode: 429, errorMessage: 'Trop de tentatives. Merci de réessayer dans quelques minutes.' });
    }

    const sessionTs = formTimestamp.lire(req);
    if (sessionTs && Date.now() - sessionTs < 800) {
      return renderPage(res, req, { form, statusCode: 400, errorMessage: 'Merci de patienter une seconde puis de renvoyer le formulaire.' });
    }

    const cleanEmail = normalizeEmail(form.email);
    const cleanPhone = normalizePhoneFR(form.phone) || normalizePhone(form.phone);

    if (!form.make || !form.model) {
      return renderPage(res, req, { form, statusCode: 400, errorMessage: 'Merci d’indiquer la marque et le modèle du véhicule.' });
    }
    if (!cleanPhone || cleanPhone.replace(/[^0-9]/g, '').length < 9) {
      return renderPage(res, req, { form, statusCode: 400, errorMessage: 'Merci d’indiquer un numéro de mobile pour qu’on puisse vous répondre (WhatsApp ou SMS).' });
    }
    if (form.email && !cleanEmail) {
      return renderPage(res, req, { form, statusCode: 400, errorMessage: 'L’e-mail ne semble pas valide.' });
    }

    const nameParts = form.fullName.split(/\s+/).filter(Boolean);
    const firstNameRaw = nameParts.shift() || '';
    const lastName = nameParts.join(' ');
    const firstName = (firstNameRaw && lastName) ? firstNameRaw : '';
    const displayName = form.fullName || cleanEmail || cleanPhone;

    const quoteRef = generateQuoteRef();
    const vehicle = vehicleLabel(form);
    const profileLabel = PROFILES[form.profile] || 'Particulier';
    const fleetLabel = form.profile === 'pro' && form.fleetSize ? FLEET_SIZES[form.fleetSize] : '';
    const regLabel = form.regType ? REG_TYPES[form.regType] : '';
    const timingLabel = form.timing ? TIMINGS[form.timing] : '';

    const details = [
      ['Profil', profileLabel + (fleetLabel ? ` — ${fleetLabel}` : '')],
      ['Véhicule', vehicle],
      ['Carte grise', regLabel],
      ['Immatriculation', form.plate],
      ['Code postal', form.postcode],
      ['Délai souhaité', timingLabel],
    ].filter(([, v]) => v);

    const composedMessage = [
      'Transformation 2 → 5 places',
      ...details.map(([k, v]) => `${k} : ${v}`),
      form.message ? `Message : ${form.message}` : '',
    ].filter(Boolean).join('\n');

    // 1) E-mail interne
    const internalSubject = `[2→5 places] ${quoteRef} — ${displayName}${vehicle ? ` — ${vehicle}` : ''}`.slice(0, 180);
    const internalHtml = `
      <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827;">
        <h2 style="margin:0 0 8px 0;">Nouvelle demande — Transformation 2 → 5 places</h2>
        <p><strong>N° de dossier :</strong> <code>${escapeHtml(quoteRef)}</code> · Source : ${CAPTURE_SOURCE} (${LANDING_PATH})</p>
        <p><strong>Nom :</strong> ${escapeHtml(displayName)}<br>
        <strong>Mobile :</strong> ${escapeHtml(cleanPhone)}${cleanEmail ? `<br><strong>E-mail :</strong> <a href="mailto:${escapeHtml(cleanEmail)}">${escapeHtml(cleanEmail)}</a>` : ''}</p>
        <ul>${details.map(([k, v]) => `<li><strong>${escapeHtml(k)} :</strong> ${escapeHtml(v)}</li>`).join('')}</ul>
        ${form.message ? `<p><strong>Message :</strong><br>${escapeHtml(form.message).replace(/\r?\n/g, '<br>')}</p>` : ''}
        <p style="color:#6b7280;font-size:12px;">Rappel : ce client a choisi d’être recontacté par WhatsApp/SMS ou e-mail (pas d’appel sur cette page). Lead visible dans /admin/activite-panier (filtre « Landing 2 → 5 places »).</p>
      </div>`.trim();
    const internalText = [
      'Nouvelle demande — Transformation 2 → 5 places',
      `N° de dossier : ${quoteRef}`,
      `Nom : ${displayName}`,
      `Mobile : ${cleanPhone}`,
      cleanEmail ? `E-mail : ${cleanEmail}` : '',
      ...details.map(([k, v]) => `${k} : ${v}`),
      form.message ? `\nMessage :\n${form.message}` : '',
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
      console.error('[transformation-5-places] internal email failed:', err && err.message);
    }

    // 2) Accusé de réception client (best-effort, sans téléphone)
    if (cleanEmail) {
      try {
        await emailService.sendEmail({
          toEmail: cleanEmail,
          subject: `Votre demande ${quoteRef} est bien reçue — Autoliva`,
          html: buildAckEmailHtml({ firstName, quoteRef, vehicle }),
          text: [
            firstName ? `Bonjour ${firstName},` : 'Bonjour,',
            '',
            'Votre demande pour repasser votre véhicule en 5 places est bien reçue.',
            `Dossier : ${quoteRef}`,
            vehicle ? `Véhicule : ${vehicle}` : '',
            '',
            'Nous revenons vers vous sous 24 heures ouvrées, par e-mail ou WhatsApp.',
            `Pour aller plus vite, envoyez une photo de votre carte grise sur WhatsApp : https://autoliva.com${WHATSAPP_URL}`,
            '',
            "L'équipe Autoliva",
          ].filter((l) => l !== null).join('\n'),
        });
      } catch (err) {
        console.error('[transformation-5-places] ack email failed:', err && err.message);
      }
    }

    // 3) Timeline + lead (non bloquants)
    if (cleanEmail) rememberEmail(req, cleanEmail);
    trackEvent(req, 'quote_request', {
      meta: { mode: 'devis', source: CAPTURE_SOURCE, profile: form.profile, regType: form.regType },
      target: cleanEmail || cleanPhone,
    });

    captureContactLead({
      req,
      mode: 'devis',
      email: cleanEmail,
      firstName,
      lastName,
      phone: cleanPhone,
      message: composedMessage,
      productHints: {
        Immat: form.plate,
        Reference: quoteRef,
        Vehicule: `Transformation 2 → 5 places — ${vehicle}${regLabel ? ` (${regLabel})` : ''}`,
      },
    }).then((result) => {
      if (result && result.leadId && mongoose.connection.readyState === 1) {
        const AbandonedCart = require('../models/AbandonedCart');
        return AbandonedCart.updateOne({ _id: result.leadId }, { $set: { captureSource: CAPTURE_SOURCE } }).catch(() => {});
      }
      return null;
    }).catch(() => {});

    formTimestamp.poser(res);

    return renderPage(res, req, {
      form: emptyForm(),
      successMessage: `Merci${firstName ? ' ' + firstName : ''} ! Votre demande est bien reçue. Nous revenons vers vous sous 24h ouvrées, par e-mail ou WhatsApp.`,
      conversion: { ref: quoteRef, email: cleanEmail || '', phone: cleanPhone || '', profile: form.profile },
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getLanding,
  postDevis,
  _internal: { LANDING_PATH, FORM_ACTION, CAPTURE_SOURCE, PRICING, readForm, buildAckEmailHtml },
};
