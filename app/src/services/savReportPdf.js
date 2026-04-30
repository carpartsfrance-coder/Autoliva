/*
 * SAV — Génération du rapport d'analyse PDF
 * Stocké en MongoDB (GridFS) via savFileStorage. Retourne l'URL `/sav-files/<id>`.
 */

const crypto = require('crypto');
const https = require('https');
const http = require('http');

const PDFDocument = require('pdfkit');
const savFileStorage = require('./savFileStorage');
const brand = require('../config/brand');
let QRCode = null;
try { QRCode = require('qrcode'); } catch (_) { /* optionnel */ }

function reportSignature(ticket, template) {
  const secret = process.env.REPORT_SIGNATURE_SECRET || process.env.SAV_API_TOKEN || 'sav-secret';
  const payload = `${ticket.numero}|${template || 'client'}|${(ticket.analyse && ticket.analyse.conclusion) || ''}`;
  return crypto.createHmac('sha256', secret).update(payload).digest('hex').slice(0, 32);
}

async function buildQrDataUrl(text) {
  if (!QRCode) return null;
  try { return await QRCode.toDataURL(text, { margin: 1, width: 140 }); }
  catch (_) { return null; }
}

const CONCLUSION_LABELS = {
  defaut_produit: 'DÉFAUT PRODUIT — pris en charge sous garantie',
  mauvais_montage: 'MAUVAIS MONTAGE — facturation 149€',
  usure_normale: 'USURE NORMALE — facturation 149€',
  non_defectueux: 'NON DÉFECTUEUX — facturation 149€',
};

function fmtDate(d) {
  if (!d) return '—';
  try { return new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' }); }
  catch (_) { return '—'; }
}

function safe(v) { return v == null || v === '' ? '—' : String(v); }

function fetchBuffer(url) {
  return new Promise((resolve) => {
    if (!url || !/^https?:\/\//.test(url)) return resolve(null);
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, (r) => {
      if (r.statusCode !== 200) { r.resume(); return resolve(null); }
      const chunks = [];
      r.on('data', (c) => chunks.push(c));
      r.on('end', () => resolve(Buffer.concat(chunks)));
      r.on('error', () => resolve(null));
    }).on('error', () => resolve(null));
  });
}

const TEMPLATES = {
  client: {
    title: 'Rapport d\'analyse — Client',
    showClient: true,
    showVehicule: true,
    showSymptomes: true,
    showProcedure: true,
    showResultatsTech: true,
    showPhotos: true,
    showConclusion: true,
    showScoreInterne: false,
    showJustif: true,
    showLegal: true,
    anonymized: false,
    footerNote: null,
  },
  interne: {
    title: 'Rapport d\'analyse — Interne',
    showClient: true,
    showVehicule: true,
    showSymptomes: true,
    showProcedure: false,
    showResultatsTech: true,
    showPhotos: true,
    showConclusion: true,
    showScoreInterne: true,
    showJustif: true,
    showLegal: false,
    anonymized: false,
    footerNote: 'Document interne — ne pas diffuser au client.',
  },
  fournisseur: {
    title: 'Rapport d\'analyse — Fournisseur',
    showClient: false,
    showVehicule: true,
    showSymptomes: true,
    showProcedure: true,
    showResultatsTech: true,
    showPhotos: true,
    showConclusion: true,
    showScoreInterne: false,
    showJustif: true,
    showLegal: false,
    anonymized: true,
    footerNote: 'Document destiné au fournisseur — données client anonymisées.',
  },
};

function getTemplateSummary(template) {
  const t = TEMPLATES[template] || TEMPLATES.client;
  const sections = [];
  if (t.showClient && !t.anonymized) sections.push('Identification client');
  if (t.showVehicule) sections.push('Véhicule');
  if (t.showSymptomes) sections.push('Symptômes déclarés');
  if (t.showProcedure) sections.push('Procédure de test');
  if (t.showResultatsTech) sections.push('Résultats banc');
  if (t.showPhotos) sections.push('Photos banc');
  if (t.showScoreInterne) sections.push('Score de risque interne');
  if (t.showConclusion) sections.push('Conclusion & justification');
  if (t.showLegal) sections.push('Mentions légales');
  return { title: t.title, sections, note: t.footerNote };
}

async function generateAnalysisReport(ticket, options = {}) {
  if (!ticket || !ticket.numero) throw new Error('Ticket invalide');
  const template = TEMPLATES[options.template] ? options.template : 'client';
  const tpl = TEMPLATES[template];
  const fileName = template === 'client' ? `${ticket.numero}.pdf` : `${ticket.numero}-${template}.pdf`;

  const doc = new PDFDocument({ size: 'A4', margin: 48 });
  // Bufferise le PDF en mémoire puis l'envoie en GridFS (pas de fichier disque)
  const chunks = [];
  const bufferPromise = new Promise((resolve, reject) => {
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

  // ----- Header -----
  doc.fillColor('#ec1313').fontSize(20).font('Helvetica-Bold').text(brand.NAME);
  doc.fillColor('#1a1a1a').fontSize(9).font('Helvetica')
    .text('Rapport d\'analyse SAV — Mécatroniques & organes de transmission')
    .text(`${brand.EMAIL_SAV} · ${brand.PHONE} · ${brand.SITE_URL.replace(/^https?:\/\//, '')}`);
  doc.moveDown(0.6);
  doc.strokeColor('#ec1313').lineWidth(1.2).moveTo(48, doc.y).lineTo(547, doc.y).stroke();
  doc.moveDown(0.8);

  // ----- Titre & ref -----
  doc.fillColor('#1a1a1a').fontSize(16).font('Helvetica-Bold').text(`${tpl.title} n° ${ticket.numero}`);
  doc.fontSize(10).font('Helvetica').fillColor('#475569')
    .text(`Date d'analyse : ${fmtDate(ticket.updatedAt || new Date())}    ·    Ouvert le : ${fmtDate(ticket.sla && ticket.sla.dateOuverture)}`);
  if (tpl.footerNote) {
    doc.fillColor('#b45309').fontSize(9).font('Helvetica-Oblique').text(tpl.footerNote);
    doc.fillColor('#1a1a1a').font('Helvetica');
  }
  doc.moveDown(1);

  let section = 1;

  // ----- Pièce -----
  doc.fillColor('#1a1a1a').fontSize(12).font('Helvetica-Bold').text(`${section++}. Identification de la pièce`);
  doc.font('Helvetica').fontSize(10).fillColor('#1a1a1a');
  doc.text(`Type :        ${safe(ticket.pieceType)}`);
  doc.text(`Référence :   ${safe(ticket.referencePiece)}`);
  doc.text(`N° de série : ${safe(ticket.numeroSerie)}`);
  doc.text(`Commande :    ${safe(ticket.numeroCommande)}    ·    Date d'achat : ${fmtDate(ticket.dateAchat)}`);
  doc.moveDown(0.6);

  // ----- Client (hors fournisseur) -----
  if (tpl.showClient && !tpl.anonymized) {
    const c = ticket.client || {};
    doc.fontSize(12).font('Helvetica-Bold').text(`${section++}. Client`);
    doc.font('Helvetica').fontSize(10);
    doc.text(`Nom :     ${safe(c.nom)}`);
    doc.text(`Email :   ${safe(c.email)}`);
    doc.text(`Téléphone : ${safe(c.telephone)}`);
    doc.moveDown(0.6);
  }

  // ----- Véhicule -----
  if (tpl.showVehicule) {
    doc.fontSize(12).font('Helvetica-Bold').text(`${section++}. Véhicule`);
    doc.font('Helvetica').fontSize(10);
    const v = ticket.vehicule || {};
    doc.text(`Marque/Modèle : ${safe(v.marque)} ${safe(v.modele)}`);
    doc.text(`Motorisation :  ${safe(v.motorisation)}`);
    if (tpl.anonymized) {
      doc.text(`VIN :           ${safe(v.vin && String(v.vin).slice(0, 8) + '…')}`);
    } else {
      doc.text(`VIN :           ${safe(v.vin)}    ·    Immat. : ${safe(v.immatriculation)}`);
    }
    doc.text(`Kilométrage :   ${safe(v.kilometrage)} km`);
    doc.moveDown(0.6);
  }

  // ----- Symptômes -----
  if (tpl.showSymptomes) {
    doc.fontSize(12).font('Helvetica-Bold').text(`${section++}. Symptômes déclarés`);
    doc.font('Helvetica').fontSize(10);
    const symptomes = (ticket.diagnostic && ticket.diagnostic.symptomes) || [];
    if (symptomes.length) symptomes.forEach((s) => doc.text(`• ${s}`));
    else doc.fillColor('#64748b').text('—').fillColor('#1a1a1a');
    const codes = (ticket.diagnostic && ticket.diagnostic.codesDefaut) || [];
    if (codes.length) doc.text(`Codes défaut OBD : ${codes.join(', ')}`);
    doc.moveDown(0.6);
  }

  // ----- Procédure -----
  if (tpl.showProcedure) {
    doc.fontSize(12).font('Helvetica-Bold').text(`${section++}. Procédure de test sur banc`);
    doc.font('Helvetica').fontSize(10).fillColor('#1a1a1a');
    doc.text("• Contrôle visuel et structurel de la pièce à réception");
    doc.text("• Mise en charge sur banc dédié (selon type : DQ200, DQ250, DQ381, DQ500 ou banc d'essai mécanique)");
    doc.text("• Lecture et analyse des paramètres en temps réel (pressions, températures, courants solénoïdes)");
    doc.text("• Tests de passage de rapports / charge / inversion (selon pièce)");
    doc.text("• Confrontation aux valeurs de référence constructeur");
    doc.moveDown(0.6);
  }

  // ----- Résultats -----
  const a = ticket.analyse || {};
  if (tpl.showResultatsTech) {
    doc.fontSize(12).font('Helvetica-Bold').text(`${section++}. Résultats du banc`);
    doc.font('Helvetica').fontSize(10);
    if (a.diagnosticBanc) doc.text(a.diagnosticBanc);
    else doc.fillColor('#64748b').text('Mesures détaillées consignées dans le dossier interne.').fillColor('#1a1a1a');
    if (tpl.showScoreInterne && ticket.diagnostic && ticket.diagnostic.scoreRisque != null) {
      doc.text(`Score de risque interne : ${ticket.diagnostic.scoreRisque} / 100`);
    }
  }

  // Photos banc (si URLs http)
  const photos = tpl.showPhotos ? (a.photosBanc || []).slice(0, 4) : [];
  if (photos.length) {
    doc.moveDown(0.4);
    doc.fontSize(10).fillColor('#475569').text('Photos issues du banc :');
    doc.fillColor('#1a1a1a').moveDown(0.2);
    for (const url of photos) {
      const buf = await fetchBuffer(url);
      if (buf) {
        try {
          if (doc.y > 650) doc.addPage();
          doc.image(buf, { width: 220 });
          doc.moveDown(0.4);
        } catch (_) { /* image non supportée */ }
      }
    }
  }
  doc.moveDown(0.6);

  // ----- Conclusion -----
  if (!tpl.showConclusion) { /* skip */ } else {
  if (doc.y > 640) doc.addPage();
  doc.fontSize(12).font('Helvetica-Bold').fillColor('#1a1a1a').text(`${section++}. Conclusion`);
  const concl = a.conclusion;
  const isGarantie = concl === 'defaut_produit';
  doc.fontSize(11).font('Helvetica-Bold')
    .fillColor(isGarantie ? '#059669' : '#b91c1c')
    .text(CONCLUSION_LABELS[concl] || 'Conclusion non renseignée');
  doc.moveDown(0.4);

  doc.font('Helvetica').fontSize(10).fillColor('#1a1a1a');
  if (tpl.showJustif) {
    doc.text('Justification technique :');
    doc.font('Helvetica').fillColor('#1a1a1a').text(safe(a.justification || a.diagnosticBanc || '—'), {
      width: 499,
      align: 'left',
    });
    doc.moveDown(1);
  }
  } // end showConclusion

  // ----- Signature + QR vérification -----
  const sig = reportSignature(ticket, template);
  const verifyUrl = (process.env.PUBLIC_URL || 'https://www.carpartsfrance.fr') +
    `/api/sav/verify-report/${ticket.numero}?h=${sig}&t=${template}`;
  const qrDataUrl = await buildQrDataUrl(verifyUrl);

  doc.fontSize(10).fillColor('#1a1a1a').text('Technicien : ____________________________   Date : ____ / ____ / ________');
  doc.moveDown(0.4);
  doc.text('Signature :');
  doc.moveDown(0.8);

  if (qrDataUrl) {
    const qrBuf = Buffer.from(qrDataUrl.split(',')[1], 'base64');
    try {
      const qrY = doc.y;
      doc.image(qrBuf, 48, qrY, { width: 70 });
      doc.fontSize(8).fillColor('#475569').text(
        'Document signé numériquement.\nScannez ce QR code pour vérifier l\'authenticité.\nID de signature : ' + sig.slice(0, 12) + '…',
        130, qrY + 4, { width: 380 }
      );
      doc.moveDown(2);
    } catch (_) { /* image insertion fail silent */ }
  } else {
    doc.fontSize(8).fillColor('#475569').text(
      'Signature numérique : ' + sig + '\nVérification : ' + verifyUrl,
      { width: 499 }
    );
    doc.moveDown(1);
  }

  // ----- Footer mentions légales -----
  if (tpl.showLegal) {
    doc.strokeColor('#e5e7eb').lineWidth(0.6).moveTo(48, doc.y).lineTo(547, doc.y).stroke();
    doc.moveDown(0.4);
    doc.fontSize(8).fillColor('#64748b').text(
      `${brand.COMPANY.LEGAL_NAME || brand.NAME}${brand.COMPANY.RCS ? ` — RCS ${brand.COMPANY.RCS}` : ''}${brand.COMPANY.VAT ? ` · TVA intracommunautaire ${brand.COMPANY.VAT}` : ''}. ` +
      "Le présent rapport constitue le compte-rendu de l'analyse réalisée sur banc à la demande du client. " +
      "Conformément aux conditions générales du SAV, en cas de conclusion ne caractérisant pas un défaut produit (mauvais montage, usure normale, pièce non défectueuse), " +
      `le forfait d'analyse de 149 € TTC est dû. En cas d'impayé, conformément à l'article 2286 du Code civil, ${brand.NAME} exerce son droit de rétention sur la pièce.`,
      { align: 'justify' }
    );
  }

  doc.end();

  const buffer = await bufferPromise;

  // Supprime l'ancienne version (même ticket + même template) pour éviter les doublons
  try {
    const existing = await savFileStorage.findByMetadata({
      'metadata.ticketNumero': ticket.numero,
      'metadata.kind': 'rapport_pdf',
      'metadata.template': template,
    });
    for (const f of existing || []) {
      try { await savFileStorage.deleteFile(f._id); } catch (_) {}
    }
  } catch (_) {}

  const stored = await savFileStorage.saveBuffer({
    buffer,
    filename: fileName,
    mime: 'application/pdf',
    metadata: {
      ticketNumero: ticket.numero,
      kind: 'rapport_pdf',
      template,
      uploadedBy: 'system',
    },
  });
  return stored.url;
}

module.exports = { generateAnalysisReport, getTemplateSummary, TEMPLATES, reportSignature };
