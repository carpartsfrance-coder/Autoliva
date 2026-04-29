const mongoose = require('mongoose');

const newsletterSubscriberSchema = new mongoose.Schema(
  {
    email: { type: String, required: true, unique: true, index: true, trim: true, lowercase: true },
    status: { type: String, default: 'active', trim: true },
    source: { type: String, default: 'footer', trim: true },
    subscribedAt: { type: Date, default: Date.now },
    unsubscribedAt: { type: Date, default: null },
  },
  { timestamps: true }
);

module.exports = mongoose.model('NewsletterSubscriber', newsletterSubscriberSchema);
