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

function buildLeadVariables({ lead, req, adminName }) {
  const baseUrl = getBaseUrl(req);
  const items = Array.isArray(lead.items) ? lead.items : [];
  const firstItem = items[0] || null;
  const productName = firstItem ? (firstItem.name || 'votre article') : 'votre article';

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
    nom_commercial: trim(adminName) || 'L’équipe ' + brand.NAME,
    brand: brand.NAME,
    telephone: trim(brand.PHONE) || '',
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
    subject: 'Suite à votre demande chez {brand}',
    body: 'Suite à votre demande, je reviens vers vous : {nom_produit} est bien disponible au prix de {prix_total}.\n\nPouvez-vous me confirmer votre VIN ou votre immatriculation ? Cela me permettra de garantir la compatibilité avec votre véhicule.\n\nN’hésitez pas à me joindre par retour d’email ou au {telephone}, je suis à votre disposition.',
  },
  {
    key: 'cart_reminder',
    label: '🛒 Votre panier vous attend',
    forSource: ['cart_activity', 'guest_checkout', 'user'],
    subject: 'Votre panier {brand} vous attend',
    body: 'Vous avez sélectionné {nom_produit} sur notre site sans finaliser votre commande.\n\nMontant : {prix_total}\n\nPour reprendre votre commande en un clic : {lien_panier}\n\nSi vous avez la moindre question (compatibilité, délai de livraison, garantie…), je suis disponible pour vous aider.',
  },
  {
    key: 'compatibility_check',
    label: '🔧 Question sur la compatibilité ?',
    subject: 'Compatibilité de {nom_produit} avec votre véhicule',
    body: 'Vous avez consulté {nom_produit} sur notre site sans valider votre commande.\n\nAvez-vous une question sur la compatibilité avec votre véhicule ? Pour vous garantir la bonne pièce, je peux vérifier votre VIN ou votre plaque d’immatriculation.\n\nRépondez simplement à cet email avec votre VIN ou votre immatriculation, je reviens vers vous très vite.',
  },
  {
    key: 'discount_offer',
    label: '💰 -10 % offerts pour finaliser',
    subject: '-10 % sur {nom_produit} chez {brand}',
    body: 'Pour vous remercier de votre intérêt pour {nom_produit}, je vous offre 10 % de remise sur votre commande.\n\nMontant : {prix_total} → avec le code RELANCE10 valable 7 jours.\n\nReprendre votre panier : {lien_panier}\n\nÀ très bientôt sur {brand}.',
  },
  {
    key: 'availability_confirm',
    label: '✅ Confirmation disponibilité',
    subject: '{nom_produit} est disponible',
    body: '{nom_produit} est en stock et prêt à être expédié.\n\nMontant : {prix_total}\nLivraison sous 24/48h ouvrées.\n\nPour finaliser votre commande : {lien_panier}\n\nCordialement.',
  },
];

/* ──────────────────────────────────────────────────────────────────────── */
/*  TEMPLATES SMS (160 chars idéaux, on tolère plus si besoin)              */
/* ──────────────────────────────────────────────────────────────────────── */

const SMS_TEMPLATES = [
  {
    key: 'sms_cart_reminder',
    label: '🛒 Panier en attente',
    body: '{prenom}, votre panier {brand} ({prix_total}) vous attend. Reprendre : {lien_panier}',
  },
  {
    key: 'sms_devis_followup',
    label: '📨 Suite devis',
    body: '{prenom}, votre {nom_produit} à {prix_total} est dispo. Répondez à ce SMS pour valider ou appelez le {telephone}.',
  },
  {
    key: 'sms_discount',
    label: '💰 -10 %',
    body: '{prenom}, -10% sur votre panier {brand} avec RELANCE10 (7 jours). {lien_panier}',
  },
  {
    key: 'sms_callback',
    label: '📞 Demande de rappel',
    body: '{prenom}, je peux vous rappeler pour votre {nom_produit} ? Répondez avec un créneau qui vous arrange. {brand}',
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
