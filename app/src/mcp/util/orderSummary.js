'use strict';

// Résumé d'une commande pour le connecteur : ce qu'il faut pour instruire un
// dossier SAV (dates, statuts, envois, consigne, remboursements, e-mails
// partis), sans les fichiers, sans les adresses postales ni les téléphones.

const Order = require('../../models/Order');
const { eurFromCents } = require('./format');
const { iso } = require('./sav');

/* Champs lourds ou sans intérêt ici : binaires (étiquettes, avoirs, facture
 * d'achat), réponses brutes des prestataires de paiement, attribution pub. */
const EXCLUDED = [
  '-documents.fileData',
  '-shipments.document.fileData',
  '-creditNotes.pdfData',
  '-purchase.invoiceFile.data',
  '-refunds.providerRawResponse',
  '-attribution',
  '-comptoir',
].join(' ');

/* Une commande se retrouve par son numéro (CP2026-000374) ou, à défaut, par
 * son numéro de facture (F-2026-1323) : les tickets SAV portent l'un ou l'autre. */
async function findOrder(reference) {
  const ref = String(reference || '').trim();
  if (!ref || ref.length > 60) return null;
  const byNumber = await Order.findOne({ number: ref }).select(EXCLUDED).lean();
  if (byNumber) return byNumber;
  return Order.findOne({ 'invoice.number': ref }).select(EXCLUDED).lean();
}

function summarizeOrder(o) {
  if (!o) return null;
  const ship = o.shippingAddress || {};
  const consigne = o.consigne || {};
  const purchase = o.purchase || {};
  return {
    number: o.number,
    invoice_number: (o.invoice && o.invoice.number) || null,
    created_at: iso(o.createdAt),
    status: o.status,
    order_type: o.orderType || null,
    account_type: o.accountType || null,
    source: (o.source && o.source.channel) || null,
    is_manual: !!o.isManual,
    deleted: !!o.deletedAt,
    archived: !!o.archived,
    customer: {
      name: ship.fullName || '',
      postal_code: ship.postalCode || '',
      city: ship.city || '',
      country: ship.country || '',
    },
    vehicle: {
      plate: (o.vehicle && o.vehicle.plate) || null,
      vin: (o.vehicle && o.vehicle.vin) || null,
    },
    legal: {
      cgv_accepted_at: iso(o.legal && o.legal.cgvAcceptedAt),
      cgv_version_updated_at: iso(o.legal && o.legal.cgvUpdatedAt),
    },
    items: (o.items || []).map((i) => ({
      name: i.name,
      sku: i.sku || '',
      quantity: i.quantity,
      unit_price_eur: eurFromCents(i.unitPriceCents),
      line_total_eur: eurFromCents(i.lineTotalCents),
      item_type: i.itemType || '',
      options: i.optionsSummary || '',
    })),
    totals: {
      items_eur: eurFromCents(o.itemsSubtotalCents),
      shipping_eur: eurFromCents(o.shippingCostCents),
      total_eur: eurFromCents(o.totalCents),
      currency: o.currency || 'EUR',
    },
    payment: {
      provider: o.paymentProvider || '',
      status: o.paymentStatus || '',
      paid_at: iso(o.molliePaidAt || o.scalapayCapturedAt),
    },
    delivery_estimate: iso(o.deliveryEstimate && o.deliveryEstimate.date),
    sourcing: {
      status: (o.sourcing && o.sourcing.status) || null,
      ordered_at: iso(o.sourcing && o.sourcing.orderedAt),
      expected_days: (o.sourcing && o.sourcing.expectedDays) ?? null,
      note: (o.sourcing && o.sourcing.note) || '',
    },
    preparation: {
      state: (o.preparation && o.preparation.state) || null,
      note: (o.preparation && o.preparation.note) || '',
    },
    status_history: (o.statusHistory || []).map((h) => ({
      status: h.status,
      at: iso(h.changedAt),
      by: h.changedBy || '',
      note: h.note || '',
    })),
    shipments: (o.shipments || []).map((s) => ({
      label: s.label || '',
      carrier: s.carrier || '',
      tracking_number: s.trackingNumber,
      created_at: iso(s.createdAt),
      created_by: s.createdBy || '',
      note: s.note || '',
      has_document: !!(s.document && (s.document.originalName || s.document.storedName)),
    })),
    return_dates: {
      due: iso(o.returnDates && o.returnDates.returnDueDate),
      label_sent_at: iso(o.returnDates && o.returnDates.returnLabelSentAt),
      received_at: iso(o.returnDates && o.returnDates.returnReceivedAt),
    },
    return_status: o.returnStatus || null,
    consigne: {
      charged_total_eur: eurFromCents(consigne.chargedTotalCents),
      refunded_total_eur: eurFromCents(consigne.refundedTotalCents),
      refunded_at: iso(consigne.refundedAt),
      lines: (consigne.lines || []).map((l) => ({
        name: l.name,
        amount_eur: eurFromCents(l.amountCents),
        due_at: iso(l.dueAt),
        received_at: iso(l.receivedAt),
        refunded_at: iso(l.refundedAt),
      })),
    },
    refunds: (o.refunds || []).map((r) => ({
      amount_eur: eurFromCents(r.amountCents),
      kind: r.kind || 'standard',
      method: r.method || '',
      reason: r.reason || '',
      at: iso(r.createdAt),
      credit_note: r.creditNoteNumber || '',
    })),
    emails_sent: (o.emailsSent || []).map((e) => ({ type: e.type, at: iso(e.sentAt), status: e.status })),
    documents: (o.documents || []).map((d) => ({
      type: d.docType || '',
      name: d.originalName || '',
      uploaded_at: iso(d.uploadedAt),
    })),
    purchase: {
      supplier: purchase.supplier || '',
      invoice_ref: purchase.invoiceRef || '',
      has_invoice_file: !!(purchase.invoiceFile && purchase.invoiceFile.originalName),
    },
    note_internal: o.noteInternal || '',
  };
}

module.exports = { findOrder, summarizeOrder, EXCLUDED };
