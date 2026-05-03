const mongoose = require('mongoose');

const orderItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    name: { type: String, required: true, trim: true },
    sku: { type: String, default: '', trim: true },
    optionsSelection: { type: Object, default: {} },
    optionsSummary: { type: String, default: '', trim: true },
    unitPriceCents: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1, max: 99 },
    lineTotalCents: { type: Number, required: true, min: 0 },
    itemType: {
      type: String,
      enum: ['standard', 'exchange', 'exchange_cloning', ''],
      default: '',
    },
  },
  { _id: false }
);

const shipmentDocumentSchema = new mongoose.Schema(
  {
    originalName: { type: String, default: '', trim: true },
    storedName: { type: String, default: '', trim: true },
    storedPath: { type: String, default: '', trim: true },
    mimeType: { type: String, default: 'application/pdf', trim: true },
    sizeBytes: { type: Number, default: 0 },
    stamped: { type: Boolean, default: false },
    fileData: { type: Buffer, default: null, select: false },
    uploadedAt: { type: Date, default: null },
  },
  { _id: false }
);

const shipmentSchema = new mongoose.Schema(
  {
    label: { type: String, default: '', trim: true },
    carrier: { type: String, default: '', trim: true },
    trackingNumber: { type: String, required: true, trim: true },
    note: { type: String, default: '', trim: true },
    document: { type: shipmentDocumentSchema, default: null },
    createdAt: { type: Date, required: true },
    createdBy: { type: String, default: '', trim: true },
  },
  { timestamps: false }
);

const consigneLineSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    name: { type: String, required: true, trim: true },
    sku: { type: String, default: '', trim: true },
    quantity: { type: Number, required: true, min: 1, max: 99 },
    amountCents: { type: Number, required: true, min: 0 },
    delayDays: { type: Number, required: true, min: 0, max: 3650 },
    startAt: { type: Date, default: null },
    dueAt: { type: Date, default: null, index: true },
    receivedAt: { type: Date, default: null },
  },
  { timestamps: false }
);

const addressSnapshotSchema = new mongoose.Schema(
  {
    label: { type: String, default: '', trim: true },
    fullName: { type: String, default: '', trim: true },
    phone: { type: String, default: '', trim: true },
    line1: { type: String, required: true, trim: true },
    line2: { type: String, default: '', trim: true },
    postalCode: { type: String, required: true, trim: true },
    city: { type: String, required: true, trim: true },
    country: { type: String, default: 'France', trim: true },
  },
  { _id: false }
);

const statusHistorySchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['draft', 'pending_payment', 'paid', 'processing', 'shipped', 'delivered', 'completed', 'cancelled', 'refunded'],
      required: true,
    },
    cloningStatus: { type: String, default: null, trim: true },
    returnStatus: { type: String, default: null, trim: true },
    changedAt: { type: Date, required: true },
    changedBy: { type: String, default: '', trim: true },
    note: { type: String, default: '', trim: true },
  },
  { _id: false }
);

const emailSentSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, trim: true },
    sentAt: { type: Date, required: true },
    recipientEmail: { type: String, default: '', trim: true },
    status: { type: String, enum: ['sent', 'failed'], default: 'sent' },
    reason: { type: String, default: '', trim: true },
  },
  { _id: false }
);

const smsSentSchema = new mongoose.Schema(
  {
    type: { type: String, required: true, trim: true },
    sentAt: { type: Date, required: true },
    recipientPhone: { type: String, default: '', trim: true },
    status: { type: String, enum: ['sent', 'failed'], default: 'sent' },
    reason: { type: String, default: '', trim: true },
  },
  { _id: false }
);

const orderDocumentSchema = new mongoose.Schema(
  {
    docType: {
      type: String,
      enum: ['etiquette_envoi', 'bon_retour', 'recuperation_clonage', 'facture', 'bon_commande', 'autre'],
      default: 'autre',
    },
    originalName: { type: String, default: '', trim: true },
    storedName: { type: String, default: '', trim: true },
    storedPath: { type: String, default: '', trim: true },
    mimeType: { type: String, default: 'application/pdf', trim: true },
    sizeBytes: { type: Number, default: 0 },
    stamped: { type: Boolean, default: false },
    fileData: { type: Buffer, default: null, select: false },
    note: { type: String, default: '', trim: true },
    uploadedAt: { type: Date, default: null },
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },
    uploadedByName: { type: String, default: '', trim: true },
  },
  { timestamps: false }
);

const orderSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, index: true },
    number: { type: String, required: true, unique: true, trim: true },
    invoice: {
      number: { type: String, default: '', trim: true, index: true },
      issuedAt: { type: Date, default: null },
    },
    status: {
      type: String,
      enum: ['draft', 'pending_payment', 'paid', 'processing', 'shipped', 'delivered', 'completed', 'cancelled', 'refunded'],
      default: 'pending_payment',
      required: true,
    },
    orderType: {
      type: String,
      enum: ['standard', 'exchange', 'exchange_cloning'],
      default: 'standard',
    },
    cloningStatus: {
      type: String,
      enum: [
        'pending_label',
        'label_sent',
        'client_piece_in_transit',
        'client_piece_received',
        'cloning_in_progress',
        'cloning_done',
        'cloning_failed',
        null,
      ],
      default: null,
    },
    returnStatus: {
      type: String,
      enum: [
        'not_applicable',
        'pending',
        'label_sent',
        'in_transit',
        'received',
        'inspected_ok',
        'inspected_nok',
        'overdue',
      ],
      default: 'not_applicable',
    },
    cloningDates: {
      labelSentAt: { type: Date, default: null },
      clientPieceReceivedAt: { type: Date, default: null },
      cloningStartedAt: { type: Date, default: null },
      cloningCompletedAt: { type: Date, default: null },
      shippedToClientAt: { type: Date, default: null },
    },
    cloningTracking: {
      carrier: { type: String, default: '', trim: true },
      trackingNumber: { type: String, default: '', trim: true },
      trackingUrl: { type: String, default: '', trim: true },
    },
    cloningFailureNote: { type: String, default: '', trim: true },
    returnDates: {
      returnDueDate: { type: Date, default: null },
      returnLabelSentAt: { type: Date, default: null },
      returnReceivedAt: { type: Date, default: null },
      returnInspectedAt: { type: Date, default: null },
    },
    statusHistory: { type: [statusHistorySchema], default: [] },
    // ── Archivage & corbeille (soft delete) ─────────────────────────────
    archived: { type: Boolean, default: false },
    archivedAt: { type: Date, default: null },
    archivedBy: { type: String, default: '', trim: true },
    deletedAt: { type: Date, default: null },
    deletedBy: { type: String, default: '', trim: true },
    deleteReason: { type: String, default: '', trim: true },
    accountType: { type: String, enum: ['particulier', 'pro'], required: true },
    paymentProvider: { type: String, default: 'mollie', trim: true },
    paymentStatus: { type: String, default: 'pending', trim: true },
    molliePaymentId: { type: String, default: '', trim: true, index: true },
    molliePaymentStatus: { type: String, default: '', trim: true },
    mollieCheckoutUrl: { type: String, default: '', trim: true },
    mollieProfileId: { type: String, default: '', trim: true },
    molliePaidAt: { type: Date, default: null },
    mollieLastCheckedAt: { type: Date, default: null },
    scalapayOrderToken: { type: String, default: '', trim: true, index: true },
    scalapayCheckoutUrl: { type: String, default: '', trim: true },
    scalapayStatus: { type: String, default: '', trim: true },
    scalapayCapturedAt: { type: Date, default: null },
    scalapayLastCheckedAt: { type: Date, default: null },
    stockReservedAt: { type: Date, default: null },
    stockReleasedAt: { type: Date, default: null },
    currency: { type: String, default: 'EUR', trim: true },
    shippingMethod: { type: String, default: 'domicile', trim: true },
    shippingCostCents: { type: Number, default: 0, min: 0 },
    itemsSubtotalCents: { type: Number, default: 0, min: 0 },
    clientDiscountPercent: { type: Number, default: 0, min: 0, max: 100 },
    clientDiscountCents: { type: Number, default: 0, min: 0 },
    promoCode: { type: String, default: '', trim: true },
    promoDiscountCents: { type: Number, default: 0, min: 0 },
    itemsTotalAfterDiscountCents: { type: Number, default: 0, min: 0 },
    notifications: {
      orderConfirmationSentAt: { type: Date, default: null },
      consigneStartSentAt: { type: Date, default: null },
      consigneReceivedSentAt: { type: Date, default: null },
      consigneReminderSoonSentAt: { type: Date, default: null },
      consigneOverdueSentAt: { type: Date, default: null },
      shipmentLastSentAt: { type: Date, default: null },
      shipmentTrackingNumbersSent: { type: [String], default: [] },
      deliveryConfirmedSentAt: { type: Date, default: null },
      statusChangeSentAt: { type: Date, default: null },
    },
    emailsSent: { type: [emailSentSchema], default: [] },
    smsSent: { type: [smsSentSchema], default: [] },
    consigne: {
      lines: { type: [consigneLineSchema], default: [] },
    },
    shipments: { type: [shipmentSchema], default: [] },
    totalCents: { type: Number, required: true, min: 0 },
    items: { type: [orderItemSchema], required: true },
    shippingAddress: { type: addressSnapshotSchema, required: true },
    billingAddress: { type: addressSnapshotSchema, required: true },
    vehicle: {
      identifierType: { type: String, enum: ['', 'plate', 'vin'], default: '', trim: true },
      plate: { type: String, default: '', trim: true },
      vin: { type: String, default: '', trim: true },
      consentAt: { type: Date, default: null },
      providedAt: { type: Date, default: null },
    },
    legal: {
      cgvAcceptedAt: { type: Date, default: null },
      cgvSlug: { type: String, default: 'cgv', trim: true },
      cgvUpdatedAt: { type: Date, default: null },
    },
    source: {
      channel: {
        type: String,
        enum: ['website', 'phone', 'email', 'whatsapp', 'leboncoin', 'marketplace', 'salon', 'manual', 'other'],
        default: 'website',
      },
      detail: { type: String, default: '', trim: true },
    },
    isManual: { type: Boolean, default: false },
    // Flag GA4/GTM : passe à true la première fois que la page de confirmation
    // a poussé l'event `purchase` dans le dataLayer. Permet d'éviter les
    // doubles comptages (reload, re-visite, etc.) côté serveur.
    analyticsTracked: { type: Boolean, default: false },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', default: null },
    noteInternal: { type: String, default: '', trim: true },
    noteClient: { type: String, default: '', trim: true },
    quoteReference: { type: String, default: '', trim: true },
    documents: { type: [orderDocumentSchema], default: [] },
  },
  {
    timestamps: true,
  }
);

// ---------------------------------------------------------------------------
// Pre-save middleware — validation des sous-statuts et historique automatique
// ---------------------------------------------------------------------------
orderSchema.pre('save', function (next) {
  const order = this;

  // ─── 1. Synchroniser cloningStatus / returnStatus selon orderType ───
  if (order.isModified('orderType')) {
    if (order.orderType === 'exchange_cloning') {
      // Clonage : la pièce client est envoyée au DÉBUT, pas de retour séparé
      if (!order.cloningStatus) order.cloningStatus = 'pending_label';
      order.returnStatus = 'not_applicable';
    } else if (order.orderType === 'exchange') {
      // Échange standard : retour attendu J+30 après livraison
      order.cloningStatus = null;
      if (order.returnStatus === 'not_applicable') {
        order.returnStatus = 'pending';
      }
    } else {
      // Standard : rien
      order.cloningStatus = null;
      order.returnStatus = 'not_applicable';
    }
  }

  // ─── 2. Si status → 'shipped' → calculer returnDueDate selon orderType ───
  if (order.isModified('status') && order.status === 'shipped') {
    if (!order.returnDates) order.returnDates = {};

    if (order.orderType === 'exchange') {
      // Échange standard : retour J+30 systématique
      if (!order.returnDates.returnDueDate) {
        const dueDate = new Date();
        dueDate.setDate(dueDate.getDate() + 30);
        order.returnDates.returnDueDate = dueDate;
      }
      if (order.returnStatus === 'not_applicable') {
        order.returnStatus = 'pending';
      }
    } else if (order.orderType === 'exchange_cloning') {
      // Clonage : vérifier si un article est de type 'exchange' (commande mixte)
      // Si oui, un retour J+30 est quand même nécessaire pour cet article
      const hasExchangeItem = Array.isArray(order.items)
        && order.items.some(item => item && item.itemType === 'exchange');
      if (hasExchangeItem) {
        if (!order.returnDates.returnDueDate) {
          const dueDate = new Date();
          dueDate.setDate(dueDate.getDate() + 30);
          order.returnDates.returnDueDate = dueDate;
        }
        order.returnStatus = 'pending';
      }
      // Si tous les articles sont exchange_cloning → returnStatus reste 'not_applicable'
    }
  }

  // ─── 3. Mise à jour automatique des cloningDates ───
  if (order.isModified('cloningStatus') && order.orderType === 'exchange_cloning') {
    if (!order.cloningDates) order.cloningDates = {};

    switch (order.cloningStatus) {
      case 'label_sent':
        if (!order.cloningDates.labelSentAt) order.cloningDates.labelSentAt = new Date();
        break;
      case 'client_piece_received':
        if (!order.cloningDates.clientPieceReceivedAt) order.cloningDates.clientPieceReceivedAt = new Date();
        break;
      case 'cloning_in_progress':
        if (!order.cloningDates.cloningStartedAt) order.cloningDates.cloningStartedAt = new Date();
        break;
      case 'cloning_done':
      case 'cloning_failed':
        if (!order.cloningDates.cloningCompletedAt) order.cloningDates.cloningCompletedAt = new Date();
        break;
    }
  }

  // ─── 4. Mise à jour automatique des returnDates ───
  if (order.isModified('returnStatus') && order.orderType === 'exchange') {
    if (!order.returnDates) order.returnDates = {};

    switch (order.returnStatus) {
      case 'label_sent':
        if (!order.returnDates.returnLabelSentAt) order.returnDates.returnLabelSentAt = new Date();
        break;
      case 'received':
        if (!order.returnDates.returnReceivedAt) order.returnDates.returnReceivedAt = new Date();
        break;
      case 'inspected_ok':
      case 'inspected_nok':
        if (!order.returnDates.returnInspectedAt) order.returnDates.returnInspectedAt = new Date();
        break;
    }
  }

  // ─── 5. Ajout automatique dans statusHistory ───
  // On ajoute une entrée si status, cloningStatus ou returnStatus a changé
  const statusChanged = order.isModified('status');
  const cloningChanged = order.isModified('cloningStatus');
  const returnChanged = order.isModified('returnStatus');

  if ((statusChanged || cloningChanged || returnChanged) && !order.isNew) {
    // Vérifier si la dernière entrée n'est pas identique (éviter doublons)
    const lastEntry = Array.isArray(order.statusHistory) && order.statusHistory.length
      ? order.statusHistory[order.statusHistory.length - 1]
      : null;

    const isSame = lastEntry
      && lastEntry.status === order.status
      && (lastEntry.cloningStatus || null) === (order.cloningStatus || null)
      && (lastEntry.returnStatus || null) === (order.returnStatus || null);

    if (!isSame) {
      // Garde défensive : les vieilles commandes peuvent ne pas avoir le champ statusHistory
      if (!Array.isArray(order.statusHistory)) order.statusHistory = [];
      order.statusHistory.push({
        status: order.status,
        cloningStatus: order.cloningStatus || null,
        returnStatus: order.returnStatus || null,
        changedAt: new Date(),
        changedBy: order._statusChangedBy || '',
        note: order._statusChangeNote || '',
      });
    }
  }

  // Nettoyer les champs temporaires
  delete order._statusChangedBy;
  delete order._statusChangeNote;

  next();
});

orderSchema.index({ userId: 1, createdAt: -1 });
orderSchema.index({ userId: 1, status: 1, createdAt: -1 });
orderSchema.index({ archived: 1, createdAt: -1 });
orderSchema.index(
  { deletedAt: 1 },
  { partialFilterExpression: { deletedAt: { $type: 'date' } } }
);

module.exports = mongoose.model('Order', orderSchema);
