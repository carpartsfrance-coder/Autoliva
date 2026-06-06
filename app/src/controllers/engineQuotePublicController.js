'use strict';

/**
 * Routes PUBLIQUES (sans auth) pour le workflow devis moteurs :
 *   - Webhook Mollie : notification de paiement acompte
 *   - Pixel de tracking : ouverture de l'email de devis
 *
 * Montées sous /api/devis-moteurs/* dans app.js.
 */

const mongoose = require('mongoose');
const AbandonedCart = require('../models/AbandonedCart');
const mollie = require('../services/mollie');
const emailService = require('../services/emailService');
const { buildAcompteConfirmationHtml } = require('../services/engineQuoteEmail');
const brand = require('../config/brand');

// GIF transparent 1x1 (43 bytes) — servi au pixel de tracking
const TRANSPARENT_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

function fmtEur(cents) {
  return new Intl.NumberFormat('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
    .format((Number(cents) || 0) / 100) + ' €';
}

/**
 * POST /api/devis-moteurs/mollie-webhook
 * Body form-encoded : { id: <paymentId> }
 * Mollie ping → on récupère le payment, vérifie le statut, et si payé
 * on passe le lead en 'acompte_recu' + notifie le commercial.
 *
 * IMPORTANT : toujours répondre 200 (sinon Mollie retry en boucle).
 */
async function postMollieWebhook(req, res) {
  try {
    const paymentId = (req.body && req.body.id) || (req.query && req.query.id);
    if (!paymentId) return res.status(200).end();
    if (mongoose.connection.readyState !== 1) return res.status(200).end();

    const payment = await mollie.getPayment(paymentId);
    if (!payment || !payment.metadata) return res.status(200).end();

    // On ne traite que les paiements de notre kind
    if (payment.metadata.kind !== 'engine_quote_deposit') return res.status(200).end();

    const engineQuoteId = payment.metadata.engineQuoteId;
    if (!engineQuoteId || !mongoose.Types.ObjectId.isValid(engineQuoteId)) return res.status(200).end();

    const cart = await AbandonedCart.findById(engineQuoteId);
    if (!cart) return res.status(200).end();

    const amountCents = payment.amount && payment.amount.value
      ? Math.round(parseFloat(payment.amount.value) * 100)
      : 0;

    // Idempotence : si déjà traité comme payé, ne rien refaire
    const alreadyPaid = cart.engineQuote && cart.engineQuote.payment && cart.engineQuote.payment.status === 'paid';

    if (payment.status === 'paid') {
      await AbandonedCart.updateOne(
        { _id: cart._id },
        {
          $set: {
            'engineQuote.status': 'acompte_recu',
            'engineQuote.payment.mollieId': paymentId,
            'engineQuote.payment.amountCents': amountCents,
            'engineQuote.payment.status': 'paid',
            'engineQuote.payment.paidAt': new Date(),
            'engineQuote.updatedAt': new Date(),
          },
        }
      );

      // Notification commerciale (best-effort, une seule fois)
      if (!alreadyPaid) {
        const quoteRef = (cart.requested && cart.requested.ref) || '';
        const clientName = ((cart.firstName || '') + ' ' + (cart.lastName || '')).trim() || cart.email || cart.phone || '—';
        const toEmail = brand.EMAIL_CONTACT;
        const subject = `💰 Acompte reçu — ${quoteRef} — ${clientName}`;
        const html = `
          <div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827;">
            <h2 style="margin:0 0 12px;color:#047857;">💰 Acompte payé !</h2>
            <p style="margin:0 0 8px;"><strong>Dossier :</strong> ${quoteRef}</p>
            <p style="margin:0 0 8px;"><strong>Client :</strong> ${clientName}</p>
            <p style="margin:0 0 8px;"><strong>Montant :</strong> ${fmtEur(amountCents)}</p>
            ${cart.phone ? `<p style="margin:0 0 8px;"><strong>Téléphone :</strong> <a href="tel:${cart.phone}">${cart.phone}</a></p>` : ''}
            ${cart.email ? `<p style="margin:0 0 8px;"><strong>Email :</strong> <a href="mailto:${cart.email}">${cart.email}</a></p>` : ''}
            <p style="margin:16px 0 8px;color:#6b7280;font-size:13px;">Le moteur est réservé. Lance la préparation et l'expédition.</p>
            <p style="margin:0;"><a href="${(brand.SITE_URL || 'https://autoliva.com').replace(/\/$/, '')}/admin/devis-moteurs/${cart._id}" style="color:#E1001A;font-weight:bold;">Ouvrir le dossier →</a></p>
          </div>`;
        const text = `Acompte payé !\nDossier: ${quoteRef}\nClient: ${clientName}\nMontant: ${fmtEur(amountCents)}\nTéléphone: ${cart.phone || '—'}\n\nLe moteur est réservé.`;
        try {
          await emailService.sendEmail({ toEmail, subject, html, text });
        } catch (err) {
          console.error('[engine-quote-webhook] notif commercial échouée:', err && err.message);
        }
        console.log(`[engine-quote-webhook] Acompte payé pour ${quoteRef || cart._id} : ${fmtEur(amountCents)}`);

        // Confirmation AU CLIENT : son acompte est reçu, le moteur est réservé.
        // (best-effort, ne bloque jamais le webhook qui doit répondre 200 à Mollie)
        if (cart.email) {
          const site = (brand.SITE_URL || 'https://autoliva.com').replace(/\/$/, '');
          const firstName = (cart.firstName || '').trim();
          const greeting = firstName ? `Bonjour ${firstName},` : 'Bonjour,';
          const clientSubject = `Acompte reçu — votre moteur est réservé (${quoteRef})`;
          const clientHtml = buildAcompteConfirmationHtml({
            firstName,
            quoteRef,
            amountEur: amountCents / 100,
            brandPhone: brand.PHONE_MOTEUR,
            brandPhoneIntl: brand.PHONE_MOTEUR_INTL,
          });
          const clientText = [
            `${greeting}`,
            ``,
            `Votre acompte de ${fmtEur(amountCents)} est bien reçu : votre moteur est officiellement réservé (dossier ${quoteRef}).`,
            ``,
            `Et maintenant ?`,
            `- Préparation et passage sur banc d'essai.`,
            `- Email d'expédition avec le suivi transporteur.`,
            `- Solde à régler une fois le moteur testé et déclaré conforme.`,
            ``,
            `Une question ? ${brand.PHONE_MOTEUR || '04 65 84 85 39'}`,
            ``,
            `L'équipe technique Autoliva`,
            `Référence : ${quoteRef}`,
          ].join('\n');
          try {
            await emailService.sendEmail({ toEmail: cart.email, subject: clientSubject, html: clientHtml, text: clientText });
          } catch (err) {
            console.error('[engine-quote-webhook] confirmation client échouée:', err && err.message);
          }
        }
      }
    } else if (['failed', 'expired', 'canceled'].includes(payment.status)) {
      // On garde une trace mais on ne change pas le statut workflow
      await AbandonedCart.updateOne(
        { _id: cart._id },
        {
          $set: {
            'engineQuote.payment.mollieId': paymentId,
            'engineQuote.payment.status': payment.status,
          },
        }
      );
    }

    return res.status(200).end();
  } catch (err) {
    console.error('[engine-quote-webhook]', err && err.message);
    return res.status(200).end(); // ne JAMAIS renvoyer 5xx à Mollie
  }
}

/**
 * GET /api/devis-moteurs/track-open/:cartId/:sentQuoteId
 * Pixel 1x1 inséré dans l'email de devis. À l'affichage par le client,
 * on incrémente openCount et on pose openedAt (1ère fois seulement).
 * Renvoie toujours le GIF transparent, même en cas d'erreur.
 */
async function getTrackOpen(req, res) {
  // Helper pour servir le GIF avec headers anti-cache
  function serveGif() {
    res.set('Content-Type', 'image/gif');
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Pragma', 'no-cache');
    res.set('Expires', '0');
    return res.send(TRANSPARENT_GIF);
  }

  try {
    const { cartId, sentQuoteId } = req.params;
    if (mongoose.connection.readyState !== 1) return serveGif();
    if (!mongoose.Types.ObjectId.isValid(cartId)) return serveGif();

    const cart = await AbandonedCart.findById(cartId);
    if (!cart || !cart.engineQuote || !Array.isArray(cart.engineQuote.sentQuotes)) return serveGif();

    const sq = cart.engineQuote.sentQuotes.id(sentQuoteId);
    if (!sq) return serveGif();

    sq.openCount = (sq.openCount || 0) + 1;
    if (!sq.openedAt) sq.openedAt = new Date();
    await cart.save();

    return serveGif();
  } catch (err) {
    console.error('[engine-quote-track]', err && err.message);
    return serveGif();
  }
}

/**
 * GET /api/devis-moteurs/track-pay/:cartId/:sentQuoteId
 * Lien du bouton "Valider la réservation" dans l'email. On enregistre le clic
 * (signal chaud : le client veut payer) puis on redirige vers le vrai lien Mollie.
 */
async function getTrackPay(req, res) {
  const fallback = (brand.SITE_URL || 'https://autoliva.com').replace(/\/$/, '');
  try {
    const { cartId, sentQuoteId } = req.params;
    if (mongoose.connection.readyState !== 1) return res.redirect(302, fallback);
    if (!mongoose.Types.ObjectId.isValid(cartId)) return res.redirect(302, fallback);

    const cart = await AbandonedCart.findById(cartId);
    if (!cart || !cart.engineQuote || !Array.isArray(cart.engineQuote.sentQuotes)) {
      return res.redirect(302, fallback);
    }
    const sq = cart.engineQuote.sentQuotes.id(sentQuoteId);
    if (!sq) return res.redirect(302, fallback);

    // Devis évolutif : paiement de la DERNIÈRE version qui a un lien Mollie
    // (montant à jour), sinon celui du devis cliqué.
    const latest = cart.engineQuote.sentQuotes.slice().sort((a, b) => new Date(b.sentAt || 0) - new Date(a.sentAt || 0))[0];
    const payTarget = (latest && latest.mollieUrl) ? latest : sq;
    payTarget.payClickCount = (payTarget.payClickCount || 0) + 1;
    if (!payTarget.payClickedAt) payTarget.payClickedAt = new Date();
    await cart.save();

    // Redirige vers le vrai lien Mollie (validé http(s))
    const dest = String(payTarget.mollieUrl || '');
    if (/^https?:\/\//i.test(dest)) return res.redirect(302, dest);
    return res.redirect(302, fallback);
  } catch (err) {
    console.error('[engine-quote-track-pay]', err && err.message);
    return res.redirect(302, fallback);
  }
}

/**
 * GET /api/devis-moteurs/track-pdf/:cartId/:sentQuoteId
 * Lien "Voir le devis en ligne (PDF)" dans l'email. On enregistre la vue
 * puis on redirige vers le PDF stocké en GridFS (/sav-files/:id).
 */
async function getTrackPdf(req, res) {
  const fallback = (brand.SITE_URL || 'https://autoliva.com').replace(/\/$/, '');
  try {
    const { cartId, sentQuoteId } = req.params;
    if (mongoose.connection.readyState !== 1) return res.redirect(302, fallback);
    if (!mongoose.Types.ObjectId.isValid(cartId)) return res.redirect(302, fallback);

    const cart = await AbandonedCart.findById(cartId);
    if (!cart || !cart.engineQuote || !Array.isArray(cart.engineQuote.sentQuotes)) {
      return res.redirect(302, fallback);
    }
    const sq = cart.engineQuote.sentQuotes.id(sentQuoteId);
    if (!sq) return res.redirect(302, fallback);

    sq.pdfViewCount = (sq.pdfViewCount || 0) + 1;
    if (!sq.pdfViewedAt) sq.pdfViewedAt = new Date();
    await cart.save();

    // Redirige vers le PDF (URL relative /sav-files/:id ou absolue)
    const dest = String(sq.pdfUrl || (sq.pdfId ? '/sav-files/' + sq.pdfId : ''));
    if (dest.startsWith('/') || /^https?:\/\//i.test(dest)) return res.redirect(302, dest);
    return res.redirect(302, fallback);
  } catch (err) {
    console.error('[engine-quote-track-pdf]', err && err.message);
    return res.redirect(302, fallback);
  }
}

/**
 * GET /d/:code
 * Lien court de marque envoyé par SMS (« Le voir : autoliva.com/d/Xa7Qk2 »).
 * Résout le devis via son shortCode, enregistre la vue (comme /track-pdf)
 * puis redirige vers le PDF (désormais servi par /sav-files au porteur du lien).
 */
async function getShortDevisLink(req, res) {
  const fallback = (brand.SITE_URL || 'https://autoliva.com').replace(/\/$/, '');
  try {
    const code = String(req.params.code || '');
    if (mongoose.connection.readyState !== 1) return res.redirect(302, fallback);
    if (!/^[A-Za-z0-9]{4,16}$/.test(code)) return res.redirect(302, fallback);

    const cart = await AbandonedCart.findOne({ 'engineQuote.sentQuotes.shortCode': code });
    if (!cart || !cart.engineQuote || !Array.isArray(cart.engineQuote.sentQuotes)) {
      return res.redirect(302, fallback);
    }
    const sq = cart.engineQuote.sentQuotes.find((s) => s && s.shortCode === code);
    if (!sq) return res.redirect(302, fallback);

    // Devis évolutif : tout lien (même ancien) montre la DERNIÈRE version envoyée
    // → le client voit toujours le devis à jour après une modification.
    const target = cart.engineQuote.sentQuotes.slice().sort((a, b) => new Date(b.sentAt || 0) - new Date(a.sentAt || 0))[0] || sq;
    target.pdfViewCount = (target.pdfViewCount || 0) + 1;
    if (!target.pdfViewedAt) target.pdfViewedAt = new Date();
    await cart.save();

    const dest = String(target.pdfUrl || (target.pdfId ? '/sav-files/' + target.pdfId : '') || sq.pdfUrl || '');
    if (dest.startsWith('/') || /^https?:\/\//i.test(dest)) return res.redirect(302, dest);
    return res.redirect(302, fallback);
  } catch (err) {
    console.error('[engine-quote-short-link]', err && err.message);
    return res.redirect(302, fallback);
  }
}

/**
 * GET /devis/merci?ref=<quoteRef>
 * Page de RETOUR après le paiement Mollie de l'acompte (c'est le `redirectUrl`
 * du paiement). Mollie y renvoie le client pour TOUS les cas — payé, annulé,
 * expiré — et la redirection ne porte AUCUN statut. Avant, cette route
 * n'existait pas → le client tombait sur le 404 d'Autoliva (« redirigé vers
 * autoliva avec une erreur »). On lit donc le statut côté base (posé par le
 * webhook) et on affiche une page TOUJOURS rassurante, jamais une erreur.
 */
async function getDevisMerci(req, res) {
  const ref = String((req.query && req.query.ref) || '').trim().slice(0, 40);
  let paid = false;
  try {
    if (ref && mongoose.connection.readyState === 1) {
      const cart = await AbandonedCart
        .findOne({ 'requested.ref': ref })
        .select('engineQuote.status engineQuote.payment.status')
        .lean();
      if (cart && cart.engineQuote) {
        const pst = cart.engineQuote.payment && cart.engineQuote.payment.status;
        if (pst === 'paid' || cart.engineQuote.status === 'acompte_recu') paid = true;
      }
    }
  } catch (err) {
    console.error('[devis-merci]', err && err.message);
  }

  // Pas (encore) payé : le webhook Mollie peut arriver juste APRÈS la
  // redirection. On rafraîchit UNE seule fois (8 s) pour basculer en « payé »
  // sans action du client ; le garde `r=1` empêche toute boucle.
  const refreshUrl = (!paid && ref && !(req.query && req.query.r))
    ? '/devis/merci?ref=' + encodeURIComponent(ref) + '&r=1'
    : '';

  return res.status(200).render('devis/merci', {
    title: paid ? `Acompte reçu — ${brand.NAME}` : `Merci — ${brand.NAME}`,
    metaRobots: 'noindex, nofollow',
    ref,
    paid,
    refreshUrl,
    brandPhone: brand.PHONE_MOTEUR || '',
    brandPhoneIntl: brand.PHONE_MOTEUR_INTL || '',
  });
}

module.exports = { postMollieWebhook, getTrackOpen, getTrackPay, getTrackPdf, getShortDevisLink, getDevisMerci };
