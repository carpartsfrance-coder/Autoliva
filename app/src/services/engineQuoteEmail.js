'use strict';

/**
 * Templates HTML email pour le workflow devis moteurs Autoliva.
 *
 *  - buildQuoteEmailHtml   : email de devis. Design "Killian" (Stitch) :
 *                            2 colonnes (moteur | récap+acompte) puis sections
 *                            pleine largeur. Email-safe (tables + inline styles),
 *                            compatible Outlook + responsive mobile (empilement).
 *  - buildReminderEmailHtml: relances J+3 / J+7.
 */

const RED = '#E1001A';
const NAVY = '#0b2046';
const PUBLIC_SITE = 'https://autoliva.com';
const LOGO_URL = PUBLIC_SITE + '/images/logo-autoliva.png';

function fmtEur(n) {
  return new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(n) || 0) + ' €';
}
function fmtMileage(km) {
  const n = Number(km) || 0;
  if (n <= 0) return '';
  return new Intl.NumberFormat('fr-FR').format(n) + ' km';
}
function escapeHtml(s) {
  return String(s || '').replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]));
}

/**
 * @param {object} opts  (voir engineQuoteAdminController.postSendQuote)
 */
function buildQuoteEmailHtml(opts) {
  const greeting = opts.firstName ? 'Bonjour ' + escapeHtml(opts.firstName) + ',' : 'Bonjour,';
  const engineTitle = (opts.engine && opts.engine.model) ? escapeHtml(opts.engine.model) : 'Moteur d\'occasion';
  const engineCode = (opts.engine && opts.engine.code) ? escapeHtml(opts.engine.code) : '';
  const mileage = opts.engine && opts.engine.mileage ? fmtMileage(opts.engine.mileage) : '';
  const badge = opts.conditionBadge || 'Occasion';
  const badgeColor = opts.isReconditionne ? RED : NAVY;
  const conditionText = opts.conditionLabel || 'Moteur d\'occasion testé';

  const sellHt = Number(opts.sellHt) || 0;
  const sellTtc = Number(opts.sellTtc) || 0;
  const depositTtc = Number(opts.depositTtc) || 0;
  const remaining = Math.max(sellTtc - depositTtc, 0);
  const isFull = depositTtc > 0 && Math.abs(depositTtc - sellTtc) < 0.01;
  const vatRate = opts.vatRate != null ? Number(opts.vatRate) : 20;
  // Garantie dérivée de l'état du moteur : occasion 6 mois, reconditionné 12 mois.
  const warrantyMonths = opts.warrantyMonths != null ? Number(opts.warrantyMonths) : (opts.isReconditionne ? 12 : 6);

  const photoSentence = opts.photoCount > 0
    ? ` Le détail complet est en pièce jointe (PDF), ainsi que <strong style="color:${NAVY};">${opts.photoCount} photo${opts.photoCount > 1 ? 's' : ''}</strong> du moteur.`
    : ' Le détail complet est en pièce jointe (PDF).';

  // En stock atelier vs sur commande (sourcing) : conditionne le wording du solde.
  const inStock = opts.stockLocation === 'atelier' || /stock/i.test(opts.stockLabel || '');

  // Carte acompte (colonne droite, sous le récap)
  let reservationCard = '';
  if (depositTtc > 0) {
    const headLabel = isFull ? 'Paiement intégral' : 'Acompte de réservation';
    const soldeLine = isFull
      ? 'Votre moteur est immédiatement réservé.'
      : 'Solde de <strong>' + fmtEur(remaining) + '</strong> à régler une fois le moteur ' + (inStock ? '' : 'sourcé, ') + 'testé en atelier et déclaré conforme — rapport de test et attestation de conformité transmis.';
    // Le bouton pointe vers l'URL trackée (clic paiement) si fournie, sinon Mollie direct.
    const payHref = opts.payTrackUrl || opts.mollieUrl;
    const action = payHref
      ? `<a href="${escapeHtml(payHref)}" style="display:block;background:${RED};color:#ffffff;text-decoration:none;font-weight:700;font-size:13px;letter-spacing:0.03em;text-transform:uppercase;text-align:center;padding:13px 12px;border-radius:8px;">${isFull ? 'Payer maintenant' : 'Valider la réservation'} →</a>`
      : `<p style="margin:0;font-size:11px;color:#64748b;line-height:1.5;">Lien de paiement sécurisé transmis par retour de mail.</p>`;
    reservationCard = `
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#fef2f2;border:1px solid #fecaca;border-radius:14px;margin-top:14px;">
        <tr><td style="padding:18px 20px;">
          <p style="margin:0 0 5px;font-size:10px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${RED};">${headLabel}</p>
          <p style="margin:0 0 6px;font-size:26px;line-height:1;font-weight:800;color:${RED};">${fmtEur(depositTtc)}</p>
          <p style="margin:0 0 14px;font-size:12px;color:#475569;line-height:1.5;">${soldeLine}</p>
          ${action}
        </td></tr>
      </table>`;
  }

  // Message du commercial : message saisi sinon texte auto
  let commercialMessage;
  if (opts.customMessage && opts.customMessage.trim()) {
    commercialMessage = escapeHtml(opts.customMessage.trim()).replace(/\r?\n/g, '<br>');
  } else {
    const lines = [greeting, '', 'Moteur intégralement contrôlé sur banc d\'essai avant expédition.'];
    if (mileage) lines.push('Kilométrage : ' + mileage + ' certifiés au compteur.');
    if (opts.stockLabel) lines.push((opts.stockLabel) + (opts.delay ? ' · délai estimé ' + escapeHtml(opts.delay) : '') + '.');
    lines.push('', 'À votre disposition pour toute question.');
    commercialMessage = lines.join('\n').replace(/\n/g, '<br>');
  }

  // "Inclus dans votre devis" : construit selon l'état réel du moteur saisi dans le devis.
  const includedItems = [];
  if (opts.isReconditionne) {
    includedItems.push('Reconditionnement complet en atelier (pièces d\'usure remplacées)');
    includedItems.push('Banc d\'essai (compression, étanchéité, endoscopie)');
  } else {
    includedItems.push('Banc d\'essai obligatoire (compression, étanchéité, endoscopie)');
    if (mileage) includedItems.push('Kilométrage certifié, photo du compteur transmise');
  }
  if (warrantyMonths > 0) {
    includedItems.push('Garantie ' + warrantyMonths + ' mois sans franchise kilométrique');
  }
  includedItems.push('Transférable en cas de revente');
  includedItems.push('Expédition sécurisée Europe (palette, scellés, attestation)');
  const includedHtml = includedItems.map(it => `
    <tr><td style="padding:5px 0;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="vertical-align:top;padding-right:10px;width:20px;"><span style="display:inline-block;width:18px;height:18px;background:${NAVY};border-radius:50%;color:#fff;font-size:11px;line-height:18px;text-align:center;font-weight:700;">✓</span></td>
        <td style="font-size:14px;color:${NAVY};line-height:1.4;">${it}</td>
      </tr></table>
    </td></tr>`).join('');

  const lbl = 'margin:0 0 12px;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:#64748b;';

  return `<!DOCTYPE html>
<html lang="fr"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Votre devis ${escapeHtml(opts.quoteRef)} — Autoliva</title>
<style>
  @media only screen and (max-width:600px){
    .email-pad { padding:0 !important; }
    .email-container { border-radius:0 !important; }
    .pad-x { padding-left:18px !important; padding-right:18px !important; }
    .col-l, .col-r { display:block !important; width:100% !important; padding:0 !important; }
    .col-r { padding-top:14px !important; }
    .h1-mobile { font-size:30px !important; }
  }
</style>
</head>
<body style="margin:0;padding:0;background:#f3f4f6;font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:${NAVY};">
<div style="display:none;font-size:1px;color:#f3f4f6;max-height:0;overflow:hidden;">Votre devis ${escapeHtml(opts.quoteRef)} est prêt — ${fmtEur(sellTtc)} TTC</div>

<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f3f4f6;">
<tr><td align="center" class="email-pad" style="padding:24px 12px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="720" class="email-container" style="max-width:720px;width:100%;background:#ffffff;border-radius:16px;border:1px solid #eef0f3;overflow:hidden;">

  <!-- HEADER -->
  <tr><td class="pad-x" style="padding:26px 30px 22px;border-bottom:1px solid #eef0f3;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
      <td style="vertical-align:middle;"><img src="${LOGO_URL}" alt="Autoliva" width="148" style="display:block;border:0;height:auto;width:148px;"></td>
      <td align="right" style="vertical-align:middle;"><span style="display:inline-block;background:#f3f4f6;border-radius:8px;padding:7px 12px;font-size:13px;color:#475569;font-weight:500;">Devis <span style="color:${NAVY};">${escapeHtml(opts.quoteRef)}</span></span></td>
    </tr></table>
  </td></tr>

  <!-- GREETING -->
  <tr><td class="pad-x" style="padding:28px 30px 22px;">
    <p style="margin:0 0 8px;font-size:13px;font-weight:700;color:${RED};">Votre devis est prêt</p>
    <h1 class="h1-mobile" style="margin:0 0 12px;font-size:32px;line-height:1.1;font-weight:800;color:${NAVY};letter-spacing:-0.02em;">${greeting}</h1>
    <p style="margin:0;font-size:15px;line-height:1.6;color:#475569;">Voici votre devis personnalisé pour votre <strong style="color:${NAVY};">${escapeHtml(opts.plate || 'véhicule')}</strong>.${photoSentence}</p>
    ${opts.pdfTrackUrl ? `<p style="margin:12px 0 0;font-size:14px;line-height:1.5;"><a href="${escapeHtml(opts.pdfTrackUrl)}" style="color:#2563eb;text-decoration:none;font-weight:600;">📄 Voir le devis en ligne (PDF) →</a></p>` : ''}
  </td></tr>

  <!-- ROW 2 COLONNES : moteur | récap+acompte -->
  <tr><td class="pad-x" style="padding:0 30px 8px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>

      <td class="col-l" width="400" style="vertical-align:top;padding-right:14px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid #e5e7eb;border-radius:14px;height:100%;"><tr><td style="padding:22px;">
          <p style="${lbl}">Moteur proposé</p>
          <span style="display:inline-block;background:${badgeColor};color:#fff;font-size:10px;font-weight:700;letter-spacing:0.04em;text-transform:uppercase;padding:4px 9px;border-radius:4px;margin-bottom:12px;">${escapeHtml(badge)}</span>
          <h2 style="margin:0 0 ${engineCode ? '4px' : '12px'};font-size:16px;line-height:1.3;font-weight:700;color:${NAVY};text-transform:uppercase;">${engineTitle}</h2>
          ${engineCode ? `<p style="margin:0 0 14px;font-size:14px;color:#6b7280;font-weight:600;">${engineCode}</p>` : ''}
          <p style="margin:0 0 8px;font-size:13px;color:#475569;">✓&nbsp;&nbsp;${escapeHtml(conditionText)}</p>
          ${mileage ? `<p style="margin:0 0 8px;font-size:13px;color:#475569;">◷&nbsp;&nbsp;Kilométrage certifié : ${mileage}</p>` : ''}
          ${opts.stockLabel ? `<p style="margin:0;font-size:13px;font-weight:700;color:${RED};">→&nbsp;&nbsp;${escapeHtml(opts.stockLabel)}${opts.delay ? ' · délai ' + escapeHtml(opts.delay) : ''}</p>` : ''}
        </td></tr></table>
      </td>

      <td class="col-r" width="276" style="vertical-align:top;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid #e5e7eb;border-radius:14px;"><tr><td style="padding:20px;">
          <p style="${lbl}">Récapitulatif</p>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr><td style="padding:2px 0;font-size:14px;color:${NAVY};">Prix HT</td><td style="padding:2px 0;font-size:14px;color:${NAVY};text-align:right;">${fmtEur(sellHt)}</td></tr>
            <tr><td style="padding:2px 0 12px;font-size:14px;color:${NAVY};">TVA ${vatRate}%</td><td style="padding:2px 0 12px;font-size:14px;color:${NAVY};text-align:right;">${fmtEur(sellTtc - sellHt)}</td></tr>
          </table>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-top:1px solid #f1f5f9;"><tr>
            <td style="padding-top:12px;font-size:14px;font-weight:700;color:${NAVY};vertical-align:bottom;">Total TTC</td>
            <td style="padding-top:12px;font-size:22px;font-weight:800;color:${RED};text-align:right;line-height:1;">${fmtEur(sellTtc)}</td>
          </tr></table>
        </td></tr></table>
        ${reservationCard}
      </td>

    </tr></table>
  </td></tr>

  <!-- INCLUS (pleine largeur) -->
  <tr><td class="pad-x" style="padding:14px 30px 8px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border:1px solid #e5e7eb;border-radius:14px;"><tr><td style="padding:22px 24px;">
      <p style="${lbl}">Inclus dans votre devis</p>
      <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">${includedHtml}</table>
    </td></tr></table>
  </td></tr>

  <!-- MESSAGE DU COMMERCIAL -->
  <tr><td class="pad-x" style="padding:14px 30px 20px;">
    <p style="${lbl}">Message du commercial</p>
    <p style="margin:0 0 14px;font-size:14px;line-height:1.7;color:${NAVY};">${commercialMessage}</p>
    <p style="margin:0;font-size:14px;font-weight:700;color:${NAVY};">L'équipe technique Autoliva</p>
  </td></tr>

  <!-- FOOTER -->
  <tr><td class="pad-x" style="padding:6px 30px 28px;">
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-top:1px solid #eef0f3;"><tr><td style="padding-top:18px;">
      <p style="margin:0 0 4px;font-size:12px;color:#64748b;">Disponibles pour toute question,</p>
      <p style="margin:0 0 14px;font-size:14px;font-weight:700;color:${NAVY};">L'équipe technique Autoliva</p>
      <p style="margin:0;font-size:12px;color:#94a3b8;line-height:1.6;">
        Devis valable 24h (le moteur peut être vendu entre-temps) · Référence : <strong style="color:#475569;">${escapeHtml(opts.quoteRef)}</strong><br>
        <a href="mailto:contact@autoliva.com" style="color:#2563eb;text-decoration:none;">contact@autoliva.com</a> · <a href="tel:${escapeHtml(opts.brandPhoneIntl || '+33465848539')}" style="color:#64748b;text-decoration:none;">${escapeHtml(opts.brandPhone || '04 65 84 85 39')}</a> · <a href="${PUBLIC_SITE}" style="color:#2563eb;text-decoration:none;">autoliva.com</a>
      </p>
    </td></tr></table>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;
}

/**
 * Template HTML pour relance J+3 / J+7 (devis non répondu).
 */
function buildReminderEmailHtml(opts) {
  const greeting = opts.firstName ? 'Bonjour ' + escapeHtml(opts.firstName) + ',' : 'Bonjour,';
  const type = opts.type || 'j3';

  // 3 variantes. NB cohérence : le devis est annoncé "valable 24h" (le moteur
  // peut être vendu / le prix bouge). Les relances n'affirment donc PAS que le
  // devis est "toujours actif" → elles proposent de RE-confirmer dispo + prix.
  let subject, heroLine, ctaLine;
  if (type === 'j14') {
    subject = 'Dernier rappel — votre devis moteur';
    heroLine = 'Sans nouvelle de votre part, je vais bientôt clôturer votre dossier.';
    ctaLine = 'Si votre projet est toujours d\'actualité, dites-le moi : je re-vérifie la disponibilité du moteur et je vous reconfirme le prix du jour.';
  } else if (type === 'j7') {
    subject = 'Votre devis moteur — je peux reconfirmer la dispo';
    heroLine = 'Je voulais m\'assurer que mon devis vous est bien parvenu il y a une semaine.';
    ctaLine = 'Comme un devis n\'est garanti que 24h (le moteur peut partir et les prix bougent), dites-moi si vous êtes toujours intéressé : je reconfirme la disponibilité et le prix pour vous.';
  } else {
    subject = 'On reste dispo pour votre devis moteur';
    heroLine = 'Je voulais m\'assurer que mon devis vous est bien parvenu il y a quelques jours.';
    ctaLine = 'Si vous avez la moindre question, n\'hésitez pas — je suis là pour ça. Et si vous voulez avancer, je reconfirme la disponibilité du moteur et le prix du jour.';
  }

  // CTA : "Revoir mon devis" (lien tracké → PDF) + "Réserver" si lien Mollie.
  const ctaBlock = (opts.pdfUrl || opts.mollieUrl) ? `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:4px 0 22px;">
      <tr>
        ${opts.pdfUrl ? `<td style="border-radius:8px;background:${RED};"><a href="${escapeHtml(opts.pdfUrl)}" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:700;color:#ffffff;text-decoration:none;border-radius:8px;">Revoir mon devis</a></td>` : ''}
        ${opts.mollieUrl ? `<td style="padding-left:10px;"><a href="${escapeHtml(opts.mollieUrl)}" style="display:inline-block;padding:12px 22px;font-size:14px;font-weight:700;color:${RED};text-decoration:none;border:2px solid ${RED};border-radius:8px;">Réserver le moteur</a></td>` : ''}
      </tr>
    </table>` : '';

  return `<!DOCTYPE html>
<html lang="fr"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${subject}</title>
</head>
<body style="margin:0;padding:0;background:#f4f5f7;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;color:#1f2937;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4f5f7;padding:32px 12px;">
<tr><td align="center">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="600" style="max-width:600px;width:100%;background:#fff;border-radius:14px;overflow:hidden;border:1px solid #e5e7eb;">
  <tr><td style="padding:24px 32px;border-bottom:1px solid #f1f2f4;"><img src="${LOGO_URL}" alt="Autoliva" width="140" style="display:block;border:0;height:auto;width:140px;"></td></tr>
  <tr><td style="padding:32px 32px 16px;">
    <h1 style="margin:0 0 16px;font-size:22px;line-height:1.3;font-weight:700;color:#0f172a;">${greeting}</h1>
    <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.6;">${heroLine}</p>
    <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.6;">Pour rappel, voici votre dossier :</p>
    <div style="background:#fafbfc;border:1px solid #eef0f3;border-radius:10px;padding:16px;margin-bottom:16px;">
      <p style="margin:0 0 6px;font-size:13px;color:#64748b;">Référence : <strong style="color:#0f172a;font-family:'SF Mono',monospace;">${escapeHtml(opts.quoteRef)}</strong></p>
      <p style="margin:0 0 6px;font-size:13px;color:#64748b;">Véhicule : <strong style="color:#0f172a;">${escapeHtml(opts.plate || '—')}</strong></p>
      <p style="margin:0;font-size:13px;color:#64748b;">Total TTC : <strong style="color:${RED};font-family:'SF Mono',monospace;">${fmtEur(opts.sellTtc)}</strong></p>
    </div>
    <p style="margin:0 0 16px;font-size:15px;color:#374151;line-height:1.6;">${ctaLine}</p>
    ${ctaBlock}
    <p style="margin:0 0 8px;font-size:14px;color:#1f2937;line-height:1.6;">Bonne journée,<br><strong>L'équipe Autoliva</strong></p>
  </td></tr>
  <tr><td style="padding:0 32px 24px;">
    <p style="margin:0;font-size:11px;color:#94a3b8;line-height:1.5;"><a href="mailto:contact@autoliva.com" style="color:#94a3b8;">contact@autoliva.com</a> · <a href="tel:${escapeHtml(opts.brandPhoneIntl || '+33465848539')}" style="color:#94a3b8;text-decoration:none;">${escapeHtml(opts.brandPhone || '04 65 84 85 39')}</a></p>
  </td></tr>
</table>
</td></tr>
</table>
</body></html>`;
}

module.exports = { buildQuoteEmailHtml, buildReminderEmailHtml };
