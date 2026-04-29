const mongoose = require('mongoose');

const analyticsEventSchema = new mongoose.Schema(
  {
    // Event type: pageview, search, funnel_step, product_click, product_interaction
    type: { type: String, required: true, index: true },

    // Session identifier (anonymous, cookie-based)
    sessionId: { type: String, required: true, index: true },

    // Traffic source info (captured on first pageview of session)
    source: { type: String, default: '' },       // google, facebook, direct, etc.
    medium: { type: String, default: '' },        // organic, cpc, referral, etc.
    campaign: { type: String, default: '' },       // utm_campaign value
    referrer: { type: String, default: '' },       // full referrer URL

    // Page info
    page: { type: String, default: '' },           // path visited
    productId: { type: mongoose.Schema.Types.ObjectId, default: null },
    productName: { type: String, default: '' },

    // Search-specific
    searchQuery: { type: String, default: '' },
    searchResultCount: { type: Number, default: -1 },

    // Funnel step: landing, product_view, add_to_cart, checkout_shipping, checkout_payment, order_confirmed
    funnelStep: { type: String, default: '' },

    // Product interaction: image_click, description_expand, compatibility_check, faq_expand, add_to_cart_click
    interaction: { type: String, default: '' },

    // Whether session ended in a conversion (order placed)
    converted: { type: Boolean, default: false },

    // Device info
    deviceType: { type: String, default: '' },     // mobile, tablet, desktop
  },
  {
    timestamps: true,
  }
);

// Compound indexes for efficient dashboard queries
analyticsEventSchema.index({ type: 1, createdAt: -1 });
analyticsEventSchema.index({ sessionId: 1, type: 1 });
analyticsEventSchema.index({ type: 1, source: 1, createdAt: -1 });
analyticsEventSchema.index({ type: 1, funnelStep: 1, createdAt: -1 });
analyticsEventSchema.index({ type: 1, searchQuery: 1, searchResultCount: 1, createdAt: -1 });

// TTL index: auto-delete events after 180 days to keep DB lean
analyticsEventSchema.index({ createdAt: 1 }, { expireAfterSeconds: 180 * 24 * 3600 });

module.exports = mongoose.model('AnalyticsEvent', analyticsEventSchema);
