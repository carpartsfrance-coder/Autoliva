'use strict';

/**
 * BROCHURE de présentation d'entreprise (PDF, 3 pages) — jointe aux devis.
 * Même charte graphique que le devis (engineQuotePdf.js) : marine #0b2046,
 * rouge #d32f2f, logo Autoliva, primitives WinAnsi (pas de ✓/→/● en texte).
 * Contenu STATIQUE (présentation société), indépendant du client.
 */

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const brand = require('../config/brand');

const C_NAVY       = '#0b2046';
const C_RED        = '#d32f2f';
const C_TEXT       = '#191b23';
const C_TEXT_MUTED = '#43474e';
const C_OUTLINE_LT = '#dfe2eb';
const C_BG_LIGHT   = '#f0f3ff';
const C_BG_VARIANT = '#f4f5f8';
const C_WHITE      = '#ffffff';
const C_NAVY_SUB   = '#8aa0c6'; // texte clair sur fond marine

function buildCompanyBrochurePdf(opts = {}) {
  const NAME = brand.NAME || 'Autoliva';
  const LEGAL = brand.LEGAL_NAME || 'Car Parts France';
  const EMAIL = brand.EMAIL_CONTACT || 'contact@autoliva.com';
  const PHONE = brand.PHONE_MOTEUR || '04 65 84 85 39';
  const SITE = 'autoliva.com';

  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4', margin: 36, bufferPages: true,
      info: { Title: `${NAME} — Présentation`, Author: NAME, Subject: 'Présentation entreprise' },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const M = doc.page.margins.left;
    const W = doc.page.width - M * 2;
    const PW = doc.page.width;
    const PH = doc.page.height;
    const logoPath = path.join(__dirname, '..', '..', 'public', 'images', 'logo-autoliva.png');
    const hasLogo = fs.existsSync(logoPath);

    // ─── Helpers de dessin (primitives, encodage WinAnsi safe) ──────────
    function checkmark(cx, cy, color, size) {
      const s = size || 6;
      doc.save().strokeColor(color).lineWidth(1.5).lineCap('round').lineJoin('round')
        .moveTo(cx - s * 0.6, cy).lineTo(cx - s * 0.1, cy + s * 0.5).lineTo(cx + s * 0.7, cy - s * 0.5)
        .stroke().restore();
    }
    function checkCircle(cx, cy, r, color) {
      doc.save().fillColor(color).circle(cx, cy, r).fill().restore();
      checkmark(cx + 0.2, cy + 0.5, C_WHITE, r);
    }
    function card(x, y, w, h, fill, stroke) {
      doc.save();
      if (fill) doc.roundedRect(x, y, w, h, 7).fill(fill);
      if (stroke) doc.roundedRect(x, y, w, h, 7).lineWidth(0.7).stroke(stroke);
      doc.restore();
    }
    function eyebrow(x, y, label) {
      doc.save().fillColor(C_RED).rect(x, y + 1, 18, 2.4).fill().restore();
      doc.fontSize(9).font('Helvetica-Bold').fillColor(C_RED)
        .text(label.toUpperCase(), x + 24, y - 3, { characterSpacing: 1.2, lineBreak: false });
    }
    // Petite "chip" carrée colorée + glyphe blanc
    function chip(x, y, s, fill) { doc.save().roundedRect(x, y, s, s, 5).fill(fill).restore(); }
    function glyphShield(cx, cy) {
      doc.save().strokeColor(C_WHITE).lineWidth(1.3).lineJoin('round')
        .moveTo(cx, cy - 6).lineTo(cx + 5, cy - 3.5).lineTo(cx + 5, cy + 1)
        .bezierCurveTo(cx + 5, cy + 4.5, cx + 2.5, cy + 6, cx, cy + 7)
        .bezierCurveTo(cx - 2.5, cy + 6, cx - 5, cy + 4.5, cx - 5, cy + 1)
        .lineTo(cx - 5, cy - 3.5).closePath().stroke().restore();
      checkmark(cx, cy, C_WHITE, 5);
    }
    function glyphGauge(cx, cy) {
      doc.save().strokeColor(C_WHITE).lineWidth(1.3).circle(cx, cy + 1, 6).stroke().restore();
      doc.save().strokeColor(C_WHITE).lineWidth(1.3).lineCap('round').moveTo(cx, cy + 1).lineTo(cx + 3, cy - 2.5).stroke().restore();
      doc.save().fillColor(C_WHITE).circle(cx, cy + 1, 1.2).fill().restore();
    }
    function glyphTruck(cx, cy) {
      doc.save().strokeColor(C_WHITE).lineWidth(1.2).lineJoin('round');
      doc.rect(cx - 7, cy - 4, 8, 7).stroke();
      doc.moveTo(cx + 1, cy - 1).lineTo(cx + 5, cy - 1).lineTo(cx + 7, cy + 1).lineTo(cx + 7, cy + 3).lineTo(cx + 1, cy + 3).closePath().stroke();
      doc.restore();
      doc.save().fillColor(C_WHITE).circle(cx - 4, cy + 4, 1.6).fill().circle(cx + 4, cy + 4, 1.6).fill().restore();
    }
    function glyphCard(cx, cy) {
      doc.save().strokeColor(C_WHITE).lineWidth(1.2).roundedRect(cx - 7, cy - 4.5, 14, 9, 1.5).stroke().restore();
      doc.save().fillColor(C_WHITE).rect(cx - 7, cy - 2, 14, 2).fill().restore();
    }

    // ════════════════════════ PAGE 1 — COUVERTURE ════════════════════════
    // En-tête
    if (hasLogo) { try { doc.image(logoPath, M, 40, { height: 40 }); } catch (_) {} }
    doc.fontSize(8).font('Helvetica').fillColor(C_TEXT_MUTED)
      .text('anciennement ' + LEGAL, M, 84, { lineBreak: false });
    doc.save().roundedRect(PW - M - 168, 46, 168, 26, 13).fill(C_BG_LIGHT).restore();
    doc.fontSize(8.5).font('Helvetica-Bold').fillColor(C_NAVY)
      .text('DOSSIER DE PRÉSENTATION', PW - M - 168, 54, { width: 168, align: 'center', characterSpacing: 0.5, lineBreak: false });
    doc.moveTo(M, 104).lineTo(M + W, 104).strokeColor(C_OUTLINE_LT).lineWidth(0.7).stroke();

    // Hero
    let y = 150;
    doc.fontSize(9).font('Helvetica-Bold').fillColor(C_RED)
      .text('PIÈCES AUTOMOBILES RECONDITIONNÉES PREMIUM', M, y, { characterSpacing: 1.2, lineBreak: false });
    y += 22;
    doc.fontSize(27).font('Helvetica-Bold').fillColor(C_NAVY)
      .text('Des moteurs et pièces auto\ntestés, garantis, prêts à rouler.', M, y, { width: W - 40, lineGap: 4 });
    y += 78;
    doc.save().fillColor(C_RED).rect(M, y, 46, 3).fill().restore();
    y += 16;
    doc.fontSize(12).font('Helvetica').fillColor(C_TEXT_MUTED)
      .text("Testées sur banc d'essai, certifiées et expédiées rapidement partout en Europe — pour les particuliers comme pour les professionnels.",
        M, y, { width: W - 30, lineGap: 3 });

    // Preuve sociale (avis clients confirmés)
    doc.fontSize(11).font('Helvetica-Bold').fillColor(C_NAVY)
      .text('Déjà plus de 1 000 clients satisfaits en Europe', M, 336, { width: W, align: 'center', lineBreak: false });
    doc.fontSize(9).font('Helvetica').fillColor(C_TEXT_MUTED)
      .text('Particuliers et professionnels nous font confiance.', M, 351, { width: W, align: 'center', lineBreak: false });

    // Bandeau de réassurance (marine) — 3 colonnes
    const bandY = 384, bandH = 116;
    card(M, bandY, W, bandH, C_NAVY);
    const cols = [
      { g: glyphShield, t: 'Testé & certifié', s: "sur banc d'essai" },
      { g: glyphGauge,  t: 'Garantie incluse', s: '6 mois à 1 an selon l\'état' },
      { g: glyphTruck,  t: 'Expédition rapide', s: 'partout en Europe' },
    ];
    const colW = W / 3;
    cols.forEach((c, i) => {
      const cx = M + colW * i + colW / 2;
      chip(cx - 16, bandY + 26, 32, C_RED);
      c.g(cx, bandY + 42);
      doc.fontSize(12).font('Helvetica-Bold').fillColor(C_WHITE)
        .text(c.t, M + colW * i, bandY + 70, { width: colW, align: 'center', lineBreak: false });
      doc.fontSize(9.5).font('Helvetica').fillColor(C_NAVY_SUB)
        .text(c.s, M + colW * i, bandY + 88, { width: colW, align: 'center', lineBreak: false });
      if (i < 2) doc.save().strokeColor('#1c2f57').lineWidth(0.7).moveTo(M + colW * (i + 1), bandY + 24).lineTo(M + colW * (i + 1), bandY + bandH - 24).stroke().restore();
    });

    // Accroche bas de page
    const accY = bandY + bandH + 26;
    card(M, accY, W, 64, C_BG_VARIANT);
    doc.save().fillColor(C_RED).rect(M, accY, 3, 64).fill().restore();
    doc.fontSize(11.5).font('Helvetica-Oblique').fillColor(C_NAVY)
      .text('Ce dossier accompagne votre devis. Prenez le temps de comparer :\nnous, nous prenons le temps de tout contrôler.', M + 20, accY + 16, { width: W - 40, lineGap: 3 });

    // Pied de couverture
    doc.fontSize(8.5).font('Helvetica').fillColor(C_TEXT_MUTED)
      .text(NAME + '  ·  ' + PHONE + '  ·  ' + EMAIL + '  ·  ' + SITE, M, PH - 48, { width: W, align: 'center', lineBreak: false });

    // En-tête interne réutilisable (pages 2-3)
    function interiorHeader(title) {
      if (hasLogo) { try { doc.image(logoPath, M, 34, { height: 24 }); } catch (_) {} }
      doc.fontSize(8.5).font('Helvetica-Bold').fillColor(C_TEXT_MUTED)
        .text(title.toUpperCase(), PW - M - 220, 40, { width: 220, align: 'right', characterSpacing: 1, lineBreak: false });
      doc.moveTo(M, 68).lineTo(M + W, 68).strokeColor(C_OUTLINE_LT).lineWidth(0.7).stroke();
    }
    function pageFooter(n) {
      // y DOIT rester au-dessus de la marge basse (PH - 36 = 806), sinon pdfkit
      // insère une page fantôme.
      const fy = PH - 50;
      doc.fontSize(8).font('Helvetica').fillColor('#8b9099')
        .text(NAME + ' — présentation', M, fy, { lineBreak: false });
      doc.fontSize(8).font('Helvetica').fillColor('#8b9099')
        .text('Page ' + n + '/3', PW - M - 80, fy, { width: 80, align: 'right', lineBreak: false });
    }

    // ═══════════════════ PAGE 2 — QUI SOMMES-NOUS / CONFIANCE ═══════════════════
    doc.addPage();
    interiorHeader('Présentation de l\'entreprise');

    let y2 = 92;
    eyebrow(M, y2, 'Qui sommes-nous');
    y2 += 22;
    doc.fontSize(17).font('Helvetica-Bold').fillColor(C_NAVY)
      .text('Spécialiste des moteurs et pièces auto reconditionnés et testés', M, y2, { width: W, lineGap: 1 });
    y2 += 26;
    doc.fontSize(10.5).font('Helvetica').fillColor(C_TEXT_MUTED)
      .text(NAME + ' (raison sociale ' + LEGAL + ') reconditionne et contrôle chaque pièce dans son atelier avant expédition, pour toutes les marques et tous les modèles. Notre métier : vous livrer une pièce fiable, documentée et garantie, sans mauvaise surprise — que vous soyez un particulier ou un garage professionnel.',
        M, y2, { width: W, lineGap: 3 });
    y2 += 56;

    eyebrow(M, y2, 'Pourquoi nous faire confiance');
    y2 += 24;
    const vp = [
      { icon: glyphShield, fill: C_RED,  t: 'Garantie écrite', d: 'Occasion : 6 mois, sans franchise kilométrique, transférable à la revente. Reconditionné : 1 an.' },
      { icon: glyphGauge,  fill: C_NAVY, t: 'Contrôlé & certifié', d: "Chaque moteur passe sur banc d'essai : compression, étanchéité, endoscopie. Rapport de test + attestation fournis." },
      { icon: glyphTruck,  fill: C_NAVY, t: 'Expédition rapide', d: 'Logistique optimisée, emballage sécurisé et suivi colis, partout en Europe une fois la pièce prête et payée.' },
      { icon: glyphCard,   fill: C_RED,  t: 'Paiement flexible', d: 'Réglez en 3 ou 4 fois si vous le souhaitez : solution de financement immédiate et 100% sécurisée.' },
    ];
    const cardW = (W - 14) / 2, cardH = 96, gapX = 14, gapY = 14;
    vp.forEach((v, i) => {
      const cx = M + (i % 2) * (cardW + gapX);
      const cy = y2 + Math.floor(i / 2) * (cardH + gapY);
      card(cx, cy, cardW, cardH, C_WHITE, C_OUTLINE_LT);
      chip(cx + 16, cy + 16, 30, v.fill);
      v.icon(cx + 31, cy + 31);
      doc.fontSize(12.5).font('Helvetica-Bold').fillColor(C_NAVY)
        .text(v.t, cx + 56, cy + 18, { width: cardW - 70, lineBreak: false });
      doc.fontSize(9.5).font('Helvetica').fillColor(C_TEXT_MUTED)
        .text(v.d, cx + 56, cy + 36, { width: cardW - 70, height: cardH - 44, lineGap: 2 });
    });
    y2 += cardH * 2 + gapY + 24;

    // Bandeau garanties
    card(M, y2, W, 58, C_BG_LIGHT);
    doc.fontSize(10).font('Helvetica-Bold').fillColor(C_NAVY)
      .text('NOS GARANTIES', M + 20, y2 + 12, { characterSpacing: 1, lineBreak: false });
    doc.fontSize(11).font('Helvetica').fillColor(C_TEXT)
      .text("Moteur d'occasion testé : 6 mois, sans franchise km, transférable   ·   Moteur reconditionné : 1 an",
        M + 20, y2 + 30, { width: W - 40, lineBreak: false });
    y2 += 58 + 30;

    // Preuve sociale + partenaires
    eyebrow(M, y2, 'Ils nous font confiance');
    y2 += 22;
    doc.fontSize(16).font('Helvetica-Bold').fillColor(C_NAVY)
      .text('Plus de 1 000 clients satisfaits en Europe', M, y2, { width: W, lineBreak: false });
    y2 += 23;
    doc.fontSize(10).font('Helvetica').fillColor(C_TEXT_MUTED)
      .text('Professionnels et particuliers nous font confiance. Nos moteurs ont été montés par :', M, y2, { width: W, lineBreak: false });
    y2 += 22;
    const partners = ['logo-porsche.png', 'sun-motors.png', 'mougins-autosport.png', 'chassay-automobiles.png', 'LOGO-SIMPLICI-CAR-NOIR-copie.png'];
    const logoH = 86;
    card(M, y2, W, logoH, C_WHITE, C_OUTLINE_LT);
    const slotW = W / partners.length;
    partners.forEach((p, i) => {
      const lp = path.join(__dirname, '..', '..', 'public', 'images', 'partenaires', p);
      if (!fs.existsSync(lp)) return;
      try { doc.image(lp, M + slotW * i + 16, y2 + 20, { fit: [slotW - 32, logoH - 40], align: 'center', valign: 'center' }); } catch (_) {}
      if (i < partners.length - 1) doc.save().strokeColor(C_OUTLINE_LT).lineWidth(0.6).moveTo(M + slotW * (i + 1), y2 + 18).lineTo(M + slotW * (i + 1), y2 + logoH - 18).stroke().restore();
    });

    pageFooter(2);

    // ═══════════════════ PAGE 3 — OFFRE / PROCESS / CONTACT ═══════════════════
    doc.addPage();
    interiorHeader('Notre offre & comment ça marche');

    let y3 = 92;
    eyebrow(M, y3, 'Notre offre');
    y3 += 24;
    const services = [
      { t: "Moteurs d'occasion testés", d: 'Testés sur banc, kilométrage certifié, garantie 6 mois. Le meilleur rapport qualité/prix.' },
      { t: 'Moteurs reconditionnés', d: "Pièces d'usure remplacées, remontage aux couples constructeur, garantie 1 an. Comme neufs." },
      { t: 'Boîtes de vitesses', d: "D'occasion et reconditionnées, contrôlées avant expédition, pour particuliers et professionnels." },
      { t: 'Pièces multi-marques', d: 'Boîtes de transfert, différentiels, mécatroniques, optiques et pièces reconditionnées testées.' },
    ];
    const sW = (W - 14) / 2, sH = 76;
    services.forEach((s, i) => {
      const cx = M + (i % 2) * (sW + 14);
      const cy = y3 + Math.floor(i / 2) * (sH + 12);
      card(cx, cy, sW, sH, C_WHITE, C_OUTLINE_LT);
      doc.save().fillColor(C_RED).roundedRect(cx, cy, 3.5, sH, 1).fill().restore();
      doc.fontSize(12).font('Helvetica-Bold').fillColor(C_NAVY)
        .text(s.t, cx + 16, cy + 14, { width: sW - 28, lineBreak: false });
      doc.fontSize(9.5).font('Helvetica').fillColor(C_TEXT_MUTED)
        .text(s.d, cx + 16, cy + 32, { width: sW - 28, height: sH - 38, lineGap: 2 });
    });
    y3 += sH * 2 + 12 + 26;

    eyebrow(M, y3, 'Comment ça marche');
    y3 += 26;
    const steps = [
      { t: 'Votre devis', d: 'Plaque, châssis ou code moteur' },
      { t: 'Sourcing', d: 'Réseau, réponse sous 24 h' },
      { t: 'Contrôle & rapport', d: 'Banc d\'essai, attestation' },
      { t: 'Expédition', d: 'Sécurisée, partout en Europe' },
    ];
    const stepW = W / 4;
    // ligne de liaison
    doc.save().strokeColor(C_OUTLINE_LT).lineWidth(1).moveTo(M + stepW / 2, y3 + 16).lineTo(M + W - stepW / 2, y3 + 16).stroke().restore();
    steps.forEach((s, i) => {
      const cx = M + stepW * i + stepW / 2;
      doc.save().fillColor(C_NAVY).circle(cx, y3 + 16, 15).fill().restore();
      doc.fontSize(12).font('Helvetica-Bold').fillColor(C_WHITE)
        .text(String(i + 1), cx - 15, y3 + 10, { width: 30, align: 'center', lineBreak: false });
      doc.fontSize(10.5).font('Helvetica-Bold').fillColor(C_NAVY)
        .text(s.t, M + stepW * i, y3 + 40, { width: stepW, align: 'center', lineBreak: false });
      doc.fontSize(8.5).font('Helvetica').fillColor(C_TEXT_MUTED)
        .text(s.d, M + stepW * i + 4, y3 + 56, { width: stepW - 8, align: 'center', lineGap: 1 });
    });
    y3 += 92;

    // Bloc contact / CTA (marine)
    const ctaH = 132;
    const ctaY = Math.min(y3 + 6, PH - 36 - ctaH);
    card(M, ctaY, W, ctaH, C_NAVY);
    doc.fontSize(15).font('Helvetica-Bold').fillColor(C_WHITE)
      .text('Demandez votre devis gratuit dès maintenant', M + 24, ctaY + 20, { width: W - 48, lineBreak: false });
    doc.fontSize(10).font('Helvetica').fillColor(C_NAVY_SUB)
      .text('Réponse sous 24 h ouvrées, sans engagement.', M + 24, ctaY + 42, { width: W - 48, lineBreak: false });
    // colonnes contact
    const cyc = ctaY + 70;
    const contacts = [
      ['Téléphone', PHONE],
      ['Email', EMAIL],
      ['Site', SITE],
    ];
    const ccW = (W - 48) / 3;
    contacts.forEach((c, i) => {
      const x = M + 24 + ccW * i;
      doc.fontSize(8).font('Helvetica-Bold').fillColor(C_NAVY_SUB)
        .text(c[0].toUpperCase(), x, cyc, { characterSpacing: 0.8, lineBreak: false });
      doc.fontSize(11.5).font('Helvetica-Bold').fillColor(C_WHITE)
        .text(c[1], x, cyc + 13, { width: ccW - 8, lineBreak: false });
    });
    doc.fontSize(8.5).font('Helvetica').fillColor(C_NAVY_SUB)
      .text(LEGAL + ' · 50 Boulevard Stalingrad, 06300 Nice · du lundi au vendredi, 08:00–18:00', M + 24, ctaY + ctaH - 24, { width: W - 48, lineBreak: false });

    pageFooter(3);

    doc.end();
  });
}

// Brochure STATIQUE : on la génère une seule fois par process et on met le
// buffer en cache (réutilisé pour tous les devis).
let _brochureCache = null;
async function getCompanyBrochureBuffer() {
  if (_brochureCache) return _brochureCache;
  _brochureCache = await buildCompanyBrochurePdf();
  return _brochureCache;
}

module.exports = { buildCompanyBrochurePdf, getCompanyBrochureBuffer };
