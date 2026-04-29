const brand = require('../config/brand');

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatEuro(totalCents) {
  if (!Number.isFinite(totalCents)) return '—';
  return `${(totalCents / 100).toFixed(2).replace('.', ',')} €`;
}

function formatDateFR(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
}

function formatShippingMethod(method) {
  const key = getTrimmedString(method);
  if (key === 'domicile') return 'Livraison à domicile';
  if (key === 'relais') return 'Point relais';
  if (key === 'magasin') return 'Retrait magasin';
  return key ? `Livraison (${key})` : 'Livraison';
}

function computeOrderTotals(order) {
  const shippingCostCents = order && Number.isFinite(order.shippingCostCents) ? order.shippingCostCents : 0;

  const fallbackItemsSubtotalCents = Array.isArray(order && order.items)
    ? order.items.reduce((sum, it) => {
        if (!it || !Number.isFinite(it.lineTotalCents)) return sum;
        return sum + it.lineTotalCents;
      }, 0)
    : 0;

  const itemsSubtotalCents = order && Number.isFinite(order.itemsSubtotalCents)
    ? order.itemsSubtotalCents
    : fallbackItemsSubtotalCents;

  const clientDiscountCents = order && Number.isFinite(order.clientDiscountCents) ? order.clientDiscountCents : 0;
  const promoDiscountCents = order && Number.isFinite(order.promoDiscountCents) ? order.promoDiscountCents : 0;

  const itemsTotalAfterDiscountCents = order && Number.isFinite(order.itemsTotalAfterDiscountCents)
    ? order.itemsTotalAfterDiscountCents
    : Math.max(0, itemsSubtotalCents - clientDiscountCents - promoDiscountCents);

  const totalCents = order && Number.isFinite(order.totalCents)
    ? order.totalCents
    : itemsTotalAfterDiscountCents + shippingCostCents;

  const htCents = Math.round(totalCents / 1.2);
  const vatCents = totalCents - htCents;

  return {
    shippingCostCents,
    itemsSubtotalCents,
    clientDiscountCents,
    promoDiscountCents,
    itemsTotalAfterDiscountCents,
    totalCents,
    htCents,
    vatCents,
  };
}

function renderAddressBlock(title, address) {
  if (!address) {
    return `<div style="padding:12px 14px;border:1px solid #e5e7eb;background:#ffffff;border-radius:14px;">
      <div style="font-weight:900;color:#0f172a;">${escapeHtml(title)}</div>
      <div style="margin-top:6px;font-size:13px;color:#64748b;">Non renseignée</div>
    </div>`;
  }

  const lines = [
    address.fullName,
    address.line1,
    address.line2,
    `${getTrimmedString(address.postalCode)} ${getTrimmedString(address.city)}`.trim(),
    address.country,
  ].filter((v) => getTrimmedString(v));

  const phone = getTrimmedString(address.phone);

  return `<div style="padding:12px 14px;border:1px solid #e5e7eb;background:#ffffff;border-radius:14px;">
    <div style="font-weight:900;color:#0f172a;">${escapeHtml(title)}</div>
    <div style="margin-top:8px;font-size:13px;color:#334155;line-height:1.5;white-space:pre-line;">${escapeHtml(lines.join('\n'))}</div>
    ${phone ? `<div style="margin-top:6px;font-size:12px;color:#64748b;">Téléphone : <strong style="color:#0f172a;">${escapeHtml(phone)}</strong></div>` : ''}
  </div>`;
}

function renderEmailLayout({ title, preheader, bodyHtml, baseUrl } = {}) {
  const safeTitle = escapeHtml(getTrimmedString(title) || brand.NAME);
  const safePreheader = escapeHtml(getTrimmedString(preheader) || '');
  const safeBody = String(bodyHtml || '');
  const safeBaseUrl = getTrimmedString(baseUrl);

  const brandUrl = safeBaseUrl || '';
  const logoUrl = brand.SITE_URL + brand.LOGO_URL;

  return `<!doctype html>
<html lang="fr">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<meta name="x-apple-disable-message-reformatting" />
<title>${safeTitle}</title>
</head>
<body style="margin:0;padding:0;background:#f6f7fb;font-family:Inter,Arial,sans-serif;color:#0f172a;">
  <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${safePreheader}</div>
  <table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="background:#f6f7fb;">
    <tr>
      <td align="center" style="padding:24px 12px;">
        <table role="presentation" cellpadding="0" cellspacing="0" width="600" style="width:600px;max-width:600px;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 12px 30px rgba(15,23,42,0.08);">
          <tr>
            <td align="center" style="padding:24px 24px 16px;border-bottom:1px solid #e5e7eb;">
              <img src="${escapeHtml(logoUrl)}" alt="${escapeHtml(brand.NAME)}" height="40" style="display:block;height:40px;width:auto;margin:0 auto;border:0;outline:none;text-decoration:none;" />
              <div style="margin-top:10px;font-size:12px;font-weight:600;color:#64748b;">Pièces auto • Catalogue • Devis</div>
            </td>
          </tr>
          <tr>
            <td style="padding:22px 24px;">
              ${safeBody}
            </td>
          </tr>
          <tr>
            <td style="padding:18px 24px;border-top:1px solid #e5e7eb;background:#ffffff;">
              <div style="font-size:12px;color:#64748b;line-height:1.5;">
                <div>Besoin d’aide ? Réponds directement à cet email.</div>
                ${brandUrl ? `<div style="margin-top:8px;"><a href="${escapeHtml(brandUrl)}" style="color:#ec1313;text-decoration:none;font-weight:700;">${escapeHtml(brandUrl.replace(/^https?:\/\//, ''))}</a></div>` : ''}
              </div>
            </td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
}

function renderPrimaryButton({ href, label } = {}) {
  const url = getTrimmedString(href);
  const text = getTrimmedString(label) || 'Voir';
  if (!url) return '';

  return `
<table role="presentation" cellpadding="0" cellspacing="0" style="margin:18px 0 0;">
  <tr>
    <td bgcolor="#ec1313" style="border-radius:12px;">
      <a href="${escapeHtml(url)}" style="display:inline-block;padding:12px 16px;color:#ffffff;text-decoration:none;font-weight:800;font-size:14px;border-radius:12px;">${escapeHtml(text)}</a>
    </td>
  </tr>
</table>`;
}

function buildOrderConfirmationEmail({ order, user, baseUrl, meta } = {}) {
  const number = order && order.number ? String(order.number) : '';
  const orderId = order && order._id ? String(order._id) : '';
  const items = order && Array.isArray(order.items) ? order.items : [];
  const totals = computeOrderTotals(order);

  const firstName = user && user.firstName ? String(user.firstName).trim() : '';
  const greetingName = firstName ? escapeHtml(firstName) : 'Bonjour';

  const createdAtLabel = order && order.createdAt ? formatDateFR(order.createdAt) : '';
  const shippingMethodLabel = formatShippingMethod(order && order.shippingMethod ? order.shippingMethod : '');

  const legalBase = baseUrl ? String(baseUrl).replace(/\/$/, '') : '';
  const cgvUrl = legalBase ? `${legalBase}/legal/cgv` : '';

  const shippingAddressHtml = renderAddressBlock('Adresse de livraison', order && order.shippingAddress ? order.shippingAddress : null);
  const billingAddressHtml = renderAddressBlock('Adresse de facturation', order && order.billingAddress ? order.billingAddress : null);

  const linesHtml = items
    .map((it) => {
      if (!it) return '';
      const name = it.name ? escapeHtml(it.name) : 'Article';
      const qty = Number.isFinite(it.quantity) ? it.quantity : 1;
      const sku = it.sku ? escapeHtml(it.sku) : '';
      const unitTtc = Number.isFinite(it.unitPriceCents) ? it.unitPriceCents : null;
      const unitHt = unitTtc !== null ? Math.round(unitTtc / 1.2) : null;
      const lineTotal = Number.isFinite(it.lineTotalCents) ? formatEuro(it.lineTotalCents) : '—';

      const imageUrl = it.imageUrl ? getTrimmedString(it.imageUrl) : '';
      const imageCell = imageUrl
        ? `<img src="${escapeHtml(imageUrl)}" alt="${name}" width="56" height="56" style="display:block;width:56px;height:56px;object-fit:cover;border-radius:12px;" />`
        : `<div style="width:56px;height:56px;border-radius:12px;background:#f1f5f9;"></div>`;

      const unitLine = unitTtc !== null
        ? `<div style="font-size:12px;color:#64748b;margin-top:4px;">PU TTC : <strong style="color:#0f172a;">${escapeHtml(formatEuro(unitTtc))}</strong>${unitHt !== null ? ` • PU HT : <strong style="color:#0f172a;">${escapeHtml(formatEuro(unitHt))}</strong>` : ''}</div>`
        : '';

      return `<tr>
        <td style="padding:12px 0;border-bottom:1px solid #f1f5f9;vertical-align:top;width:64px;">
          ${imageCell}
        </td>
        <td style="padding:12px 0;border-bottom:1px solid #f1f5f9;vertical-align:top;">
          <div style="font-weight:900;color:#0f172a;">${name}</div>
          ${sku ? `<div style="font-size:12px;color:#64748b;margin-top:2px;">Réf : <strong style="color:#0f172a;">${sku}</strong></div>` : ''}
          <div style="font-size:12px;color:#64748b;margin-top:2px;">Quantité : <strong style="color:#0f172a;">${escapeHtml(qty)}</strong></div>
          ${unitLine}
        </td>
        <td align="right" style="padding:12px 0;border-bottom:1px solid #f1f5f9;font-weight:900;white-space:nowrap;vertical-align:top;">${escapeHtml(lineTotal)}</td>
      </tr>`;
    })
    .join('');

  const orderUrl = baseUrl && orderId ? `${baseUrl.replace(/\/$/, '')}/compte/commandes/${encodeURIComponent(orderId)}` : '';

  const hasAnyDiscount = totals.clientDiscountCents > 0 || totals.promoDiscountCents > 0;
  const promoCode = order && typeof order.promoCode === 'string' ? order.promoCode.trim() : '';

  const hasInvoice = meta && meta.hasInvoice === true;
  const hasCgv = meta && meta.hasCgv === true;
  const attachmentsInfo = hasInvoice || hasCgv
    ? `<div style="margin-top:12px;padding:12px 14px;border:1px solid #dcfce7;background:#f0fdf4;border-radius:14px;color:#14532d;font-size:13px;line-height:1.6;">
        <div style="font-weight:900;">Pièces jointes</div>
        <div style="margin-top:6px;">${[
          hasInvoice ? 'Facture PDF' : '',
          hasCgv ? 'CGV (PDF)' : '',
        ].filter(Boolean).map((s) => `• ${escapeHtml(s)}`).join('<br/>')}</div>
      </div>`
    : '';

  const bodyHtml = `
<div style="font-size:16px;font-weight:900;">${greetingName},</div>
<div style="margin-top:10px;font-size:14px;line-height:1.6;color:#334155;">
  Nous confirmons la commande${number ? ` <strong>#${escapeHtml(number)}</strong>` : ''}${createdAtLabel ? ` du <strong>${escapeHtml(createdAtLabel)}</strong>` : ''}.
</div>

${attachmentsInfo}

<div style="margin-top:18px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;">Livraison & facturation</div>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:10px;">
  <tr>
    <td style="width:50%;padding-right:6px;vertical-align:top;">${shippingAddressHtml}</td>
    <td style="width:50%;padding-left:6px;vertical-align:top;">${billingAddressHtml}</td>
  </tr>
</table>

<div style="margin-top:18px;padding:12px 14px;border:1px solid #e5e7eb;background:#f8fafc;border-radius:14px;color:#0f172a;font-size:13px;line-height:1.6;">
  <div style="font-weight:900;">Mode de livraison : ${escapeHtml(shippingMethodLabel)}</div>
</div>

<div style="margin-top:18px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;">Articles</div>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:10px;">
  ${linesHtml || ''}
</table>

<div style="margin-top:18px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;">Récapitulatif</div>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:10px;">
  <tr>
    <td style="padding:6px 0;color:#64748b;">Sous-total articles</td>
    <td align="right" style="padding:6px 0;font-weight:900;white-space:nowrap;">${escapeHtml(formatEuro(totals.itemsSubtotalCents))}</td>
  </tr>
  ${totals.clientDiscountCents > 0 ? `<tr>
    <td style="padding:6px 0;color:#64748b;">Remise compte${order && Number.isFinite(order.clientDiscountPercent) && order.clientDiscountPercent > 0 ? ` (${escapeHtml(String(order.clientDiscountPercent).replace('.', ','))}%)` : ''}</td>
    <td align="right" style="padding:6px 0;font-weight:900;white-space:nowrap;">- ${escapeHtml(formatEuro(totals.clientDiscountCents))}</td>
  </tr>` : ''}
  ${totals.promoDiscountCents > 0 ? `<tr>
    <td style="padding:6px 0;color:#64748b;">Code promo${promoCode ? ` (${escapeHtml(promoCode)})` : ''}</td>
    <td align="right" style="padding:6px 0;font-weight:900;white-space:nowrap;">- ${escapeHtml(formatEuro(totals.promoDiscountCents))}</td>
  </tr>` : ''}
  ${hasAnyDiscount ? `<tr>
    <td style="padding:6px 0;color:#64748b;">Sous-total après remise</td>
    <td align="right" style="padding:6px 0;font-weight:900;white-space:nowrap;">${escapeHtml(formatEuro(totals.itemsTotalAfterDiscountCents))}</td>
  </tr>` : ''}
  <tr>
    <td style="padding:6px 0;color:#64748b;">Livraison</td>
    <td align="right" style="padding:6px 0;font-weight:900;white-space:nowrap;">${totals.shippingCostCents === 0 ? 'OFFERT' : escapeHtml(formatEuro(totals.shippingCostCents))}</td>
  </tr>
  <tr>
    <td style="padding:10px 0;font-weight:900;border-top:1px solid #e5e7eb;">Total TTC</td>
    <td align="right" style="padding:10px 0;font-weight:900;white-space:nowrap;border-top:1px solid #e5e7eb;">${escapeHtml(formatEuro(totals.totalCents))}</td>
  </tr>
  <tr>
    <td style="padding:6px 0;color:#64748b;">Total HT</td>
    <td align="right" style="padding:6px 0;font-weight:900;white-space:nowrap;">${escapeHtml(formatEuro(totals.htCents))}</td>
  </tr>
  <tr>
    <td style="padding:6px 0;color:#64748b;">TVA (20%)</td>
    <td align="right" style="padding:6px 0;font-weight:900;white-space:nowrap;">${escapeHtml(formatEuro(totals.vatCents))}</td>
  </tr>
</table>

${order && order.orderType === 'exchange_cloning' ? `
<div style="margin-top:18px;padding:16px;border:2px solid #ddd6fe;background:#f5f3ff;border-radius:14px;">
  <div style="font-weight:900;color:#4c1d95;font-size:14px;margin-bottom:10px;">🔬 Service clonage 1:1 inclus</div>
  <div style="font-size:13px;line-height:1.8;color:#334155;">
    Votre commande inclut le <strong>clonage des données</strong> de votre ancienne mécatronique. Voici comment ça se passe :
  </div>
  <table role="presentation" cellpadding="0" cellspacing="0" style="margin-top:10px;font-size:13px;line-height:1.8;color:#334155;">
    <tr><td style="padding:4px 8px 4px 0;font-weight:bold;vertical-align:top;color:#7c3aed;">①</td><td>Vous recevrez une <strong>étiquette UPS</strong> pour nous envoyer votre ancienne pièce</td></tr>
    <tr><td style="padding:4px 8px 4px 0;font-weight:bold;vertical-align:top;color:#7c3aed;">②</td><td>Nos techniciens <strong>clonent les données</strong> sur votre nouvelle pièce (2-5 jours)</td></tr>
    <tr><td style="padding:4px 8px 4px 0;font-weight:bold;vertical-align:top;color:#7c3aed;">③</td><td>Votre <strong>pièce programmée est expédiée</strong> chez vous</td></tr>
  </table>
  <div style="margin-top:10px;font-size:12px;color:#64748b;">Vous serez notifié par email à chaque étape.</div>
</div>` : ''}

${renderPrimaryButton({ href: orderUrl, label: 'Voir ma commande' })}

${cgvUrl ? `<div style="margin-top:14px;font-size:12px;line-height:1.6;color:#64748b;"><a href="${escapeHtml(cgvUrl)}" style="color:#ec1313;text-decoration:none;font-weight:800;">Consulter nos conditions générales de vente</a></div>` : ''}

<div style="margin-top:16px;font-size:12px;line-height:1.6;color:#64748b;">
  Si vous avez une question, répondez directement à cet email.
</div>`;

  const subject = number ? `Confirmation de commande #${number}` : 'Confirmation de commande';

  return {
    subject,
    html: renderEmailLayout({
      title: subject,
      preheader: number ? `Commande #${number} confirmée` : 'Commande confirmée',
      bodyHtml,
      baseUrl,
    }),
    text: `${firstName ? `${firstName}, ` : ''}commande confirmée${number ? ` (#${number})` : ''}. Total TTC : ${formatEuro(totals.totalCents)}. Total HT : ${formatEuro(totals.htCents)}.`,
  };
}

function buildConsigneStartEmail({ order, user, baseUrl } = {}) {
  const number = order && order.number ? String(order.number) : '';
  const orderId = order && order._id ? String(order._id) : '';

  const lines = order && order.consigne && Array.isArray(order.consigne.lines) ? order.consigne.lines : [];
  const relevant = lines.filter((l) => l && !l.receivedAt);
  if (!relevant.length) {
    return null;
  }

  const orderUrl = baseUrl && orderId ? `${baseUrl.replace(/\/$/, '')}/compte/commandes/${encodeURIComponent(orderId)}` : '';

  const rows = relevant
    .map((l) => {
      const name = l.name ? escapeHtml(l.name) : 'Pièce';
      const qty = Number.isFinite(l.quantity) ? l.quantity : 1;
      const amountUnit = Number.isFinite(l.amountCents) ? formatEuro(l.amountCents) : '—';
      const amountTotal = Number.isFinite(l.amountCents) && Number.isFinite(l.quantity)
        ? formatEuro(l.amountCents * l.quantity)
        : '—';
      const dueAt = l.dueAt ? formatDateFR(l.dueAt) : '—';

      return `<tr>
        <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;">
          <div style="font-weight:900;color:#0f172a;">${name}</div>
          <div style="font-size:12px;color:#64748b;margin-top:2px;">Quantité : ${escapeHtml(qty)} • Consigne : ${escapeHtml(amountUnit)} / pièce</div>
          <div style="font-size:12px;color:#64748b;margin-top:2px;">À retourner avant le : <strong>${escapeHtml(dueAt)}</strong></div>
        </td>
        <td align="right" style="padding:10px 0;border-bottom:1px solid #f1f5f9;font-weight:900;white-space:nowrap;">${escapeHtml(amountTotal)}</td>
      </tr>`;
    })
    .join('');

  const totalDueCents = relevant.reduce((sum, l) => {
    const qty = Number.isFinite(l && l.quantity) ? l.quantity : 0;
    const amt = Number.isFinite(l && l.amountCents) ? l.amountCents : 0;
    return sum + qty * amt;
  }, 0);

  const subject = number ? `Consigne : retour de l'ancienne pièce (commande #${number})` : "Consigne : retour de l'ancienne pièce";

  const bodyHtml = `
<div style="font-size:16px;font-weight:900;">Information consigne</div>
<div style="margin-top:10px;font-size:14px;line-height:1.6;color:#334155;">
  Votre commande${number ? ` <strong>#${escapeHtml(number)}</strong>` : ''} est indiquée comme <strong>livrée</strong>.
  À partir de maintenant, vous disposez d’un délai pour nous retourner votre ancienne pièce.
</div>

<div style="margin-top:12px;padding:12px 14px;border:1px solid #fee2e2;background:#fff1f2;border-radius:14px;color:#881337;font-size:13px;line-height:1.6;">
  La consigne <strong>n’est pas encaissée</strong> à l’achat.
  Par contre, si l’ancienne pièce n’est pas retournée à temps, le montant de consigne devient dû.
</div>

<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:16px;">
  ${rows}
  <tr>
    <td style="padding:12px 0;font-weight:900;">Total consigne (si non retournée à temps)</td>
    <td align="right" style="padding:12px 0;font-weight:900;white-space:nowrap;">${escapeHtml(formatEuro(totalDueCents))}</td>
  </tr>
</table>

${renderPrimaryButton({ href: orderUrl, label: 'Voir le détail de ma consigne' })}

<div style="margin-top:16px;font-size:12px;line-height:1.6;color:#64748b;">
  Si vous avez déjà renvoyé la pièce, vous pouvez ignorer ce message.
</div>`;

  return {
    subject,
    html: renderEmailLayout({
      title: subject,
      preheader: 'Consigne : pensez à retourner votre ancienne pièce',
      bodyHtml,
      baseUrl,
    }),
    text: `Consigne : pensez à retourner votre ancienne pièce. Total consigne (si non retournée à temps) : ${formatEuro(totalDueCents)}.`,
  };
}

function buildConsigneReceivedEmail({ order, user, baseUrl } = {}) {
  const number = order && order.number ? String(order.number) : '';
  const orderId = order && order._id ? String(order._id) : '';

  const subject = number ? `Consigne reçue - commande #${number}` : 'Consigne reçue';
  const orderUrl = baseUrl && orderId ? `${baseUrl.replace(/\/$/, '')}/compte/commandes/${encodeURIComponent(orderId)}` : '';

  const bodyHtml = `
<div style="font-size:16px;font-weight:900;">Merci !</div>
<div style="margin-top:10px;font-size:14px;line-height:1.6;color:#334155;">
  Nous confirmons avoir reçu votre ancienne pièce (consigne) pour la commande${number ? ` <strong>#${escapeHtml(number)}</strong>` : ''}.
</div>

<div style="margin-top:12px;padding:12px 14px;border:1px solid #dcfce7;background:#f0fdf4;border-radius:14px;color:#14532d;font-size:13px;line-height:1.6;">
  Votre consigne est maintenant considérée comme <strong>régularisée</strong>.
</div>

${renderPrimaryButton({ href: orderUrl, label: 'Voir ma commande' })}`;

  return {
    subject,
    html: renderEmailLayout({
      title: subject,
      preheader: 'Consigne reçue',
      bodyHtml,
      baseUrl,
    }),
    text: `Nous confirmons avoir reçu votre consigne pour la commande${number ? ` #${number}` : ''}.`,
  };
}

function buildShipmentTrackingEmail({ order, user, shipment, baseUrl, meta } = {}) {
  const number = order && order.number ? String(order.number) : '';
  const orderId = order && order._id ? String(order._id) : '';
  const firstName = user && user.firstName ? String(user.firstName).trim() : '';

  const totals = computeOrderTotals(order);
  const items = order && Array.isArray(order.items) ? order.items : [];

  const carrier = shipment && shipment.carrier ? String(shipment.carrier).trim() : '';
  const trackingNumber = shipment && shipment.trackingNumber ? String(shipment.trackingNumber).trim() : '';
  const label = shipment && shipment.label ? String(shipment.label).trim() : '';

  const subject = number ? `Commande #${number} expédiée` : 'Commande expédiée';
  const orderUrl = baseUrl && orderId ? `${baseUrl.replace(/\/$/, '')}/compte/commandes/${encodeURIComponent(orderId)}` : '';

  const legalBase = baseUrl ? String(baseUrl).replace(/\/$/, '') : '';
  const cgvUrl = legalBase ? `${legalBase}/legal/cgv` : '';

  const recapRows = items
    .slice(0, 6)
    .map((it) => {
      if (!it) return '';
      const name = it.name ? escapeHtml(it.name) : 'Article';
      const qty = Number.isFinite(it.quantity) ? it.quantity : 1;
      const imageUrl = it.imageUrl ? getTrimmedString(it.imageUrl) : '';
      const imageCell = imageUrl
        ? `<img src="${escapeHtml(imageUrl)}" alt="${name}" width="44" height="44" style="display:block;width:44px;height:44px;object-fit:cover;border-radius:12px;" />`
        : `<div style="width:44px;height:44px;border-radius:12px;background:#f1f5f9;"></div>`;

      return `<tr>
        <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;vertical-align:top;width:52px;">${imageCell}</td>
        <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;vertical-align:top;">
          <div style="font-weight:900;color:#0f172a;">${name}</div>
          <div style="font-size:12px;color:#64748b;margin-top:2px;">Quantité : <strong style="color:#0f172a;">${escapeHtml(qty)}</strong></div>
        </td>
      </tr>`;
    })
    .join('');

  const moreCount = items.length > 6 ? items.length - 6 : 0;

  const hasInvoice = meta && meta.hasInvoice === true;
  const hasCgv = meta && meta.hasCgv === true;
  const attachmentsInfo = hasInvoice || hasCgv
    ? `<div style="margin-top:14px;padding:12px 14px;border:1px solid #dcfce7;background:#f0fdf4;border-radius:14px;color:#14532d;font-size:13px;line-height:1.6;">
        <div style="font-weight:900;">Pièces jointes</div>
        <div style="margin-top:6px;">${[
          hasInvoice ? 'Facture PDF' : '',
          hasCgv ? 'CGV (PDF)' : '',
        ].filter(Boolean).map((s) => `• ${escapeHtml(s)}`).join('<br/>')}</div>
      </div>`
    : '';

  const bodyHtml = `
<div style="font-size:16px;font-weight:900;">${firstName ? `${escapeHtml(firstName)}, ` : ''}votre commande est expédiée</div>
<div style="margin-top:10px;font-size:14px;line-height:1.6;color:#334155;">
  ${number ? `Commande <strong>#${escapeHtml(number)}</strong>. ` : ''}Vous pouvez suivre l’acheminement avec le numéro ci-dessous.
</div>

<div style="margin-top:14px;padding:12px 14px;border:1px solid #e5e7eb;background:#f8fafc;border-radius:14px;color:#0f172a;font-size:13px;line-height:1.6;">
  ${label ? `<div style="font-weight:800;margin-bottom:6px;">${escapeHtml(label)}</div>` : ''}
  ${carrier ? `<div>Transporteur : <strong>${escapeHtml(carrier)}</strong></div>` : ''}
  ${trackingNumber ? `<div>Numéro de suivi : <strong>${escapeHtml(trackingNumber)}</strong></div>` : ''}
</div>

${attachmentsInfo}

<div style="margin-top:18px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;">Récapitulatif commande</div>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:10px;">
  ${recapRows}
</table>
${moreCount ? `<div style="margin-top:10px;font-size:12px;color:#64748b;">+ ${escapeHtml(moreCount)} autre(s) article(s) dans la commande.</div>` : ''}

<div style="margin-top:12px;padding:12px 14px;border:1px solid #e5e7eb;background:#f8fafc;border-radius:14px;color:#0f172a;font-size:13px;line-height:1.6;">
  <div style="display:flex;justify-content:space-between;gap:10px;">
    <div style="font-weight:900;">Total TTC</div>
    <div style="font-weight:900;white-space:nowrap;">${escapeHtml(formatEuro(totals.totalCents))}</div>
  </div>
</div>

${renderPrimaryButton({ href: orderUrl, label: 'Voir ma commande' })}

${cgvUrl ? `<div style="margin-top:14px;font-size:12px;line-height:1.6;color:#64748b;"><a href="${escapeHtml(cgvUrl)}" style="color:#ec1313;text-decoration:none;font-weight:800;">Consulter nos conditions générales de vente</a></div>` : ''}

<div style="margin-top:14px;font-size:12px;line-height:1.6;color:#64748b;">
  Si le suivi met quelques heures à apparaître, c’est normal.
</div>`;

  const text = `Commande expédiée${number ? ` (#${number})` : ''}. ${carrier ? `Transporteur: ${carrier}. ` : ''}${trackingNumber ? `Suivi: ${trackingNumber}. ` : ''}`;

  return {
    subject,
    html: renderEmailLayout({
      title: subject,
      preheader: 'Votre colis est en route',
      bodyHtml,
      baseUrl,
    }),
    text,
  };
}

function buildConsigneReminderSoonEmail({ order, user, baseUrl } = {}) {
  const number = order && order.number ? String(order.number) : '';
  const orderId = order && order._id ? String(order._id) : '';
  const firstName = user && user.firstName ? String(user.firstName).trim() : '';

  const lines = order && order.consigne && Array.isArray(order.consigne.lines) ? order.consigne.lines : [];
  const pending = lines.filter((l) => l && !l.receivedAt && l.dueAt);
  if (!pending.length) return null;

  const soonRows = pending
    .map((l) => {
      const name = l.name ? escapeHtml(l.name) : 'Pièce';
      const qty = Number.isFinite(l.quantity) ? l.quantity : 1;
      const dueAt = l.dueAt ? formatDateFR(l.dueAt) : '—';
      return `<tr>
        <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;">
          <div style="font-weight:900;color:#0f172a;">${name}</div>
          <div style="font-size:12px;color:#64748b;margin-top:2px;">Quantité : ${escapeHtml(qty)} • Date limite : <strong>${escapeHtml(dueAt)}</strong></div>
        </td>
      </tr>`;
    })
    .join('');

  const orderUrl = baseUrl && orderId ? `${baseUrl.replace(/\/$/, '')}/compte/commandes/${encodeURIComponent(orderId)}` : '';
  const subject = number
    ? `Rappel consigne : retour à prévoir (commande #${number})`
    : 'Rappel consigne : retour à prévoir';

  const bodyHtml = `
<div style="font-size:16px;font-weight:900;">${firstName ? `${escapeHtml(firstName)}, ` : ''}rappel consigne</div>
<div style="margin-top:10px;font-size:14px;line-height:1.6;color:#334155;">
  Il vous reste peu de temps pour nous retourner votre ancienne pièce.
</div>

<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:16px;">
  ${soonRows}
</table>

${renderPrimaryButton({ href: orderUrl, label: 'Voir le détail de ma consigne' })}

<div style="margin-top:12px;font-size:12px;line-height:1.6;color:#64748b;">
  La consigne n’est pas encaissée à l’achat, mais elle devient due si la pièce n’est pas retournée à temps.
</div>`;

  return {
    subject,
    html: renderEmailLayout({
      title: subject,
      preheader: 'Rappel consigne',
      bodyHtml,
      baseUrl,
    }),
    text: 'Rappel consigne : pensez à retourner votre ancienne pièce avant la date limite.',
  };
}

function buildConsigneOverdueEmail({ order, user, baseUrl } = {}) {
  const number = order && order.number ? String(order.number) : '';
  const orderId = order && order._id ? String(order._id) : '';
  const firstName = user && user.firstName ? String(user.firstName).trim() : '';

  const lines = order && order.consigne && Array.isArray(order.consigne.lines) ? order.consigne.lines : [];
  const pending = lines.filter((l) => l && !l.receivedAt && l.dueAt);
  if (!pending.length) return null;

  const overdueRows = pending
    .map((l) => {
      const name = l.name ? escapeHtml(l.name) : 'Pièce';
      const qty = Number.isFinite(l.quantity) ? l.quantity : 1;
      const dueAt = l.dueAt ? formatDateFR(l.dueAt) : '—';
      const amountTotal = Number.isFinite(l.amountCents) && Number.isFinite(l.quantity)
        ? formatEuro(l.amountCents * l.quantity)
        : '—';
      return `<tr>
        <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;">
          <div style="font-weight:900;color:#0f172a;">${name}</div>
          <div style="font-size:12px;color:#64748b;margin-top:2px;">Quantité : ${escapeHtml(qty)} • Date limite dépassée : <strong>${escapeHtml(dueAt)}</strong></div>
        </td>
        <td align="right" style="padding:10px 0;border-bottom:1px solid #f1f5f9;font-weight:900;white-space:nowrap;">${escapeHtml(amountTotal)}</td>
      </tr>`;
    })
    .join('');

  const totalDueCents = pending.reduce((sum, l) => {
    const qty = Number.isFinite(l && l.quantity) ? l.quantity : 0;
    const amt = Number.isFinite(l && l.amountCents) ? l.amountCents : 0;
    return sum + qty * amt;
  }, 0);

  const orderUrl = baseUrl && orderId ? `${baseUrl.replace(/\/$/, '')}/compte/commandes/${encodeURIComponent(orderId)}` : '';
  const subject = number
    ? `Consigne en retard : action requise (commande #${number})`
    : 'Consigne en retard : action requise';

  const bodyHtml = `
<div style="font-size:16px;font-weight:900;">${firstName ? `${escapeHtml(firstName)}, ` : ''}consigne en retard</div>
<div style="margin-top:10px;font-size:14px;line-height:1.6;color:#334155;">
  Nous n’avons pas encore reçu l’ancienne pièce. La date limite est dépassée.
</div>

<div style="margin-top:12px;padding:12px 14px;border:1px solid #fee2e2;background:#fff1f2;border-radius:14px;color:#881337;font-size:13px;line-height:1.6;">
  Montant total de consigne concerné : <strong>${escapeHtml(formatEuro(totalDueCents))}</strong>.
</div>

<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:16px;">
  ${overdueRows}
</table>

${renderPrimaryButton({ href: orderUrl, label: 'Voir le détail de ma commande' })}

<div style="margin-top:12px;font-size:12px;line-height:1.6;color:#64748b;">
  Si vous avez déjà renvoyé la pièce, ce message peut se croiser avec l’acheminement.
</div>`;

  return {
    subject,
    html: renderEmailLayout({
      title: subject,
      preheader: 'Consigne en retard',
      bodyHtml,
      baseUrl,
    }),
    text: `Consigne en retard${number ? ` (commande #${number})` : ''}.`,
  };
}

function buildWelcomeEmail({ user, baseUrl } = {}) {
  const firstName = user && user.firstName ? String(user.firstName).trim() : '';
  const greeting = firstName ? escapeHtml(firstName) : 'Bonjour';
  const homeUrl = baseUrl ? baseUrl.replace(/\/$/, '') : '';
  const accountUrl = homeUrl ? `${homeUrl}/compte` : '';

  const subject = `Bienvenue sur ${brand.NAME}`;

  const bodyHtml = `
<div style="font-size:16px;font-weight:900;">${greeting},</div>
<div style="margin-top:10px;font-size:14px;line-height:1.6;color:#334155;">
  Votre compte est prêt. Vous pouvez maintenant commander plus rapidement et suivre vos commandes.
</div>

${renderPrimaryButton({ href: accountUrl, label: 'Accéder à mon compte' })}

<div style="margin-top:14px;font-size:12px;line-height:1.6;color:#64748b;">
  Si vous n’êtes pas à l’origine de cette inscription, vous pouvez ignorer cet email.
</div>`;

  return {
    subject,
    html: renderEmailLayout({
      title: subject,
      preheader: 'Votre compte est prêt',
      bodyHtml,
      baseUrl,
    }),
    text: `Bienvenue sur ${brand.NAME}. Votre compte est prêt.`,
  };
}

function buildGuestAccountCreatedEmail({ user, resetUrl, baseUrl } = {}) {
  const firstName = user && user.firstName ? String(user.firstName).trim() : '';
  const greeting = firstName ? escapeHtml(firstName) : 'Bonjour';

  const subject = 'Votre compte a été créé';

  const bodyHtml = `
<div style="font-size:16px;font-weight:900;">${greeting},</div>
<div style="margin-top:10px;font-size:14px;line-height:1.6;color:#334155;">
  Nous avons créé votre compte automatiquement à la suite de votre commande invité.
  Cliquez sur le bouton ci-dessous pour définir votre mot de passe et retrouver vos commandes.
</div>

${renderPrimaryButton({ href: resetUrl, label: 'Définir mon mot de passe' })}

<div style="margin-top:14px;font-size:12px;line-height:1.6;color:#64748b;">
  Si vous n’êtes pas à l’origine de cette demande, vous pouvez ignorer cet email.
</div>`;

  return {
    subject,
    html: renderEmailLayout({
      title: subject,
      preheader: 'Définissez votre mot de passe',
      bodyHtml,
      baseUrl,
    }),
    text: `Votre compte a été créé. Définissez votre mot de passe ici : ${resetUrl}`,
  };
}

function buildResetPasswordEmail({ user, resetUrl, baseUrl } = {}) {
  const firstName = user && user.firstName ? String(user.firstName).trim() : '';
  const greeting = firstName ? escapeHtml(firstName) : 'Bonjour';

  const subject = 'Réinitialisation de votre mot de passe';

  const bodyHtml = `
<div style="font-size:16px;font-weight:900;">${greeting},</div>
<div style="margin-top:10px;font-size:14px;line-height:1.6;color:#334155;">
  Vous avez demandé à réinitialiser votre mot de passe.
  Cliquez sur le bouton ci-dessous pour en choisir un nouveau.
</div>

${renderPrimaryButton({ href: resetUrl, label: 'Créer un nouveau mot de passe' })}

<div style="margin-top:14px;font-size:12px;line-height:1.6;color:#64748b;">
  Si vous n’avez rien demandé, ignorez cet email.
</div>`;

  return {
    subject,
    html: renderEmailLayout({
      title: subject,
      preheader: 'Lien de réinitialisation',
      bodyHtml,
      baseUrl,
    }),
    text: `Réinitialisez votre mot de passe : ${resetUrl}`,
  };
}

function buildNewBlogPostEmail({ post, baseUrl } = {}) {
  const title = getTrimmedString(post && post.title) || 'Nouvel article';
  const excerpt = getTrimmedString(post && post.excerpt) || '';
  const slug = getTrimmedString(post && post.slug);
  const coverImageUrl = getTrimmedString(post && post.coverImageUrl);
  const safeBaseUrl = getTrimmedString(baseUrl);
  const articleUrl = slug ? `${safeBaseUrl}/blog/${slug}` : `${safeBaseUrl}/blog`;
  const unsubscribeUrl = `${safeBaseUrl}/newsletter/desinscription`;

  const coverHtml = coverImageUrl
    ? `<div style="margin-bottom:16px;border-radius:12px;overflow:hidden;">
        <a href="${escapeHtml(articleUrl)}"><img src="${escapeHtml(coverImageUrl.startsWith('http') ? coverImageUrl : safeBaseUrl + coverImageUrl)}" alt="${escapeHtml(title)}" style="width:100%;max-width:552px;height:auto;display:block;border-radius:12px;" /></a>
      </div>`
    : '';

  const bodyHtml = `
    ${coverHtml}
    <h1 style="margin:0 0 8px;font-size:22px;font-weight:800;color:#0f172a;line-height:1.3;">${escapeHtml(title)}</h1>
    ${excerpt ? `<p style="margin:0 0 16px;font-size:14px;color:#64748b;line-height:1.6;">${escapeHtml(excerpt.length > 200 ? excerpt.slice(0, 200) + '...' : excerpt)}</p>` : ''}
    ${renderPrimaryButton({ href: articleUrl, label: 'Lire l\'article' })}
    <div style="margin-top:28px;padding-top:16px;border-top:1px solid #e5e7eb;font-size:11px;color:#94a3b8;line-height:1.5;">
      Vous recevez cet email car vous êtes inscrit à la newsletter ${brand.NAME}.<br />
      <a href="${escapeHtml(unsubscribeUrl)}" style="color:#94a3b8;text-decoration:underline;">Se désinscrire</a>
    </div>
  `;

  return {
    subject: `Nouvel article : ${title}`,
    html: renderEmailLayout({ title: `Nouvel article : ${title}`, preheader: excerpt.slice(0, 100), bodyHtml, baseUrl: safeBaseUrl }),
    text: `Nouvel article sur ${brand.NAME} : ${title}\n\n${excerpt}\n\nLire l'article : ${articleUrl}\n\nSe désinscrire : ${unsubscribeUrl}`,
  };
}

function renderCartItemRowsSimple(items) {
  if (!Array.isArray(items) || !items.length) return '';
  return items
    .map((it) => {
      if (!it) return '';
      const name = it.name ? escapeHtml(it.name) : 'Article';
      const qty = Number.isFinite(it.quantity) ? it.quantity : 1;
      const price = Number.isFinite(it.price) ? formatEuro(it.price) : '';
      return `<div style="padding:8px 0;border-bottom:1px solid #f1f5f9;font-size:14px;color:#0f172a;">
        ${name}${qty > 1 ? ` (x${escapeHtml(qty)})` : ''}${price ? ` — ${escapeHtml(price)}` : ''}
      </div>`;
    })
    .join('');
}

function buildAbandonedCartReminder1({ cart, baseUrl } = {}) {
  const firstName = cart && cart.firstName ? String(cart.firstName).trim() : '';
  const greeting = firstName ? escapeHtml(firstName) : 'Bonjour';
  const items = cart && Array.isArray(cart.items) ? cart.items : [];
  const totalAmountCents = cart && Number.isFinite(cart.totalAmountCents) ? cart.totalAmountCents : 0;
  const token = cart && cart.recoveryToken ? String(cart.recoveryToken) : '';
  const safeBaseUrl = getTrimmedString(baseUrl);
  const recoveryUrl = token && safeBaseUrl ? `${safeBaseUrl}/panier/recuperer/${encodeURIComponent(token)}` : '';
  const unsubscribeUrl = safeBaseUrl ? `${safeBaseUrl}/newsletter/desinscription` : '';

  const itemsText = renderCartItemRowsSimple(items);

  const subject = `Re: Votre commande en cours sur ${brand.NAME}`;

  const bodyHtml = `
<div style="font-size:14px;line-height:1.7;color:#334155;">
  <p>${greeting},</p>
  <p>Je me permets de revenir vers vous car j'ai vu que votre commande n'a pas \u00e9t\u00e9 finalis\u00e9e. Il y a peut-\u00eatre eu un souci technique ?</p>
  <p>Votre panier est toujours sauvegard\u00e9 :</p>
  ${itemsText}
  ${totalAmountCents > 0 ? `<p style="margin-top:8px;font-weight:700;">Total : ${escapeHtml(formatEuro(totalAmountCents))}</p>` : ''}
  <p>Vous pouvez reprendre votre commande directement ici :<br />
  <a href="${escapeHtml(recoveryUrl)}" style="color:#ec1313;">${escapeHtml(recoveryUrl)}</a></p>
  <p>Si vous avez une question sur une pi\u00e8ce ou la compatibilit\u00e9 avec votre v\u00e9hicule, r\u00e9pondez \u00e0 cet email, je vous r\u00e9ponds rapidement.</p>
  <p>Bonne journ\u00e9e,<br /><strong>L'\u00e9quipe ${brand.NAME}</strong><br />
  <span style="font-size:12px;color:#64748b;">${brand.PHONE}</span></p>
</div>
${unsubscribeUrl ? `<div style="margin-top:24px;padding-top:14px;border-top:1px solid #e5e7eb;font-size:11px;color:#94a3b8;line-height:1.5;text-align:center;">
  Vous recevez cet email suite \u00e0 un panier abandonn\u00e9 sur ${brand.NAME}.<br/>
  <a href="${escapeHtml(unsubscribeUrl)}" style="color:#94a3b8;text-decoration:underline;">Se d\u00e9sinscrire des emails marketing</a>
</div>` : ''}`;

  return {
    subject,
    unsubscribeUrl,
    html: renderEmailLayout({
      title: subject,
      preheader: '',
      bodyHtml,
      baseUrl,
    }),
    text: `${greeting},\n\nJe me permets de revenir vers vous car votre commande n'a pas \u00e9t\u00e9 finalis\u00e9e.\n\nReprenez votre commande : ${recoveryUrl}\n\nTotal : ${formatEuro(totalAmountCents)}\n\nL'\u00e9quipe ${brand.NAME}\n${brand.PHONE}${unsubscribeUrl ? `\n\nSe d\u00e9sinscrire : ${unsubscribeUrl}` : ''}`,
  };
}

function buildAbandonedCartReminder2({ cart, baseUrl } = {}) {
  const firstName = cart && cart.firstName ? String(cart.firstName).trim() : '';
  const greeting = firstName ? escapeHtml(firstName) : 'Bonjour';
  const items = cart && Array.isArray(cart.items) ? cart.items : [];
  const totalAmountCents = cart && Number.isFinite(cart.totalAmountCents) ? cart.totalAmountCents : 0;
  const token = cart && cart.recoveryToken ? String(cart.recoveryToken) : '';
  const safeBaseUrl = getTrimmedString(baseUrl);
  const recoveryUrl = token && safeBaseUrl ? `${safeBaseUrl}/panier/recuperer/${encodeURIComponent(token)}` : '';
  const unsubscribeUrl = safeBaseUrl ? `${safeBaseUrl}/newsletter/desinscription` : '';

  const itemsText = renderCartItemRowsSimple(items);

  const subject = `Re: Disponibilit\u00e9 de votre pi\u00e8ce`;

  const bodyHtml = `
<div style="font-size:14px;line-height:1.7;color:#334155;">
  <p>${greeting},</p>
  <p>Je voulais vous pr\u00e9venir : les pi\u00e8ces de votre panier sont des r\u00e9f\u00e9rences reconditionn\u00e9es, et nous les avons en stock en quantit\u00e9 tr\u00e8s limit\u00e9e. Je ne peux pas vous garantir qu'elles seront encore l\u00e0 dans quelques jours.</p>
  <p>Votre panier :</p>
  ${itemsText}
  ${totalAmountCents > 0 ? `<p style="margin-top:8px;font-weight:700;">Total : ${escapeHtml(formatEuro(totalAmountCents))}</p>` : ''}
  <p>Pour finaliser :<br />
  <a href="${escapeHtml(recoveryUrl)}" style="color:#ec1313;">${escapeHtml(recoveryUrl)}</a></p>
  <p>Si vous h\u00e9sitez sur la compatibilit\u00e9 ou si vous avez besoin d'un conseil, n'h\u00e9sitez pas \u00e0 me r\u00e9pondre ou \u00e0 nous appeler.</p>
  <p>Cordialement,<br /><strong>L'\u00e9quipe ${brand.NAME}</strong><br />
  <span style="font-size:12px;color:#64748b;">${brand.PHONE}</span></p>
</div>
${unsubscribeUrl ? `<div style="margin-top:24px;padding-top:14px;border-top:1px solid #e5e7eb;font-size:11px;color:#94a3b8;line-height:1.5;text-align:center;">
  Vous recevez cet email suite \u00e0 un panier abandonn\u00e9 sur ${brand.NAME}.<br/>
  <a href="${escapeHtml(unsubscribeUrl)}" style="color:#94a3b8;text-decoration:underline;">Se d\u00e9sinscrire des emails marketing</a>
</div>` : ''}`;

  return {
    subject,
    unsubscribeUrl,
    html: renderEmailLayout({
      title: subject,
      preheader: '',
      bodyHtml,
      baseUrl,
    }),
    text: `${greeting},\n\nLes pi\u00e8ces de votre panier sont en stock limit\u00e9. Je ne peux pas garantir leur disponibilit\u00e9.\n\nFinalisez votre commande : ${recoveryUrl}\n\nTotal : ${formatEuro(totalAmountCents)}\n\nL'\u00e9quipe ${brand.NAME}\n${brand.PHONE}${unsubscribeUrl ? `\n\nSe d\u00e9sinscrire : ${unsubscribeUrl}` : ''}`,
  };
}

function buildAbandonedCartReminder3({ cart, baseUrl, promoCode } = {}) {
  const firstName = cart && cart.firstName ? String(cart.firstName).trim() : '';
  const greeting = firstName ? escapeHtml(firstName) : 'Bonjour';
  const items = cart && Array.isArray(cart.items) ? cart.items : [];
  const totalAmountCents = cart && Number.isFinite(cart.totalAmountCents) ? cart.totalAmountCents : 0;
  const token = cart && cart.recoveryToken ? String(cart.recoveryToken) : '';
  const safeBaseUrl = getTrimmedString(baseUrl);
  const recoveryUrl = token && safeBaseUrl ? `${safeBaseUrl}/panier/recuperer/${encodeURIComponent(token)}` : '';
  const unsubscribeUrl = safeBaseUrl ? `${safeBaseUrl}/newsletter/desinscription` : '';
  const safePromoCode = getTrimmedString(promoCode);

  const itemsText = renderCartItemRowsSimple(items);

  const subject = `Re: Votre panier ${brand.NAME}`;

  const promoLine = safePromoCode
    ? `<p>Pour vous remercier de votre int\u00e9r\u00eat, je vous ai g\u00e9n\u00e9r\u00e9 un code de r\u00e9duction de 5% : <strong>${escapeHtml(safePromoCode)}</strong>. Il est valable sur votre panier actuel.</p>`
    : '';

  const bodyHtml = `
<div style="font-size:14px;line-height:1.7;color:#334155;">
  <p>${greeting},</p>
  <p>Dernier message de ma part \u00e0 ce sujet. Votre panier va \u00eatre automatiquement vid\u00e9 dans les prochains jours, et les pi\u00e8ces seront remises en vente.</p>
  ${promoLine}
  <p>Pour rappel, votre panier :</p>
  ${itemsText}
  ${totalAmountCents > 0 ? `<p style="margin-top:8px;font-weight:700;">Total : ${escapeHtml(formatEuro(totalAmountCents))}</p>` : ''}
  <p>Lien direct :<br />
  <a href="${escapeHtml(recoveryUrl)}" style="color:#ec1313;">${escapeHtml(recoveryUrl)}</a></p>
  <p>Si vous avez d\u00e9cid\u00e9 de ne pas commander, pas de souci du tout. Bonne continuation !</p>
  <p>Cordialement,<br /><strong>L'\u00e9quipe ${brand.NAME}</strong><br />
  <span style="font-size:12px;color:#64748b;">${brand.PHONE}</span></p>
</div>
${unsubscribeUrl ? `<div style="margin-top:24px;padding-top:14px;border-top:1px solid #e5e7eb;font-size:11px;color:#94a3b8;line-height:1.5;text-align:center;">
  Vous recevez cet email suite \u00e0 un panier abandonn\u00e9 sur ${brand.NAME}.<br/>
  <a href="${escapeHtml(unsubscribeUrl)}" style="color:#94a3b8;text-decoration:underline;">Se d\u00e9sinscrire des emails marketing</a>
</div>` : ''}`;

  return {
    subject,
    unsubscribeUrl,
    html: renderEmailLayout({
      title: subject,
      preheader: '',
      bodyHtml,
      baseUrl,
    }),
    text: `${greeting},\n\nDernier message : votre panier va \u00eatre vid\u00e9 prochainement.${safePromoCode ? `\n\nCode promo 5% : ${safePromoCode}` : ''}\n\nLien : ${recoveryUrl}\n\nTotal : ${formatEuro(totalAmountCents)}\n\nL'\u00e9quipe ${brand.NAME}\n${brand.PHONE}${unsubscribeUrl ? `\n\nSe d\u00e9sinscrire : ${unsubscribeUrl}` : ''}`,
  };
}

function buildDeliveryConfirmedEmail({ order, user, baseUrl } = {}) {
  const number = order && order.number ? String(order.number) : '';
  const orderId = order && order._id ? String(order._id) : '';
  const firstName = user && user.firstName ? String(user.firstName).trim() : '';
  const greeting = firstName ? escapeHtml(firstName) : 'Bonjour';
  const items = order && Array.isArray(order.items) ? order.items : [];

  const totals = computeOrderTotals(order);

  const orderUrl = baseUrl && orderId ? `${baseUrl.replace(/\/$/, '')}/compte/commandes/${encodeURIComponent(orderId)}` : '';
  const contactUrl = baseUrl ? `${baseUrl.replace(/\/$/, '')}/contact` : '';

  const recapRows = items
    .slice(0, 6)
    .map((it) => {
      if (!it) return '';
      const name = it.name ? escapeHtml(it.name) : 'Article';
      const qty = Number.isFinite(it.quantity) ? it.quantity : 1;
      const imageUrl = it.imageUrl ? getTrimmedString(it.imageUrl) : '';
      const imageCell = imageUrl
        ? `<img src="${escapeHtml(imageUrl)}" alt="${name}" width="44" height="44" style="display:block;width:44px;height:44px;object-fit:cover;border-radius:12px;" />`
        : `<div style="width:44px;height:44px;border-radius:12px;background:#f1f5f9;"></div>`;

      return `<tr>
        <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;vertical-align:top;width:52px;">${imageCell}</td>
        <td style="padding:10px 0;border-bottom:1px solid #f1f5f9;vertical-align:top;">
          <div style="font-weight:900;color:#0f172a;">${name}</div>
          <div style="font-size:12px;color:#64748b;margin-top:2px;">Quantit\u00e9 : <strong style="color:#0f172a;">${escapeHtml(qty)}</strong></div>
        </td>
      </tr>`;
    })
    .join('');

  const moreCount = items.length > 6 ? items.length - 6 : 0;

  const subject = number ? `Commande #${number} livr\u00e9e` : 'Votre commande a \u00e9t\u00e9 livr\u00e9e';

  const bodyHtml = `
<div style="font-size:16px;font-weight:900;">${greeting}, bonne nouvelle !</div>
<div style="margin-top:10px;font-size:14px;line-height:1.6;color:#334155;">
  Votre commande${number ? ` <strong>#${escapeHtml(number)}</strong>` : ''} a \u00e9t\u00e9 livr\u00e9e avec succ\u00e8s.
</div>

<div style="margin-top:12px;padding:12px 14px;border:1px solid #dcfce7;background:#f0fdf4;border-radius:14px;color:#14532d;font-size:13px;line-height:1.6;">
  <div style="font-weight:900;">Livraison confirm\u00e9e</div>
  <div style="margin-top:4px;">Votre colis a bien \u00e9t\u00e9 r\u00e9ceptionn\u00e9. Si tout est en ordre, nous vous invitons \u00e0 nous laisser un avis.</div>
</div>

<div style="margin-top:18px;font-size:12px;font-weight:900;letter-spacing:0.08em;text-transform:uppercase;color:#94a3b8;">Articles livr\u00e9s</div>
<table role="presentation" cellpadding="0" cellspacing="0" width="100%" style="margin-top:10px;">
  ${recapRows}
</table>
${moreCount ? `<div style="margin-top:10px;font-size:12px;color:#64748b;">+ ${escapeHtml(moreCount)} autre(s) article(s).</div>` : ''}

<div style="margin-top:12px;padding:12px 14px;border:1px solid #e5e7eb;background:#f8fafc;border-radius:14px;color:#0f172a;font-size:13px;line-height:1.6;">
  <div style="display:flex;justify-content:space-between;gap:10px;">
    <div style="font-weight:900;">Total TTC</div>
    <div style="font-weight:900;white-space:nowrap;">${escapeHtml(formatEuro(totals.totalCents))}</div>
  </div>
</div>

${renderPrimaryButton({ href: orderUrl, label: 'Voir ma commande' })}

<div style="margin-top:18px;padding:12px 14px;border:1px solid #e5e7eb;background:#ffffff;border-radius:14px;color:#0f172a;font-size:13px;line-height:1.6;">
  <div style="font-weight:900;">Un probl\u00e8me avec votre commande ?</div>
  <div style="margin-top:4px;color:#64748b;">
    Si un article ne correspond pas ou si vous constatez un d\u00e9faut, contactez-nous rapidement.
    Notre \u00e9quipe se chargera de trouver une solution.
  </div>
  ${contactUrl ? `<div style="margin-top:6px;"><a href="${escapeHtml(contactUrl)}" style="color:#ec1313;text-decoration:none;font-weight:800;">Contacter le support</a></div>` : ''}
</div>

<div style="margin-top:14px;font-size:12px;line-height:1.6;color:#64748b;">
  Merci pour votre confiance. \u00c0 bient\u00f4t sur ${brand.NAME} !
</div>`;

  return {
    subject,
    html: renderEmailLayout({
      title: subject,
      preheader: 'Votre colis a bien \u00e9t\u00e9 livr\u00e9',
      bodyHtml,
      baseUrl,
    }),
    text: `Commande${number ? ` #${number}` : ''} livr\u00e9e. Total TTC : ${formatEuro(totals.totalCents)}.`,
  };
}

function getOrderStatusLabelFR(status) {
  const labels = {
    pending_payment: 'En attente de paiement',
    paid: 'Pay\u00e9e',
    processing: 'En pr\u00e9paration',
    shipped: 'Exp\u00e9di\u00e9e',
    delivered: 'Livr\u00e9e',
    completed: 'Termin\u00e9e',
    cancelled: 'Annul\u00e9e',
    refunded: 'Rembours\u00e9e',
    draft: 'Brouillon',
  };
  return labels[status] || String(status || '').replace(/_/g, ' ');
}

function getStatusIcon(status) {
  const icons = {
    pending_payment: { icon: 'hourglass_top', color: '#d97706', bg: '#fffbeb', border: '#fef3c7' },
    paid: { icon: 'check_circle', color: '#059669', bg: '#f0fdf4', border: '#dcfce7' },
    processing: { icon: 'inventory_2', color: '#2563eb', bg: '#eff6ff', border: '#dbeafe' },
    shipped: { icon: 'local_shipping', color: '#7c3aed', bg: '#f5f3ff', border: '#ede9fe' },
    delivered: { icon: 'done_all', color: '#059669', bg: '#f0fdf4', border: '#dcfce7' },
    completed: { icon: 'verified', color: '#059669', bg: '#f0fdf4', border: '#dcfce7' },
    cancelled: { icon: 'cancel', color: '#dc2626', bg: '#fff1f2', border: '#fee2e2' },
    refunded: { icon: 'currency_exchange', color: '#64748b', bg: '#f8fafc', border: '#e5e7eb' },
  };
  return icons[status] || { icon: 'info', color: '#64748b', bg: '#f8fafc', border: '#e5e7eb' };
}

function buildOrderStatusChangeEmail({ order, user, newStatus, message, baseUrl } = {}) {
  const number = order && order.number ? String(order.number) : '';
  const orderId = order && order._id ? String(order._id) : '';
  const firstName = user && user.firstName ? String(user.firstName).trim() : '';
  const greeting = firstName ? escapeHtml(firstName) : 'Bonjour';

  const statusLabel = getOrderStatusLabelFR(newStatus);
  const si = getStatusIcon(newStatus);

  const orderUrl = baseUrl && orderId ? `${baseUrl.replace(/\/$/, '')}/compte/commandes/${encodeURIComponent(orderId)}` : '';
  const safeMessage = message ? getTrimmedString(message) : '';

  const subject = number
    ? `Commande #${number} : ${statusLabel}`
    : `Mise \u00e0 jour de votre commande : ${statusLabel}`;

  const bodyHtml = `
<div style="font-size:16px;font-weight:900;">${greeting},</div>
<div style="margin-top:10px;font-size:14px;line-height:1.6;color:#334155;">
  Le statut de votre commande${number ? ` <strong>#${escapeHtml(number)}</strong>` : ''} a \u00e9t\u00e9 mis \u00e0 jour.
</div>

<div style="margin-top:14px;padding:16px;border:1px solid ${si.border};background:${si.bg};border-radius:14px;color:${si.color};font-size:14px;line-height:1.6;">
  <div style="font-weight:900;font-size:16px;">${escapeHtml(statusLabel)}</div>
</div>

${safeMessage ? `
<div style="margin-top:14px;padding:12px 14px;border:1px solid #e5e7eb;background:#ffffff;border-radius:14px;color:#334155;font-size:13px;line-height:1.6;">
  <div style="font-weight:900;color:#0f172a;margin-bottom:6px;">Message</div>
  ${escapeHtml(safeMessage)}
</div>` : ''}

${renderPrimaryButton({ href: orderUrl, label: 'Voir ma commande' })}

<div style="margin-top:14px;font-size:12px;line-height:1.6;color:#64748b;">
  Si vous avez une question, r\u00e9pondez directement \u00e0 cet email.
</div>`;

  return {
    subject,
    html: renderEmailLayout({
      title: subject,
      preheader: `Commande${number ? ` #${number}` : ''} : ${statusLabel}`,
      bodyHtml,
      baseUrl,
    }),
    text: `Commande${number ? ` #${number}` : ''} : statut mis \u00e0 jour \u2192 ${statusLabel}.${safeMessage ? ` Message : ${safeMessage}` : ''}`,
  };
}

function buildCloningPieceReceivedEmail({ order, user, baseUrl } = {}) {
  const number = order && order.number ? String(order.number) : '';
  const orderId = order && order._id ? String(order._id) : '';
  const orderUrl = baseUrl && orderId ? `${baseUrl.replace(/\/$/, '')}/compte/commandes/${encodeURIComponent(orderId)}` : '';

  const subject = number
    ? `Pièce reçue, le clonage va commencer — commande #${number}`
    : 'Nous avons bien reçu votre pièce';

  const bodyHtml = `
<div style="font-size:16px;font-weight:900;">Votre pièce est bien arrivée !</div>
<div style="margin-top:10px;font-size:14px;line-height:1.6;color:#334155;">
  Nous confirmons la réception de votre ancienne pièce pour la commande${number ? ` <strong>#${escapeHtml(number)}</strong>` : ''}.
</div>

<div style="margin-top:16px;padding:16px;border:1px solid #ddd6fe;background:#f5f3ff;border-radius:14px;">
  <div style="font-weight:900;color:#4c1d95;font-size:14px;margin-bottom:8px;">🔬 Prochaine étape : clonage</div>
  <div style="font-size:13px;line-height:1.6;color:#334155;">
    Nos techniciens vont maintenant procéder à la <strong>lecture des données</strong> de votre ancienne mécatronique et les <strong>programmer sur votre nouvelle pièce</strong>.<br/>
    Délai estimé : <strong>2 à 5 jours ouvrés</strong>.
  </div>
</div>

<div style="margin-top:16px;padding:12px 14px;border:1px solid #dcfce7;background:#f0fdf4;border-radius:14px;color:#14532d;font-size:13px;line-height:1.6;">
  Vous recevrez un email dès que le clonage sera terminé et que votre pièce sera prête à être expédiée.
</div>

${renderPrimaryButton({ href: orderUrl, label: 'Suivre le parcours de ma commande' })}`;

  return {
    subject,
    html: renderEmailLayout({ title: subject, preheader: 'Votre pièce est arrivée, le clonage va commencer', bodyHtml, baseUrl }),
    text: `Nous confirmons la réception de votre pièce pour la commande${number ? ` #${number}` : ''}. Le clonage va commencer sous 2 à 5 jours ouvrés.`,
  };
}

function buildCloningDoneEmail({ order, user, baseUrl } = {}) {
  const number = order && order.number ? String(order.number) : '';
  const orderId = order && order._id ? String(order._id) : '';
  const orderUrl = baseUrl && orderId ? `${baseUrl.replace(/\/$/, '')}/compte/commandes/${encodeURIComponent(orderId)}` : '';

  const subject = number
    ? `Clonage terminé, expédition imminente — commande #${number}`
    : 'Clonage terminé, votre pièce va être expédiée';

  const bodyHtml = `
<div style="font-size:16px;font-weight:900;">✅ Clonage terminé avec succès !</div>
<div style="margin-top:10px;font-size:14px;line-height:1.6;color:#334155;">
  La programmation de votre nouvelle mécatronique pour la commande${number ? ` <strong>#${escapeHtml(number)}</strong>` : ''} est terminée.
</div>

<div style="margin-top:16px;padding:16px;border:1px solid #dcfce7;background:#f0fdf4;border-radius:14px;">
  <div style="font-weight:900;color:#14532d;font-size:14px;margin-bottom:8px;">📦 Prochaine étape : expédition</div>
  <div style="font-size:13px;line-height:1.6;color:#334155;">
    Votre pièce clonée sera <strong>expédiée sous 24 à 48h</strong>. Vous recevrez un email avec le numéro de suivi dès l'envoi.
  </div>
</div>

${renderPrimaryButton({ href: orderUrl, label: 'Suivre ma commande' })}`;

  return {
    subject,
    html: renderEmailLayout({ title: subject, preheader: 'Clonage terminé, expédition sous 24-48h', bodyHtml, baseUrl }),
    text: `Le clonage de votre pièce pour la commande${number ? ` #${number}` : ''} est terminé. Expédition sous 24-48h.`,
  };
}

function buildCloningFailedEmail({ order, user, baseUrl } = {}) {
  const number = order && order.number ? String(order.number) : '';
  const orderId = order && order._id ? String(order._id) : '';
  const orderUrl = baseUrl && orderId ? `${baseUrl.replace(/\/$/, '')}/compte/commandes/${encodeURIComponent(orderId)}` : '';

  const subject = number
    ? `Information importante concernant votre commande #${number}`
    : 'Information importante concernant votre commande';

  const bodyHtml = `
<div style="font-size:16px;font-weight:900;">Un problème a été détecté</div>
<div style="margin-top:10px;font-size:14px;line-height:1.6;color:#334155;">
  Nos techniciens ont rencontré une difficulté lors du clonage de votre pièce pour la commande${number ? ` <strong>#${escapeHtml(number)}</strong>` : ''}.
</div>

<div style="margin-top:16px;padding:16px;border:2px solid #fca5a5;background:#fef2f2;border-radius:14px;">
  <div style="font-weight:900;color:#991b1b;font-size:14px;margin-bottom:8px;">⚠️ Que se passe-t-il ?</div>
  <div style="font-size:13px;line-height:1.6;color:#334155;">
    La lecture ou le transfert des données de votre ancienne pièce n'a pas pu aboutir. Cela peut arriver si la pièce est endommagée, si les données sont corrompues ou si le composant est incompatible.
  </div>
</div>

<div style="margin-top:16px;padding:12px 14px;border:1px solid #e2e8f0;background:#f8fafc;border-radius:14px;color:#334155;font-size:13px;line-height:1.6;">
  <strong>Notre équipe technique va vous contacter</strong> dans les plus brefs délais pour discuter des solutions disponibles (programmation alternative, remplacement, remboursement).
</div>

${renderPrimaryButton({ href: orderUrl, label: 'Voir ma commande' })}

<div style="margin-top:16px;font-size:12px;line-height:1.6;color:#64748b;">
  Si vous souhaitez nous contacter directement : <a href="mailto:${brand.EMAIL_CONTACT}" style="color:#dc2626;font-weight:bold;">${brand.EMAIL_CONTACT}</a>
</div>`;

  return {
    subject,
    html: renderEmailLayout({ title: subject, preheader: 'Un problème a été détecté lors du clonage', bodyHtml, baseUrl }),
    text: `Un problème a été détecté lors du clonage de votre pièce pour la commande${number ? ` #${number}` : ''}. Notre équipe vous contactera rapidement.`,
  };
}

function buildCloningLabelEmail({ order, user, baseUrl } = {}) {
  const number = order && order.number ? String(order.number) : '';
  const orderId = order && order._id ? String(order._id) : '';
  const orderUrl = baseUrl && orderId ? `${baseUrl.replace(/\/$/, '')}/compte/commandes/${encodeURIComponent(orderId)}` : '';

  const subject = number
    ? `Étiquette de récupération prête — commande #${number}`
    : 'Votre étiquette de récupération est prête';

  const bodyHtml = `
<div style="font-size:16px;font-weight:900;">Votre étiquette de récupération est prête</div>
<div style="margin-top:10px;font-size:14px;line-height:1.6;color:#334155;">
  Pour votre commande${number ? ` <strong>#${escapeHtml(number)}</strong>` : ''} avec service de clonage 1:1, nous avons besoin de votre ancienne pièce pour lire et transférer les données sur votre nouvelle mécatronique.
</div>

<div style="margin-top:16px;padding:16px;border:2px solid #fb923c;background:#fff7ed;border-radius:14px;">
  <div style="font-weight:900;color:#9a3412;font-size:14px;margin-bottom:10px;">📦 Comment procéder :</div>
  <table role="presentation" cellpadding="0" cellspacing="0" style="font-size:13px;line-height:1.8;color:#334155;">
    <tr><td style="padding:4px 8px 4px 0;font-weight:bold;vertical-align:top;">1.</td><td><strong>Imprimez l'étiquette UPS</strong> en pièce jointe de cet email</td></tr>
    <tr><td style="padding:4px 8px 4px 0;font-weight:bold;vertical-align:top;">2.</td><td><strong>Emballez soigneusement</strong> votre pièce dans un sachet antistatique, entourée de mousse ou papier bulle, dans un carton rigide</td></tr>
    <tr><td style="padding:4px 8px 4px 0;font-weight:bold;vertical-align:top;">3.</td><td><strong>Collez l'étiquette UPS</strong> sur le carton et déposez-le dans un <a href="https://www.ups.com/dropoff?loc=fr_FR" style="color:#dc2626;font-weight:bold;">Point Relais UPS</a></td></tr>
  </table>
</div>

<div style="margin-top:16px;padding:12px 14px;border:1px solid #ddd6fe;background:#f5f3ff;border-radius:14px;color:#4c1d95;font-size:13px;line-height:1.6;">
  <strong>Délai estimé :</strong> une fois votre pièce reçue, le clonage prend en moyenne 2 à 5 jours ouvrés. Vous serez notifié à chaque étape.
</div>

${renderPrimaryButton({ href: orderUrl, label: 'Suivre le parcours de ma commande' })}

<div style="margin-top:16px;font-size:12px;line-height:1.6;color:#64748b;">
  L'étiquette UPS est également téléchargeable depuis votre espace client, sur la page de votre commande.
</div>`;

  return {
    subject,
    html: renderEmailLayout({
      title: subject,
      preheader: 'Imprimez l\'étiquette et envoyez-nous votre ancienne pièce',
      bodyHtml,
      baseUrl,
    }),
    text: `Votre étiquette de récupération est prête pour la commande${number ? ` #${number}` : ''}. Imprimez l'étiquette UPS en pièce jointe, emballez soigneusement votre pièce et déposez le colis dans un Point Relais UPS.`,
  };
}

module.exports = {
  buildOrderConfirmationEmail,
  buildConsigneStartEmail,
  buildConsigneReceivedEmail,
  buildShipmentTrackingEmail,
  buildConsigneReminderSoonEmail,
  buildConsigneOverdueEmail,
  buildWelcomeEmail,
  buildGuestAccountCreatedEmail,
  buildResetPasswordEmail,
  buildNewBlogPostEmail,
  buildAbandonedCartReminder1,
  buildAbandonedCartReminder2,
  buildAbandonedCartReminder3,
  buildDeliveryConfirmedEmail,
  buildOrderStatusChangeEmail,
  buildCloningLabelEmail,
  buildCloningPieceReceivedEmail,
  buildCloningDoneEmail,
  buildCloningFailedEmail,
};
