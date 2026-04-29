function formatEuro(totalCents) {
  const n = Number(totalCents);
  if (!Number.isFinite(n)) return '—';
  return `${(n / 100).toFixed(2).replace('.', ',')} €`;
}

const fs = require('fs');
const path = require('path');
const invoiceSettings = require('./invoiceSettings');
const mediaStorage = require('./mediaStorage');

function formatDateFR(value) {
  if (!value) return '—';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

function safeText(value) {
  return typeof value === 'string' ? value.trim() : value ? String(value) : '';
}

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : value ? String(value).trim() : '';
}

function resolvePublicFilePath(publicPath) {
  const raw = getTrimmedString(publicPath);
  if (!raw) return '';
  if (!raw.startsWith('/')) return '';

  const rel = raw.replace(/^\//, '');
  const resolved = path.join(__dirname, '..', '..', 'public', rel);
  return resolved;
}

async function loadLogoBufferFromUrl(logoUrl) {
  const raw = getTrimmedString(logoUrl);
  if (!raw) return null;

  const mediaId = mediaStorage.extractMediaIdFromUrl(raw);
  if (!mediaId) return null;

  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = mediaStorage.openDownloadStream(mediaId);
    stream.on('data', (c) => chunks.push(c));
    stream.on('end', () => resolve(Buffer.concat(chunks)));
    stream.on('error', reject);
  });
}

function deriveSirenFromSiret(siret) {
  const raw = getTrimmedString(siret);
  if (!raw) return '';
  const digits = raw.replace(/[^0-9]/g, '');
  if (digits.length < 9) return '';
  return digits.slice(0, 9);
}

function computeTotals(order) {
  const shippingCostCents = order && Number.isFinite(order.shippingCostCents) ? order.shippingCostCents : 0;
  const itemsSubtotalCents = order && Number.isFinite(order.itemsSubtotalCents)
    ? order.itemsSubtotalCents
    : Array.isArray(order && order.items)
      ? order.items.reduce((sum, it) => sum + (Number.isFinite(it && it.lineTotalCents) ? it.lineTotalCents : 0), 0)
      : 0;

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
    itemsSubtotalCents,
    itemsTotalAfterDiscountCents,
    shippingCostCents,
    clientDiscountCents,
    promoDiscountCents,
    totalCents,
    htCents,
    vatCents,
  };
}

async function buildOrderInvoicePdfBuffer({ order, user } = {}) {
  let PDFDocument;
  try {
    PDFDocument = require('pdfkit');
  } catch (err) {
    return null;
  }

  if (!order) return null;

  const totals = computeTotals(order);
  const settings = await invoiceSettings.getInvoiceSettingsMergedWithFallback();

  const orderNumber = safeText(order.number);
  const invoiceNumber = order && order.invoice && typeof order.invoice.number === 'string' ? order.invoice.number.trim() : '';

  const createdAt = order.createdAt ? new Date(order.createdAt) : null;
  const issuedAt = order && order.invoice && order.invoice.issuedAt ? new Date(order.invoice.issuedAt) : null;
  const validCreatedAt = createdAt && !Number.isNaN(createdAt.getTime()) ? createdAt : null;
  const validIssuedAt = issuedAt && !Number.isNaN(issuedAt.getTime()) ? issuedAt : null;
  const invoiceDate = validCreatedAt || validIssuedAt;

  const customerName = safeText(user && user.firstName ? `${user.firstName}` : '') + (user && user.lastName ? ` ${safeText(user.lastName)}` : '');
  const customerEmail = safeText(user && user.email);
  const customerCompanyName = safeText(user && user.companyName);
  const customerSiret = safeText(user && user.siret);
  const isPro = getTrimmedString(user && user.accountType).toLowerCase() === 'pro';

  const shipping = order.shippingAddress || null;
  const billing = order.billingAddress || null;

  let logoBuffer = null;
  try {
    logoBuffer = await loadLogoBufferFromUrl(settings && settings.logoUrl ? settings.logoUrl : '');
  } catch (err) {
    logoBuffer = null;
  }

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 48 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const pageW = doc.page.width;
      const left = doc.page.margins.left;
      const right = pageW - doc.page.margins.right;

      const logoPath = !logoBuffer
        ? resolvePublicFilePath(settings && settings.logoUrl ? settings.logoUrl : '')
        : '';

      const hasLogo = (() => {
        if (logoBuffer && Buffer.isBuffer(logoBuffer) && logoBuffer.length) return true;
        if (!logoPath) return false;
        try {
          return fs.existsSync(logoPath);
        } catch (e) {
          return false;
        }
      })();

      const headerTopY = doc.y;
      if (hasLogo) {
        try {
          doc.image(logoBuffer || logoPath, left, headerTopY, { width: 140 });
        } catch (e) {
          // ignore
        }
      } else {
        doc.fontSize(18).font('Helvetica-Bold').text('CarPartsFrance', left, headerTopY);
      }

      const invoiceTitle = invoiceNumber ? `FACTURE ${invoiceNumber}` : (orderNumber ? `FACTURE ${orderNumber}` : 'FACTURE');
      const headerRightX = left + 220;
      doc.fontSize(16).font('Helvetica-Bold').fillColor('#111827').text(invoiceTitle, headerRightX, headerTopY, {
        width: right - headerRightX,
        align: 'right',
      });

      doc.fontSize(10).font('Helvetica').fillColor('#374151');
      doc.text(`Date : ${formatDateFR(invoiceDate)}`, headerRightX, headerTopY + 22, {
        width: right - headerRightX,
        align: 'right',
      });
      if (orderNumber) {
        doc.text(`Commande : ${orderNumber}`, headerRightX, headerTopY + 36, {
          width: right - headerRightX,
          align: 'right',
        });
      }

      doc.moveDown(2.2);

      const legalBlockX = left;
      const legalBlockY = doc.y;
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#111827').text(settings.legalName, legalBlockX, legalBlockY);
      doc.font('Helvetica').fillColor('#374151');
      doc.text(settings.address, { width: (right - left) * 0.62 });
      const siren = deriveSirenFromSiret(settings.siret);
      doc.text(`${settings.legalForm} • SIREN : ${siren || '—'} • SIRET : ${settings.siret}`, { width: (right - left) * 0.62 });
      doc.text(`TVA : ${settings.vat} • APE : ${settings.ape}`, { width: (right - left) * 0.62 });
      if (settings.capital) doc.text(`Capital social : ${settings.capital}`, { width: (right - left) * 0.62 });
      if (settings.rcs) doc.text(`RCS : ${settings.rcs}`, { width: (right - left) * 0.62 });
      if (settings.website) doc.text(settings.website, { width: (right - left) * 0.62 });

      doc.moveDown(1);

      doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(1).strokeColor('#e5e7eb').stroke();
      doc.moveDown(1);

      doc.moveDown(1);

      doc.fontSize(11).font('Helvetica-Bold').text('Client');
      doc.font('Helvetica').text(customerName || '—');
      if (isPro && customerCompanyName) doc.text(customerCompanyName);
      if (isPro && customerSiret) doc.text(`SIRET : ${customerSiret}`);
      if (customerEmail) doc.text(customerEmail);

      doc.moveDown(0.8);

      const startY = doc.y;
      const colGap = 18;
      const colWidth = (doc.page.width - doc.page.margins.left - doc.page.margins.right - colGap) / 2;

      doc.fontSize(11).font('Helvetica-Bold').text('Adresse de livraison', doc.page.margins.left, startY, { width: colWidth });
      doc.font('Helvetica');
      const shippingLines = shipping
        ? [shipping.fullName, shipping.line1, shipping.line2, `${shipping.postalCode || ''} ${shipping.city || ''}`.trim(), shipping.country, shipping.phone ? `Tél : ${shipping.phone}` : '']
            .filter((v) => safeText(v))
        : ['—'];
      doc.text(shippingLines.join('\n'), doc.page.margins.left, startY + 14, { width: colWidth });

      const rightX = doc.page.margins.left + colWidth + colGap;
      doc.fontSize(11).font('Helvetica-Bold').text('Adresse de facturation', rightX, startY, { width: colWidth });
      doc.font('Helvetica');
      const billingLines = billing
        ? [billing.fullName, billing.line1, billing.line2, `${billing.postalCode || ''} ${billing.city || ''}`.trim(), billing.country, billing.phone ? `Tél : ${billing.phone}` : '']
            .filter((v) => safeText(v))
        : ['—'];
      doc.text(billingLines.join('\n'), rightX, startY + 14, { width: colWidth });

      doc.y = Math.max(doc.y, startY + 90);
      doc.moveDown(1);

      doc.fontSize(11).font('Helvetica-Bold').text('Articles');
      doc.moveDown(0.6);

      const items = Array.isArray(order.items) ? order.items : [];
      const leftX = doc.page.margins.left;
      const tableW = doc.page.width - doc.page.margins.left - doc.page.margins.right;

      const colQty = 50;
      const colPU = 90;
      const colTotal = 90;
      const colName = tableW - colQty - colPU - colTotal;

      const headerY = doc.y;
      doc.fontSize(10).font('Helvetica-Bold');
      doc.text('Produit', leftX, headerY, { width: colName });
      doc.text('Qté', leftX + colName, headerY, { width: colQty, align: 'right' });
      doc.text('PU TTC', leftX + colName + colQty, headerY, { width: colPU, align: 'right' });
      doc.text('Total TTC', leftX + colName + colQty + colPU, headerY, { width: colTotal, align: 'right' });
      doc.moveDown(0.4);
      doc.font('Helvetica');

      for (const it of items) {
        const name = safeText(it && it.name) || 'Article';
        const qty = Number.isFinite(it && it.quantity) ? it.quantity : 1;
        const unit = Number.isFinite(it && it.unitPriceCents) ? formatEuro(it.unitPriceCents) : '—';
        const line = Number.isFinite(it && it.lineTotalCents) ? formatEuro(it.lineTotalCents) : '—';

        const y = doc.y;
        doc.fontSize(10).text(name, leftX, y, { width: colName });
        const afterNameY = doc.y;
        doc.text(String(qty), leftX + colName, y, { width: colQty, align: 'right' });
        doc.text(unit, leftX + colName + colQty, y, { width: colPU, align: 'right' });
        doc.text(line, leftX + colName + colQty + colPU, y, { width: colTotal, align: 'right' });
        doc.y = Math.max(doc.y, afterNameY);
        doc.moveDown(0.3);
      }

      {
        const isFreeShipping = totals.shippingCostCents === 0;
        const shippingLabel = isFreeShipping ? 'Frais de transport (offerts)' : 'Frais de transport';
        const shippingText = formatEuro(totals.shippingCostCents);
        const y = doc.y;
        doc.fontSize(10).font('Helvetica-Bold').text(shippingLabel, leftX, y, { width: colName });
        doc.font('Helvetica');
        doc.text('1', leftX + colName, y, { width: colQty, align: 'right' });
        doc.text(shippingText, leftX + colName + colQty, y, { width: colPU, align: 'right' });
        doc.text(shippingText, leftX + colName + colQty + colPU, y, { width: colTotal, align: 'right' });
        doc.moveDown(0.3);
      }

      doc.moveDown(1);

      doc.fontSize(11).font('Helvetica-Bold').text('Récapitulatif');
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica');

      const summaryLines = [];
      summaryLines.push({ label: 'Sous-total articles', value: formatEuro(totals.itemsSubtotalCents) });
      if (totals.clientDiscountCents > 0) summaryLines.push({ label: 'Remise compte', value: `- ${formatEuro(totals.clientDiscountCents)}` });
      if (totals.promoDiscountCents > 0) summaryLines.push({ label: 'Code promo', value: `- ${formatEuro(totals.promoDiscountCents)}` });
      if (totals.shippingCostCents > 0) summaryLines.push({ label: 'Frais de transport', value: formatEuro(totals.shippingCostCents) });
      if (totals.shippingCostCents === 0) summaryLines.push({ label: 'Frais de transport (offerts)', value: formatEuro(0) });

      summaryLines.push({ label: 'Total TTC', value: formatEuro(totals.totalCents) });
      summaryLines.push({ label: 'Total HT', value: formatEuro(totals.htCents) });
      summaryLines.push({ label: 'TVA (20%)', value: formatEuro(totals.vatCents) });

      const labelW = 250;
      const valueW = 150;
      for (const line of summaryLines) {
        const y = doc.y;
        doc.text(line.label, leftX, y, { width: labelW });
        doc.text(line.value, leftX + tableW - valueW, y, { width: valueW, align: 'right' });
        doc.moveDown(0.2);
      }

      doc.moveDown(1);
      doc.fontSize(9).fillColor('#6b7280');
      doc.text(settings.paymentTermsText);
      doc.text(settings.latePenaltyText);
      if (isPro) {
        doc.text(settings.proRecoveryFeeText);
      }
      doc.moveDown(0.4);
      doc.text('Merci pour votre commande.');

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  buildOrderInvoicePdfBuffer,
  computeTotals,
};
