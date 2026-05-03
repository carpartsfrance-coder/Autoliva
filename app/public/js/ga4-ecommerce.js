/* GA4 / GTM e-commerce events client-side
 * - add_to_cart  : déclenché au submit d'un formulaire `form[action*="/panier/ajouter/"]`
 *                  qui porte les data-attrs `data-product-*`.
 * - phone_click  : déclenché au clic sur un `a[href^="tel:"]`.
 * - whatsapp_click : déclenché au clic sur un `a[href*="wa.me"]` ou `a[href*="api.whatsapp.com"]`.
 *
 * Les pushes view_item / view_item_list / view_cart / begin_checkout / purchase
 * sont faits inline dans les templates EJS (données disponibles côté serveur).
 */
(function () {
  'use strict';

  /* Si le script inline du footer a déjà installé les listeners, ne pas les
     dupliquer ici (sinon double push add_to_cart / phone_click / whatsapp_click). */
  if (window.__ga4InlineReady) return;
  window.__ga4InlineReady = true;

  function ensureDataLayer() {
    window.dataLayer = window.dataLayer || [];
  }

  function toNumber(value) {
    var n = Number(value);
    return Number.isFinite(n) ? n : 0;
  }

  function readProductFromForm(form) {
    if (!form || !form.dataset) return null;
    var d = form.dataset;
    var id = d.productId || '';
    var sku = d.productSku || id;
    if (!sku) return null;
    var qtyInput = form.querySelector('input[name="qty"]');
    var qty = qtyInput ? parseInt(qtyInput.value, 10) : 1;
    if (!Number.isFinite(qty) || qty < 1) qty = 1;
    var priceCents = toNumber(d.productPriceCents);
    var price = priceCents > 0 ? Math.round(priceCents) / 100 : toNumber(d.productPrice);
    return {
      item_id: sku,
      item_name: d.productName || '',
      item_category: d.productCategory || '',
      item_brand: d.productBrand || '',
      price: price,
      quantity: qty,
    };
  }

  function pushAddToCart(item) {
    if (!item) return;
    ensureDataLayer();
    window.dataLayer.push({ ecommerce: null });
    window.dataLayer.push({
      event: 'add_to_cart',
      ecommerce: {
        currency: 'EUR',
        value: Number((item.price * item.quantity).toFixed(2)),
        items: [item],
      },
    });
  }

  function onAddToCartSubmit(event) {
    var form = event && event.target ? event.target : null;
    if (!form || form.tagName !== 'FORM') return;
    var action = form.getAttribute('action') || '';
    if (action.indexOf('/panier/ajouter/') === -1) return;
    /* La fiche produit gère son push dans le AJAX success — skip pour éviter
       le doublon. Le footer inline gère aussi déjà cette branche, mais
       l'inline et l'externe peuvent se déclencher en parallèle. */
    if (form.hasAttribute('data-add-to-cart-form')) return;
    var item = readProductFromForm(form);
    if (item) pushAddToCart(item);
  }

  /* Hook pour les fiches produit qui font un fetch AJAX
   * (le listener submit ne suffit pas si le form a event.preventDefault).
   * Le template appelle window.GA4Ecommerce.trackAddToCart(item) après succès. */
  function trackAddToCart(item) {
    pushAddToCart(item);
  }

  function onPhoneClick(event) {
    var a = event && event.target ? (event.target.closest ? event.target.closest('a[href^="tel:"]') : null) : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    var raw = href.replace(/^tel:/i, '').trim();
    ensureDataLayer();
    window.dataLayer.push({
      event: 'phone_click',
      phone_number: raw,
      page_path: window.location.pathname,
    });
  }

  function onWhatsAppClick(event) {
    var a = event && event.target ? (event.target.closest ? event.target.closest('a') : null) : null;
    if (!a) return;
    var href = a.getAttribute('href') || '';
    if (!/wa\.me|api\.whatsapp\.com/.test(href)) return;
    var phone = '';
    var m = href.match(/wa\.me\/(\+?\d+)/i);
    if (m) phone = '+' + m[1].replace(/^\+/, '');
    if (!phone) {
      var m2 = href.match(/[?&]phone=(\+?\d+)/i);
      if (m2) phone = '+' + m2[1].replace(/^\+/, '');
    }
    ensureDataLayer();
    window.dataLayer.push({
      event: 'whatsapp_click',
      phone_number: phone,
      page_path: window.location.pathname,
    });
  }

  document.addEventListener('submit', onAddToCartSubmit, true);
  document.addEventListener('click', onPhoneClick, true);
  document.addEventListener('click', onWhatsAppClick, true);

  window.GA4Ecommerce = {
    trackAddToCart: trackAddToCart,
  };
})();
