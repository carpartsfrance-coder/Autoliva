const mongoose = require('mongoose');

const Product = require('../models/Product');
const User = require('../models/User');
const Order = require('../models/Order');
const AbandonedCart = require('../models/AbandonedCart');
const demoProducts = require('../demoProducts');

const promoCodes = require('../services/promoCodes');
const pricing = require('../services/pricing');
const productOptions = require('../services/productOptions');
const { getShippingMethods } = require('../services/shippingPricing');
const { logCartEvent } = require('../services/cartEventLogger');
const brand = require('../config/brand');

function getCart(req) {
  if (!req.session.cart) {
    req.session.cart = { items: {} };
  }

  return req.session.cart;
}

function getSafeReturnTo(value) {
  if (typeof value !== 'string') return null;
  if (!value.startsWith('/')) return null;
  if (value.startsWith('//')) return null;
  return value;
}

function wantsJsonResponse(req) {
  const acceptHeader = req && req.headers && typeof req.headers.accept === 'string'
    ? req.headers.accept
    : '';
  const requestedWith = req && req.headers && typeof req.headers['x-requested-with'] === 'string'
    ? req.headers['x-requested-with']
    : '';
  return acceptHeader.includes('application/json') || requestedWith.toLowerCase() === 'xmlhttprequest';
}

function buildCartProductPreview(product) {
  if (!product || typeof product !== 'object') return null;

  const gallery = Array.isArray(product.galleryUrls) ? product.galleryUrls.filter(Boolean) : [];
  return {
    id: product._id ? String(product._id) : '',
    name: product.name ? String(product.name) : 'Produit',
    imageUrl: product.imageUrl || gallery[0] || '',
  };
}

function storeCartFeedback(req, payload) {
  if (!req || !req.session) return;
  req.session.cartFeedback = payload && typeof payload === 'object' ? payload : null;
}

function computeCartItemCount(cart) {
  return Object.values(cart.items).reduce((sum, item) => sum + (Number(item && item.quantity) || 0), 0);
}

function clampQty(value) {
  if (!Number.isFinite(value)) return 1;
  if (value < 0) return 0;
  if (value > 99) return 99;
  return value;
}

function parseNumberFromLooseString(value) {
  if (typeof value !== 'string') return null;

  const cleaned = value
    .replace(/[\s\u00A0]/g, '')
    .replace(/[^\d,.-]/g, '');

  if (!cleaned) return null;

  const hasComma = cleaned.includes(',');
  const hasDot = cleaned.includes('.');

  let normalized = cleaned;

  if (hasComma && hasDot) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      normalized = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = cleaned.replace(/,/g, '');
    }
  } else if (hasComma) {
    normalized = cleaned.replace(',', '.');
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function parseLegacyPriceCents(product) {
  if (Number.isFinite(product.priceCents)) return product.priceCents;

  if (typeof product.priceCents === 'string') {
    const parsed = parseNumberFromLooseString(product.priceCents);
    if (parsed !== null) {
      if (parsed >= 50000) return Math.round(parsed);
      return Math.round(parsed * 100);
    }
  }

  const legacy =
    product.price ??
    product.priceEuro ??
    product.priceEuros ??
    product.prix ??
    null;

  if (typeof legacy === 'number' && Number.isFinite(legacy)) {
    if (legacy >= 50000) return Math.round(legacy);
    return Math.round(legacy * 100);
  }

  if (typeof legacy === 'string') {
    const parsed = parseNumberFromLooseString(legacy);
    if (parsed === null) return 0;
    if (parsed >= 50000) return Math.round(parsed);
    return Math.round(parsed * 100);
  }

  return 0;
}

function normalizeProduct(product) {
  if (!product) return product;

  let stockQty = null;
  if (Number.isFinite(product.stockQty)) {
    stockQty = product.stockQty;
  } else if (typeof product.stockQty === 'string') {
    const trimmed = product.stockQty.trim();
    if (trimmed) {
      const n = Number(trimmed);
      if (Number.isFinite(n) && n >= 0) {
        stockQty = Math.floor(n);
      }
    }
  }

  const inStock =
    stockQty !== null
      ? stockQty > 0
      :
    product.inStock === false ||
    product.inStock === 'false' ||
    product.inStock === 0 ||
    product.inStock === '0'
      ? false
      : true;

  return {
    ...product,
    inStock,
    stockQty,
    priceCents: parseLegacyPriceCents(product),
  };
}

async function showCart(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const cart = getCart(req);
    const cartItemCount = computeCartItemCount(cart);

    const errorMessage = req.session.cartError || null;
    delete req.session.cartError;

    const items = Object.entries(cart.items).map(([key, it]) => {
      const safe = it && typeof it === 'object' ? it : {};
      return {
        ...safe,
        lineId: safe.lineId || key,
      };
    });

    if (items.length === 0) {
      const suggestedProducts = dbConnected
        ? (await Product.find({})
            .sort({ createdAt: -1 })
            .limit(4)
            .lean())
            .map(normalizeProduct)
        : demoProducts.slice(0, 4).map(normalizeProduct);

      return res.render('cart/index', {
        title: `Panier - ${brand.NAME}`,
        dbConnected,
        cartItemCount,
        items: [],
        totalCents: 0,
        itemsSubtotalCents: 0,
        shippingCostCents: 0,
        estimatedShippingMethod: null,
        errorMessage,
        suggestedProducts,
      });
    }

    const productById = new Map();

    if (dbConnected) {
      const productIds = items.map((i) => i.productId);
      const products = await Product.find({ _id: { $in: productIds } }).lean();
      for (const p of products) {
        productById.set(String(p._id), p);
      }
    }

    for (const p of demoProducts) {
      if (!productById.has(String(p._id))) {
        productById.set(String(p._id), p);
      }
    }

    const viewItems = [];
    let itemsSubtotalCents = 0;

    for (const item of items) {
      const product = normalizeProduct(productById.get(String(item.productId)));
      if (!product) continue;

      const unitPriceCents = productOptions.computeUnitPriceCents(product, item.optionsSelection);
      const lineTotalCents = unitPriceCents * item.quantity;
      itemsSubtotalCents += lineTotalCents;

      const fallbackSummary = productOptions.buildOptionsDisplay(product.options, item.optionsSelection).optionsSummary;
      const optionsSummary = typeof item.optionsSummary === 'string' && item.optionsSummary.trim() ? item.optionsSummary.trim() : fallbackSummary;

      viewItems.push({
        lineId: item.lineId || '',
        product,
        quantity: item.quantity,
        unitPriceCents,
        lineTotalCents,
        optionsSummary,
      });
    }

    const sessionUser = req.session.user;
    let clientDiscountPercent = 0;
    if (dbConnected && sessionUser && sessionUser._id) {
      const user = await User.findById(sessionUser._id).select('_id discountPercent').lean();
      clientDiscountPercent = user && Number.isFinite(user.discountPercent) ? user.discountPercent : 0;
    }

    const promoCodeFromSession = typeof req.session.promoCode === 'string' ? req.session.promoCode : '';
    let promo = null;
    let appliedPromoCode = '';

    if (dbConnected && promoCodeFromSession) {
      const result = await promoCodes.getApplicablePromo({
        code: promoCodeFromSession,
        userId: sessionUser && sessionUser._id ? sessionUser._id : null,
        itemsSubtotalCents,
      });

      if (!result.ok) {
        delete req.session.promoCode;
        req.session.cartError = result.reason || 'Code promo invalide.';
        return res.redirect('/panier');
      }

      promo = result.promo;
      appliedPromoCode = result.code;
    }

    const shippingMethods = await getShippingMethods(
      dbConnected,
      viewItems.map((it) => it.product)
    );
    const estimatedShippingMethod = shippingMethods.find((method) => method && method.id === 'domicile') || shippingMethods[0] || null;
    const shippingCostCents = estimatedShippingMethod && Number.isFinite(estimatedShippingMethod.priceCents)
      ? estimatedShippingMethod.priceCents
      : 0;

    const computed = pricing.computePricing({
      itemsSubtotalCents,
      shippingCostCents,
      clientDiscountPercent,
      promo,
    });

    const totalCents = computed.totalCents;

    const cartProductIds = new Set(viewItems.map((it) => String(it.product && it.product._id ? it.product._id : '')).filter(Boolean));

    let suggestedProducts = [];
    if (dbConnected) {
      suggestedProducts = (await Product.find({ _id: { $nin: Array.from(cartProductIds) } })
        .sort({ createdAt: -1 })
        .limit(4)
        .lean()).map(normalizeProduct);
    } else {
      suggestedProducts = demoProducts
        .filter((p) => !cartProductIds.has(String(p._id)))
        .slice(0, 4)
        .map(normalizeProduct);
    }

    return res.render('cart/index', {
      title: `Panier - ${brand.NAME}`,
      dbConnected,
      cartItemCount,
      items: viewItems,
      totalCents,
      itemsSubtotalCents,
      clientDiscountPercent: computed.clientDiscountPercent,
      clientDiscountCents: computed.clientDiscountCents,
      promoCode: appliedPromoCode,
      promoDiscountCents: computed.promoDiscountCents,
      itemsTotalAfterDiscountCents: computed.itemsTotalAfterDiscountCents,
      shippingCostCents: computed.shippingCostCents,
      estimatedShippingMethod,
      errorMessage,
      suggestedProducts,
    });
  } catch (err) {
    return next(err);
  }
}

async function postCartPromoCode(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const raw = typeof req.body.code === 'string' ? req.body.code : '';
    const code = promoCodes.normalizeCode(raw);

    if (!code) {
      delete req.session.promoCode;
      return res.redirect('/panier');
    }

    if (!promoCodes.isValidCode(code)) {
      req.session.cartError = 'Code promo invalide.';
      delete req.session.promoCode;
      return res.redirect('/panier');
    }

    req.session.promoCode = code;

    if (dbConnected) {
      const cart = getCart(req);
      const items = Object.values(cart.items);
      const productById = new Map();

      const productIds = items.map((i) => i.productId);
      const products = await Product.find({ _id: { $in: productIds } }).lean();
      for (const p of products) {
        productById.set(String(p._id), p);
      }
      for (const p of demoProducts) {
        if (!productById.has(String(p._id))) {
          productById.set(String(p._id), p);
        }
      }

      let itemsSubtotalCents = 0;
      for (const item of items) {
        const product = normalizeProduct(productById.get(String(item.productId)));
        if (!product) continue;
        const unitPriceCents = productOptions.computeUnitPriceCents(product, item.optionsSelection);
        itemsSubtotalCents += unitPriceCents * item.quantity;
      }

      const sessionUser = req.session.user;
      const result = await promoCodes.getApplicablePromo({
        code,
        userId: sessionUser && sessionUser._id ? sessionUser._id : null,
        itemsSubtotalCents,
      });

      if (!result.ok) {
        req.session.cartError = result.reason || 'Code promo invalide.';
        delete req.session.promoCode;
      } else {
        req.session.promoCode = result.code;
      }
    }

    return res.redirect('/panier');
  } catch (err) {
    return next(err);
  }
}

function formatEuro(totalCents) {
  return `${(totalCents / 100).toFixed(2).replace('.', ',')} €`;
}

function getDefaultAddress(user) {
  if (!user || !Array.isArray(user.addresses)) return null;
  return user.addresses.find((a) => a && a.isDefault) || user.addresses[0] || null;
}

async function placeOrder(req, res, next) {
  try {
    return res.redirect('/commande/livraison');
  } catch (err) {
    return next(err);
  }
}

async function addToCart(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const { id } = req.params;
    const returnTo = getSafeReturnTo(req.body.returnTo);
    const jsonResponse = wantsJsonResponse(req);

    const qtyRaw = req.body.qty;
    let qty = 1;
    if (typeof qtyRaw === 'string') {
      const parsed = Number.parseInt(qtyRaw, 10);
      if (Number.isFinite(parsed) && parsed > 0) {
        qty = Math.min(parsed, 99);
      }
    }

    if (!mongoose.Types.ObjectId.isValid(id)) {
      if (jsonResponse) {
        return res.status(404).json({ ok: false, error: 'Produit introuvable.' });
      }
      return res.status(404).render('errors/404', {
        title: `Page introuvable - ${brand.NAME}`,
      });
    }

    let product = null;
    if (dbConnected) {
      product = await Product.findById(id).select('_id name imageUrl galleryUrls inStock stockQty options').lean();
    }

    if (!product) {
      product = demoProducts.find((p) => String(p._id) === String(id)) || null;
    }

    product = normalizeProduct(product);

    if (!product) {
      if (jsonResponse) {
        return res.status(404).json({ ok: false, error: 'Produit introuvable.' });
      }
      return res.status(404).render('errors/404', {
        title: `Page introuvable - ${brand.NAME}`,
      });
    }

    if (product.inStock === false) {
      if (jsonResponse) {
        return res.status(400).json({ ok: false, error: 'Ce produit est actuellement indisponible.' });
      }
      storeCartFeedback(req, {
        type: 'error',
        message: 'Ce produit est actuellement indisponible.',
      });
      return res.redirect(returnTo || `/produits/${id}`);
    }

    const selectionResult = productOptions.buildSelectionFromBody(req.body, product.options);
    if (!selectionResult.ok) {
      const selectionError = selectionResult.errors[0] || 'Merci de vérifier les options sélectionnées.';
      if (jsonResponse) {
        return res.status(400).json({ ok: false, error: selectionError });
      }
      req.session.cartError = selectionError;
      storeCartFeedback(req, {
        type: 'error',
        message: selectionError,
      });
      return res.redirect(`/produits/${id}`);
    }

    const selection = selectionResult.selection;
    const display = productOptions.buildOptionsDisplay(product.options, selection);
    const { lineId } = productOptions.buildCartLineId(id, selection);

    const cart = getCart(req);

    if (Number.isFinite(product.stockQty)) {
      const existingQty = Object.values(cart.items).reduce((sum, it) => {
        if (!it || typeof it !== 'object') return sum;
        if (String(it.productId || '') !== String(id)) return sum;
        return sum + (Number(it.quantity) || 0);
      }, 0);

      if (existingQty + qty > product.stockQty) {
        if (jsonResponse) {
          return res.status(400).json({ ok: false, error: 'Stock insuffisant pour la quantité demandée.' });
        }
        req.session.cartError = 'Stock insuffisant pour la quantité demandée.';
        storeCartFeedback(req, {
          type: 'error',
          message: 'Stock insuffisant pour la quantité demandée.',
        });
        return res.redirect(returnTo || `/produits/${id}`);
      }
    }

    if (!cart.items[lineId]) {
      cart.items[lineId] = {
        lineId,
        productId: id,
        quantity: 0,
        optionsSelection: selection,
        optionsSummary: display.optionsSummary,
      };
    }

    cart.items[lineId].quantity = Math.min(cart.items[lineId].quantity + qty, 99);

    /* Tracking activité panier (non-bloquant) */
    logCartEvent({
      req,
      action: 'add',
      productId: id,
      productName: product.name || '',
      productSku: product.sku || '',
      quantity: qty,
      optionsSummary: display.optionsSummary || '',
    });

    if (jsonResponse) {
      return res.status(200).json({
        ok: true,
        cartItemCount: computeCartItemCount(cart),
        product: buildCartProductPreview(product),
      });
    }

    storeCartFeedback(req, {
      type: 'success',
      cartItemCount: computeCartItemCount(cart),
      product: buildCartProductPreview(product),
    });

    return res.redirect(returnTo || '/panier');
  } catch (err) {
    if (wantsJsonResponse(req)) {
      return res.status(500).json({ ok: false, error: 'Impossible d’ajouter le produit au panier pour le moment.' });
    }
    return next(err);
  }
}

function updateCartItem(req, res) {
  const { id } = req.params;
  const returnTo = getSafeReturnTo(req.body.returnTo);

  const qtyRaw = req.body.qty;
  let qty = 1;
  if (typeof qtyRaw === 'string') {
    const parsed = Number.parseInt(qtyRaw, 10);
    if (Number.isFinite(parsed)) {
      qty = clampQty(parsed);
    }
  }

  const cart = getCart(req);
  const existingItem = cart.items[id];
  const previousQuantity = existingItem ? existingItem.quantity : 0;

  if (qty <= 0) {
    /* Tracking suppression (non-bloquant) */
    if (existingItem) {
      logCartEvent({
        req,
        action: 'remove',
        productId: existingItem.productId || id,
        quantity: 0,
        previousQuantity,
        optionsSummary: existingItem.optionsSummary || '',
      });
    }
    delete cart.items[id];
  } else {
    if (!cart.items[id]) {
      return res.redirect(returnTo || '/panier');
    }
    cart.items[id].quantity = qty;

    /* Tracking modification (non-bloquant) */
    logCartEvent({
      req,
      action: 'update',
      productId: existingItem.productId || id,
      quantity: qty,
      previousQuantity,
      optionsSummary: existingItem.optionsSummary || '',
    });
  }

  return res.redirect(returnTo || '/panier');
}

function removeFromCart(req, res) {
  const { id } = req.params;
  const returnTo = getSafeReturnTo(req.body.returnTo);

  const cart = getCart(req);
  const removedItem = cart.items[id];

  /* Tracking suppression (non-bloquant) */
  if (removedItem) {
    logCartEvent({
      req,
      action: 'remove',
      productId: removedItem.productId || id,
      quantity: 0,
      previousQuantity: removedItem.quantity || 0,
      optionsSummary: removedItem.optionsSummary || '',
    });
  }

  delete cart.items[id];

  return res.redirect(returnTo || '/panier');
}

function clearCart(req, res) {
  req.session.cart = { items: {} };
  delete req.session.promoCode;
  return res.redirect('/panier');
}

async function recoverCart(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const { token } = req.params;
    if (!token || typeof token !== 'string' || !dbConnected) {
      return res.redirect('/panier');
    }

    const abandonedCart = await AbandonedCart.findOne({
      recoveryToken: token,
      status: { $nin: ['recovered', 'expired'] },
    });

    if (!abandonedCart) {
      return res.redirect('/panier');
    }

    // Restore items into the session cart
    const cart = getCart(req);

    for (const item of abandonedCart.items) {
      if (!item.productId) continue;

      const lineId = String(item.productId) + (item.optionsSummary ? '_' + item.optionsSummary : '');

      cart.items[lineId] = {
        lineId,
        productId: String(item.productId),
        quantity: item.quantity || 1,
        optionsSelection: item.optionsSelection || {},
        optionsSummary: item.optionsSummary || '',
      };
    }

    // Mark as recovered
    abandonedCart.status = 'recovered';
    abandonedCart.recoveredAt = new Date();
    await abandonedCart.save();

    return res.redirect('/panier');
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  showCart,
  postCartPromoCode,
  addToCart,
  updateCartItem,
  removeFromCart,
  clearCart,
  placeOrder,
  recoverCart,
};
