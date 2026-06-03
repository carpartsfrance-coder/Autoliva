/* refundService — orchestre les remboursements de commandes.
 *
 * Une seule fonction publique : `processOrderRefund(...)`. Elle :
 *   1. valide le montant et la méthode demandée
 *   2. appelle l'API du provider (Mollie pour l'instant ; Scalapay & autres
 *      en phase 2)
 *   3. push l'entrée dans Order.refunds[]
 *   4. génère un avoir PDF + entrée dans Order.creditNotes[] si demandé
 *   5. envoie l'email de confirmation au client si demandé
 *   6. bascule le statut Order (partially_refunded / refunded)
 *
 * Conçu pour être appelé depuis le contrôleur admin commande ET, en phase 2,
 * depuis le contrôleur SAV.
 */

const mongoose = require('mongoose');

const Order = require('../models/Order');
const User = require('../models/User');
const CreditNoteCounter = require('../models/CreditNoteCounter');

const mollie = require('./mollie');
const scalapay = require('./scalapay');
const { buildCreditNotePdfBuffer } = require('./creditNotePdf');
const emailService = require('./emailService');

const SUPPORTED_METHODS = ['mollie', 'scalapay', 'manual', 'bank_transfer', 'cash', 'other'];

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : value ? String(value).trim() : '';
}

function totalRefundedCents(order) {
  if (!order || !Array.isArray(order.refunds)) return 0;
  return order.refunds.reduce((s, r) => s + (Number(r && r.amountCents) || 0), 0);
}

function deriveDefaultMethod(order) {
  if (!order) return 'manual';
  /* Mollie capturé → remboursable via API */
  if (order.molliePaymentId && order.molliePaymentStatus === 'paid') return 'mollie';
  if (order.scalapayOrderToken && order.scalapayStatus === 'captured') return 'scalapay';
  return 'manual';
}

/** Génère le prochain numéro d'avoir (AV-YYYY-NNNN) de façon atomique. */
async function nextCreditNoteNumber(now = new Date()) {
  const year = now.getFullYear();
  const doc = await CreditNoteCounter.findOneAndUpdate(
    { year },
    { $inc: { seq: 1 } },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );
  const seq = String(doc.seq).padStart(4, '0');
  return `AV-${year}-${seq}`;
}

/**
 * @param {object} args
 * @param {string} args.orderId   - ID Mongo de la commande à rembourser
 * @param {number} args.amountCents - montant à rembourser (€ * 100)
 * @param {string} args.method    - 'mollie' | 'scalapay' | 'manual' | 'bank_transfer' | 'cash' | 'other'
 *                                  (si vide, déduit automatiquement depuis le provider de la commande)
 * @param {string} args.reason    - motif (saisie admin)
 * @param {Array<object>} [args.lines] - lignes remboursées (optionnel, sert au PDF d'avoir)
 * @param {boolean} [args.generateCreditNote=true] - produit un PDF avoir
 * @param {boolean} [args.sendEmail=true]          - envoie l'email client
 * @param {string} [args.adminEmail='admin']       - qui a déclenché l'action
 * @param {string} [args.notes]    - notes internes
 *
 * @returns {Promise<{ ok, refund?, creditNote?, providerResponse?, error?, errorCode? }>}
 */
async function processOrderRefund({
  orderId,
  amountCents,
  method,
  reason = '',
  lines = [],
  generateCreditNote = true,
  sendEmail = true,
  adminEmail = 'admin',
  notes = '',
} = {}) {
  /* ── 1. Validation ────────────────────────────────────────────── */
  if (!mongoose.Types.ObjectId.isValid(String(orderId))) {
    return { ok: false, errorCode: 'invalid_order_id', error: 'Identifiant de commande invalide.' };
  }
  const amount = Number(amountCents);
  if (!Number.isFinite(amount) || amount <= 0) {
    return { ok: false, errorCode: 'invalid_amount', error: 'Montant invalide.' };
  }

  const order = await Order.findById(orderId);
  if (!order) {
    return { ok: false, errorCode: 'order_not_found', error: 'Commande introuvable.' };
  }

  const alreadyRefunded = totalRefundedCents(order);
  const orderTotal = Number(order.totalCents) || 0;
  if (alreadyRefunded + amount > orderTotal) {
    return {
      ok: false,
      errorCode: 'amount_exceeds_total',
      error: `Le montant demandé dépasse ce qui reste remboursable (déjà remboursé : ${(alreadyRefunded / 100).toFixed(2)} €, plafond : ${(orderTotal / 100).toFixed(2)} €).`,
    };
  }

  const effectiveMethod = SUPPORTED_METHODS.includes(method) ? method : deriveDefaultMethod(order);

  /* ── 2. Appel provider ───────────────────────────────────────── */
  let providerRefundId = '';
  let providerStatus = '';
  let providerRawResponse = null;

  try {
    if (effectiveMethod === 'mollie') {
      if (!order.molliePaymentId) {
        return { ok: false, errorCode: 'no_mollie_payment', error: 'Aucun paiement Mollie associé à cette commande.' };
      }
      const desc = (reason ? `${reason} ` : '') + `(commande ${order.number})`;
      const resp = await mollie.createRefund({
        paymentId: order.molliePaymentId,
        amountCents: amount,
        description: desc.trim(),
      });
      providerRefundId = resp && resp.id ? String(resp.id) : '';
      providerStatus = resp && resp.status ? String(resp.status) : '';
      providerRawResponse = resp;
    } else if (effectiveMethod === 'scalapay') {
      /* Scalapay refund — fonction ajoutée si le service la supporte. En
       * phase 1 on accepte la méthode mais on ne contacte pas l'API pour
       * éviter une régression : on enregistre comme remboursement manuel
       * scalapay (à faire dans le back-office Scalapay). */
      if (typeof scalapay.refundPayment === 'function' && order.scalapayOrderToken) {
        try {
          const resp = await scalapay.refundPayment({ token: order.scalapayOrderToken, amountCents: amount, reason });
          providerRefundId = resp && resp.id ? String(resp.id) : '';
          providerStatus = resp && resp.status ? String(resp.status) : '';
          providerRawResponse = resp;
        } catch (errScala) {
          /* Si Scalapay rejette, on bascule en manuel : l'admin devra agir
           * dans le portail Scalapay. */
          providerStatus = 'manual_required';
          providerRawResponse = { error: errScala && errScala.message ? errScala.message : String(errScala) };
        }
      } else {
        providerStatus = 'manual_required';
      }
    } else {
      /* manual / bank_transfer / cash / other : pas d'appel API */
      providerStatus = 'manual';
    }
  } catch (providerErr) {
    return {
      ok: false,
      errorCode: 'provider_error',
      error: `Le provider ${effectiveMethod} a rejeté le remboursement : ${providerErr && providerErr.message ? providerErr.message : 'erreur inconnue'}.`,
    };
  }

  /* ── 3. Bookkeeping : push refund + avoir ────────────────────── */
  const now = new Date();
  const refundEntry = {
    amountCents: amount,
    reason: getTrimmedString(reason),
    method: effectiveMethod,
    providerRefundId,
    providerStatus,
    providerRawResponse,
    creditNoteNumber: '',
    lines: Array.isArray(lines) ? lines : [],
    createdAt: now,
    createdBy: adminEmail,
    notes: getTrimmedString(notes),
  };
  order.refunds.push(refundEntry);
  const refundIndex = order.refunds.length - 1;

  let creditNoteEntry = null;
  let creditNotePdfBuffer = null;
  if (generateCreditNote) {
    try {
      const number = await nextCreditNoteNumber(now);
      const cnDraft = {
        number,
        issuedAt: now,
        totalCents: amount,
        reason: getTrimmedString(reason),
        lines: refundEntry.lines,
        refundIndex,
        createdBy: adminEmail,
      };
      const recipient = order.userId ? await User.findById(order.userId).lean() : null;
      creditNotePdfBuffer = await buildCreditNotePdfBuffer({
        order: order.toObject ? order.toObject() : order,
        user: recipient,
        creditNote: cnDraft,
        refund: refundEntry,
      });
      const sizeBytes = creditNotePdfBuffer && Buffer.isBuffer(creditNotePdfBuffer) ? creditNotePdfBuffer.length : 0;
      creditNoteEntry = {
        ...cnDraft,
        pdfData: creditNotePdfBuffer || null,
        pdfSizeBytes: sizeBytes,
      };
      order.creditNotes.push(creditNoteEntry);
      order.refunds[refundIndex].creditNoteNumber = number;
    } catch (cnErr) {
      console.error('[refund-service] Génération avoir échouée :', cnErr && cnErr.message ? cnErr.message : cnErr);
      /* On continue : le refund a été émis, l'avoir pourra être régénéré */
    }
  }

  /* ── 4. Mise à jour statut commande ──────────────────────────── */
  const totalAfter = alreadyRefunded + amount;
  if (totalAfter >= orderTotal) {
    order.status = 'refunded';
  } else if (totalAfter > 0 && order.status !== 'refunded') {
    order.status = 'partially_refunded';
  }
  order._statusChangedBy = adminEmail;
  order._statusChangeNote = `Remboursement ${(amount / 100).toFixed(2)} € via ${effectiveMethod}${reason ? ` — ${reason}` : ''}`;

  await order.save();

  /* ── 5. Email client (best effort) ───────────────────────────── */
  if (sendEmail && order.userId) {
    try {
      const user = await User.findById(order.userId).lean();
      if (user && user.email) {
        const sendRes = await emailService.sendRefundIssuedEmail({
          order: order.toObject ? order.toObject() : order,
          user,
          refund: refundEntry,
          creditNote: creditNoteEntry,
          creditNotePdfBuffer,
        });
        await emailService.logEmailSent({
          orderId: order._id,
          emailType: 'refund_issued',
          recipientEmail: user.email,
          result: sendRes,
        });
      }
    } catch (mailErr) {
      console.error('[refund-service] Email remboursement échoué :', mailErr && mailErr.message ? mailErr.message : mailErr);
    }
  }

  return {
    ok: true,
    refund: refundEntry,
    creditNote: creditNoteEntry,
    providerResponse: providerRawResponse,
  };
}

/* ════════════════════════════════════════════════════════════════
 * Remboursement de la CONSIGNE (caution hors-TVA) au retour du core
 * ════════════════════════════════════════════════════════════════
 *
 * Distinct de processOrderRefund — un retour de caution n'est PAS un
 * remboursement commercial :
 *   - rembourse uniquement la consigne ENCAISSÉE (consigne.chargedTotalCents)
 *   - n'émet PAS d'avoir TVA (la caution n'était pas du CA taxable)
 *   - ne bascule PAS le statut commande en partially_refunded (le client
 *     garde sa pièce ; l'échange s'est déroulé normalement)
 *   - marque consigne.lines[].refundedAt/refundedCents + consigne.refunded*
 *   - trace tout de même dans Order.refunds[] (kind:'consigne') pour la compta
 *
 * Validation MANUELLE : déclenché par l'admin depuis la fiche commande
 * une fois l'ancien organe physiquement reçu.
 */
async function processConsigneRefund({ orderId, adminEmail = 'admin', sendEmail = true } = {}) {
  if (!mongoose.Types.ObjectId.isValid(String(orderId))) {
    return { ok: false, errorCode: 'invalid_order_id', error: 'Identifiant de commande invalide.' };
  }

  const order = await Order.findById(orderId);
  if (!order) {
    return { ok: false, errorCode: 'order_not_found', error: 'Commande introuvable.' };
  }

  const consigne = order.consigne || {};
  const chargedTotal = Number(consigne.chargedTotalCents) || 0;
  if (chargedTotal <= 0) {
    return { ok: false, errorCode: 'no_consigne_charged', error: 'Aucune consigne n’a été encaissée à la commande — rien à rembourser.' };
  }

  const alreadyRefundedConsigne = Number(consigne.refundedTotalCents) || 0;
  const amount = chargedTotal - alreadyRefundedConsigne;
  if (amount <= 0) {
    return { ok: false, errorCode: 'consigne_already_refunded', error: 'La consigne a déjà été remboursée.' };
  }

  /* Sécurité : ne jamais dépasser le total remboursable de la commande. */
  const alreadyRefundedAll = totalRefundedCents(order);
  const orderTotal = Number(order.totalCents) || 0;
  if (alreadyRefundedAll + amount > orderTotal) {
    return {
      ok: false,
      errorCode: 'amount_exceeds_total',
      error: `Le montant de la consigne (${(amount / 100).toFixed(2)} €) dépasse le plafond remboursable restant de la commande.`,
    };
  }

  /* Méthode : Mollie si paiement capturé, sinon manuel (virement à faire). */
  const method = order.molliePaymentId && order.molliePaymentStatus === 'paid' ? 'mollie' : 'manual';
  let providerRefundId = '';
  let providerStatus = '';
  let providerRawResponse = null;

  try {
    if (method === 'mollie') {
      const resp = await mollie.createRefund({
        paymentId: order.molliePaymentId,
        amountCents: amount,
        description: `Remboursement consigne (commande ${order.number})`,
      });
      providerRefundId = resp && resp.id ? String(resp.id) : '';
      providerStatus = resp && resp.status ? String(resp.status) : '';
      providerRawResponse = resp;
    } else {
      providerStatus = 'manual';
    }
  } catch (providerErr) {
    return {
      ok: false,
      errorCode: 'provider_error',
      error: `Le remboursement Mollie a échoué : ${providerErr && providerErr.message ? providerErr.message : 'erreur inconnue'}.`,
    };
  }

  const now = new Date();

  /* Marque les lignes de consigne encaissées non encore remboursées. */
  (order.consigne.lines || []).forEach((l) => {
    if (!l) return;
    const lineCharged = Number(l.chargedCents) || 0;
    if (l.charged && lineCharged > 0 && !l.refundedAt) {
      l.refundedAt = now;
      l.refundedCents = lineCharged;
    }
  });

  order.consigne.refundedTotalCents = alreadyRefundedConsigne + amount;
  order.consigne.refundedAt = now;
  order.consigne.refundMethod = method;
  order.consigne.refundProviderRefundId = providerRefundId;

  /* Trace compta — caution hors-TVA, donc aucun avoir TVA généré. */
  const refundEntry = {
    amountCents: amount,
    reason: 'Remboursement consigne (retour du core)',
    kind: 'consigne',
    method,
    providerRefundId,
    providerStatus,
    providerRawResponse,
    creditNoteNumber: '',
    lines: [],
    createdAt: now,
    createdBy: adminEmail,
    notes: 'Caution hors-TVA remboursée au retour de l’ancien organe.',
  };
  order.refunds.push(refundEntry);

  /* IMPORTANT : pas de changement de order.status — un retour de caution
   * fait partie du cycle de vie normal de l'échange. */
  await order.save();

  /* Email de confirmation au client (best effort). */
  if (sendEmail && order.userId) {
    try {
      const user = await User.findById(order.userId).lean();
      if (user && user.email) {
        const sendRes = await emailService.sendConsigneRefundEmail({
          order: order.toObject ? order.toObject() : order,
          user,
          amountCents: amount,
          method,
        });
        await emailService.logEmailSent({
          orderId: order._id,
          emailType: 'consigne_refund',
          recipientEmail: user.email,
          result: sendRes,
        });
      }
    } catch (mailErr) {
      console.error('[refund-service] Email remboursement consigne échoué :', mailErr && mailErr.message ? mailErr.message : mailErr);
    }
  }

  return { ok: true, refund: refundEntry, amountCents: amount, method, providerRefundId };
}

/* ════════════════════════════════════════════════════════════════
 * Synchronisation des remboursements créés EN DEHORS de notre site
 * ════════════════════════════════════════════════════════════════
 *
 * Cas d'usage : l'owner ouvre le dashboard Mollie, clique sur
 * "Rembourser" sur une transaction. Mollie effectue le remboursement
 * et fire un webhook vers notre URL. Mais notre site n'a JAMAIS appelé
 * mollie.createRefund() pour ce remboursement → aucun avoir n'a été
 * créé → non-conformité légale (art. 289-VII CGI : tout remboursement
 * doit donner lieu à une facture rectificative ou avoir).
 *
 * Cette fonction est le filet de sécurité : elle scanne les refunds
 * Mollie d'un paiement et, pour chaque refund qu'on n'a pas encore
 * enregistré dans Order.refunds[], crée l'avoir + l'entrée bookkeeping.
 *
 * Idempotente : appelée plusieurs fois sur le même paiement, ne
 * recrée rien (dédup via providerRefundId).
 */
async function syncMollieRefundsForOrder({ orderId, mollieRefunds = [] } = {}) {
  if (!mongoose.Types.ObjectId.isValid(String(orderId))) {
    return { ok: false, errorCode: 'invalid_order_id', error: 'Identifiant de commande invalide.' };
  }
  if (!Array.isArray(mollieRefunds) || mollieRefunds.length === 0) {
    return { ok: true, newRefundsCount: 0, totalAmountCents: 0 };
  }

  const order = await Order.findById(orderId);
  if (!order) return { ok: false, errorCode: 'order_not_found', error: 'Commande introuvable.' };

  /* Set des providerRefundId déjà connus pour faire la diff rapide */
  const knownIds = new Set();
  for (const r of order.refunds || []) {
    if (r && r.providerRefundId) knownIds.add(String(r.providerRefundId));
  }

  let newRefundsCount = 0;
  let totalAmountCents = 0;
  const errors = [];

  for (const mr of mollieRefunds) {
    if (!mr || !mr.id) continue;
    if (knownIds.has(String(mr.id))) continue; // déjà traité

    /* Conversion Mollie amount → cents */
    const amountStr = mr.amount && mr.amount.value ? String(mr.amount.value) : '';
    const amountCents = Math.round(parseFloat(amountStr) * 100);
    if (!Number.isFinite(amountCents) || amountCents <= 0) {
      errors.push({ refundId: mr.id, error: 'amount invalide' });
      continue;
    }

    /* On vérifie qu'on ne dépasse pas le total commande (sécurité) */
    const alreadyRefunded = totalRefundedCents(order);
    const orderTotal = Number(order.totalCents) || 0;
    if (alreadyRefunded + amountCents > orderTotal) {
      console.warn(`[refund-service] sync : refund Mollie ${mr.id} dépasse le total commande (${alreadyRefunded + amountCents} > ${orderTotal}). Ignoré.`);
      errors.push({ refundId: mr.id, error: 'dépasse le total commande' });
      continue;
    }

    /* Bookkeeping : ajout dans Order.refunds[] + génération avoir */
    const now = new Date();
    const refundEntry = {
      amountCents,
      reason: getTrimmedString(mr.description) || 'Remboursement Mollie (dashboard)',
      method: 'mollie',
      providerRefundId: String(mr.id),
      providerStatus: getTrimmedString(mr.status) || '',
      providerRawResponse: mr,
      creditNoteNumber: '',
      lines: [],
      createdAt: mr.createdAt ? new Date(mr.createdAt) : now,
      createdBy: 'mollie-webhook',
      notes: 'Détecté via webhook Mollie (refund créé hors back-office)',
    };
    order.refunds.push(refundEntry);
    const refundIndex = order.refunds.length - 1;

    /* Génération de l'avoir PDF */
    try {
      const number = await nextCreditNoteNumber(now);
      const cnDraft = {
        number,
        issuedAt: now,
        totalCents: amountCents,
        reason: refundEntry.reason,
        lines: [],
        refundIndex,
        createdBy: 'mollie-webhook',
      };
      const recipient = order.userId ? await User.findById(order.userId).lean() : null;
      const pdfBuffer = await buildCreditNotePdfBuffer({
        order: order.toObject ? order.toObject() : order,
        user: recipient,
        creditNote: cnDraft,
        refund: refundEntry,
      });
      const sizeBytes = pdfBuffer && Buffer.isBuffer(pdfBuffer) ? pdfBuffer.length : 0;
      order.creditNotes.push({ ...cnDraft, pdfData: pdfBuffer || null, pdfSizeBytes: sizeBytes });
      order.refunds[refundIndex].creditNoteNumber = number;
    } catch (cnErr) {
      console.error('[refund-service] Sync : génération avoir échouée :', cnErr && cnErr.message ? cnErr.message : cnErr);
      errors.push({ refundId: mr.id, error: 'avoir non généré (' + (cnErr && cnErr.message ? cnErr.message : 'inconnu') + ')' });
      /* on continue : le refund est enregistré, l'avoir pourra être regénéré au téléchargement */
    }

    knownIds.add(String(mr.id));
    newRefundsCount++;
    totalAmountCents += amountCents;
  }

  if (newRefundsCount > 0) {
    /* Mise à jour du statut commande */
    const newTotal = totalRefundedCents(order);
    const orderTotal = Number(order.totalCents) || 0;
    if (newTotal >= orderTotal) {
      order.status = 'refunded';
    } else if (newTotal > 0 && order.status !== 'refunded') {
      order.status = 'partially_refunded';
    }
    order._statusChangedBy = 'mollie-webhook';
    order._statusChangeNote = `Sync auto ${newRefundsCount} refund(s) Mollie (${(totalAmountCents / 100).toFixed(2)} €)`;

    await order.save();
  }

  return { ok: true, newRefundsCount, totalAmountCents, errors };
}

module.exports = {
  processOrderRefund,
  processConsigneRefund,
  syncMollieRefundsForOrder,
  nextCreditNoteNumber,
  totalRefundedCents,
  deriveDefaultMethod,
  SUPPORTED_METHODS,
};
