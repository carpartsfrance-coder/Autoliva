const mongoose = require('mongoose');

const AbandonedCart = require('../models/AbandonedCart');
const Order = require('../models/Order');
const Product = require('../models/Product');

const ABANDON_DELAY_MS = 60 * 60 * 1000; // 1 hour

/**
 * Scans MongoDB sessions for carts that have items but no associated order
 * for more than 1 hour. Only considers sessions with a logged-in user (email).
 *
 * Can be called directly or scheduled via node-cron.
 */
async function detectAbandonedCarts() {
  if (mongoose.connection.readyState !== 1) {
    console.error('[abandoned-carts] MongoDB non connectée, skip.');
    return { detected: 0, skipped: 0, errors: 0 };
  }

  const now = new Date();
  const cutoff = new Date(now.getTime() - ABANDON_DELAY_MS);

  const report = { detected: 0, skipped: 0, alreadyTracked: 0, errors: 0 };

  try {
    // Access the raw sessions collection managed by connect-mongo
    const db = mongoose.connection.db;
    const sessionsCollection = db.collection('sessions');

    // Find sessions that were last modified more than 1h ago
    // connect-mongo stores sessions as { _id, expires, session (JSON string) }
    const cursor = sessionsCollection.find({
      expires: { $gt: now }, // session not expired
    });

    const sessions = await cursor.toArray();

    for (const doc of sessions) {
      try {
        let sessionData;
        try {
          sessionData = typeof doc.session === 'string' ? JSON.parse(doc.session) : doc.session;
        } catch {
          continue;
        }

        if (!sessionData) continue;

        // Must have cart items
        const cart = sessionData.cart;
        if (!cart || !cart.items || typeof cart.items !== 'object') continue;

        const itemKeys = Object.keys(cart.items);
        if (itemKeys.length === 0) continue;

        // Must have a logged-in user with an email
        const user = sessionData.user;
        if (!user || !user.email) {
          report.skipped += 1;
          continue;
        }

        const email = String(user.email).trim().toLowerCase();
        if (!email || !email.includes('@')) {
          report.skipped += 1;
          continue;
        }

        const sessionId = String(doc._id);
        const userId = user._id ? String(user._id) : null;

        // Check if this session cart was already tracked and is still active
        const existingCart = await AbandonedCart.findOne({
          sessionId,
          status: { $nin: ['recovered', 'expired'] },
        }).lean();

        if (existingCart) {
          report.alreadyTracked += 1;
          continue;
        }

        // Check if the user has placed an order in the last hour
        // (meaning this cart may have been converted)
        const recentOrder = userId
          ? await Order.findOne({
              userId: new mongoose.Types.ObjectId(userId),
              createdAt: { $gte: cutoff },
              status: { $nin: ['cancelled', 'refunded'] },
            })
              .select('_id')
              .lean()
          : null;

        if (recentOrder) {
          report.skipped += 1;
          continue;
        }

        // Check session last modification — we use the _id timestamp or a heuristic
        // connect-mongo doesn't store lastModified, but we can check if session
        // hasn't been updated recently by looking at expires
        // expires = lastAccess + ttl, so lastAccess = expires - ttl
        const ttlMs = 30 * 24 * 60 * 60 * 1000; // 30 days (matches session config)
        const lastAccess = new Date(doc.expires.getTime() - ttlMs);

        if (lastAccess > cutoff) {
          // Session was accessed less than 1h ago — not abandoned yet
          report.skipped += 1;
          continue;
        }

        // Build cart items with product details
        const productIds = [];
        for (const item of Object.values(cart.items)) {
          if (item && item.productId && mongoose.Types.ObjectId.isValid(item.productId)) {
            productIds.push(new mongoose.Types.ObjectId(item.productId));
          }
        }

        const products = await Product.find({ _id: { $in: productIds } })
          .select('_id name sku imageUrl galleryUrls priceCents price')
          .lean();

        const productMap = new Map();
        for (const p of products) {
          productMap.set(String(p._id), p);
        }

        const abandonedItems = [];
        let totalAmountCents = 0;

        for (const item of Object.values(cart.items)) {
          if (!item || !item.productId) continue;

          const product = productMap.get(String(item.productId));
          if (!product) continue;

          const priceCents = Number.isFinite(product.priceCents) ? product.priceCents : 0;
          const qty = Number(item.quantity) || 1;
          const gallery = Array.isArray(product.galleryUrls) ? product.galleryUrls : [];

          abandonedItems.push({
            productId: product._id,
            name: product.name || 'Produit',
            sku: product.sku || '',
            price: priceCents,
            quantity: qty,
            image: product.imageUrl || gallery[0] || '',
            optionsSelection: item.optionsSelection || {},
            optionsSummary: item.optionsSummary || '',
          });

          totalAmountCents += priceCents * qty;
        }

        if (abandonedItems.length === 0) {
          report.skipped += 1;
          continue;
        }

        await AbandonedCart.create({
          sessionId,
          userId: userId ? new mongoose.Types.ObjectId(userId) : null,
          email,
          firstName: user.firstName || '',
          items: abandonedItems,
          totalAmountCents,
          status: 'abandoned',
          abandonedAt: lastAccess,
        });

        report.detected += 1;
      } catch (err) {
        report.errors += 1;
        console.error('[abandoned-carts] Erreur traitement session:', err.message || err);
      }
    }
  } catch (err) {
    report.errors += 1;
    console.error('[abandoned-carts] Erreur globale:', err.message || err);
  }

  console.log('[abandoned-carts] Rapport:', JSON.stringify(report));
  return report;
}

module.exports = { detectAbandonedCarts };
