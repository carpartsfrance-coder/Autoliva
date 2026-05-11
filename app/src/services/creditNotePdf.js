/* Génération du PDF d'un AVOIR (credit note).
 *
 * Mirroir de invoicePdf.js : même librairie (pdfkit), même style (logo,
 * blocs légaux, tableau d'articles, récap). On affiche les montants en
 * négatif pour bien indiquer qu'il s'agit d'un avoir.
 *
 * Le PDF est retourné sous forme de Buffer pour stockage dans MongoDB
 * (filesystem éphémère sur Render).
 */

const fs = require('fs');
const path = require('path');
const invoiceSettings = require('./invoiceSettings');
const mediaStorage = require('./mediaStorage');

function formatEuro(totalCents) {
  const n = Number(totalCents);
  if (!Number.isFinite(n)) return '—';
  return `${(n / 100).toFixed(2).replace('.', ',')} €`;
}

function formatNegativeEuro(totalCents) {
  const n = Number(totalCents);
  if (!Number.isFinite(n) || n === 0) return formatEuro(0);
  return `- ${formatEuro(Math.abs(n))}`;
}

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
  if (!raw || !raw.startsWith('/')) return '';
  const rel = raw.replace(/^\//, '');
  return path.join(__dirname, '..', '..', 'public', rel);
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
  return digits.length < 9 ? '' : digits.slice(0, 9);
}

/**
 * @param {object} args
 * @param {object} args.order  - L'objet Order (lean ou doc)
 * @param {object} args.user   - L'utilisateur destinataire de l'avoir
 * @param {object} args.creditNote - { number, issuedAt, totalCents, reason, lines, refundIndex }
 * @param {object} [args.refund] - Refund associé (méthode, providerRefundId…)
 * @returns {Promise<Buffer|null>}
 */
async function buildCreditNotePdfBuffer({ order, user, creditNote, refund } = {}) {
  let PDFDocument;
  try {
    PDFDocument = require('pdfkit');
  } catch (err) {
    return null;
  }
  if (!order || !creditNote) return null;

  const settings = await invoiceSettings.getInvoiceSettingsMergedWithFallback();

  const orderNumber = safeText(order.number);
  const invoiceNumber = order && order.invoice && typeof order.invoice.number === 'string'
    ? order.invoice.number.trim()
    : '';
  const creditNoteNumber = safeText(creditNote.number);
  const issuedAt = creditNote.issuedAt ? new Date(creditNote.issuedAt) : new Date();

  const customerName = (safeText(user && user.firstName ? user.firstName : '')
    + (user && user.lastName ? ` ${safeText(user.lastName)}` : '')).trim() || '—';
  const customerEmail = safeText(user && user.email);
  const customerCompanyName = safeText(user && user.companyName);
  const customerSiret = safeText(user && user.siret);
  const isPro = getTrimmedString(user && user.accountType).toLowerCase() === 'pro';

  const billing = order.billingAddress || null;

  let logoBuffer = null;
  try {
    logoBuffer = await loadLogoBufferFromUrl(settings && settings.logoUrl ? settings.logoUrl : '');
  } catch (err) {
    logoBuffer = null;
  }

  const lines = Array.isArray(creditNote.lines) && creditNote.lines.length
    ? creditNote.lines
    : [{ name: safeText(creditNote.reason) || 'Remboursement', quantity: 1, unitPriceCents: creditNote.totalCents, lineTotalCents: creditNote.totalCents }];

  const subtotalCents = lines.reduce((s, l) => s + (Number(l.lineTotalCents) || 0), 0);
  const totalCents = Number.isFinite(creditNote.totalCents) ? creditNote.totalCents : subtotalCents;
  const htCents = Math.round(totalCents / 1.2);
  const vatCents = Math.max(0, totalCents - htCents);

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
      const tableW = right - left;

      /* ── Header : logo + numéro d'avoir ───────────────────────── */
      const logoPath = !logoBuffer ? resolvePublicFilePath(settings && settings.logoUrl ? settings.logoUrl : '') : '';
      const hasLogo = (() => {
        if (logoBuffer && Buffer.isBuffer(logoBuffer) && logoBuffer.length) return true;
        if (!logoPath) return false;
        try { return fs.existsSync(logoPath); } catch (e) { return false; }
      })();

      const headerTopY = doc.y;
      if (hasLogo) {
        try { doc.image(logoBuffer || logoPath, left, headerTopY, { width: 140 }); } catch (e) { /* ignore */ }
      } else {
        doc.fontSize(18).font('Helvetica-Bold').text('CarPartsFrance', left, headerTopY);
      }

      const title = creditNoteNumber ? `AVOIR ${creditNoteNumber}` : 'AVOIR';
      const headerRightX = left + 220;
      doc.fontSize(16).font('Helvetica-Bold').fillColor('#b91c1c').text(title, headerRightX, headerTopY, {
        width: right - headerRightX, align: 'right',
      });
      doc.fontSize(10).font('Helvetica').fillColor('#374151');
      doc.text(`Date d'émission : ${formatDateFR(issuedAt)}`, headerRightX, headerTopY + 22, { width: right - headerRightX, align: 'right' });
      if (invoiceNumber) {
        doc.text(`Facture d'origine : ${invoiceNumber}`, headerRightX, headerTopY + 36, { width: right - headerRightX, align: 'right' });
      }
      if (orderNumber) {
        doc.text(`Commande : ${orderNumber}`, headerRightX, headerTopY + 50, { width: right - headerRightX, align: 'right' });
      }

      doc.moveDown(3.5);

      /* ── Bloc légal vendeur ────────────────────────────────────── */
      const legalBlockX = left;
      const legalBlockY = doc.y;
      doc.fontSize(10).font('Helvetica-Bold').fillColor('#111827').text(settings.legalName, legalBlockX, legalBlockY);
      doc.font('Helvetica').fillColor('#374151');
      doc.text(settings.address, { width: tableW * 0.62 });
      const siren = deriveSirenFromSiret(settings.siret);
      doc.text(`${settings.legalForm} • SIREN : ${siren || '—'} • SIRET : ${settings.siret}`, { width: tableW * 0.62 });
      doc.text(`TVA : ${settings.vat} • APE : ${settings.ape}`, { width: tableW * 0.62 });
      if (settings.capital) doc.text(`Capital social : ${settings.capital}`, { width: tableW * 0.62 });
      if (settings.rcs) doc.text(`RCS : ${settings.rcs}`, { width: tableW * 0.62 });

      doc.moveDown(1);
      doc.moveTo(left, doc.y).lineTo(right, doc.y).lineWidth(1).strokeColor('#e5e7eb').stroke();
      doc.moveDown(1);

      /* ── Client ────────────────────────────────────────────────── */
      doc.fontSize(11).font('Helvetica-Bold').text('Client');
      doc.font('Helvetica').text(customerName);
      if (isPro && customerCompanyName) doc.text(customerCompanyName);
      if (isPro && customerSiret) doc.text(`SIRET : ${customerSiret}`);
      if (customerEmail) doc.text(customerEmail);
      if (billing) {
        if (billing.line1) doc.text(billing.line1);
        if (billing.line2) doc.text(billing.line2);
        const cityLine = `${billing.postalCode || ''} ${billing.city || ''}`.trim();
        if (cityLine) doc.text(cityLine);
        if (billing.country) doc.text(billing.country);
      }

      doc.moveDown(1);

      /* ── Motif du remboursement ────────────────────────────────── */
      const reason = safeText(creditNote.reason);
      if (reason) {
        doc.fontSize(11).font('Helvetica-Bold').text('Motif du remboursement');
        doc.font('Helvetica').text(reason, { width: tableW });
        doc.moveDown(0.6);
      }

      /* ── Tableau des lignes remboursées (montants négatifs) ────── */
      doc.fontSize(11).font('Helvetica-Bold').text('Lignes remboursées');
      doc.moveDown(0.6);

      const colQty = 50;
      const colPU = 95;
      const colTotal = 95;
      const colName = tableW - colQty - colPU - colTotal;

      const headerY = doc.y;
      doc.fontSize(10).font('Helvetica-Bold');
      doc.text('Article', left, headerY, { width: colName });
      doc.text('Qté', left + colName, headerY, { width: colQty, align: 'right' });
      doc.text('PU TTC', left + colName + colQty, headerY, { width: colPU, align: 'right' });
      doc.text('Total', left + colName + colQty + colPU, headerY, { width: colTotal, align: 'right' });
      doc.moveDown(0.4);
      doc.font('Helvetica');

      for (const it of lines) {
        const name = safeText(it && it.name) || 'Article';
        const qty = Number.isFinite(it && it.quantity) ? it.quantity : 1;
        const unit = Number.isFinite(it && it.unitPriceCents) ? formatNegativeEuro(it.unitPriceCents) : '—';
        const lineTotal = Number.isFinite(it && it.lineTotalCents) ? formatNegativeEuro(it.lineTotalCents) : '—';
        const y = doc.y;
        doc.fontSize(10).text(name, left, y, { width: colName });
        const afterNameY = doc.y;
        doc.text(String(qty), left + colName, y, { width: colQty, align: 'right' });
        doc.text(unit, left + colName + colQty, y, { width: colPU, align: 'right' });
        doc.text(lineTotal, left + colName + colQty + colPU, y, { width: colTotal, align: 'right' });
        doc.y = Math.max(doc.y, afterNameY);
        doc.moveDown(0.3);
      }

      doc.moveDown(1);

      /* ── Récap totaux (négatifs) ───────────────────────────────── */
      doc.fontSize(11).font('Helvetica-Bold').text('Récapitulatif');
      doc.moveDown(0.5);
      doc.fontSize(10).font('Helvetica');

      const summary = [
        { label: 'Total HT remboursé', value: formatNegativeEuro(htCents) },
        { label: 'TVA (20%)', value: formatNegativeEuro(vatCents) },
        { label: 'Total TTC remboursé', value: formatNegativeEuro(totalCents) },
      ];
      const labelW = 250;
      const valueW = 150;
      for (const line of summary) {
        const y = doc.y;
        doc.text(line.label, left, y, { width: labelW });
        doc.text(line.value, left + tableW - valueW, y, { width: valueW, align: 'right' });
        doc.moveDown(0.2);
      }

      doc.moveDown(1);

      /* ── Méthode du remboursement ──────────────────────────────── */
      if (refund) {
        const methodLabels = {
          mollie: 'Mollie (carte / virement instantané)',
          scalapay: 'Scalapay (paiement en 3x)',
          manual: 'Geste commercial (interne)',
          bank_transfer: 'Virement bancaire',
          cash: 'Espèces',
          other: 'Autre',
        };
        doc.fontSize(10).font('Helvetica-Bold').fillColor('#111827').text('Modalités du remboursement');
        doc.font('Helvetica').fillColor('#374151');
        doc.text(`Méthode : ${methodLabels[refund.method] || refund.method || '—'}`);
        if (refund.providerRefundId) doc.text(`Référence ${refund.method} : ${refund.providerRefundId}`);
        if (refund.providerStatus) doc.text(`Statut : ${refund.providerStatus}`);
        doc.moveDown(0.5);
      }

      doc.fontSize(9).fillColor('#6b7280');
      doc.text('Ce document constitue un avoir. Il atteste un remboursement effectué au profit du client.');
      doc.moveDown(0.3);
      doc.text(`Document généré le ${formatDateFR(new Date())}.`);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  buildCreditNotePdfBuffer,
};
