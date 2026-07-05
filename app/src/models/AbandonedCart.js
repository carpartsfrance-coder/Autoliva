const mongoose = require('mongoose');
const crypto = require('crypto');

const abandonedCartItemSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, required: true },
    name: { type: String, required: true, trim: true },
    sku: { type: String, default: '', trim: true },
    price: { type: Number, required: true, min: 0 },
    quantity: { type: Number, required: true, min: 1, max: 99 },
    image: { type: String, default: '', trim: true },
    optionsSelection: { type: Object, default: {} },
    optionsSummary: { type: String, default: '', trim: true },
  },
  { _id: false }
);

const abandonedCartNoteSchema = new mongoose.Schema(
  {
    text: { type: String, required: true, trim: true },
    addedBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    addedByName: { type: String, default: '', trim: true },
    addedAt: { type: Date, default: Date.now },
  },
  { _id: true }
);

/**
 * Sous-document pour le workflow "Devis moteur d'occasion".
 * Présent uniquement sur les leads avec captureSource = 'landing_moteurs'.
 * Permet au commercial de saisir l'identification moteur, le stock, la
 * tarification (marge auto), et de stocker les photos (moteur, km, banc).
 */
const engineQuotePhotoSchema = new mongoose.Schema(
  {
    id: { type: String, required: true },                // ObjectId GridFS (string)
    url: { type: String, required: true },               // /sav-files/<id>
    filename: { type: String, default: '' },
    mime: { type: String, default: '' },
    size: { type: Number, default: 0 },
    uploadedAt: { type: Date, default: Date.now },
    uploadedByName: { type: String, default: '' },
  },
  { _id: false }
);

// Résultat d'un envoi SMS (visible dans l'admin pour diagnostiquer « pas reçu »).
const smsResultSchema = new mongoose.Schema(
  {
    status: { type: String, default: '' },  // 'sent' | 'failed' | 'disabled'
    reason: { type: String, default: '' },   // ex: 'invalid_phone', 'brevo_error', 'disabled'
    message: { type: String, default: '' },  // message clair (crédits épuisés…)
    at: { type: Date, default: null },
    phone: { type: String, default: '' },
  },
  { _id: false }
);

const engineQuoteSentSchema = new mongoose.Schema(
  {
    sentAt: { type: Date, default: Date.now },
    version: { type: Number, default: 1 }, // n° de révision (1, 2, 3…)
    sms: { type: smsResultSchema, default: null }, // résultat SMS du devis envoyé
    pdfId: { type: String, default: '' },
    pdfUrl: { type: String, default: '' },
    sellPriceHt: { type: Number, default: 0 },
    sellPriceTtc: { type: Number, default: 0 },
    depositCents: { type: Number, default: 0 },
    mollieUrl: { type: String, default: '' },
    mollieId: { type: String, default: '' },
    customMessage: { type: String, default: '' },
    sentByName: { type: String, default: '' },
    openedAt: { type: Date, default: null },     // 1er pixel d'ouverture email
    openCount: { type: Number, default: 0 },     // nombre total d'ouvertures
    payClickedAt: { type: Date, default: null }, // 1er clic sur le bouton paiement
    payClickCount: { type: Number, default: 0 }, // nombre total de clics paiement
    pdfViewedAt: { type: Date, default: null },  // 1ère vue du PDF en ligne (lien tracké)
    pdfViewCount: { type: Number, default: 0 },  // nombre total de vues PDF en ligne
    /** Code court pour le lien SMS de marque : autoliva.com/d/<shortCode>. */
    shortCode: { type: String, default: '', index: true },
    /** Snapshot des photos jointes au moment de l'envoi (URLs GridFS) */
    attachedPhotos: {
      type: [{ id: String, url: String, filename: String, category: String }],
      default: [],
    },
  },
  { _id: true }
);

const engineQuoteReminderSchema = new mongoose.Schema(
  {
    type: { type: String, enum: ['j3', 'j7', 'j14', 'j14_lost', 'j21_lost', 'hot_pdf', 'hot_pay', 'winback'], required: true },
    sentAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const engineQuoteSchema = new mongoose.Schema(
  {
    status: {
      type: String,
      enum: ['new', 'analyzing', 'quote_sent', 'acompte_recu', 'won', 'lost'],
      default: 'new',
    },
    identifiedEngine: {
      code: { type: String, default: '', trim: true },      // ex: 'M48.50'
      model: { type: String, default: '', trim: true },     // ex: 'Porsche Cayenne Turbo 4.5 V8 — 955 Turbo'
      year: { type: String, default: '', trim: true },      // ex: '2005'
      mileage: { type: Number, default: 0, min: 0 },        // km au compteur du moteur donneur
      condition: {                                          // état/reconditionnement
        type: String,
        enum: ['', 'occasion', 'reconditionne_chemise_fonte', 'reconditionne_complet'],
        default: '',
      },
    },
    stock: {
      location: {
        type: String,
        enum: ['atelier', 'sourcing', 'indisponible', ''],
        default: '',
      },
      estimatedDelay: { type: String, default: '', trim: true },
    },
    pricing: {
      purchasePrice: { type: Number, default: 0, min: 0 },  // HT en €
      additionalFees: { type: Number, default: 0, min: 0 }, // port, palette, frais
      sellPrice: { type: Number, default: 0, min: 0 },      // HT (régime normal) OU prix tout compris (régime marge)
      vatRate: { type: Number, default: 20, min: 0, max: 100 },
      // Régime de TVA : 'margin' = TVA sur marge (art. 297 A CGI, moteurs d'occasion
      // achetés à des particuliers/casses), 'normal' = TVA 20% sur le prix total.
      vatScheme: { type: String, enum: ['normal', 'margin'], default: 'margin' },
    },
    // Consigne / échange standard (surtout moteurs & boîtes reconditionnés) :
    // caution hors-TVA encaissée avec le règlement, remboursée au retour de
    // l'ancienne pièce sous `delayDays`. Saisie par devis ; amount=0 → aucun
    // affichage (le bloc « Échange standard » n'apparaît que si > 0).
    consigne: {
      amount: { type: Number, default: 0, min: 0 },     // montant en € (hors TVA)
      delayDays: { type: Number, default: 30, min: 0, max: 365 },
    },
    photos: {
      engine: { type: [engineQuotePhotoSchema], default: [] },
      kmReading: { type: [engineQuotePhotoSchema], default: [] },
    },
    updatedAt: { type: Date, default: null },
    updatedByName: { type: String, default: '', trim: true },

    /** Résultat du SMS d'accusé de réception envoyé à la soumission du formulaire */
    ackSms: { type: smsResultSchema, default: null },

    /** Historique des envois de devis au client */
    sentQuotes: { type: [engineQuoteSentSchema], default: [] },
    /** Relances automatiques envoyées (anti-doublon cron) */
    remindersSent: { type: [engineQuoteReminderSchema], default: [] },

    /**
     * Devis instantané PROGRAMMÉ (envoi différé) : à la capture on programme le
     * devis (dueAt = capture + délai) au lieu de l'envoyer ; l'accusé de
     * réception part d'abord, le devis suit après le délai via le cron
     * processScheduledAutoDevis. Claim atomique scheduled->sending = idempotence.
     */
    autoDevis: {
      // 'sourcing' = état demandé par le client indisponible au catalogue →
      // pas d'envoi auto, à sourcer/rappeler par le commercial (badge back-office).
      status: { type: String, enum: ['scheduled', 'sending', 'sent', 'error', 'sourcing'], default: null },
      dueAt: { type: Date, default: null },
      scheduledAt: { type: Date, default: null },
      claimedAt: { type: Date, default: null },
      sentAt: { type: Date, default: null },
      result: { type: String, default: '' },
      offers: { type: [mongoose.Schema.Types.Mixed], default: [] },
      // Condition demandée par le client quand status='sourcing' ('occasion'/'reconditionne').
      requested: { type: String, default: '' },
    },

    /** Paiement acompte reçu (webhook Mollie) */
    payment: {
      mollieId: { type: String, default: '' },
      amountCents: { type: Number, default: 0 },
      status: { type: String, default: '' },     // 'paid', 'failed', etc.
      paidAt: { type: Date, default: null },
    },

    /** Expédition (posée par le commercial depuis le back-office) */
    shipment: {
      carrier: { type: String, default: '' },         // ex: 'DPD', 'Chronopost', 'Affrètement palette'
      trackingNumber: { type: String, default: '' },
      trackingUrl: { type: String, default: '' },
      shippedAt: { type: Date, default: null },
      shippedByName: { type: String, default: '' },
      emailSentAt: { type: Date, default: null },
    },
  },
  { _id: false }
);

const abandonedCartSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, trim: true, index: true },
    userId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    email: { type: String, default: '', trim: true, index: true },
    firstName: { type: String, default: '', trim: true },
    lastName: { type: String, default: '', trim: true },
    phone: { type: String, default: '', trim: true },
    isGuest: { type: Boolean, default: false, index: true },

    /**
     * Comment ce lead a été capturé. Permet de différencier le panier
     * abandonné (cron) d'une demande de devis explicite ou d'un contact form.
     */
    captureSource: {
      type: String,
      enum: ['user', 'guest_checkout', 'newsletter', 'contact', 'devis', 'cart_activity', 'blog_cta', 'landing_moteurs', 'landing_boites', 'manual', ''],
      default: '',
      index: true,
    },

    items: { type: [abandonedCartItemSchema], default: [] },
    totalAmountCents: { type: Number, default: 0, min: 0 },

    /** Statut workflow automatique (cron) */
    status: {
      type: String,
      enum: ['abandoned', 'reminded_1', 'reminded_2', 'reminded_3', 'recovered', 'expired'],
      default: 'abandoned',
      required: true,
      index: true,
    },

    /** Statut manuel posé par un admin — bloque les relances auto si != null */
    manualStatus: {
      type: String,
      enum: ['contacted', 'converted', 'lost', null],
      default: null,
      index: true,
    },
    manualStatusBy: { type: mongoose.Schema.Types.ObjectId, default: null },
    manualStatusByName: { type: String, default: '', trim: true },
    manualStatusAt: { type: Date, default: null },

    /** Notes internes admin (chronologique) */
    notes: { type: [abandonedCartNoteSchema], default: [] },

    /** Workflow devis moteur (rempli par commercial dans /admin/devis-moteurs) */
    engineQuote: { type: engineQuoteSchema, default: null },

    /**
     * Demande explicite saisie par le client dans /devis ou /contact.
     * Distinct du panier (qui peut contenir autre chose) : le `requested`
     * exprime ce que le client cherche réellement.
     */
    requested: {
      vehicle: { type: String, default: '', trim: true },     // ex: "Golf 7"
      vin: { type: String, default: '', trim: true },          // ex: "WAUZZZ..."
      plate: { type: String, default: '', trim: true },        // immatriculation
      ref: { type: String, default: '', trim: true },          // référence pièce
      message: { type: String, default: '', trim: true },      // message libre
    },

    /** Contexte additionnel libre (legacy + concat pour leads multi-touchpoints) */
    contextMessage: { type: String, default: '', trim: true },
    attribution: {
      source: { type: String, default: '' },
      medium: { type: String, default: '' },
      campaign: { type: String, default: '' },
      referrer: { type: String, default: '' },
      gclid: { type: String, default: '' },
    },

    /**
     * Idempotence de l'import de conversions hors-ligne vers Google Ads
     * (services/googleAdsConversionSync.js). Date posée une fois la conversion
     * remontée → empêche tout double-envoi.
     */
    googleAdsUpload: {
      leadAt: { type: Date, default: null },   // conversion "Lead - Devis" remontée
      saleAt: { type: Date, default: null },   // conversion "Vente moteur" remontée
    },

    /** Compteurs d'actions manuelles depuis le dashboard admin */
    manualEmailsSent: { type: Number, default: 0 },
    manualSmsSent: { type: Number, default: 0 },
    lastManualContactAt: { type: Date, default: null },

    /**
     * Archivage manuel admin : sort le lead de la liste active de
     * /admin/devis-moteurs sans le supprimer (gagnés/perdus/traités qui
     * encombrent la vue). Réversible via "Désarchiver".
     */
    archived: { type: Boolean, default: false, index: true },
    archivedAt: { type: Date, default: null },
    archivedByName: { type: String, default: '', trim: true },

    /**
     * Alertes SLA internes déjà envoyées au commercial pour ce lead moteur
     * (anti-doublon). Ex : 'sla_24h', 'sla_48h'. Stocké à la RACINE car
     * engineQuote peut être null sur un lead jamais ouvert.
     */
    slaAlertsSent: { type: [String], default: [] },

    abandonedAt: { type: Date, required: true, index: true },
    lastActivityAt: { type: Date, default: Date.now, index: true },
    lastRemindedAt: { type: Date, default: null },
    recoveredAt: { type: Date, default: null },

    /**
     * Commande qui a « récupéré » ce lead (services/leadRecovery). Permet
     * d'afficher « A commandé — n°X · montant » sur la carte au lieu du
     * simple statut Récupéré. On ne supprime jamais le lead : il reste
     * l'historique client (et le vivier réachat).
     */
    recoveredOrder: {
      orderId: { type: mongoose.Schema.Types.ObjectId, default: null },
      number: { type: String, default: '', trim: true },
      totalCents: { type: Number, default: 0 },
      at: { type: Date, default: null },
    },

    /**
     * Relance réachat J+90 après achat (jobs/sendRepurchaseReminders).
     * sentAt posé UNIQUEMENT si l'email est parti (anti-doublon) ;
     * skippedReason documente les exclusions (ex: 'racheté').
     */
    repurchaseReminder: {
      sentAt: { type: Date, default: null },
      skippedReason: { type: String, default: '', trim: true },
    },
    recoveryToken: {
      type: String,
      unique: true,
      required: true,
      default: () => crypto.randomBytes(32).toString('hex'),
    },
  },
  {
    timestamps: true,
  }
);

abandonedCartSchema.index({ status: 1, abandonedAt: 1 });
abandonedCartSchema.index({ email: 1, status: 1 });
abandonedCartSchema.index({ manualStatus: 1, lastActivityAt: -1 });
abandonedCartSchema.index({ captureSource: 1, lastActivityAt: -1 });

module.exports = mongoose.model('AbandonedCart', abandonedCartSchema);
