(function () {
  'use strict';

  var COOKIE_NAME = 'cpf_consent';
  var COOKIE_MAX_AGE = 13 * 30 * 24 * 60 * 60;
  var CONSENT_VERSION = 1;

  var I18N = (window.CPF_CONSENT_I18N && typeof window.CPF_CONSENT_I18N === 'object') ? window.CPF_CONSENT_I18N : {};
  function t(key, fallback) {
    return Object.prototype.hasOwnProperty.call(I18N, key) ? I18N[key] : fallback;
  }

  function gtag() {
    window.dataLayer = window.dataLayer || [];
    window.dataLayer.push(arguments);
  }

  function getCookie(name) {
    var match = document.cookie.match(new RegExp('(?:^|;\\s*)' + name + '=([^;]+)'));
    return match ? decodeURIComponent(match[1]) : null;
  }

  function setCookie(name, value, maxAge) {
    var secure = (location.protocol === 'https:') ? ';Secure' : '';
    document.cookie = name + '=' + encodeURIComponent(value) + ';path=/;max-age=' + maxAge + ';SameSite=Lax' + secure;
  }

  function readConsent() {
    try {
      var raw = getCookie(COOKIE_NAME);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || parsed.version !== CONSENT_VERSION) return null;
      return parsed;
    } catch (e) { return null; }
  }

  function saveConsent(state) {
    var payload = {
      version: CONSENT_VERSION,
      analytics: !!state.analytics,
      ads: !!state.ads,
      timestamp: new Date().toISOString()
    };
    setCookie(COOKIE_NAME, JSON.stringify(payload), COOKIE_MAX_AGE);
    return payload;
  }

  function applyConsent(state) {
    gtag('consent', 'update', {
      ad_storage: state.ads ? 'granted' : 'denied',
      ad_user_data: state.ads ? 'granted' : 'denied',
      ad_personalization: state.ads ? 'granted' : 'denied',
      analytics_storage: state.analytics ? 'granted' : 'denied'
    });
    window.dataLayer.push({
      event: 'cpf_consent_update',
      cpf_consent: {
        analytics: !!state.analytics,
        ads: !!state.ads
      }
    });
  }

  function el(tag, attrs, children) {
    var node = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (k === 'text') node.textContent = attrs[k];
        else if (k.indexOf('on') === 0 && typeof attrs[k] === 'function') node.addEventListener(k.slice(2), attrs[k]);
        else node.setAttribute(k, attrs[k]);
      });
    }
    if (children) {
      children.forEach(function (c) { if (c) node.appendChild(c); });
    }
    return node;
  }

  function buildBanner(onAcceptAll, onRejectAll, onCustomize) {
    var policyUrl = (window.CPF_CONSENT_PRIVACY_URL || '/legal/confidentialite');
    var bodyHtml = t('consent.banner.body',
      'Nous utilisons des cookies pour mesurer l’audience du site et personnaliser nos publicités. Vous pouvez accepter, refuser ou personnaliser. Pour en savoir plus, consultez notre <a href="' +
      policyUrl + '">politique de confidentialité</a>.');

    return el('div', { class: 'cpf-consent-banner', role: 'dialog', 'aria-labelledby': 'cpf-consent-title', 'aria-describedby': 'cpf-consent-desc' }, [
      el('h2', { class: 'cpf-consent-banner__title', id: 'cpf-consent-title', text: t('consent.banner.title', 'Vos préférences cookies') }),
      el('p', { class: 'cpf-consent-banner__body', id: 'cpf-consent-desc', html: bodyHtml }),
      el('div', { class: 'cpf-consent-banner__actions' }, [
        el('button', { class: 'cpf-consent-btn cpf-consent-btn--ghost', type: 'button', onclick: onCustomize, text: t('consent.banner.customize', 'Personnaliser') }),
        el('button', { class: 'cpf-consent-btn cpf-consent-btn--secondary', type: 'button', onclick: onRejectAll, text: t('consent.banner.rejectAll', 'Tout refuser') }),
        el('button', { class: 'cpf-consent-btn cpf-consent-btn--primary', type: 'button', onclick: onAcceptAll, text: t('consent.banner.acceptAll', 'Tout accepter') })
      ])
    ]);
  }

  function buildModal(initial, onClose, onSave, onAcceptAll, onRejectAll) {
    var analyticsChecked = !!initial.analytics;
    var adsChecked = !!initial.ads;

    var analyticsInput = el('input', { type: 'checkbox', id: 'cpf-consent-analytics' });
    analyticsInput.checked = analyticsChecked;
    var adsInput = el('input', { type: 'checkbox', id: 'cpf-consent-ads' });
    adsInput.checked = adsChecked;
    var necessaryInput = el('input', { type: 'checkbox', id: 'cpf-consent-necessary', disabled: 'disabled' });
    necessaryInput.checked = true;

    function category(titleKey, descKey, defaultTitle, defaultDesc, input) {
      return el('div', { class: 'cpf-consent-category' }, [
        el('div', { class: 'cpf-consent-category__row' }, [
          el('div', null, [
            el('h3', { class: 'cpf-consent-category__title', text: t(titleKey, defaultTitle) }),
            el('p', { class: 'cpf-consent-category__desc', text: t(descKey, defaultDesc) })
          ]),
          el('label', { class: 'cpf-consent-toggle', for: input.id }, [
            input,
            el('span', { class: 'cpf-consent-toggle__slider' })
          ])
        ])
      ]);
    }

    var overlay = el('div', { class: 'cpf-consent-overlay', role: 'dialog', 'aria-modal': 'true', 'aria-labelledby': 'cpf-consent-modal-title' }, [
      el('div', { class: 'cpf-consent-modal' }, [
        el('div', { class: 'cpf-consent-modal__header' }, [
          el('h2', { class: 'cpf-consent-modal__title', id: 'cpf-consent-modal-title', text: t('consent.modal.title', 'Personnaliser mes cookies') }),
          el('button', { class: 'cpf-consent-modal__close', type: 'button', 'aria-label': t('consent.modal.close', 'Fermer'), onclick: onClose, text: '✕' })
        ]),
        el('div', { class: 'cpf-consent-modal__body' }, [
          el('p', { class: 'cpf-consent-modal__intro', text: t('consent.modal.intro', 'Vous contrôlez les cookies déposés sur votre appareil. Le strict nécessaire au fonctionnement du site est toujours actif.') }),
          category(
            'consent.modal.necessary.title', 'consent.modal.necessary.desc',
            'Cookies nécessaires', 'Indispensables au panier, à la connexion et à la sécurité. Toujours actifs.',
            necessaryInput
          ),
          category(
            'consent.modal.analytics.title', 'consent.modal.analytics.desc',
            'Mesure d’audience', 'Nous aide à comprendre comment vous utilisez le site (pages vues, parcours d’achat) afin de l’améliorer.',
            analyticsInput
          ),
          category(
            'consent.modal.ads.title', 'consent.modal.ads.desc',
            'Publicité personnalisée', 'Permet de vous montrer des publicités pertinentes et de mesurer leur efficacité (Google Ads, retargeting).',
            adsInput
          )
        ]),
        el('div', { class: 'cpf-consent-modal__footer' }, [
          el('button', { class: 'cpf-consent-btn cpf-consent-btn--ghost', type: 'button', onclick: onRejectAll, text: t('consent.banner.rejectAll', 'Tout refuser') }),
          el('button', { class: 'cpf-consent-btn cpf-consent-btn--secondary', type: 'button', onclick: function () { onSave({ analytics: analyticsInput.checked, ads: adsInput.checked }); }, text: t('consent.modal.save', 'Enregistrer mes choix') }),
          el('button', { class: 'cpf-consent-btn cpf-consent-btn--primary', type: 'button', onclick: onAcceptAll, text: t('consent.banner.acceptAll', 'Tout accepter') })
        ])
      ])
    ]);

    return overlay;
  }

  var currentBanner = null;
  var currentModal = null;

  function removeBanner() {
    if (currentBanner && currentBanner.parentNode) currentBanner.parentNode.removeChild(currentBanner);
    currentBanner = null;
  }
  function removeModal() {
    if (currentModal && currentModal.parentNode) currentModal.parentNode.removeChild(currentModal);
    currentModal = null;
  }

  function finalize(state) {
    var saved = saveConsent(state);
    applyConsent(saved);
    removeBanner();
    removeModal();
  }

  function showBanner() {
    if (currentBanner) return;
    var banner = buildBanner(
      function () { finalize({ analytics: true, ads: true }); },
      function () { finalize({ analytics: false, ads: false }); },
      function () { showModal({ analytics: false, ads: false }); }
    );
    currentBanner = banner;
    document.body.appendChild(banner);
  }

  function showModal(initial) {
    removeModal();
    var modal = buildModal(
      initial,
      function () { removeModal(); },
      function (state) { finalize(state); },
      function () { finalize({ analytics: true, ads: true }); },
      function () { finalize({ analytics: false, ads: false }); }
    );
    currentModal = modal;
    document.body.appendChild(modal);
  }

  window.cpfConsent = {
    open: function () {
      var existing = readConsent() || { analytics: false, ads: false };
      removeBanner();
      showModal(existing);
    },
    reset: function () {
      setCookie(COOKIE_NAME, '', 0);
      applyConsent({ analytics: false, ads: false });
      showBanner();
    },
    get: function () { return readConsent(); }
  };

  function init() {
    var existing = readConsent();
    if (existing) {
      applyConsent(existing);
      return;
    }
    showBanner();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
