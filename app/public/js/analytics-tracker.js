/**
 * CPF Analytics Tracker
 * Tracks: traffic source, searches, funnel steps, product interactions
 */
(function () {
  'use strict';

  var ENDPOINT = '/api/analytics/track';
  var SESSION_KEY = 'cpf_sid';
  var SOURCE_KEY = 'cpf_src';
  var queue = [];
  var flushTimer = null;

  /* ---- Session ID ---- */
  function getSessionId() {
    var sid = sessionStorage.getItem(SESSION_KEY);
    if (!sid) {
      sid = 'S' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      sessionStorage.setItem(SESSION_KEY, sid);
    }
    return sid;
  }

  /* ---- Device type ---- */
  function getDeviceType() {
    var w = window.innerWidth;
    if (w < 768) return 'mobile';
    if (w < 1024) return 'tablet';
    return 'desktop';
  }

  /* ---- Traffic source detection ---- */
  function detectSource() {
    var stored = sessionStorage.getItem(SOURCE_KEY);
    if (stored) {
      try { return JSON.parse(stored); } catch (e) { /* ignore */ }
    }

    var params = new URLSearchParams(window.location.search);
    var source = params.get('utm_source') || '';
    var medium = params.get('utm_medium') || '';
    var campaign = params.get('utm_campaign') || '';
    var referrer = document.referrer || '';

    if (!source && referrer) {
      try {
        var refHost = new URL(referrer).hostname.replace('www.', '');
        var selfHost = window.location.hostname.replace('www.', '');
        if (refHost.includes('google')) { source = 'google'; medium = 'organic'; }
        else if (refHost.includes('bing')) { source = 'bing'; medium = 'organic'; }
        else if (refHost.includes('duckduckgo')) { source = 'duckduckgo'; medium = 'organic'; }
        else if (refHost.includes('search.brave')) { source = 'brave'; medium = 'organic'; }
        else if (refHost.includes('qwant')) { source = 'qwant'; medium = 'organic'; }
        else if (refHost.includes('ecosia')) { source = 'ecosia'; medium = 'organic'; }
        else if (refHost.includes('startpage')) { source = 'startpage'; medium = 'organic'; }
        else if (refHost.includes('search.lilo') || refHost.includes('lilo.org')) { source = 'lilo'; medium = 'organic'; }
        else if (refHost.includes('yahoo')) { source = 'yahoo'; medium = 'organic'; }
        else if (refHost.includes('yandex') || refHost === 'ya.ru') { source = 'yandex'; medium = 'organic'; }
        else if (refHost.includes('chatgpt') || refHost.includes('openai')) { source = 'chatgpt'; medium = 'ai'; }
        else if (refHost.includes('perplexity')) { source = 'perplexity'; medium = 'ai'; }
        else if (refHost.includes('claude.ai') || refHost.includes('anthropic')) { source = 'claude'; medium = 'ai'; }
        else if (refHost.includes('copilot') || refHost.includes('bing.com/chat')) { source = 'copilot'; medium = 'ai'; }
        else if (refHost.includes('gemini.google')) { source = 'gemini'; medium = 'ai'; }
        else if (refHost.includes('aisearchindex')) { source = refHost; medium = 'ai'; }
        else if (refHost.includes('facebook') || refHost.includes('fb.com')) { source = 'facebook'; medium = 'social'; }
        else if (refHost.includes('instagram')) { source = 'instagram'; medium = 'social'; }
        else if (refHost.includes('tiktok')) { source = 'tiktok'; medium = 'social'; }
        else if (refHost.includes('youtube')) { source = 'youtube'; medium = 'social'; }
        else if (refHost.includes('twitter') || refHost.includes('x.com')) { source = 'twitter'; medium = 'social'; }
        else if (refHost.includes('linkedin')) { source = 'linkedin'; medium = 'social'; }
        else if (refHost !== selfHost && !refHost.endsWith('.' + selfHost)) { source = refHost; medium = 'referral'; }
      } catch (e) { /* invalid URL */ }
    }

    if (!source) { source = 'direct'; medium = '(none)'; }

    var result = { source: source, medium: medium, campaign: campaign, referrer: referrer };
    sessionStorage.setItem(SOURCE_KEY, JSON.stringify(result));
    return result;
  }

  /* ---- Queue & flush ---- */
  function track(event) {
    var src = detectSource();
    event.sessionId = getSessionId();
    event.source = src.source;
    event.medium = src.medium;
    event.campaign = src.campaign;
    event.referrer = src.referrer;
    event.deviceType = getDeviceType();
    event.page = window.location.pathname;

    queue.push(event);

    if (flushTimer) clearTimeout(flushTimer);
    flushTimer = setTimeout(flush, 2000);
  }

  function flush() {
    if (queue.length === 0) return;
    var batch = queue.splice(0, 20);

    var payload = JSON.stringify({ events: batch });

    if (navigator.sendBeacon) {
      navigator.sendBeacon(ENDPOINT, new Blob([payload], { type: 'application/json' }));
    } else {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', ENDPOINT, true);
      xhr.setRequestHeader('Content-Type', 'application/json');
      xhr.send(payload);
    }
  }

  // Flush on page unload
  window.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'hidden') flush();
  });

  /* ================================================================ */
  /*  1. PAGEVIEW + TRAFFIC SOURCE                                     */
  /* ================================================================ */

  function trackPageview() {
    var path = window.location.pathname;
    var funnelStep = '';

    if (path === '/' || path === '/en' || path === '/en/') funnelStep = 'landing';
    else if (path.match(/^\/(en\/)?(produits|product)\//)) funnelStep = 'product_view';
    else if (path.match(/^\/(en\/)?panier/)) funnelStep = 'add_to_cart';
    else if (path.match(/^\/(en\/)?commande\/livraison/)) funnelStep = 'checkout_shipping';
    else if (path.match(/^\/(en\/)?commande\/paiement/)) {
      funnelStep = 'checkout_payment';
      // Flag: user reached payment step, next /compte/commandes/ visit = real conversion
      sessionStorage.setItem('cpf_checkout_started', '1');
    }
    else if (path.match(/^\/(en\/)?(commande\/confirmation|compte\/commandes\/)/) && sessionStorage.getItem('cpf_checkout_started')) {
      funnelStep = 'order_confirmed';
      sessionStorage.removeItem('cpf_checkout_started'); // only count once
    }

    track({ type: 'pageview' });

    if (funnelStep) {
      track({
        type: 'funnel_step',
        funnelStep: funnelStep,
        converted: funnelStep === 'order_confirmed',
      });
    }
  }

  /* ================================================================ */
  /*  3. RECHERCHES INTERNES                                           */
  /* ================================================================ */

  function hookSearch() {
    // Hook into the existing search autocomplete
    var origFetch = window.fetch;
    if (origFetch) {
      window.fetch = function () {
        var url = arguments[0];
        if (typeof url === 'string' && url.includes('/rechercher/suggest')) {
          var match = url.match(/[?&]q=([^&]*)/);
          var query = match ? decodeURIComponent(match[1]) : '';

          return origFetch.apply(this, arguments).then(function (response) {
            // Clone so we can read the body without consuming it
            var clone = response.clone();
            clone.json().then(function (data) {
              var total = data.total || 0;
              if (query && query.length >= 2) {
                track({
                  type: 'search',
                  searchQuery: query,
                  searchResultCount: total,
                });
              }
            }).catch(function () {});
            return response;
          });
        }
        return origFetch.apply(this, arguments);
      };
    }

    // Also hook XMLHttpRequest for older autocomplete code
    var origOpen = XMLHttpRequest.prototype.open;
    var origSend = XMLHttpRequest.prototype.send;

    XMLHttpRequest.prototype.open = function (method, url) {
      this._cpfUrl = url;
      return origOpen.apply(this, arguments);
    };

    XMLHttpRequest.prototype.send = function () {
      var self = this;
      if (self._cpfUrl && typeof self._cpfUrl === 'string' && self._cpfUrl.includes('/rechercher/suggest')) {
        var match = self._cpfUrl.match(/[?&]q=([^&]*)/);
        var query = match ? decodeURIComponent(match[1]) : '';

        self.addEventListener('load', function () {
          try {
            var data = JSON.parse(self.responseText);
            var total = data.total || 0;
            if (query && query.length >= 2) {
              track({
                type: 'search',
                searchQuery: query,
                searchResultCount: total,
              });
            }
          } catch (e) { /* ignore */ }
        });
      }
      return origSend.apply(this, arguments);
    };
  }

  /* ================================================================ */
  /*  4. FUNNEL: track add-to-cart from button clicks                  */
  /* ================================================================ */

  function hookAddToCart() {
    document.addEventListener('submit', function (e) {
      var form = e.target;
      if (!form || !form.action) return;
      var action = typeof form.action === 'string' ? form.action : '';
      if (action.includes('/panier/ajouter') || action.includes('/cart/add')) {
        var productName = '';
        var nameEl = document.querySelector('h1');
        if (nameEl) productName = nameEl.textContent.trim();

        track({
          type: 'funnel_step',
          funnelStep: 'add_to_cart',
          productName: productName,
        });
        flush();
      }
    });
  }

  /* ================================================================ */
  /*  5. PRODUCT PAGE INTERACTIONS (heatmap-style)                     */
  /* ================================================================ */

  function hookProductInteractions() {
    var path = window.location.pathname;
    if (!path.match(/^\/(en\/)?(produits|product)\//)) return;

    var productName = '';
    var h1 = document.querySelector('h1');
    if (h1) productName = h1.textContent.trim();

    // Track image clicks
    var gallery = document.querySelectorAll('.product-gallery img, .product-image img, [data-gallery] img, .swiper img');
    for (var i = 0; i < gallery.length; i++) {
      gallery[i].addEventListener('click', function () {
        track({ type: 'product_interaction', interaction: 'image_click', productName: productName });
      });
    }

    // Track main product image click
    var mainImg = document.querySelector('.product-main-image, .product-hero img');
    if (mainImg) {
      mainImg.addEventListener('click', function () {
        track({ type: 'product_interaction', interaction: 'image_click', productName: productName });
      });
    }

    // Track description expand / read more
    var descToggles = document.querySelectorAll('[data-toggle-desc], .read-more-btn, .description-toggle');
    for (var j = 0; j < descToggles.length; j++) {
      descToggles[j].addEventListener('click', function () {
        track({ type: 'product_interaction', interaction: 'description_expand', productName: productName });
      });
    }

    // Track compatibility section interactions
    var compatSection = document.querySelectorAll('.compatibility-section, [data-compatibility], .vehicle-compatibility');
    for (var k = 0; k < compatSection.length; k++) {
      compatSection[k].addEventListener('click', function () {
        track({ type: 'product_interaction', interaction: 'compatibility_check', productName: productName });
      });
    }

    // Track FAQ accordion opens
    var faqItems = document.querySelectorAll('.faq-item, [data-faq], details');
    for (var l = 0; l < faqItems.length; l++) {
      faqItems[l].addEventListener('click', function () {
        track({ type: 'product_interaction', interaction: 'faq_expand', productName: productName });
      });
    }

    // Track specs table views (scroll into view)
    var specsSection = document.querySelector('.specs-table, .product-specs, [data-specs]');
    if (specsSection && window.IntersectionObserver) {
      var specsObserver = new IntersectionObserver(function (entries) {
        if (entries[0].isIntersecting) {
          track({ type: 'product_interaction', interaction: 'specs_view', productName: productName });
          specsObserver.disconnect();
        }
      }, { threshold: 0.5 });
      specsObserver.observe(specsSection);
    }

    // Track add to cart button click
    var addBtn = document.querySelector('[data-add-to-cart], .add-to-cart-btn, form[action*="panier/ajouter"] button[type="submit"]');
    if (addBtn) {
      addBtn.addEventListener('click', function () {
        track({ type: 'product_interaction', interaction: 'add_to_cart_click', productName: productName });
      });
    }
  }

  /* ================================================================ */
  /*  Mark conversions retroactively on order confirmation             */
  /* ================================================================ */

  function markConversion() {
    var path = window.location.pathname;
    // Only mark conversion if user came from checkout (flag set on payment page)
    if (path.match(/^\/(en\/)?(commande\/confirmation|compte\/commandes\/)/) && sessionStorage.getItem('cpf_converted_' + getSessionId()) !== '1') {
      // Check if this session went through checkout (flag set in trackPageview)
      if (sessionStorage.getItem('cpf_checkout_started') || path.match(/commande\/confirmation/)) {
        track({
          type: 'pageview',
          converted: true,
        });
        sessionStorage.setItem('cpf_converted_' + getSessionId(), '1');
      }
    }
  }

  /* ================================================================ */
  /*  6. CLICKS TÉLÉPHONE / EMAIL / WHATSAPP                          */
  /* ================================================================ */

  function hookEngagementClicks() {
    document.addEventListener('click', function (e) {
      var el = e.target;
      // Remonte jusqu'au <a> parent si on a cliqué sur un enfant (icône, span, etc.)
      while (el && el !== document.body && el.tagName !== 'A') {
        el = el.parentElement;
      }
      if (!el || el.tagName !== 'A') return;

      var href = el.getAttribute('href') || '';
      if (!href) return;

      if (href.indexOf('tel:') === 0) {
        track({
          type: 'click_phone',
          target: href.replace(/^tel:/, '').slice(0, 60),
          pageTitle: document.title,
        });
        flush();
      } else if (href.indexOf('mailto:') === 0) {
        track({
          type: 'click_email',
          target: href.replace(/^mailto:/, '').split('?')[0].slice(0, 120),
          pageTitle: document.title,
        });
        flush();
      } else if (href.match(/(wa\.me|api\.whatsapp\.com|whatsapp:)/i)) {
        track({
          type: 'click_whatsapp',
          target: href.slice(0, 200),
          pageTitle: document.title,
        });
        flush();
      } else if (href.match(/(facebook\.com\/sharer|twitter\.com\/intent|t\.me\/share)/i)) {
        track({
          type: 'click_social_share',
          target: href.slice(0, 200),
          pageTitle: document.title,
        });
      }
    }, true);
  }

  /* ================================================================ */
  /*  7. DURÉE DE LA PAGE (envoyée au unload)                          */
  /* ================================================================ */

  var pageEnterMs = Date.now();
  function trackPageDuration() {
    var duration = Date.now() - pageEnterMs;
    if (duration < 500 || duration > 30 * 60 * 1000) return;
    // Push directement dans la queue + flush, car on est en train de quitter
    track({
      type: 'page_exit',
      durationMs: duration,
      pageTitle: document.title,
    });
    flush();
  }

  /* ================================================================ */
  /*  8. APPLICATION DE FILTRES (changement URL ?marque=… etc.)       */
  /* ================================================================ */

  function hookFilters() {
    var FILTER_KEYS = ['marque', 'category', 'categorie', 'sort', 'tri', 'priceMin', 'priceMax', 'vehicleMake', 'vehicleModel'];
    try {
      var params = new URLSearchParams(window.location.search);
      var applied = {};
      var hasFilter = false;
      for (var k = 0; k < FILTER_KEYS.length; k++) {
        var v = params.get(FILTER_KEYS[k]);
        if (v) { applied[FILTER_KEYS[k]] = v; hasFilter = true; }
      }
      if (hasFilter) {
        track({
          type: 'filter_applied',
          meta: applied,
          pageTitle: document.title,
        });
      }
    } catch (e) {}
  }

  /* ================================================================ */
  /*  INIT                                                             */
  /* ================================================================ */

  function init() {
    trackPageview();
    hookSearch();
    hookAddToCart();
    hookEngagementClicks();
    hookFilters();
    markConversion();

    // Wait for DOM ready for product interactions
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', hookProductInteractions);
    } else {
      hookProductInteractions();
    }

    // Durée de page : tracker au unload
    window.addEventListener('pagehide', trackPageDuration);
    window.addEventListener('beforeunload', trackPageDuration);
  }

  init();
})();
