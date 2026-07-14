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
  // Le compte back-office affiché « Fanir CPF » = Lucas → il signe « Lucas »
  // avec SA ligne directe (et non le nom brut du compte / la ligne par défaut).
  { keys: ['lucas', 'fanir'], name: 'Lucas', phone: '04 65 84 85 39' },
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
/*  ARTICLES INSÉRÉS — token [[article|sku|prix|libellé]]                    */
/*                                                                           */
/*  Le composer (page Leads) insère ce token au curseur quand le commercial  */
/*  ajoute un produit du catalogue. Il est résolu ICI, côté serveur :        */
/*   - l'URL vient du SKU (source = catalogue, jamais le front → pas          */
/*     d'injection de lien arbitraire) ;                                      */
/*   - le prix vient du token (modifiable par le commercial), validé number ; */
/*   - rendu « naturel » : lien texte sur le nom + prix entre parenthèses,    */
/*     PAS de carte ni de bouton (meilleure délivrabilité, et ça ressemble    */
/*     à un mail écrit à la main).                                            */
/* ──────────────────────────────────────────────────────────────────────── */
const ARTICLE_TOKEN_RE = /\[\[article\|([^|\]]*)\|([^|\]]*)\|([^\]]*)\]\]/g;

/* SKUs uniques présents dans un texte (pour la requête Product côté controller). */
function extractArticleSkus(text) {
  const skus = [];
  if (typeof text !== 'string' || !text) return skus;
  let m;
  ARTICLE_TOKEN_RE.lastIndex = 0;
  while ((m = ARTICLE_TOKEN_RE.exec(text)) !== null) {
    const sku = trim(m[1]);
    if (sku && skus.indexOf(sku) === -1) skus.push(sku);
  }
  return skus;
}

function articleBaseUrl(baseUrl) {
  return String(baseUrl || brand.SITE_URL || ('https://' + (trim(brand.DOMAIN) || 'autoliva.com'))).replace(/\/$/, '');
}

/* Décompose un token en { name, url, priceStr } prêts à afficher.
   `articles` = map { [sku]: { slug, name } } résolue en base par le controller. */
function resolveArticleParts(sku, priceRaw, label, articles, baseUrl) {
  const product = (articles || {})[trim(sku)] || null;
  const price = parseFloat(String(priceRaw || '').replace(',', '.'));
  const hasPrice = Number.isFinite(price) && price > 0;
  const name = trim(label) || (product && trim(product.name)) || 'la pièce';
  const url = product && product.slug ? `${articleBaseUrl(baseUrl)}/product/${product.slug}` : '';
  const priceStr = hasPrice
    ? ` (${Number.isInteger(price) ? String(price) : price.toFixed(2).replace('.', ',')} €)`
    : '';
  return { name, url, priceStr };
}

/* Rendu texte brut (WhatsApp, version texte de l'email, dégradé SMS sans URL). */
function replaceArticleTokensPlain(text, articles, baseUrl, opts) {
  if (typeof text !== 'string' || !text) return text || '';
  const includeUrl = !opts || opts.includeUrl !== false;
  return text.replace(ARTICLE_TOKEN_RE, (match, sku, priceRaw, label) => {
    const { name, url, priceStr } = resolveArticleParts(sku, priceRaw, label, articles, baseUrl);
    return url && includeUrl ? `${name}${priceStr} : ${url}` : `${name}${priceStr}`;
  });
}

/* ──────────────────────────────────────────────────────────────────────── */
/*  TEMPLATES EMAIL                                                         */
/* ──────────────────────────────────────────────────────────────────────── */

const EMAIL_TEMPLATES = [
  {
    key: 'devis_followup',
    label: 'Suite à votre demande de devis',
    forSource: ['devis', 'contact'],
    defaultIncludeCta: false, // pas de CTA panier : la demande n'est pas le panier
    subject: 'Suite à votre demande chez {brand}',
    body: 'Suite à votre demande concernant {nom_produit}, je reviens vers vous.\n\nPour vous proposer la bonne pièce au meilleur prix, pouvez-vous me confirmer votre VIN ou votre immatriculation ?\n\nJe vérifie immédiatement la disponibilité dans notre stock et reviens vers vous avec une proposition détaillée.\n\nVous pouvez aussi me joindre directement au {telephone}.',
  },
  {
    key: 'devis_quote_ready',
    label: 'Envoyer un devis chiffré',
    forSource: ['devis', 'contact'],
    defaultIncludeCta: false,
    subject: 'Votre devis pour {nom_produit}',
    body: 'Suite à votre demande, voici ma proposition pour {nom_produit} :\n\n[Détailler ici : référence exacte, prix, délai de livraison, garantie]\n\nCe devis est valable 7 jours. Pour valider votre commande, répondez simplement à cet email ou appelez-moi au {telephone}.',
  },
  {
    key: 'compat_confirmed',
    label: 'Compatibilité confirmée',
    forSource: ['devis', 'contact', 'cart_activity', 'guest_checkout', 'user'],
    defaultIncludeCta: false,
    subject: 'Compatibilité confirmée pour votre véhicule',
    body: 'Après vérification, je vous confirme la bonne pièce pour votre véhicule.\n\n[Précisez ici : la référence exacte validée, le prix, le délai de livraison et la garantie]\n\nDès que vous me donnez le feu vert, je lance la préparation. Une question ? Vous pouvez me joindre au {telephone}.',
  },
  {
    key: 'moteur_dispo',
    label: 'Moteur disponible',
    forSource: ['devis', 'contact'],
    defaultIncludeCta: false,
    subject: 'Votre moteur est disponible chez nous',
    body: 'Bonne nouvelle : après vérification, votre moteur est disponible chez nous — testé sur banc, prêt à être expédié.\n\n[Précisez ici : la référence exacte, le prix, le délai de livraison et la garantie]\n\nOn peut lancer dès que vous êtes prêt. Une question (compatibilité, montage, livraison) ? Rappelez-moi au {telephone}, je m\'occupe de tout.',
  },
  {
    key: 'cart_reminder',
    label: 'Votre panier vous attend',
    forSource: ['cart_activity', 'guest_checkout', 'user'],
    defaultIncludeCta: true,
    subject: 'Votre panier {brand} vous attend',
    body: 'Vous avez sélectionné {nom_produit} sur notre site sans finaliser votre commande.\n\nMontant : {prix_total}\n\nPour reprendre votre commande, je vous mets le lien juste en dessous.\n\nSi vous avez la moindre question (compatibilité, délai de livraison, garantie…), je suis disponible pour vous aider.',
  },
  {
    key: 'compatibility_check',
    label: 'Question sur la compatibilité ?',
    defaultIncludeCta: false,
    subject: 'Compatibilité avec votre véhicule',
    body: 'Vous avez consulté notre site sans valider votre commande.\n\nAvez-vous une question sur la compatibilité avec votre véhicule ? Pour vous garantir la bonne pièce, je peux vérifier votre VIN ou votre plaque d’immatriculation.\n\nRépondez simplement à cet email avec votre VIN ou votre immatriculation, je reviens vers vous très vite.',
  },
  {
    key: 'reassurance',
    label: 'Réassurance & garantie',
    forSource: ['devis', 'contact', 'cart_activity', 'guest_checkout', 'user'],
    defaultIncludeCta: false,
    subject: 'Nos pièces : testées, garanties, facture à l’appui',
    body: 'Je comprends qu’acheter une pièce reconditionnée demande de la confiance. Voici nos engagements :\n\n- Chaque pièce est testée sur banc avant expédition.\n- Garantie de 6 à 24 mois selon le produit, avec facture et garantie écrite.\n- Livraison sous 24/48h, paiement en 3x ou 4x sans frais possible.\n- Un interlocuteur dédié (moi) pour vous accompagner avant et après l’achat.\n\nJe reste à votre disposition pour toute question — vous pouvez me joindre au {telephone}.',
  },
  {
    key: 'discount_offer',
    label: '-10 % offerts pour finaliser',
    forSource: ['cart_activity', 'guest_checkout', 'user'],
    defaultIncludeCta: true,
    subject: '-10 % pour finaliser votre commande chez {brand}',
    body: 'Pour vous remercier de votre intérêt pour {nom_produit}, je vous offre 10 % de remise sur votre commande.\n\nMontant : {prix_total} → avec le code RELANCE10 valable 7 jours.\n\nJe vous mets le lien ci-dessous : reprenez votre panier et appliquez le code RELANCE10 au moment du paiement.',
  },
  {
    key: 'availability_confirm',
    label: 'Confirmation de disponibilité',
    forSource: ['cart_activity', 'guest_checkout', 'user'],
    defaultIncludeCta: true,
    subject: '{nom_produit} est disponible',
    body: '{nom_produit} est en stock et prêt à être expédié.\n\nMontant : {prix_total}\nLivraison sous 24/48h ouvrées.\n\nPour finaliser, je vous mets le lien juste en dessous.',
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
    key: 'sms_moteur_dispo',
    label: 'Moteur disponible',
    forSource: ['devis', 'contact'],
    body: '{prenom},\nBonne nouvelle : votre moteur est disponible chez nous, testé sur banc et prêt à partir.\nRappelez-moi au {telephone} pour le prix, le délai et la garantie.\n{nom_commercial} – {brand}',
  },
  {
    key: 'sms_compat_check',
    label: 'Vérifier la bonne pièce',
    forSource: ['devis', 'contact', 'cart_activity', 'guest_checkout', 'user'],
    body: '{prenom},\nPour être sûr à 100% de la bonne pièce pour votre véhicule, 2 minutes au téléphone suffisent.\nRappelez-moi au {telephone}, je m\'occupe de tout.\n{nom_commercial} – {brand}',
  },
  {
    key: 'sms_reassurance',
    label: 'Réassurance & garantie',
    forSource: ['devis', 'contact', 'cart_activity', 'guest_checkout', 'user'],
    body: '{prenom},\nToutes nos pièces sont testées sur banc et garanties, facture à l\'appui.\nJe réponds à toutes vos questions : rappelez-moi au {telephone}.\n{nom_commercial} – {brand}',
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

/**
 * Rendu « email personnel » : pas de carte marketing ni de gros bouton rouge,
 * juste un message écrit à la main + une vraie signature avec le logo Autoliva.
 * Le lien (quand il y en a un) est un lien texte discret, comme le mettrait un
 * humain — pas un call-to-action de newsletter.
 */
function renderEmailHtml({ subject, body, vars, ctaUrl, articles, baseUrl }) {
  /* Les articles insérés deviennent des liens texte inline. On remplace chaque
     token par une sentinelle AVANT d'échapper le corps (pour que le nom du
     produit soit échappé par nous, pas par l'échappeur du corps), puis on
     réinjecte le <a> après échappement. */
  const linkFrags = [];
  const preBody = String(body || '').replace(ARTICLE_TOKEN_RE, (match, sku, priceRaw, label) => {
    const { name, url, priceStr } = resolveArticleParts(sku, priceRaw, label, articles, baseUrl);
    const frag = url
      ? `<a href="${escapeHtml(url)}" style="color:#1a56db;text-decoration:underline;">${escapeHtml(name)}</a>${escapeHtml(priceStr)}`
      : `${escapeHtml(name)}${escapeHtml(priceStr)}`;
    linkFrags.push(frag);
    return ` A${linkFrags.length - 1} `;
  });
  const safeBody = escapeHtml(preBody)
    .replace(/\r?\n/g, '<br/>')
    .replace(/ A(\d+) /g, (m, i) => linkFrags[Number(i)] || '');
  const greeting = vars.prenom && vars.prenom !== 'Bonjour' ? `Bonjour ${escapeHtml(vars.prenom)},` : 'Bonjour,';
  const senderName = escapeHtml(vars.nom_commercial || ('L’équipe ' + brand.NAME));
  const logoUrl = escapeHtml((brand.SITE_URL || '') + (brand.LOGO_URL || ''));
  const siteUrl = escapeHtml(brand.SITE_URL || '');
  const siteLabel = escapeHtml(brand.DOMAIN || 'autoliva.com');
  const tel = escapeHtml(vars.telephone || brand.PHONE || '');
  const contactEmail = escapeHtml(brand.EMAIL_CONTACT || '');
  const RED = '#E10613';

  const ctaBlock = ctaUrl
    ? `<p style="margin:16px 0;">Reprendre votre commande : <a href="${escapeHtml(ctaUrl)}" style="color:#1a56db;">${escapeHtml(ctaUrl)}</a></p>`
    : '';

  const contactParts = [];
  if (tel) contactParts.push(`Tél. <a href="tel:${tel.replace(/\s+/g, '')}" style="color:#555;text-decoration:none;">${tel}</a>`);
  if (contactEmail) contactParts.push(`<a href="mailto:${contactEmail}" style="color:#555;text-decoration:none;">${contactEmail}</a>`);
  const contactLine = contactParts.join(' &nbsp;·&nbsp; ');

  return `
<!DOCTYPE html>
<html lang="fr"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#ffffff;">
  <div style="max-width:600px;margin:0;padding:16px 20px 22px;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;font-size:15px;line-height:1.62;color:#1f2328;text-align:left;">
    <p style="margin:0 0 14px;">${greeting}</p>
    <div style="margin:0 0 4px;">${safeBody}</div>
    ${ctaBlock}
    <p style="margin:20px 0 2px;">Cordialement,</p>
    <p style="margin:0 0 16px;font-weight:600;color:#111;">${senderName}</p>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:4px;">
      <tr>
        <td style="padding-right:14px;vertical-align:middle;">
          <img src="${logoUrl}" alt="${escapeHtml(brand.NAME)}" height="42" style="display:block;height:42px;width:auto;border:0;outline:none;text-decoration:none;" />
        </td>
        <td style="padding-left:14px;border-left:3px solid ${RED};vertical-align:middle;font-size:12.5px;color:#555;line-height:1.55;">
          <span style="font-weight:700;color:#111;font-size:14px;">${escapeHtml(brand.NAME)}</span><br/>
          Pièces auto reconditionnées &amp; garanties<br/>
          ${contactLine ? contactLine + '<br/>' : ''}
          <a href="${siteUrl}" style="color:${RED};text-decoration:none;font-weight:600;">${siteLabel}</a>
        </td>
      </tr>
    </table>
    <p style="margin:20px 0 0;font-size:11px;color:#9ca3af;">Cet email fait suite à votre demande sur ${siteLabel}.</p>
  </div>
</body></html>`.trim();
}

function renderEmailText({ body, vars, articles, baseUrl }) {
  const resolvedBody = replaceArticleTokensPlain(body || '', articles, baseUrl);
  const greeting = vars.prenom && vars.prenom !== 'Bonjour' ? `Bonjour ${vars.prenom},` : 'Bonjour,';
  const lines = [
    greeting,
    '',
    resolvedBody,
    '',
    'Cordialement,',
    vars.nom_commercial || ('L’équipe ' + brand.NAME),
    '',
    brand.NAME + ' — Pièces auto reconditionnées & garanties',
  ];
  const contactBits = [];
  if (vars.telephone) contactBits.push('Tél. ' + vars.telephone);
  if (brand.EMAIL_CONTACT) contactBits.push(brand.EMAIL_CONTACT);
  if (contactBits.length) lines.push(contactBits.join(' · '));
  lines.push(brand.DOMAIN || 'autoliva.com');
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
  extractArticleSkus,
  replaceArticleTokensPlain,
};
