'use strict';

/**
 * Templates email + SMS pour la relance de leads, et substitution des
 * variables dynamiques. Utilisé par le dashboard admin /admin/activite-panier
 * (preview + envoi) et exposé partiellement au front via JSON.
 */

const brand = require('../config/brand');

function trim(v) { return typeof v === 'string' ? v.trim() : ''; }

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

function formatEuro(totalCents) {
  if (!Number.isFinite(totalCents)) return '—';
  return `${(totalCents / 100).toFixed(2).replace('.', ',')} €`;
}

function getBaseUrl(req) {
  const fromEnv = trim(process.env.PUBLIC_BASE_URL);
  if (fromEnv) return fromEnv.replace(/\/$/, '');
  if (req && req.protocol && req.headers && req.headers.host) {
    return `${req.protocol}://${req.headers.host}`.replace(/\/$/, '');
  }
  return `https://${trim(brand.DOMAIN) || 'autoliva.com'}`;
}

/* Annuaire des commerciaux : la signature ET la ligne directe injectées dans
   les messages dépendent de QUI est connecté (le client rappelle une personne,
   pas une entreprise → meilleure conversion). Repli sur la ligne de marque si
   l'expéditeur n'est pas reconnu (ex. envoi automatique). */
const COMMERCIAL_DIRECTORY = [
  { keys: ['killian'], name: 'Killian', phone: '04 65 84 54 88' },
  { keys: ['lucas'], name: 'Lucas', phone: '04 65 84 76 78' },
];
function resolveCommercial(admin) {
  if (!admin) return null;
  const hay = [admin.firstName, admin.name, admin.email].filter(Boolean).join(' ').toLowerCase();
  return COMMERCIAL_DIRECTORY.find((c) => c.keys.some((k) => hay.includes(k))) || null;
}

function buildLeadVariables({ lead, req, adminName, admin }) {
  const baseUrl = getBaseUrl(req);
  const commercial = resolveCommercial(admin);
  const senderName = (commercial && commercial.name) || trim(adminName) || (admin && trim(admin.name)) || ('L’équipe ' + brand.NAME);
  const senderPhone = (commercial && commercial.phone) || trim(brand.PHONE) || '';
  const items = Array.isArray(lead.items) ? lead.items : [];
  const firstItem = items[0] || null;
  const requested = lead.requested || {};
  const isExplicitRequest = lead.captureSource === 'devis' || lead.captureSource === 'contact';

  /* Pour les leads devis/contact, le "produit" pertinent est ce que le
     client a demandé explicitement, pas ce qu'il avait dans son panier */
  let productName;
  if (isExplicitRequest) {
    if (requested.ref && requested.vehicle) {
      productName = `${requested.ref} pour ${requested.vehicle}`;
    } else if (requested.ref) {
      productName = requested.ref;
    } else if (requested.vehicle) {
      productName = `la pièce pour ${requested.vehicle}`;
    } else if (firstItem) {
      productName = firstItem.name || 'votre demande';
    } else {
      productName = 'votre demande';
    }
  } else if (firstItem) {
    productName = firstItem.name || 'votre article';
  } else {
    productName = 'votre demande';
  }

  const recoveryUrl = lead.recoveryToken
    ? `${baseUrl}/panier/recuperer/${encodeURIComponent(lead.recoveryToken)}`
    : `${baseUrl}/panier`;

  let productUrl = baseUrl;
  if (firstItem) {
    if (firstItem.slug) productUrl = `${baseUrl}/product/${firstItem.slug}`;
    else if (firstItem.productId) productUrl = `${baseUrl}/product/${firstItem.productId}`;
  }

  return {
    prenom: trim(lead.firstName) || 'Bonjour',
    nom: trim(lead.lastName),
    nom_complet: ((trim(lead.firstName) + ' ' + trim(lead.lastName)).trim()) || trim(lead.email) || 'cher client',
    nom_produit: productName,
    prix_total: formatEuro(lead.totalAmountCents || 0),
    prix_produit: firstItem && Number.isFinite(firstItem.price) ? formatEuro(firstItem.price) : formatEuro(lead.totalAmountCents || 0),
    lien_panier: recoveryUrl,
    lien_produit: productUrl,
    nom_commercial: senderName,
    brand: brand.NAME,
    telephone: senderPhone,
    /* champs additionnels disponibles dans les templates */
    vin: trim(requested.vin),
    vehicule: trim(requested.vehicle),
    immatriculation: trim(requested.plate),
  };
}

/**
 * Remplace les variables {var} dans une chaîne par leur valeur depuis le map.
 */
function applyVariables(text, vars) {
  if (typeof text !== 'string' || !text) return '';
  return text.replace(/\{(\w+)\}/g, (match, key) => {
    if (Object.prototype.hasOwnProperty.call(vars, key)) {
      return String(vars[key] == null ? '' : vars[key]);
    }
    return match; // garde le placeholder si pas de remplacement (ex: code promo)
  });
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  TEMPLATES EMAIL                                                         */
/* ──────────────────────────────────────────────────────────────────────── */

const EMAIL_TEMPLATES = [
  {
    key: 'devis_followup',
    label: '📨 Suite à votre demande de devis',
    forSource: ['devis', 'contact'],
    defaultIncludeCta: false, // pas de CTA panier : la demande n'est pas le panier
    subject: 'Suite à votre demande chez {brand}',
    body: 'Suite à votre demande concernant {nom_produit}, je reviens vers vous.\n\nPour vous proposer la bonne pièce au meilleur prix, pouvez-vous me confirmer votre VIN ou votre immatriculation ?\n\nJe vérifie immédiatement la disponibilité dans notre stock et reviens vers vous avec une proposition détaillée.\n\nVous pouvez aussi me joindre directement au {telephone}.',
  },
  {
    key: 'devis_quote_ready',
    label: '💼 Envoyer un devis chiffré',
    forSource: ['devis', 'contact'],
    defaultIncludeCta: false,
    subject: 'Votre devis pour {nom_produit}',
    body: 'Suite à votre demande, voici ma proposition pour {nom_produit} :\n\n[Détailler ici : référence exacte, prix, délai de livraison, garantie]\n\nCe devis est valable 7 jours. Pour valider votre commande, répondez simplement à cet email ou appelez-moi au {telephone}.',
  },
  {
    key: 'cart_reminder',
    label: '🛒 Votre panier vous attend',
    forSource: ['cart_activity', 'guest_checkout', 'user'],
    defaultIncludeCta: true,
    subject: 'Votre panier {brand} vous attend',
    body: 'Vous avez sélectionné {nom_produit} sur notre site sans finaliser votre commande.\n\nMontant : {prix_total}\n\nPour reprendre votre commande en un clic, cliquez sur le bouton ci-dessous.\n\nSi vous avez la moindre question (compatibilité, délai de livraison, garantie…), je suis disponible pour vous aider.',
  },
  {
    key: 'compatibility_check',
    label: '🔧 Question sur la compatibilité ?',
    defaultIncludeCta: false,
    subject: 'Compatibilité avec votre véhicule',
    body: 'Vous avez consulté notre site sans valider votre commande.\n\nAvez-vous une question sur la compatibilité avec votre véhicule ? Pour vous garantir la bonne pièce, je peux vérifier votre VIN ou votre plaque d’immatriculation.\n\nRépondez simplement à cet email avec votre VIN ou votre immatriculation, je reviens vers vous très vite.',
  },
  {
    key: 'discount_offer',
    label: '💰 -10 % offerts pour finaliser',
    forSource: ['cart_activity', 'guest_checkout', 'user'],
    defaultIncludeCta: true,
    subject: '-10 % pour finaliser votre commande chez {brand}',
    body: 'Pour vous remercier de votre intérêt pour {nom_produit}, je vous offre 10 % de remise sur votre commande.\n\nMontant : {prix_total} → avec le code RELANCE10 valable 7 jours.\n\nIl vous suffit de cliquer sur le bouton ci-dessous pour reprendre votre panier et appliquer le code au moment du paiement.',
  },
  {
    key: 'availability_confirm',
    label: '✅ Confirmation disponibilité',
    forSource: ['cart_activity', 'guest_checkout', 'user'],
    defaultIncludeCta: true,
    subject: '{nom_produit} est disponible',
    body: '{nom_produit} est en stock et prêt à être expédié.\n\nMontant : {prix_total}\nLivraison sous 24/48h ouvrées.\n\nPour finaliser votre commande, cliquez sur le bouton ci-dessous.',
  },
];

/* ──────────────────────────────────────────────────────────────────────── */
/*  TEMPLATES SMS (160 chars idéaux, on tolère plus si besoin)              */
/*                                                                          */
/*  RÈGLES (apprises à la dure) :                                           */
/*   1. JAMAIS de lien dans un SMS : l'expéditeur est alphanumérique        */
/*      (« CarParts »), les opérateurs FR jettent silencieusement les SMS   */
/*      avec URL. Le lien / devis part TOUJOURS par email.                  */
/*   2. Le client ne peut PAS répondre à un expéditeur alphanumérique →     */
/*      le CTA est toujours « rappelez-moi au {telephone} », jamais         */
/*      « répondez ».                                                       */
/*   3. Certains leads n'ont QUE le téléphone (pas d'email) → chaque SMS    */
/*      doit être auto-suffisant, sans dépendre d'un email.                 */
/*   4. Compatibilité : on ne dit JAMAIS « votre {nom_produit} est          */
/*      compatible » (le client a pu choisir la mauvaise réf sur le site).  */
/*      On confirme la compat POUR SON VÉHICULE / « la bonne pièce ».       */
/* ──────────────────────────────────────────────────────────────────────── */

const SMS_TEMPLATES = [
  {
    key: 'sms_compat_ok',
    label: 'Compatibilité vérifiée',
    forSource: ['devis', 'contact', 'cart_activity', 'guest_checkout', 'user'],
    body: '{prenom},\nCompatibilité vérifiée pour votre véhicule : la bonne pièce est disponible, livrable sous 24/48h.\nRappelez-moi au {telephone} pour finaliser.\n{nom_commercial} – {brand}',
  },
  {
    key: 'sms_compat_check',
    label: 'Vérifier la bonne pièce',
    forSource: ['devis', 'contact', 'cart_activity', 'guest_checkout', 'user'],
    body: '{prenom},\nPour être sûr à 100% de la bonne pièce pour votre véhicule, 2 minutes au téléphone suffisent.\nRappelez-moi au {telephone}, je m\'occupe de tout.\n{nom_commercial} – {brand}',
  },
  {
    key: 'sms_devis_ready',
    label: 'Devis prêt',
    forSource: ['devis', 'contact'],
    body: '{prenom},\nVotre devis est prêt.\nRappelez-moi au {telephone} pour le détail, le délai et le règlement.\n{nom_commercial} – {brand}',
  },
  {
    key: 'sms_tried_to_call',
    label: 'J\'ai essayé de vous joindre',
    forSource: ['devis', 'contact', 'cart_activity', 'guest_checkout', 'user'],
    body: '{prenom},\nJ\'ai essayé de vous joindre au sujet de votre demande.\nRappelez-moi au {telephone} ou dites-moi un créneau qui vous arrange.\n{nom_commercial} – {brand}',
  },
  {
    key: 'sms_still_available',
    label: 'Encore disponible',
    forSource: ['cart_activity', 'guest_checkout', 'user', 'devis', 'contact'],
    body: '{prenom},\nLa pièce qui vous intéresse est encore en stock mais part vite.\nJe peux vous la réserver ? Rappelez-moi au {telephone}.\n{nom_commercial} – {brand}',
  },
  {
    key: 'sms_discount',
    label: '-10 % (code)',
    forSource: ['cart_activity', 'guest_checkout', 'user'],
    body: '{prenom},\n-10% sur votre commande avec le code RELANCE10 (valable 7 jours).\nRappelez-moi au {telephone} pour en profiter.\n{nom_commercial} – {brand}',
  },
  {
    key: 'sms_cart_reminder',
    label: 'Panier en attente',
    forSource: ['cart_activity', 'guest_checkout', 'user'],
    body: '{prenom},\nVotre panier ({prix_total}) est toujours là.\nJe peux le finaliser avec vous : rappelez-moi au {telephone}.\n{nom_commercial} – {brand}',
  },
];

/* ──────────────────────────────────────────────────────────────────────── */
/*  WRAP HTML EMAIL — signature + footer pro                                */
/* ──────────────────────────────────────────────────────────────────────── */

function renderEmailHtml({ subject, body, vars, ctaUrl }) {
  const safeBody = escapeHtml(body || '').replace(/\r?\n/g, '<br/>');
  const greeting = vars.prenom && vars.prenom !== 'Bonjour' ? `Bonjour ${escapeHtml(vars.prenom)},` : 'Bonjour,';

  const ctaBlock = ctaUrl
    ? `<div style="margin:24px 0;text-align:center;">
        <a href="${escapeHtml(ctaUrl)}" style="display:inline-block;background:#dc2626;color:#fff;text-decoration:none;padding:12px 28px;border-radius:8px;font-weight:600;font-size:14px;">Reprendre mon panier</a>
      </div>`
    : '';

  const phoneBlock = vars.telephone
    ? `<div style="font-size:13px;color:#6b7280;margin-top:8px;">Une question ? <a href="tel:${escapeHtml(vars.telephone)}" style="color:#dc2626;">${escapeHtml(vars.telephone)}</a></div>`
    : '';

  return `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;color:#111827;line-height:1.6;">
    <p style="margin:0 0 16px 0;font-size:15px;">${greeting}</p>
    <div style="font-size:14px;color:#374151;">${safeBody}</div>
    ${ctaBlock}
    <p style="margin:24px 0 0 0;font-size:14px;color:#374151;">
      Cordialement,<br/>
      <strong>${escapeHtml(vars.nom_commercial || 'L’équipe ' + (vars.brand || 'Autoliva'))}</strong>
    </p>
    ${phoneBlock}
  </div>
  <div style="max-width:560px;margin:12px auto 0 auto;text-align:center;font-size:11px;color:#9ca3af;">
    ${escapeHtml(vars.brand || 'Autoliva')} · cet email vous est envoyé suite à votre activité sur notre site.
  </div>
</body></html>`.trim();
}

function renderEmailText({ body, vars }) {
  const greeting = vars.prenom && vars.prenom !== 'Bonjour' ? `Bonjour ${vars.prenom},` : 'Bonjour,';
  const lines = [
    greeting,
    '',
    body || '',
    '',
    'Cordialement,',
    vars.nom_commercial || 'L’équipe ' + (vars.brand || 'Autoliva'),
  ];
  if (vars.telephone) lines.push(vars.telephone);
  return lines.join('\n');
}

module.exports = {
  EMAIL_TEMPLATES,
  SMS_TEMPLATES,
  applyVariables,
  buildLeadVariables,
  renderEmailHtml,
  renderEmailText,
  getBaseUrl,
};
