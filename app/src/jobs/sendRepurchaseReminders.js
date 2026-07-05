'use strict';

/**
 * Relance RÉACHAT : email unique ~3 mois après un achat.
 *
 * Idée : un client qui a acheté (lead « recovered » / converti) est le
 * meilleur prospect pour la vente suivante. On lui envoie UN email sobre
 * (« tout fonctionne bien ? un autre besoin ? ») ~90 jours après l'achat.
 *
 * ⚠ DÉSACTIVÉ PAR DÉFAUT : ne s'exécute que si REPURCHASE_REMINDER_ENABLED=true
 *   (variable d'environnement Render). Le texte ci-dessous est à valider par
 *   Killian avant activation.
 *
 * Garde-fous :
 *   - un seul envoi par lead (repurchaseReminder.sentAt) ;
 *   - dédoublonné par email dans le run (client multi-leads) ;
 *   - skip si le client a REPASSÉ commande depuis (payée > 7 j après le
 *     rapprochement) → skippedReason 'racheté', jamais relancé pour ça ;
 *   - fenêtre J+90 → J+104 : au-delà, trop tard, on n'envoie plus (pas de
 *     rattrapage de tout l'historique le jour de l'activation) ;
 *   - max 30 emails par run.
 */

const mongoose = require('mongoose');

const MAX_PER_RUN = 30;
const RATE_LIMIT_MS = 300;
const WINDOW_START_DAYS = 104; // borne ancienne
const WINDOW_END_DAYS = 90;    // borne récente

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
}

async function sendRepurchaseReminders() {
  const report = { selected: 0, sent: 0, skipped: 0, errors: 0 };

  if (String(process.env.REPURCHASE_REMINDER_ENABLED || 'false').toLowerCase() !== 'true') {
    console.log('[repurchase] Désactivé (REPURCHASE_REMINDER_ENABLED != true) — aucun envoi.');
    return report;
  }
  if (mongoose.connection.readyState !== 1) {
    console.error('[repurchase] MongoDB non connectée, skip.');
    return report;
  }

  const AbandonedCart = require('../models/AbandonedCart');
  const Order = require('../models/Order');
  const User = require('../models/User');
  const emailService = require('../services/emailService');
  const brand = require('../config/brand');

  const now = Date.now();
  const windowStart = new Date(now - WINDOW_START_DAYS * 24 * 3600 * 1000);
  const windowEnd = new Date(now - WINDOW_END_DAYS * 24 * 3600 * 1000);

  const candidates = await AbandonedCart.find({
    recoveredAt: { $gte: windowStart, $lte: windowEnd },
    $or: [{ status: 'recovered' }, { manualStatus: 'converted' }],
    email: { $ne: '' },
    'repurchaseReminder.sentAt': null,
  })
    .sort({ recoveredAt: 1 })
    .limit(MAX_PER_RUN * 3) // marge pour la dédup/skips
    .lean();

  report.selected = candidates.length;
  if (!candidates.length) {
    console.log('[repurchase] Aucun client dans la fenêtre J+90.');
    return report;
  }

  const seenEmails = new Set();

  for (const lead of candidates) {
    if (report.sent >= MAX_PER_RUN) break;
    try {
      const email = String(lead.email || '').trim().toLowerCase();
      if (!email || seenEmails.has(email)) { report.skipped += 1; continue; }
      seenEmails.add(email);

      /* A-t-il déjà recommandé depuis ? (commande payée bien après le
         rapprochement) → inutile de demander « un autre besoin ? » */
      const buyer = await User.findOne({ email }).select('_id').lean();
      if (buyer && lead.recoveredAt) {
        const after = new Date(new Date(lead.recoveredAt).getTime() + 7 * 24 * 3600 * 1000);
        const newerOrder = await Order.findOne({
          userId: buyer._id,
          paymentStatus: 'paid',
          createdAt: { $gte: after },
        }).select('_id').lean();
        if (newerOrder) {
          await AbandonedCart.updateOne(
            { _id: lead._id },
            { $set: { 'repurchaseReminder.skippedReason': 'racheté' } }
          );
          report.skipped += 1;
          continue;
        }
      }

      const firstName = (lead.firstName || '').trim();
      const productName = (lead.items && lead.items[0] && lead.items[0].name) ? lead.items[0].name : '';
      const subject = 'Tout fonctionne bien depuis votre commande ?';

      const introProduct = productName
        ? `votre ${escapeHtml(productName)}`
        : 'la pièce que vous avez commandée';

      const html = `
<!DOCTYPE html>
<html><head><meta charset="UTF-8"></head>
<body style="margin:0;padding:24px;background:#f3f4f6;font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;">
  <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:12px;padding:32px;color:#111827;line-height:1.6;">
    <p style="margin:0 0 16px 0;font-size:15px;">Bonjour${firstName ? ' ' + escapeHtml(firstName) : ''},</p>
    <p style="margin:0 0 12px 0;font-size:14px;color:#374151;">Il y a environ trois mois, vous avez commandé chez ${escapeHtml(brand.NAME)}. Nous espérons que ${introProduct} vous donne entière satisfaction.</p>
    <p style="margin:0 0 12px 0;font-size:14px;color:#374151;">Si tout roule : tant mieux, c'est notre objectif. Et si vous avez un nouveau besoin — entretien, pièce pour un autre véhicule, question technique — notre équipe est là pour vous conseiller, comme la première fois.</p>
    <p style="margin:0 0 12px 0;font-size:14px;color:#374151;">Répondez simplement à cet email ou appelez-nous au <a href="tel:${escapeHtml(brand.PHONE)}" style="color:#dc2626;">${escapeHtml(brand.PHONE)}</a>.</p>
    <p style="margin:24px 0 0 0;font-size:13px;color:#6b7280;">— L'équipe ${escapeHtml(brand.NAME)}</p>
  </div>
</body></html>`.trim();

      const text = `Bonjour${firstName ? ' ' + firstName : ''},\n\nIl y a environ trois mois, vous avez commandé chez ${brand.NAME}. Nous espérons que ${productName ? 'votre ' + productName : 'la pièce commandée'} vous donne entière satisfaction.\n\nSi vous avez un nouveau besoin — entretien, pièce pour un autre véhicule, question technique — notre équipe est là pour vous conseiller.\n\nRépondez à cet email ou appelez-nous au ${brand.PHONE}.\n\n— L'équipe ${brand.NAME}`;

      const result = await emailService.sendEmail({ toEmail: email, subject, html, text });

      if (result && result.ok) {
        await AbandonedCart.updateOne(
          { _id: lead._id },
          {
            $set: { 'repurchaseReminder.sentAt': new Date() },
            $push: { notes: { text: '🔁 Email réachat (J+90) envoyé automatiquement', addedByName: 'Système', addedAt: new Date() } },
          }
        );
        report.sent += 1;
        console.log(`[repurchase] Email réachat envoyé à ${email} (lead ${lead._id})`);
      } else {
        report.errors += 1;
        console.error(`[repurchase] Échec envoi à ${email}:`, result && result.reason ? result.reason : 'inconnu');
      }

      await new Promise((r) => setTimeout(r, RATE_LIMIT_MS));
    } catch (err) {
      report.errors += 1;
      console.error('[repurchase] Erreur lead:', err && err.message ? err.message : err);
    }
  }

  console.log('[repurchase] Rapport:', JSON.stringify(report));
  return report;
}

module.exports = { sendRepurchaseReminders };
