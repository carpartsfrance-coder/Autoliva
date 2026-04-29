function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function safeText(value) {
  return typeof value === 'string' ? value : value ? String(value) : '';
}

async function buildLegalPdfBuffer({ title, content } = {}) {
  let PDFDocument;
  try {
    PDFDocument = require('pdfkit');
  } catch (err) {
    return null;
  }

  const safeTitle = getTrimmedString(title) || 'Document';
  const body = safeText(content);

  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 48 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      doc.font('Helvetica-Bold').fontSize(18).text(safeTitle);
      doc.moveDown(0.8);

      doc.font('Helvetica').fontSize(11);
      const lines = body.split(/\r\n|\r|\n/);
      for (const line of lines) {
        doc.text(line, { width: doc.page.width - doc.page.margins.left - doc.page.margins.right });
      }

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

module.exports = {
  buildLegalPdfBuffer,
};
