/*
 * SAV — Wrapper Mollie pour facturation 149€
 * S'appuie sur services/mollie.js (createPayment / getPayment).
 * Variables d'env utilisées :
 *   - MOLLIE_API_KEY      (déjà utilisé par mollie.js)
 *   - MOLLIE_WEBHOOK_URL  (URL publique du webhook SAV ; sinon construit depuis SITE_URL)
 *   - SITE_URL            (pour le redirectUrl)
 */

const mollie = require('./mollie');
const SavTicket = require('../models/SavTicket');
const brand = require('../config/brand');

const PRICE_CENTS_149 = 14900;

function getSiteUrl() {
  return (brand.SITE_URL).replace(/\/$/, '');
}

function getWebhookUrl() {
  const fromEnv = (process.env.MOLLIE_WEBHOOK_URL || '').trim();
  if (fromEnv) return fromEnv;
  return `${getSiteUrl()}/api/sav/mollie-webhook`;
}

async function createPayment149(ticketNumero) {
  const ticket = await SavTicket.findOne({ numero: ticketNumero });
  if (!ticket) throw new Error(`Ticket SAV introuvable : ${ticketNumero}`);

  if (ticket.analyse && ticket.analyse.conclusion === 'defaut_produit') {
    throw new Error('Facturation 149€ interdite : conclusion = défaut produit');
  }

  const payment = await mollie.createPayment({
    amountCents: PRICE_CENTS_149,
    description: `Analyse SAV ${ticket.numero} - ${brand.NAME}`,
    redirectUrl: `${getSiteUrl()}/sav/suivi/${encodeURIComponent(ticket.numero)}`,
    webhookUrl: getWebhookUrl(),
    metadata: { savNumero: ticket.numero, kind: 'sav-analyse-149' },
  });

  if (!payment || !payment.id) {
    throw new Error('Réponse Mollie invalide (pas d\'id)');
  }

  const paymentUrl = payment._links && payment._links.checkout && payment._links.checkout.href;
  ticket.paiements = ticket.paiements || {};
  ticket.paiements.facture149 = Object.assign(ticket.paiements.facture149 || {}, {
    status: 'a_facturer',
    mollieId: payment.id,
    paymentUrl,
    dateGeneration: new Date(),
  });
  ticket.analyse = ticket.analyse || {};
  ticket.analyse.facture149 = { status: 'a_facturer' };
  ticket.addMessage('admin', 'interne', `Lien de paiement Mollie généré (${payment.id})`);
  await ticket.save();

  return {
    mollieId: payment.id,
    paymentUrl,
    status: payment.status,
  };
}

/**
 * Crée une facture Qonto + lien Mollie + envoi mail unique au client.
 * Idempotent : si déjà fait, retourne l'existant.
 */
async function createQontoAndMollieAndNotify(ticketNumero) {
  const ticket = await SavTicket.findOne({ numero: ticketNumero });
  if (!ticket) throw new Error(`Ticket SAV introuvable : ${ticketNumero}`);
  if (ticket.analyse && ticket.analyse.conclusion === 'defaut_produit') {
    throw new Error('Facturation 149€ interdite : conclusion = défaut produit');
  }

  ticket.paiements = ticket.paiements || {};
  ticket.paiements.facture149 = ticket.paiements.facture149 || {};
  const f = ticket.paiements.facture149;

  // 1) Qonto si pas déjà créée
  if (!f.qontoInvoiceId) {
    try {
      const qonto = require('./qontoService');
      const inv = await qonto.createInvoice149({ ticket });
      f.qontoInvoiceId = inv.invoiceId;
      f.qontoInvoiceUrl = inv.invoiceUrl;
      f.qontoPdfUrl = inv.pdfUrl;
      ticket.addMessage('systeme', 'interne', `Facture Qonto créée (${inv.invoiceId}${inv.fake ? ' — mode dev' : ''})`);
    } catch (e) {
      console.error('[mollieService] qonto fail', e.message);
    }
  }

  // 2) Mollie si pas déjà créée
  if (!f.mollieId) {
    try {
      const payment = await mollie.createPayment({
        amountCents: PRICE_CENTS_149,
        description: `Analyse SAV ${ticket.numero} - ${brand.NAME}`,
        redirectUrl: `${getSiteUrl()}/sav/suivi/${encodeURIComponent(ticket.numero)}`,
        webhookUrl: getWebhookUrl(),
        metadata: { savNumero: ticket.numero, kind: 'sav-analyse-149' },
      });
      if (payment && payment.id) {
        f.mollieId = payment.id;
        f.paymentUrl = payment._links && payment._links.checkout && payment._links.checkout.href;
        f.status = 'a_facturer';
        f.dateGeneration = new Date();
        ticket.addMessage('systeme', 'interne', `Lien Mollie généré (${payment.id})`);
      }
    } catch (e) {
      console.error('[mollieService] mollie fail', e.message);
    }
  }

  if (ticket.analyse) ticket.analyse.facture149 = { status: 'a_facturer' };
  await ticket.save();

  // 3) Mail au client avec PDF + lien
  try {
    const { sendEmail } = require('./emailService');
    const fs = require('fs');
    const path = require('path');
    const attachments = [];
    if (f.qontoPdfUrl && f.qontoPdfUrl.startsWith('/uploads/')) {
      const filePath = path.join(__dirname, '..', '..', '..', f.qontoPdfUrl);
      if (fs.existsSync(filePath)) {
        attachments.push({
          filename: `Facture-SAV-${ticket.numero}.pdf`,
          content: fs.readFileSync(filePath).toString('base64'),
          disposition: 'attachment',
        });
      }
    }
    const html = `
      <p>Bonjour ${(ticket.client && ticket.client.nom) || ''},</p>
      <p>Suite à l'analyse de votre dossier SAV <strong>${ticket.numero}</strong>, le forfait de <strong>149&nbsp;€ TTC</strong> est applicable
      conformément aux CGV SAV (la pièce ne présente pas de défaut produit).</p>
      <p>Vous trouverez ci-joint la facture${f.qontoPdfUrl ? '' : ' (à venir)'} et pouvez régler en ligne en un clic :</p>
      <p style="text-align:center;margin:24px 0;">
        <a href="${f.paymentUrl || '#'}" style="display:inline-block;padding:12px 22px;background:#ec1313;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;">Régler 149 € en ligne</a>
      </p>
      <p style="font-size:13px;color:#475569;">Référence : ${ticket.numero} · Lien sécurisé Mollie.</p>
    `;
    await sendEmail({
      toEmail: ticket.client && ticket.client.email,
      subject: `[SAV ${ticket.numero}] Facture analyse 149 €`,
      html,
      text: html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim(),
      attachments,
    });
    ticket.addMessage('systeme', 'interne', 'Mail facture 149€ envoyé au client');
    await ticket.save();
  } catch (e) {
    console.error('[mollieService] mail fail', e.message);
  }

  return {
    qontoInvoiceId: f.qontoInvoiceId,
    qontoInvoiceUrl: f.qontoInvoiceUrl,
    qontoPdfUrl: f.qontoPdfUrl,
    mollieId: f.mollieId,
    paymentUrl: f.paymentUrl,
    status: f.status,
  };
}

/**
 * Crée un lien de paiement Mollie sur mesure pour un ticket SAV (montant libre).
 * Distinct du forfait 149€ : ajoute une entrée dans `paiements.customLinks[]`.
 *
 * @param {object} args
 * @param {string} args.ticketNumero
 * @param {number} args.amountCents      - montant en cents (>= 1)
 * @param {string} [args.label]          - libellé interne (admin)
 * @param {string} [args.description]    - description Mollie + email client
 * @param {string} [args.adminEmail]     - qui a créé le lien
 * @returns {Promise<{ linkId, mollieId, paymentUrl, amountCents, status }>}
 */
async function createCustomPaymentLink({ ticketNumero, amountCents, label, description, adminEmail } = {}) {
  const ticket = await SavTicket.findOne({ numero: ticketNumero });
  if (!ticket) throw new Error(`Ticket SAV introuvable : ${ticketNumero}`);
  if (!Number.isFinite(amountCents) || amountCents < 1) throw new Error('Montant invalide');

  const safeLabel = (typeof label === 'string' ? label.trim() : '') || 'Paiement complémentaire';
  const safeDescription = (typeof description === 'string' ? description.trim() : '')
    || `${safeLabel} - SAV ${ticket.numero}`;

  const payment = await mollie.createPayment({
    amountCents,
    description: safeDescription,
    redirectUrl: `${getSiteUrl()}/sav/suivi/${encodeURIComponent(ticket.numero)}`,
    webhookUrl: getWebhookUrl(),
    metadata: { savNumero: ticket.numero, kind: 'sav-custom-link', label: safeLabel },
  });
  if (!payment || !payment.id) throw new Error("Réponse Mollie invalide (pas d'id)");

  const paymentUrl = payment._links && payment._links.checkout && payment._links.checkout.href;

  ticket.paiements = ticket.paiements || {};
  if (!Array.isArray(ticket.paiements.customLinks)) ticket.paiements.customLinks = [];
  const entry = {
    label: safeLabel,
    description: safeDescription,
    amountCents,
    currency: 'EUR',
    mollieId: payment.id,
    paymentUrl: paymentUrl || '',
    status: 'pending',
    createdAt: new Date(),
    createdBy: (typeof adminEmail === 'string' ? adminEmail.trim() : '') || 'admin',
  };
  ticket.paiements.customLinks.push(entry);
  ticket.addMessage(
    'admin',
    'interne',
    `Lien Mollie sur mesure créé : ${(amountCents / 100).toFixed(2)} € — ${safeLabel} (${payment.id})`
  );
  await ticket.save();

  /* L'_id n'est pas fiable côté lean — mongoose n'auto-id pas dans nos
   * subdocs `customLinks` (cf. autres tableaux du modèle). On utilise
   * mollieId comme identifiant côté UI (unique, indexé). */
  return {
    mollieId: payment.id,
    paymentUrl: paymentUrl || '',
    amountCents,
    status: 'pending',
    label: safeLabel,
    description: safeDescription,
  };
}

// Mapping Mollie status → notre statut interne
function mapMollieStatus(s) {
  if (s === 'paid') return 'payee';
  if (s === 'failed' || s === 'canceled' || s === 'expired') return 'impayee';
  return 'a_facturer'; // open / pending / authorized
}

function mapCustomLinkStatus(s) {
  if (s === 'paid') return 'paid';
  if (s === 'failed') return 'failed';
  if (s === 'canceled') return 'canceled';
  if (s === 'expired') return 'expired';
  return 'pending'; // open / pending / authorized
}

async function handleWebhook(mollieId) {
  if (!mollieId) throw new Error('mollieId manquant');
  const payment = await mollie.getPayment(mollieId);
  if (!payment) throw new Error('Paiement Mollie introuvable');

  const savNumero = payment.metadata && payment.metadata.savNumero;
  if (!savNumero) {
    return { ok: false, reason: 'no_sav_metadata', mollieId };
  }

  const ticket = await SavTicket.findOne({ numero: savNumero });
  if (!ticket) {
    return { ok: false, reason: 'ticket_not_found', mollieId, savNumero };
  }

  const kind = payment.metadata && payment.metadata.kind;
  ticket.paiements = ticket.paiements || {};

  /* ── Route 1 : lien de paiement sur mesure ──────────────────── */
  if (kind === 'sav-custom-link') {
    if (!Array.isArray(ticket.paiements.customLinks)) ticket.paiements.customLinks = [];
    const link = ticket.paiements.customLinks.find((l) => l && l.mollieId === mollieId);
    if (!link) {
      return { ok: false, reason: 'custom_link_not_found', mollieId, savNumero };
    }
    const newStatus = mapCustomLinkStatus(payment.status);
    link.status = newStatus;
    link.lastWebhookAt = new Date();
    if (newStatus === 'paid' && !link.paidAt) {
      link.paidAt = new Date();
      ticket.addMessage(
        'systeme',
        'interne',
        `Lien Mollie sur mesure payé (${mollieId}) — ${(link.amountCents / 100).toFixed(2)} €`
      );
      try {
        const { sendEmail } = require('./emailService');
        await sendEmail({
          toEmail: ticket.client && ticket.client.email,
          subject: `[SAV ${ticket.numero}] Reçu de paiement ${(link.amountCents / 100).toFixed(2)} €`,
          html: `<p>Bonjour ${(ticket.client && ticket.client.nom) || ''},</p>
            <p>Nous avons bien reçu votre paiement de <strong>${(link.amountCents / 100).toFixed(2)} €</strong> pour le dossier SAV <strong>${ticket.numero}</strong>${link.label ? ` (${link.label})` : ''}.</p>
            <p>Merci de votre confiance.</p>
            <p style="font-size:13px;color:#475569;">Référence Mollie : ${mollieId}</p>`,
          text: `Reçu de paiement ${(link.amountCents / 100).toFixed(2)}€ pour le dossier ${ticket.numero}. Réf Mollie ${mollieId}.`,
        });
      } catch (_) {}
    } else if (newStatus === 'failed' || newStatus === 'canceled' || newStatus === 'expired') {
      ticket.addMessage(
        'systeme',
        'interne',
        `Lien Mollie sur mesure ${newStatus} (${mollieId}, status=${payment.status})`
      );
    }
    await ticket.save();
    return { ok: true, savNumero, mollieStatus: payment.status, kind: 'sav-custom-link', linkStatus: newStatus };
  }

  /* ── Route 2 : forfait 149€ (comportement historique inchangé) ─ */
  const newStatus = mapMollieStatus(payment.status);
  ticket.paiements.facture149 = ticket.paiements.facture149 || {};
  ticket.paiements.facture149.status = newStatus;
  ticket.paiements.facture149.mollieId = mollieId;
  if (newStatus === 'payee') {
    ticket.paiements.facture149.datePaiement = new Date();
    if (ticket.analyse) ticket.analyse.facture149 = { status: 'payee' };
    ticket.addMessage('systeme', 'interne', `Paiement 149€ confirmé (Mollie ${mollieId})`);
    try {
      const { sendEmail } = require('./emailService');
      await sendEmail({
        toEmail: ticket.client && ticket.client.email,
        subject: `[SAV ${ticket.numero}] Reçu de paiement 149 €`,
        html: `<p>Bonjour ${(ticket.client && ticket.client.nom) || ''},</p>
          <p>Nous avons bien reçu votre paiement de <strong>149,00 €</strong> pour le dossier SAV <strong>${ticket.numero}</strong>.</p>
          <p>Merci de votre confiance.</p>
          <p style="font-size:13px;color:#475569;">Référence Mollie : ${mollieId}</p>`,
        text: `Reçu de paiement 149€ pour le dossier ${ticket.numero}. Réf Mollie ${mollieId}.`,
      });
    } catch (_) {}
    try { require('./slackNotifier').notifyPaymentReceived(ticket); } catch (_) {}
  } else if (newStatus === 'impayee') {
    if (ticket.analyse) ticket.analyse.facture149 = { status: 'impayee' };
    ticket.addMessage('systeme', 'interne', `Paiement 149€ échoué/annulé (Mollie ${mollieId}, status=${payment.status})`);
  }
  await ticket.save();

  return { ok: true, savNumero, mollieStatus: payment.status, internalStatus: newStatus };
}

/**
 * Envoie le lien de paiement sur mesure au client par email.
 * @param {object} args
 * @param {string} args.ticketNumero
 * @param {string} args.mollieId        - identifie le lien dans paiements.customLinks[]
 * @param {string} [args.adminEmail]
 * @returns {Promise<{ ok, recipient, status }>}
 */
async function sendCustomPaymentLinkEmail({ ticketNumero, mollieId, adminEmail } = {}) {
  const ticket = await SavTicket.findOne({ numero: ticketNumero });
  if (!ticket) throw new Error(`Ticket SAV introuvable : ${ticketNumero}`);
  if (!Array.isArray(ticket.paiements && ticket.paiements.customLinks)) {
    throw new Error('Aucun lien de paiement sur ce ticket');
  }
  const link = ticket.paiements.customLinks.find((l) => l && l.mollieId === mollieId);
  if (!link) throw new Error(`Lien Mollie ${mollieId} introuvable sur le ticket`);
  if (!link.paymentUrl) throw new Error('URL de paiement Mollie manquante (lien à régénérer)');

  const toEmail = ticket.client && ticket.client.email ? String(ticket.client.email).trim() : '';
  if (!toEmail) throw new Error('Email client manquant sur le ticket');

  const { sendEmail } = require('./emailService');
  const amountText = (link.amountCents / 100).toFixed(2).replace('.', ',');
  const greetingName = (ticket.client && ticket.client.prenom) || (ticket.client && ticket.client.nom) || '';
  const labelLine = link.label ? `<p style="margin:0 0 8px 0;font-size:13px;color:#475569;">Objet : <strong>${link.label}</strong></p>` : '';
  const descLine = link.description && link.description !== link.label ? `<p style="margin:0 0 8px 0;font-size:13px;color:#475569;">${link.description}</p>` : '';

  const html = `
    <p>Bonjour ${greetingName},</p>
    <p>Concernant votre dossier SAV <strong>${ticket.numero}</strong>, nous vous transmettons un lien de paiement sécurisé Mollie :</p>
    <div style="margin:14px 0;padding:14px 16px;border:1px solid #e5e7eb;background:#f8fafc;border-radius:14px;">
      ${labelLine}
      ${descLine}
      <div style="margin-top:6px;font-size:18px;font-weight:900;color:#0f172a;">${amountText} €</div>
    </div>
    <p style="text-align:center;margin:24px 0;">
      <a href="${link.paymentUrl}" style="display:inline-block;padding:12px 22px;background:#ec1313;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;">Régler ${amountText} € en ligne</a>
    </p>
    <p style="font-size:13px;color:#475569;">Référence : ${ticket.numero} · Lien sécurisé Mollie (paiement par carte / Apple Pay / virement instantané).</p>
    <p style="font-size:12px;color:#64748b;margin-top:18px;">Si vous avez une question, répondez simplement à ce mail.</p>
  `;
  const text = `Lien de paiement SAV ${ticket.numero} - ${amountText} EUR\n${link.label || ''}\n\nRégler en ligne : ${link.paymentUrl}\n`;

  const result = await sendEmail({
    toEmail,
    subject: `[SAV ${ticket.numero}] Lien de paiement ${amountText} €${link.label ? ` — ${link.label}` : ''}`,
    html,
    text,
  });

  link.sentToClientAt = new Date();
  link.sentToClientBy = (typeof adminEmail === 'string' ? adminEmail.trim() : '') || 'admin';
  ticket.addMessage(
    'admin',
    'interne',
    `Lien Mollie envoyé au client par email : ${amountText} € — ${link.label || mollieId}`
  );
  await ticket.save();

  return { ok: !!(result && result.ok !== false), recipient: toEmail, status: link.status };
}

module.exports = {
  createPayment149,
  createQontoAndMollieAndNotify,
  createCustomPaymentLink,
  sendCustomPaymentLinkEmail,
  handleWebhook,
  PRICE_CENTS_149,
};
