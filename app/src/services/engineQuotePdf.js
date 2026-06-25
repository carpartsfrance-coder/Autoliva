'use strict';

/**
 * PDF DEVIS — Layout corporate B2B Autoliva (2 pages strictes).
 * Design reproduit depuis le projet Google Stitch "Devis Autoliva".
 *
 * Page 1 = récap commercial · Page 2 = annexe technique
 *
 * Notes techniques :
 * - Helvetica intégré pdfkit = encodage WinAnsi → pas de "●" / "✓" / "→"
 *   Solution : on dessine bullets/checks comme primitives (circle, lineTo)
 * - Tous les blocs texte sont sizés via heightOfString + truncation pour
 *   empêcher pdfkit d'auto-paginer.
 */

const PDFDocument = require('pdfkit');
const path = require('path');
const fs = require('fs');
const brand = require('../config/brand');
const { partLexicon } = require('./partLexicon');

const C_NAVY        = '#0b2046';
const C_RED         = '#d32f2f';
const C_TEXT        = '#191b23';
const C_TEXT_MUTED  = '#43474e';
const C_OUTLINE     = '#c4c6cf';
const C_OUTLINE_LT  = '#dfe2eb';
const C_BG_LIGHT    = '#f0f3ff';
const C_BG_VARIANT  = '#f4f5f8';
const C_WHITE       = '#ffffff';

function fmtEur(n) {
  const num = Number(n) || 0;
  const fixed = num.toFixed(2).replace('.', ',');
  const [intPart, decPart] = fixed.split(',');
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ',' + decPart + ' EUR';
}
function fmtEurSymbol(n) {
  // Avec € (symbole ok en WinAnsi)
  const num = Number(n) || 0;
  const fixed = num.toFixed(2).replace('.', ',');
  const [intPart, decPart] = fixed.split(',');
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ',' + decPart + ' €';
}
function fmtDateFr(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: 'long', year: 'numeric' });
}
// Format compact (numérique) avec heure : 02/06/2026 09:31
function fmtDateTimeShort(d) {
  if (!d) return '';
  return new Date(d).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })
    + ' ' + new Date(d).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}
function fmtMileage(km) {
  if (!km) return '';
  return String(km).replace(/\B(?=(\d{3})+(?!\d))/g, ' ') + ' km';
}
function truncate(s, max) {
  if (!s) return '';
  if (s.length <= max) return s;
  return s.slice(0, max - 1).trim() + '…';
}

function buildQuotePdf(input) {
  const lex = partLexicon(input.category);
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({
      size: 'A4',
      margin: 36,
      bufferPages: true,
      info: {
        Title: `Devis ${input.quoteRef || ''} — Autoliva`,
        Author: 'Autoliva',
        Subject: lex.devisSubject,
      },
    });
    const chunks = [];
    doc.on('data', c => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const M = doc.page.margins.left;
    const W = doc.page.width - M * 2;
    const PH = doc.page.height;
    const eur = fmtEurSymbol;  // alias court pour formater EUR avec symbole

    // ─── Données pré-calculées ───────────────────────────────────────
    const sellHt = Number(input.pricing && input.pricing.sellPrice) || 0;
    const vatRate = Number(input.pricing && input.pricing.vatRate) || 20;
    // Régime de TVA : 'margin' (TVA sur marge, art. 297 A CGI) = défaut pour les
    // moteurs d'occasion. En marge, le prix de vente EST le prix tout compris
    // (pas de +20 %) et on ne détaille PAS la TVA au client.
    const isMarginScheme = !(input.pricing && input.pricing.vatScheme === 'normal');
    // Garantie dérivée de l'état du moteur : occasion 6 mois, reconditionné 12 mois.
    const warrantyMonths = Number(input.warrantyMonths) || (input.isReconditionne ? 12 : 6);
    const vatAmount = isMarginScheme ? 0 : sellHt * (vatRate / 100);
    const sellTtc = isMarginScheme ? sellHt : sellHt + vatAmount;
    const depositTtc = (Number(input.depositCents) || 0) / 100;
    const isFull = depositTtc > 0 && Math.abs(depositTtc - sellTtc) < 0.01;
    const remainingTtc = Math.max(sellTtc - depositTtc, 0);
    // Validité 24h : le moteur peut être vendu entre-temps → on crée l'urgence.
    const validUntil = new Date(Date.now() + 24 * 60 * 60 * 1000);

    // ─── Helpers de dessin ──────────────────────────────────────────
    function bullet(cx, cy, color) {
      doc.save().circle(cx, cy, 2).fillColor(color).fill().restore();
    }
    function infoIcon(cx, cy, color) {
      // Cercle "i" — cercle vide + point + barre verticale
      doc.save().strokeColor(color).lineWidth(0.8).circle(cx, cy, 5).stroke();
      doc.save().fillColor(color).circle(cx, cy - 1.5, 0.7).fill().restore();
      doc.save().strokeColor(color).lineWidth(0.8).moveTo(cx, cy).lineTo(cx, cy + 2.5).stroke().restore();
      doc.restore();
    }
    function checkmark(cx, cy, color, size) {
      const s = size || 6;
      doc.save().strokeColor(color).lineWidth(1.5).lineCap('round').lineJoin('round')
        .moveTo(cx - s * 0.6, cy)
        .lineTo(cx - s * 0.1, cy + s * 0.5)
        .lineTo(cx + s * 0.7, cy - s * 0.5)
        .stroke().restore();
    }
    function checkCircle(cx, cy, color) {
      doc.save().fillColor(color).circle(cx, cy, 7).fill().restore();
      checkmark(cx + 0.2, cy + 0.5, C_WHITE, 7);
    }
    function card(x, y, w, h, fillColor) {
      doc.save();
      if (fillColor) doc.roundedRect(x, y, w, h, 6).fill(fillColor);
      doc.roundedRect(x, y, w, h, 6).strokeColor(C_OUTLINE_LT).lineWidth(0.8).stroke();
      doc.restore();
    }
    // Flèche droite dessinée en primitive (WinAnsi ne rend pas "→")
    function rightArrow(x, cy, color, len) {
      const l = len || 7;
      doc.save().strokeColor(color).lineWidth(1.2).lineCap('round').lineJoin('round')
        .moveTo(x, cy).lineTo(x + l, cy)
        .moveTo(x + l - 3, cy - 3).lineTo(x + l, cy).lineTo(x + l - 3, cy + 3)
        .stroke().restore();
    }
    // Bouton d'action rempli (CTA paiement) : rectangle arrondi + label centré
    // (blanc) + flèche, toute la surface étant un lien cliquable.
    function payButton(x, y, w, h, label, url) {
      doc.save().roundedRect(x, y, w, h, 5).fill(C_RED).restore();
      const fs = 9;
      doc.fontSize(fs).font('Helvetica-Bold');
      const tw = doc.widthOfString(label);
      const gap = 6, arrowLen = 8;
      const groupW = tw + gap + arrowLen;
      const startX = x + (w - groupW) / 2;
      doc.fillColor(C_WHITE).text(label, startX, y + (h - fs) / 2 - 1, { lineBreak: false });
      rightArrow(startX + tw + gap, y + h / 2, C_WHITE, arrowLen);
      if (url) doc.link(x, y, w, h, url);
    }

    // ─── Header (commun aux 2 pages) ────────────────────────────────
    function drawHeader() {
      const logoPath = path.join(__dirname, '..', '..', 'public', 'images', 'logo-autoliva.png');
      // Logo seul à gauche (le nom "Autoliva" est déjà dans l'image du logo).
      if (fs.existsSync(logoPath)) {
        try { doc.image(logoPath, M, 38, { height: 34 }); } catch (_) {}
      } else {
        // Fallback texte si l'image manque
        doc.fontSize(24).font('Helvetica-Bold').fillColor(C_NAVY).text(brand.NAME || 'Autoliva', M, 38, { lineGap: -4 });
      }
      doc.fontSize(20).font('Helvetica-Bold').fillColor(C_NAVY).text('DEVIS', M + W - 200, 40, { width: 200, align: 'right', characterSpacing: 1.5 });
      doc.fontSize(9).font('Helvetica').fillColor(C_TEXT_MUTED).text(input.isReconditionne ? lex.headerLabelReconditionne : lex.headerLabel, M + W - 200, 64, { width: 200, align: 'right' });
      doc.moveTo(M, 84).lineTo(M + W, 84).strokeColor(C_OUTLINE_LT).lineWidth(0.6).stroke();
    }

    // ─── Footer ─────────────────────────────────────────────────────
    function drawFooter(pageLabel) {
      const fY = PH - 36 - 16;
      doc.moveTo(M, fY).lineTo(M + W, fY).strokeColor(C_OUTLINE_LT).lineWidth(0.5).stroke();
      doc.fontSize(7).font('Helvetica').fillColor(C_TEXT_MUTED);
      const left = [
        brand.NAME || 'Autoliva',
        brand.EMAIL_CONTACT || 'contact@autoliva.com',
        brand.PHONE_MOTEUR || '04 65 84 85 39',
        'autoliva.com',
      ].join(' · ');
      doc.text(left, M, fY + 7, { width: W - 60, lineBreak: false });
      // Le numéro de page (Page X/Y) est écrit en fin de génération (numérotation dynamique).
    }

    // ═════════════════════════════════════════════════════════════════
    // PAGE 1
    // ═════════════════════════════════════════════════════════════════
    drawHeader();
    let y = 98;

    // ─── 3 INFO CARDS ──────────────────────────────────────────────
    const gp = 8;
    const cw = (W - gp * 2) / 3;
    const ch = 92;

    function infoCard(x, y, label, lines) {
      card(x, y, cw, ch, C_WHITE);
      // Pastille label en haut
      doc.save().fillColor(C_BG_LIGHT).circle(x + 14, y + 14, 7).fill().restore();
      bullet(x + 14, y + 14, C_NAVY);
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor(C_NAVY).text(label.toUpperCase(), x + 28, y + 10, { characterSpacing: 1, lineBreak: false });
      // Lignes
      let cy = y + 28;
      lines.forEach((line, i) => {
        if (i === 0) {
          doc.fontSize(10).font('Helvetica-Bold').fillColor(C_TEXT).text(line, x + 14, cy, { width: cw - 28, height: 12, lineBreak: false, ellipsis: true });
          cy += 13;
        } else {
          doc.fontSize(8.5).font('Helvetica').fillColor(C_TEXT_MUTED).text(line, x + 14, cy, { width: cw - 28, height: 10, lineBreak: false, ellipsis: true });
          cy += 11;
        }
      });
    }

    infoCard(M, y, 'Émetteur', [
      brand.NAME || 'Autoliva',
      brand.EMAIL_CONTACT || 'contact@autoliva.com',
      brand.PHONE_MOTEUR || '04 65 84 85 39',
      'autoliva.com',
    ]);
    infoCard(M + cw + gp, y, 'Client', [
      truncate(input.customerName || '—', 30),
      truncate(input.customerEmail || '', 30),
      input.customerPhone || '',
      input.plate ? 'Véhicule : ' + input.plate : '',
    ]);
    infoCard(M + (cw + gp) * 2, y, 'Informations devis', [
      'N° ' + (input.quoteRef || '—'),
      'Émis le ' + fmtDateTimeShort(new Date()),
      'Valable 7 jours',
    ]);
    y += ch + 12;

    // ─── RÉSUMÉ DE L'OFFRE ─────────────────────────────────────────
    const resH = 102;
    card(M, y, W, resH, C_BG_LIGHT);
    doc.save().fillColor(C_WHITE).circle(M + 14, y + 14, 7).fill().restore();
    bullet(M + 14, y + 14, C_NAVY);
    doc.fontSize(8).font('Helvetica-Bold').fillColor(C_NAVY).text('RÉSUMÉ DE L\'OFFRE', M + 28, y + 10, { characterSpacing: 1, lineBreak: false });

    // 3 price cards à droite
    const pcW = 100;
    const pcH = 64;
    const pcGap = 8;
    const pcStartX = M + W - (pcW * 3 + pcGap * 2) - 14;
    const pcY = y + (resH - pcH) / 2 + 6;

    // Description gauche (largeur limitée par les price cards)
    const descMaxW = pcStartX - M - 28;
    const resumeTitle = input.conditionLabel || lex.defaultCondition;
    doc.fontSize(10.5).font('Helvetica-Bold').fillColor(C_TEXT).text(
      resumeTitle,
      M + 14, y + 36, { width: descMaxW, lineBreak: true, ellipsis: true, height: 26 }
    );
    doc.fontSize(8).font('Helvetica').fillColor(C_TEXT_MUTED).text(
      `Compatible véhicule ${input.plate || '—'} · garantie ${warrantyMonths} mois sans limite km · devis valable 7 jours (${lex.peutEtreVendu})`,
      M + 14, y + 66, { width: descMaxW, lineBreak: true, height: 30, ellipsis: true }
    );

    function priceCard(x, y, label, value, valueColor) {
      doc.save();
      doc.roundedRect(x, y, pcW, pcH, 6).fillAndStroke(C_WHITE, C_OUTLINE_LT);
      doc.restore();
      doc.fontSize(7).font('Helvetica-Bold').fillColor(C_TEXT_MUTED).text(label, x, y + 12, { width: pcW, align: 'center', characterSpacing: 1, lineBreak: false });
      doc.fontSize(12).font('Helvetica-Bold').fillColor(valueColor).text(value, x, y + 30, { width: pcW, align: 'center', lineBreak: false });
    }
    priceCard(pcStartX, pcY, isMarginScheme ? 'PRIX TOTAL' : 'TOTAL TTC', eur(sellTtc), C_NAVY);
    priceCard(pcStartX + pcW + pcGap, pcY, isFull ? 'PAIEMENT' : 'ACOMPTE', depositTtc > 0 ? eur(depositTtc) : '—', C_RED);
    priceCard(pcStartX + (pcW + pcGap) * 2, pcY, 'SOLDE', remainingTtc > 0 && !isFull ? eur(remainingTtc) : '—', C_NAVY);

    // Si Mollie URL fournie, rendre la card ACOMPTE cliquable
    if (input.mollieUrl && depositTtc > 0) {
      const acoX = pcStartX + pcW + pcGap;
      doc.link(acoX, pcY, pcW, pcH, input.mollieUrl);
      doc.fontSize(6.5).font('Helvetica').fillColor(C_RED).text('cliquez pour payer', acoX, pcY + pcH - 12, { width: pcW, align: 'center', lineBreak: false });
    }

    y += resH + 12;

    // ─── TABLEAU ARTICLE ───────────────────────────────────────────
    const thH = 22;
    const trH = input.conditionBadge ? 68 : 60;
    // Header navy
    doc.save();
    doc.roundedRect(M, y, W, thH, 6).fill(C_NAVY);
    doc.rect(M, y + thH - 6, W, 6).fill(C_NAVY);
    doc.restore();
    doc.fontSize(8).font('Helvetica-Bold').fillColor(C_WHITE);
    doc.text('ARTICLE', M + 14, y + 7, { characterSpacing: 1, lineBreak: false });
    doc.text('GARANTIE', M + W - 240, y + 7, { width: 100, align: 'center', characterSpacing: 1, lineBreak: false });
    doc.text(isMarginScheme ? 'PRIX' : 'PRIX HT', M + W - 130, y + 7, { width: 116, align: 'right', characterSpacing: 1, lineBreak: false });

    const tr = y + thH;
    // Engine description sur 1-2 lignes max
    const engineTitle = (input.engine && input.engine.model)
      ? input.engine.model + (input.engine.code ? ' · ' + input.engine.code : '')
      : (input.conditionLabel || lex.defaultCondition);
    const engineSubParts = [
      input.engine && input.engine.year ? input.engine.year : '',
      input.engine && input.engine.mileage > 0 ? fmtMileage(input.engine.mileage) + ' certifiés' : '',
    ].filter(Boolean).join(' · ');

    const articleW = W - 280;
    // Layout adaptatif selon présence du badge condition (recond/occasion)
    // - Avec badge : badge ligne 1, titre ligne 2, specs ligne 3, stock ligne 4
    // - Sans badge : titre ligne 1, specs ligne 2, stock ligne 3
    let articleY = tr + 10;
    if (input.conditionBadge) {
      const badgeText = input.conditionBadge.toUpperCase();
      const badgeColor = input.isReconditionne ? C_RED : C_NAVY;
      doc.fontSize(7).font('Helvetica-Bold');
      const badgeW = doc.widthOfString(badgeText) + 12;
      doc.save();
      doc.roundedRect(M + 14, articleY, badgeW, 12, 2).fill(badgeColor);
      doc.restore();
      doc.fontSize(7).font('Helvetica-Bold').fillColor(C_WHITE).text(badgeText, M + 14, articleY + 2, { width: badgeW, align: 'center', lineBreak: false, characterSpacing: 0.8 });
      articleY += 16;
    }
    doc.fontSize(10).font('Helvetica-Bold').fillColor(C_TEXT).text(
      truncate(engineTitle, 80), M + 14, articleY, { width: articleW, height: 13, lineBreak: false, ellipsis: true }
    );
    articleY += 14;
    if (engineSubParts) {
      doc.fontSize(8).font('Helvetica').fillColor(C_TEXT_MUTED).text(
        truncate(engineSubParts, 110), M + 14, articleY, { width: articleW, height: 11, lineBreak: false, ellipsis: true }
      );
      articleY += 12;
    }
    if (input.stockLabel) {
      doc.fontSize(8).font('Helvetica-Bold').fillColor(C_RED).text(
        input.stockLabel + (input.delay ? ' · ' + input.delay : ''),
        M + 14, articleY, { width: articleW, height: 11, lineBreak: false, ellipsis: true }
      );
    }
    doc.fontSize(10).font('Helvetica').fillColor(C_TEXT_MUTED).text(warrantyMonths + ' mois', M + W - 240, tr + 22, { width: 100, align: 'center', lineBreak: false });
    doc.fontSize(11).font('Helvetica-Bold').fillColor(C_TEXT).text(eur(sellHt), M + W - 130, tr + 22, { width: 116, align: 'right', lineBreak: false });

    doc.moveTo(M, tr + trH).lineTo(M + W, tr + trH).strokeColor(C_OUTLINE_LT).lineWidth(0.5).stroke();
    y = tr + trH + 14;

    // ─── 2 COLS : MODALITÉS | TOTAUX ───────────────────────────────
    const bH = 160;
    const totW = 230;
    const modW = W - totW - 12;

    // Modalités
    card(M, y, modW, bH, C_WHITE);
    doc.save().fillColor(C_BG_LIGHT).circle(M + 14, y + 14, 7).fill().restore();
    bullet(M + 14, y + 14, C_NAVY);
    doc.fontSize(7.5).font('Helvetica-Bold').fillColor(C_NAVY).text(lex.reserveTitle, M + 28, y + 10, { characterSpacing: 1, lineBreak: false });

    doc.fontSize(9).font('Helvetica').fillColor(C_TEXT).text(
      depositTtc > 0
        ? 'Le versement de l\'acompte permet de bloquer la pièce, lancer la préparation et organiser l\'expédition.'
        : 'Pour commander, contactez notre équipe : nous confirmons la disponibilité, puis lançons la préparation et l\'expédition.',
      M + 14, y + 32, { width: modW - 28, height: 28, lineGap: 1 }
    );
    doc.moveTo(M + 14, y + 70).lineTo(M + modW - 14, y + 70).strokeColor(C_OUTLINE_LT).lineWidth(0.5).stroke();
    doc.fontSize(8).font('Helvetica').fillColor(C_TEXT_MUTED).text('Modalités de paiement :', M + 14, y + 76, { lineBreak: false });

    const bullets = [
      depositTtc > 0
        ? (isFull ? 'Paiement intégral : ' + eur(depositTtc) : 'Acompte immédiat : ' + eur(depositTtc))
        : 'Paiement à confirmer avec notre équipe',
      (/stock/i.test(input.stockLabel || '') ? 'Solde après test et attestation de conformité' : 'Solde après sourcing, test et attestation de conformité'),
      'Paiement sécurisé par carte bancaire ou virement',
      'Lien de paiement transmis par email',
    ];
    let bY = y + 92;
    bullets.forEach(b => {
      bullet(M + 18, bY + 4, C_RED);
      doc.fontSize(8.5).font('Helvetica').fillColor(C_TEXT).text(
        truncate(b, 70), M + 26, bY, { width: modW - 40, height: 11, lineBreak: false, ellipsis: true }
      );
      bY += 14;
    });

    // Totaux (bleu clair)
    const totX = M + modW + 12;
    card(totX, y, totW, bH, C_BG_LIGHT);
    doc.save().fillColor(C_WHITE).circle(totX + 14, y + 14, 7).fill().restore();
    bullet(totX + 14, y + 14, C_NAVY);
    doc.fontSize(7.5).font('Helvetica-Bold').fillColor(C_NAVY).text('TOTAUX', totX + 28, y + 10, { characterSpacing: 1, lineBreak: false });

    let ty = y + 38;
    if (isMarginScheme) {
      // Régime de la marge : aucun détail HT/TVA. Prix net tout compris + mention légale.
      doc.fontSize(10).font('Helvetica-Bold').fillColor(C_TEXT).text('Prix total', totX + 14, ty, { lineBreak: false });
      doc.fontSize(12).font('Helvetica-Bold').fillColor(C_NAVY).text(eur(sellTtc), totX + 14, ty - 1, { width: totW - 28, align: 'right', lineBreak: false });
      ty += 19;
      doc.fontSize(6.5).font('Helvetica').fillColor(C_TEXT_MUTED).text(
        'TVA sur marge - art. 297 A du CGI. TVA non récupérable par l\'acheteur.',
        totX + 14, ty, { width: totW - 28, lineBreak: true }
      );
      ty += 18;
    } else {
      doc.fontSize(9).font('Helvetica').fillColor(C_TEXT_MUTED).text('Sous-total HT', totX + 14, ty, { lineBreak: false });
      doc.text(eur(sellHt), totX + 14, ty, { width: totW - 28, align: 'right', lineBreak: false });
      ty += 16;
      doc.text('TVA ' + vatRate + '%', totX + 14, ty, { lineBreak: false });
      doc.text(eur(vatAmount), totX + 14, ty, { width: totW - 28, align: 'right', lineBreak: false });
      ty += 14;
      doc.moveTo(totX + 14, ty).lineTo(totX + totW - 14, ty).strokeColor(C_OUTLINE_LT).lineWidth(0.5).stroke();
      ty += 8;

      doc.fontSize(10).font('Helvetica-Bold').fillColor(C_TEXT).text('Total TTC', totX + 14, ty, { lineBreak: false });
      doc.fontSize(12).font('Helvetica-Bold').fillColor(C_NAVY).text(eur(sellTtc), totX + 14, ty - 1, { width: totW - 28, align: 'right', lineBreak: false });
      ty += 18;
    }

    if (depositTtc > 0) {
      doc.fontSize(10).font('Helvetica-Bold').fillColor(C_TEXT).text(isFull ? 'Total à payer' : 'Acompte à payer', totX + 14, ty, { lineBreak: false });
      doc.fontSize(12).font('Helvetica-Bold').fillColor(C_RED).text(eur(depositTtc), totX + 14, ty - 1, { width: totW - 28, align: 'right', lineBreak: false });
      ty += 18;
      if (!isFull) {
        doc.fontSize(9).font('Helvetica').fillColor(C_TEXT_MUTED).text('Solde restant', totX + 14, ty, { lineBreak: false });
        doc.text(eur(remainingTtc), totX + 14, ty, { width: totW - 28, align: 'right', lineBreak: false });
        ty += 14;
      }
      if (input.mollieUrl) {
        payButton(totX + 14, ty + 4, totW - 28, 24, isFull ? 'Payer en ligne' : 'Payer l\'acompte en ligne', input.mollieUrl);
      }
    }

    y += bH + 12;

    // ─── ÉCHANGE STANDARD / CONSIGNE (affiché seulement si consigne > 0) ──
    const consigneAmount = Number(input.consigne && input.consigne.amount) || 0;
    const consigneDelay = Number(input.consigne && input.consigne.delayDays) || 30;
    if (consigneAmount > 0) {
      const csgH = 50;
      card(M, y, W, csgH, '#fffbeb');
      doc.save().strokeColor('#fcd34d').lineWidth(0.8).roundedRect(M, y, W, csgH, 8).stroke().restore();
      doc.fontSize(7.5).font('Helvetica-Bold').fillColor('#b45309')
        .text('ÉCHANGE STANDARD — CONSIGNE', M + 14, y + 9, { characterSpacing: 1, lineBreak: false });
      doc.fontSize(12).font('Helvetica-Bold').fillColor('#b45309')
        .text('+ ' + eur(consigneAmount), M + 14, y + 6, { width: W - 28, align: 'right', lineBreak: false });
      doc.fontSize(8).font('Helvetica').fillColor(C_TEXT).text(
        'Caution remboursable (hors TVA) réglée avec le solde et intégralement restituée au retour de '
        + lex.oldNoun + ' sous ' + consigneDelay + ' jours. Ce n\'est pas un coût définitif : ce dépôt de garantie vous est rendu.',
        M + 14, y + 25, { width: W - 28, lineGap: 1 }
      );
      y += csgH + 12;
    }

    // ─── INCLUS (1 ligne) ──────────────────────────────────────────
    const inclH = 30;
    card(M, y, W, inclH, C_WHITE);
    // Cercle vide + checkmark
    doc.save().circle(M + 22, y + 15, 9).strokeColor(C_NAVY).lineWidth(1).stroke().restore();
    checkmark(M + 22, y + 15, C_NAVY, 7);
    doc.fontSize(8).font('Helvetica-Bold').fillColor(C_NAVY).text('INCLUS', M + 42, y + 12, { characterSpacing: 1, lineBreak: false });
    doc.fontSize(9).font('Helvetica').fillColor(C_TEXT_MUTED).text(
      (input.isReconditionne
        ? 'reconditionnement complet · pièces d\'usure remplacées · préparation palette'
        : lex.controlListItem + ' · photos · préparation palette') + ' · garantie ' + warrantyMonths + ' mois · assistance compatibilité',
      M + 90, y + 12, { width: W - 105, lineBreak: false, ellipsis: true }
    );
    y += inclH + 12;

    // Photos désormais présentées en grand sur des pages dédiées (voir fin du PDF),
    // remplacé : on rappelle juste leur présence si on en a.
    const photos = Array.isArray(input.photos) ? input.photos.filter(p => p && p.buffer) : [];
    if (photos.length > 0) {
      const inclH2 = 26;
      card(M, y, W, inclH2, C_WHITE);
      doc.save().circle(M + 22, y + 13, 9).strokeColor(C_NAVY).lineWidth(1).stroke().restore();
      checkmark(M + 22, y + 13, C_NAVY, 7);
      doc.fontSize(8).font('Helvetica-Bold').fillColor(C_NAVY).text('PHOTOS', M + 42, y + 9, { characterSpacing: 1, lineBreak: false });
      const engineN = photos.filter(p => p.category !== 'kmReading').length;
      const kmN = photos.filter(p => p.category === 'kmReading').length;
      const parts = [];
      if (engineN) parts.push(engineN + ' photo' + (engineN > 1 ? 's' : '') + ' ' + lex.duNoun);
      if (kmN) parts.push(kmN + ' relevé' + (kmN > 1 ? 's' : '') + ' kilométrique' + (kmN > 1 ? 's' : ''));
      doc.fontSize(9).font('Helvetica').fillColor(C_TEXT_MUTED).text(
        parts.join(' · ') + ' — voir pages suivantes',
        M + 90, y + 9, { width: W - 105, lineBreak: false, ellipsis: true }
      );
      y += inclH2 + 12;
    }

    // ─── MOT DU COMMERCIAL ─────────────────────────────────────────
    // S'il tient dans l'espace restant en page 1 → on l'affiche ici.
    // Sinon → page dédiée (rendue plus bas), JAMAIS tronqué.
    let commercialMsgForPage = '';
    if (input.customMessage && input.customMessage.trim()) {
      // Strip \r (textarea CRLF) qui se rend en "Ð" dans Helvetica WinAnsi
      // Compress aussi les \n\n+ multiples en double saut max
      const cleanMsg = input.customMessage
        .replace(/\r\n/g, '\n')
        .replace(/\r/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
      const innerW = W - 28;
      const maxBoxBottom = PH - 70; // marge pour footer
      const availableH = maxBoxBottom - y;
      doc.fontSize(9).font('Helvetica');
      const textH = doc.heightOfString(cleanMsg, { width: innerW, lineGap: 2 });
      const neededH = textH + 50;

      if (availableH >= neededH && availableH > 50) {
        // Tient en page 1 → on l'affiche ici en entier
        const boxH = neededH;
        card(M, y, W, boxH, C_WHITE);
        doc.save().fillColor(C_BG_LIGHT).circle(M + 14, y + 14, 7).fill().restore();
        bullet(M + 14, y + 14, C_NAVY);
        doc.fontSize(7.5).font('Helvetica-Bold').fillColor(C_NAVY).text('MOT DU COMMERCIAL', M + 28, y + 10, { characterSpacing: 1, lineBreak: false });
        doc.fontSize(9).font('Helvetica').fillColor(C_TEXT).text(
          cleanMsg, M + 14, y + 34, { width: innerW, lineGap: 2 }
        );
        y += boxH + 8;
      } else {
        // Trop long → page dédiée (rendue après l'annexe)
        commercialMsgForPage = cleanMsg;
      }
    }

    drawFooter();

    // ═════════════════════════════════════════════════════════════════
    // PAGE 2 — Annexe technique et conditions
    // ═════════════════════════════════════════════════════════════════
    doc.addPage();
    drawHeader();
    y = 98;

    // Titre + underline rouge
    doc.fontSize(16).font('Helvetica-Bold').fillColor(C_NAVY).text('Annexe technique et conditions', M, y, { lineBreak: false });
    doc.rect(M, y + 23, 38, 3).fill(C_RED);
    y += 38;

    // ─── 2 cols : Contrôles inclus | Documents transmis ─────────────
    const cW2 = (W - 12) / 2;
    const cH2 = 180;

    function checkList(x, y, w, h, title, items) {
      card(x, y, w, h, C_WHITE);
      doc.fontSize(11).font('Helvetica-Bold').fillColor(C_NAVY).text(title, x + 14, y + 14, { width: w - 28, lineBreak: false, ellipsis: true });
      doc.moveTo(x + 14, y + 38).lineTo(x + w - 14, y + 38).strokeColor(C_OUTLINE_LT).lineWidth(0.5).stroke();
      let ly = y + 50;
      items.forEach(item => {
        // Cercle plein rouge + check blanc
        doc.save().fillColor(C_RED).circle(x + 22, ly + 4, 6).fill().restore();
        checkmark(x + 22, ly + 4, C_WHITE, 6);
        doc.fontSize(9).font('Helvetica').fillColor(C_TEXT).text(item, x + 34, ly, { width: w - 48, lineBreak: false, ellipsis: true });
        ly += 22;
      });
    }

    if (input.isReconditionne) {
      // Reconditionné = moteur REFAIT en atelier (pas un moteur d'occasion testé) :
      // pas d'endoscopie / km / compteur donneur, mais reconditionnement + pièces remplacées.
      checkList(M, y, cW2, cH2, 'Reconditionnement (atelier)', [
        'Moteur entièrement reconditionné',
        'Pièces d\'usure remplacées (joints, segments, coussinets)',
        'Remontage aux préconisations constructeur',
        'Contrôle qualité avant expédition',
        'Préparation sur palette sécurisée',
      ]);
      checkList(M + cW2 + 12, y, cW2, cH2, 'Documents transmis avec la commande', [
        'Facture',
        'Attestation de reconditionnement',
        'Conditions de garantie 12 mois',
        'Préconisations de montage',
      ]);
    } else {
      checkList(M, y, cW2, cH2, 'Contrôles inclus avant expédition', [
        lex.controlTitle,
        lex.visualControl,
        'Vérification absence de défaut majeur',
        lex.photosPartExp,
        'Préparation sur palette sécurisée',
      ]);
      checkList(M + cW2 + 12, y, cW2, cH2, 'Documents transmis avec la commande', [
        'Facture d\'achat',
        lex.photosPart,
        'Photos compteur donneur si disponible',
        'Rapport de contrôle interne',
        'Attestation de préparation',
      ]);
    }
    y += cH2 + 14;

    // ─── 2 cols dans card grise : Compatibilité | Garantie ──────────
    const cH3 = 110;
    doc.save();
    doc.roundedRect(M, y, W, cH3, 6).fillAndStroke(C_BG_VARIANT, C_OUTLINE_LT);
    doc.restore();
    const hW = (W - 24) / 2;

    doc.fontSize(11).font('Helvetica-Bold').fillColor(C_NAVY).text('Compatibilité véhicule', M + 14, y + 14, { lineBreak: false });
    doc.rect(M + 14, y + 31, 30, 2).fill(C_RED);
    doc.fontSize(9).font('Helvetica').fillColor(C_TEXT).text(
      `Ce devis est établi pour le véhicule immatriculé ${input.plate || '—'}. La compatibilité est validée à partir des informations véhicule transmises par le client (VIN, immatriculation ou code moteur).`,
      M + 14, y + 42, { width: hW - 14, height: cH3 - 56, lineGap: 1, ellipsis: true }
    );

    doc.moveTo(M + hW + 12, y + 14).lineTo(M + hW + 12, y + cH3 - 14).strokeColor(C_OUTLINE_LT).lineWidth(0.5).stroke();

    const gX = M + hW + 24;
    doc.fontSize(11).font('Helvetica-Bold').fillColor(C_NAVY).text('Garantie incluse', gX, y + 14, { lineBreak: false });
    doc.rect(gX, y + 31, 30, 2).fill(C_RED);
    doc.fontSize(9).font('Helvetica').fillColor(C_TEXT).text(
      'Garantie commerciale de ' + warrantyMonths + ' mois sans limite de kilométrage, sous réserve d\'un montage conforme, avec remplacement des consommables nécessaires et respect des préconisations constructeur.',
      gX, y + 42, { width: hW - 14, height: cH3 - 56, lineGap: 1, ellipsis: true }
    );
    y += cH3 + 14;

    // ─── LIVRAISON SÉCURISÉE ────────────────────────────────────────
    const lH = 88;
    card(M, y, W, lH, C_WHITE);
    doc.fontSize(11).font('Helvetica-Bold').fillColor(C_NAVY).text('Livraison sécurisée', M + 14, y + 14, { lineBreak: false });
    doc.rect(M + 14, y + 31, 32, 2).fill(C_RED);
    doc.fontSize(9).font('Helvetica').fillColor(C_TEXT).text(
      lex.preparedSentence,
      M + 14, y + 42, { width: W - 28, height: 22, lineGap: 1, ellipsis: true }
    );
    doc.moveTo(M + 14, y + lH - 18).lineTo(M + W - 14, y + lH - 18).strokeColor(C_OUTLINE_LT).lineWidth(0.5).stroke();
    doc.fontSize(8).font('Helvetica-Bold').fillColor(C_NAVY).text(input.isReconditionne ? 'Reconditionné' : 'Kilométrage', M + 14, y + lH - 12, { lineBreak: false });
    doc.fontSize(8).font('Helvetica').fillColor(C_TEXT_MUTED).text(
      input.isReconditionne
        ? 'Moteur entièrement refait en atelier, pièces d\'usure remplacées, contrôlé avant expédition.'
        : (input.engine && input.engine.mileage > 0
          ? fmtMileage(input.engine.mileage) + ' certifiés au compteur donneur, photo transmise avec la commande.'
          : 'Kilométrage relevé sur compteur donneur, transmis avec photo lorsque disponible.'),
      M + 80, y + lH - 12, { width: W - 94, lineBreak: false, ellipsis: true }
    );
    y += lH + 14;

    // ─── TIMELINE ÉTAPES ───────────────────────────────────────────
    const tlH = 92;
    card(M, y, W, tlH, C_WHITE);
    doc.fontSize(11).font('Helvetica-Bold').fillColor(C_NAVY).text('Étapes après validation', M + 14, y + 14, { lineBreak: false });
    doc.rect(M + 14, y + 31, 36, 2).fill(C_RED);
    // Cercles centrés verticalement dans la moitié basse de la card
    const tlLineY = y + 52;
    doc.moveTo(M + 60, tlLineY).lineTo(M + W - 60, tlLineY).strokeColor(C_OUTLINE).lineWidth(0.8).dash(2, { space: 2 }).stroke();
    doc.undash();
    const steps = input.isReconditionne
      ? ['Commande\nvalidée', 'Préparation\nen atelier', 'Contrôle\nqualité', 'Préparation\npalette', 'Expédition\nlivraison']
      : ['Paiement\nacompte', lex.blocageStep, 'Contrôles\n+ photos', 'Préparation\npalette', 'Expédition\nlivraison'];
    const stW = (W - 60) / steps.length;
    steps.forEach((label, i) => {
      const cx = M + 30 + stW * i + stW / 2;
      doc.save().fillColor(C_NAVY).circle(cx, tlLineY, 10).fill().restore();
      doc.fontSize(9).font('Helvetica-Bold').fillColor(C_WHITE).text(String(i + 1), cx - 5, tlLineY - 4.5, { width: 10, align: 'center', lineBreak: false });
      doc.fontSize(8).font('Helvetica').fillColor(C_TEXT_MUTED).text(label, cx - 38, tlLineY + 14, { width: 76, align: 'center', lineGap: -1 });
    });
    y += tlH + 12;

    // ─── CONDITIONS IMPORTANTES ────────────────────────────────────
    const condItems = [
      lex.validitySentence,
      'Les prix sont exprimés en euros. TVA française au taux en vigueur.',
      'L\'acceptation du devis vaut commande après validation du paiement.',
      'Les délais de disponibilité et d\'expédition sont confirmés au moment de la réservation.',
      'La garantie suppose un montage conforme. Fluides, consommables et main-d\'œuvre non inclus sauf accord écrit.',
    ];
    // Vérifie place disponible (footer à PH - 36 - 16 = PH - 52)
    const maxBottom = PH - 60;
    const condH = Math.min(26 + condItems.length * 16 + 14, maxBottom - y);
    doc.save();
    doc.roundedRect(M, y, W, condH, 6).fillAndStroke(C_BG_VARIANT, C_OUTLINE_LT);
    doc.restore();
    doc.fontSize(11).font('Helvetica-Bold').fillColor(C_NAVY).text('Conditions importantes', M + 14, y + 12, { lineBreak: false });
    doc.rect(M + 14, y + 29, 32, 2).fill(C_RED);
    let cdY = y + 38;
    condItems.forEach(c => {
      if (cdY + 14 > y + condH - 4) return; // skip si pas la place
      infoIcon(M + 22, cdY + 4, C_RED);
      doc.fontSize(8).font('Helvetica').fillColor(C_TEXT).text(c, M + 36, cdY, { width: W - 50, lineBreak: true, height: 14, ellipsis: true });
      cdY += 16;
    });

    drawFooter();

    // ═════════════════════════════════════════════════════════════════
    // PAGE MESSAGE DU COMMERCIAL (si trop long pour la page 1)
    // ═════════════════════════════════════════════════════════════════
    if (commercialMsgForPage) {
      doc.addPage();
      drawHeader();
      let my = 98;
      doc.fontSize(16).font('Helvetica-Bold').fillColor(C_NAVY).text('Message du commercial', M, my, { lineBreak: false });
      doc.rect(M, my + 23, 38, 3).fill(C_RED);
      my += 40;
      const innerW = W - 28;
      card(M, my, W, PH - 70 - my, C_WHITE);
      doc.fontSize(11).font('Helvetica').fillColor(C_TEXT).text(
        commercialMsgForPage, M + 14, my + 16, { width: innerW, lineGap: 3 }
      );
      drawFooter();
    }

    // ═════════════════════════════════════════════════════════════════
    // PAGES PHOTOS (dédiées) — grandes images, moteur puis relevé km
    // ═════════════════════════════════════════════════════════════════
    /**
     * Dessine une (ou plusieurs) page(s) de photos en grand format.
     * 2 photos par page max (l'une au-dessus de l'autre), titre en tête.
     */
    function drawPhotoPages(title, subtitle, list) {
      if (!list || !list.length) return;
      const perPage = 2;
      for (let i = 0; i < list.length; i += perPage) {
        doc.addPage();
        drawHeader();
        let py = 98;
        // Titre de section
        doc.fontSize(16).font('Helvetica-Bold').fillColor(C_NAVY).text(title, M, py, { lineBreak: false });
        doc.rect(M, py + 23, 38, 3).fill(C_RED);
        if (subtitle) {
          doc.fontSize(9).font('Helvetica').fillColor(C_TEXT_MUTED).text(subtitle, M, py + 30, { width: W, lineBreak: false });
        }
        py += 44;

        const slots = list.slice(i, i + perPage);
        // Espace dispo entre py et le footer
        const bottomLimit = PH - 60;
        const gap = 14;
        const slotH = (bottomLimit - py - gap * (slots.length - 1)) / slots.length;

        slots.forEach((p, k) => {
          const sy = py + k * (slotH + gap);
          // Cadre gris arrondi
          doc.save();
          doc.roundedRect(M, sy, W, slotH, 8).fill(C_BG_VARIANT);
          doc.restore();
          try {
            doc.image(p.buffer, M + 8, sy + 8, { fit: [W - 16, slotH - 16], align: 'center', valign: 'center' });
          } catch (e) {
            doc.fontSize(9).font('Helvetica').fillColor(C_TEXT_MUTED).text('Photo non affichable', M, sy + slotH / 2 - 6, { width: W, align: 'center', lineBreak: false });
          }
          doc.roundedRect(M, sy, W, slotH, 8).strokeColor(C_OUTLINE_LT).lineWidth(0.8).stroke();
        });

        drawFooter(); // le label de page sera réécrit à la fin (numérotation dynamique)
      }
    }

    const enginePhotos = photos.filter(p => p.category !== 'kmReading');
    const kmPhotos = photos.filter(p => p.category === 'kmReading');
    drawPhotoPages(lex.photosPart, 'Photos réelles ' + lex.proposeNoun + ' · dossier ' + (input.quoteRef || ''), enginePhotos);
    drawPhotoPages('Relevé kilométrique', 'Photo du compteur du véhicule donneur · dossier ' + (input.quoteRef || ''), kmPhotos);

    // ─── Numérotation dynamique des pages (X / total) ──────────────
    const range = doc.bufferedPageRange();
    const total = range.count;
    for (let i = 0; i < total; i++) {
      doc.switchToPage(range.start + i);
      const fY = PH - 36 - 16;
      doc.fontSize(7).font('Helvetica').fillColor(C_TEXT_MUTED)
        .text('Page ' + (i + 1) + '/' + total, M, fY + 7, { width: W, align: 'right', lineBreak: false });
    }

    doc.end();
  });
}

module.exports = { buildQuotePdf };
