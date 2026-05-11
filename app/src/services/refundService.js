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

module.exports = {
  processOrderRefund,
  nextCreditNoteNumber,
  totalRefundedCents,
  deriveDefaultMethod,
  SUPPORTED_METHODS,
};
