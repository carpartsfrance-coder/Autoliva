const mongoose = require('mongoose');

// Toutes les actions d'un visiteur sur le site, groupables par sessionId
// (ou via userId / emailHash pour le cross-device).
//
// Ce schéma garde la rétrocompatibilité avec l'existant (pageview, search,
// funnel_step, product_interaction) et étend pour couvrir les events
// commerciaux et d'engagement (cart, contact, login, etc.).
const analyticsEventSchema = new mongoose.Schema(
  {
    // Type d'event. Convention : snake_case court.
    //   nav: pageview, page_exit
    //   product: product_view, product_interaction (avec interaction=...)
    //   search: search, filter_applied
    //   cart: add_to_cart, remove_from_cart, update_qty
    //   checkout: checkout_start, checkout_step, checkout_abandon
    //   order: order_placed
    //   engagement: click_phone, click_email, click_whatsapp, click_contact
    //   forms: contact_submit, quote_request, newsletter_signup
    //   account: account_create, login, logout
    //   compat: vehicle_check (VIN/plaque)
    //   funnel_step (legacy)
    type: { type: String, required: true, index: true },

    // ─── Identité ──────────────────────────────────────────────────────
    sessionId: { type: String, required: true, index: true },
    // Si l'utilisateur est connecté : on lie. Permet le cross-device.
    userId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    // Hash sha256 d'un email vu pendant la session (login, newsletter,
    // checkout, etc.). Permet de raccrocher des sessions anonymes au même
    // humain quand il finit par s'authentifier ou laisse son email.
    emailHash: { type: String, default: '', index: true },

    // ─── Attribution (copie de la dernière touche connue) ─────────────
    source: { type: String, default: '' },
    medium: { type: String, default: '' },
    campaign: { type: String, default: '' },
    referrer: { type: String, default: '' },
    gclid: { type: String, default: '', index: true },

    // ─── Page ──────────────────────────────────────────────────────────
    page: { type: String, default: '' },
    pageTitle: { type: String, default: '' },
    // Durée passée sur la page en ms (poussée au unload via beacon)
    durationMs: { type: Number, default: 0 },

    // ─── Produit ──────────────────────────────────────────────────────
    productId: { type: mongoose.Schema.Types.ObjectId, default: null },
    productName: { type: String, default: '' },
    productSku: { type: String, default: '' },
    productPriceCents: { type: Number, default: 0 },

    // ─── Search ───────────────────────────────────────────────────────
    searchQuery: { type: String, default: '' },
    searchResultCount: { type: Number, default: -1 },

    // ─── Funnel (legacy + nouveau) ───────────────────────────────────
    funnelStep: { type: String, default: '' },
    interaction: { type: String, default: '' },
    converted: { type: Boolean, default: false },

    // ─── Panier ───────────────────────────────────────────────────────
    cart: {
      itemsCount: { type: Number, default: 0 },
      totalCents: { type: Number, default: 0 },
      qtyChange: { type: Number, default: 0 }, // +1 / -2 / etc.
    },

    // ─── Commande (rempli sur order_placed) ──────────────────────────
    orderId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
    orderNumber: { type: String, default: '' },
    orderTotalCents: { type: Number, default: 0 },

    // ─── Cible click (pour click_phone / click_email / click_whatsapp) ─
    target: { type: String, default: '' }, // numéro, email ou URL whatsapp

    // ─── Sub-events spécifiques ──────────────────────────────────────
    // Pour filter_applied : { facet: 'marque', value: 'Volkswagen' }
    // Pour vehicle_check : { vin: '...', plate: '...', resultMatched: true }
    // Pour newsletter_signup : { email_hash, source_form }
    // ... toute donnée libre, jamais de PII en clair
    meta: { type: mongoose.Schema.Types.Mixed, default: null },

    // ─── Device + IP ──────────────────────────────────────────────────
    deviceType: { type: String, default: '' },
    userAgent: { type: String, default: '' },
    ipHash: { type: String, default: '' },
  },
  {
    timestamps: true,
  }
);

// Indexes pour les requêtes fréquentes
analyticsEventSchema.index({ type: 1, createdAt: -1 });
analyticsEventSchema.index({ sessionId: 1, createdAt: 1 }); // timeline ascendante
analyticsEventSchema.index({ userId: 1, createdAt: -1 });
analyticsEventSchema.index({ type: 1, source: 1, createdAt: -1 });
analyticsEventSchema.index({ type: 1, funnelStep: 1, createdAt: -1 });
analyticsEventSchema.index({ type: 1, searchQuery: 1, searchResultCount: 1, createdAt: -1 });
analyticsEventSchema.index({ campaign: 1, createdAt: -1 });
analyticsEventSchema.index({ gclid: 1 });
analyticsEventSchema.index({ orderId: 1 });

// TTL : auto-purge après 90 jours (rétention demandée par le user)
analyticsEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 90 * 24 * 3600 });

module.exports = mongoose.model('AnalyticsEvent', analyticsEventSchema);
