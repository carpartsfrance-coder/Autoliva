/*
 * SAV — Génération du PDF "Acceptation CGV SAV"
 * - Reproduit le texte des CGV SAV (ou un résumé)
 * - Encart "Signature électronique" avec : numéro ticket, client, version CGV,
 *   horodatage UTC, IP, user-agent, hash SHA-256 des métadonnées
 * - Sortie : stocké en MongoDB (GridFS) via savFileStorage, URL `/sav-files/<id>`.
 *   Helper getCgvAcceptanceBuffer pour pièce jointe email.
 */

const crypto = require('crypto');
const PDFDocument = require('pdfkit');
const savFileStorage = require('./savFileStorage');
const brand = require('../config/brand');

function metaHash(ticket) {
  const cgv = (ticket && ticket.cgvAcceptance) || {};
  const payload = JSON.stringify({
    numero: ticket && ticket.numero,
    email: ticket && ticket.client && ticket.client.email,
    version: cgv.version || 'cgv-sav-v2-2026-04',
    acceptedAt: cgv.acceptedAt && new Date(cgv.acceptedAt).toISOString(),
    ip: cgv.ip || '',
    userAgent: cgv.userAgent || '',
  });
  return crypto.createHash('sha256').update(payload).digest('hex');
}

function buildPdfBuffer(ticket) {
  return new Promise((resolve, reject) => {
    try {
      const doc = new PDFDocument({ size: 'A4', margin: 56 });
      const chunks = [];
      doc.on('data', (c) => chunks.push(c));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const cgv = (ticket && ticket.cgvAcceptance) || {};
      const rgpd = (ticket && ticket.rgpdAcceptance) || {};
      const client = (ticket && ticket.client) || {};
      const acceptedAt = cgv.acceptedAt ? new Date(cgv.acceptedAt) : new Date();

      // En-tête
      doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(18)
        .text('Acceptation des Conditions Générales du SAV', { align: 'left' });
      doc.moveDown(0.3);
      doc.font('Helvetica').fontSize(10).fillColor('#475569')
        .text(`${brand.NAME} — Document signé électroniquement`, { align: 'left' });
      doc.moveDown(1);

      // Cadre dossier
      doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(12).text('Dossier SAV');
      doc.font('Helvetica').fontSize(10).fillColor('#0f172a');
      doc.text(`Numéro de dossier : ${ticket.numero || '—'}`);
      doc.text(`Client : ${client.nom || ''} <${client.email || ''}>`);
      if (ticket.numeroCommande) doc.text(`Commande liée : ${ticket.numeroCommande}`);
      if (ticket.pieceType) doc.text(`Pièce concernée : ${ticket.pieceType}`);
      doc.moveDown(0.8);

      // Texte d'acceptation
      doc.font('Helvetica-Bold').fontSize(12).text("Texte de l'acceptation");
      doc.font('Helvetica').fontSize(10).fillColor('#1e293b');
      doc.text(
        `Le client déclare avoir pris connaissance et accepter sans réserve les Conditions Générales du Service Après-Vente de ${brand.NAME}, et notamment :`,
        { align: 'justify' }
      );
      doc.moveDown(0.4);
      const items = [
        "Une analyse sur banc de la pièce est nécessaire pour conclure au défaut produit.",
        "Si l'analyse confirme un défaut produit, l'échange ou le remboursement est intégral et le retour est gratuit.",
        "Si l'analyse conclut à un mauvais montage, à une usure normale ou à une pièce non défectueuse, un forfait de 149 € TTC sera facturé au client.",
        "Le retour de la pièce vers le client en cas d'analyse négative est facturé 25 € TTC.",
        "Aucun montant n'est prélevé à l'ouverture de la demande.",
      ];
      items.forEach((it) => {
        doc.text('•  ' + it, { indent: 8, align: 'justify' });
      });
      doc.moveDown(0.6);

      // RGPD
      doc.font('Helvetica-Bold').fontSize(12).text('Traitement des données personnelles (RGPD)');
      doc.font('Helvetica').fontSize(10).fillColor('#1e293b').text(
        rgpd.acceptedAt
          ? `Le client a accepté le traitement de ses données personnelles aux fins du traitement de sa demande SAV (version ${rgpd.version || 'rgpd-v1-2026-04'}).`
          : "Aucun consentement RGPD spécifique n'a été enregistré pour cette demande.",
        { align: 'justify' }
      );
      doc.moveDown(1);

      // Signature électronique
      const startY = doc.y;
      doc.rect(56, startY, doc.page.width - 112, 130).strokeColor('#cbd5e1').lineWidth(0.7).stroke();
      doc.fillColor('#0f172a').font('Helvetica-Bold').fontSize(11)
        .text('Signature électronique', 64, startY + 8);
      doc.font('Helvetica').fontSize(9).fillColor('#1e293b');
      const lines = [
        `Version CGV : ${cgv.version || 'cgv-sav-v2-2026-04'}`,
        `Horodatage UTC : ${acceptedAt.toISOString()}`,
        `Adresse IP : ${cgv.ip || '—'}`,
        `User-Agent : ${(cgv.userAgent || '—').slice(0, 110)}`,
        `Hash SHA-256 des métadonnées : ${metaHash(ticket)}`,
      ];
      lines.forEach((l, i) => doc.text(l, 64, startY + 26 + i * 14));

      // Pied de page
      doc.font('Helvetica').fontSize(8).fillColor('#94a3b8')
        .text(
          `Document généré automatiquement par ${brand.COMPANY.LEGAL_NAME || brand.NAME}${brand.COMPANY.RCS ? ` — RCS ${brand.COMPANY.RCS}` : ''} — ${brand.DOMAIN}`,
          56,
          doc.page.height - 60,
          { align: 'center', width: doc.page.width - 112 }
        );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });
}

async function generateCgvAcceptance(ticket) {
  const buf = await buildPdfBuffer(ticket);
  const filename = `${ticket.numero || 'SAV-NOUMERO'}.pdf`;

  // Si un PDF existe déjà pour ce ticket, on le supprime pour éviter les doublons
  try {
    const existing = await savFileStorage.findByMetadata({
      'metadata.ticketNumero': ticket.numero,
      'metadata.kind': 'cgv_pdf',
    });
    for (const f of existing || []) {
      try { await savFileStorage.deleteFile(f._id); } catch (_) {}
    }
  } catch (_) {}

  const stored = await savFileStorage.saveBuffer({
    buffer: buf,
    filename,
    mime: 'application/pdf',
    metadata: {
      ticketNumero: ticket.numero,
      kind: 'cgv_pdf',
      uploadedBy: 'system',
    },
  });
  return stored.url;
}

async function getCgvAcceptanceBuffer(ticket) {
  // Cherche d'abord en GridFS (PDF déjà généré), sinon génère à la volée.
  try {
    const existing = await savFileStorage.findByMetadata({
      'metadata.ticketNumero': ticket.numero,
      'metadata.kind': 'cgv_pdf',
    });
    if (existing && existing[0]) {
      return await savFileStorage.readBuffer(existing[0]._id);
    }
  } catch (_) {}
  return buildPdfBuffer(ticket);
}

module.exports = { generateCgvAcceptance, getCgvAcceptanceBuffer };
