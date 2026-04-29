/* ============================================================
   CarParts France — Toast Notification System
   Expose window.showToast(message, type) for backward compat
   + window.toast.{ success, error, warning, info }
   ============================================================ */
(function () {
  'use strict';

  var MAX_TOASTS = 3;
  var COLORS = {
    success: '#059669',
    error:   '#DC2626',
    warning: '#D97706',
    info:    '#2563EB',
  };
  var ICONS = {
    success: 'check_circle',
    error:   'error',
    warning: 'warning',
    info:    'info',
  };

  function getContainer() {
    var c = document.getElementById('toast-container');
    if (!c) {
      c = document.createElement('div');
      c.id = 'toast-container';
      c.style.cssText = 'position:fixed;bottom:24px;right:24px;z-index:9999;display:flex;flex-direction:column;gap:12px;pointer-events:none;';
      document.body.appendChild(c);
    }
    return c;
  }

  function dismissToast(el) {
    if (!el || el._dismissing) return;
    el._dismissing = true;
    clearTimeout(el._toastTimer);
    el.style.transition = 'transform 200ms ease, opacity 200ms ease';
    el.style.transform = 'translateX(120%)';
    el.style.opacity = '0';
    setTimeout(function () { if (el.parentNode) el.remove(); }, 220);
  }

  function showToastInternal(type, message, iconName) {
    var container = getContainer();

    /* Enforce max 3 — remove oldest */
    while (container.children.length >= MAX_TOASTS) {
      dismissToast(container.children[0]);
    }

    var color = COLORS[type] || COLORS.info;
    var icon  = iconName || ICONS[type] || 'info';

    var el = document.createElement('div');
    el.style.cssText = [
      'pointer-events:auto',
      'display:flex',
      'align-items:center',
      'gap:12px',
      'padding:12px 16px',
      'border-radius:12px',
      'box-shadow:0 8px 32px rgba(0,0,0,0.2)',
      'color:#fff',
      'font-size:14px',
      'font-weight:600',
      'background:' + color,
      'transform:translateX(120%)',
      'transition:transform 300ms ease',
      'max-width:380px',
      'min-width:220px',
    ].join(';');

    el.innerHTML =
      '<span class="material-symbols-outlined" style="font-size:20px;flex-shrink:0;">' + icon + '</span>' +
      '<span style="flex:1;line-height:1.4;">' + message + '</span>' +
      '<button style="background:none;border:none;color:rgba(255,255,255,0.75);cursor:pointer;padding:2px;display:flex;align-items:center;flex-shrink:0;border-radius:4px;" aria-label="Fermer">' +
        '<span class="material-symbols-outlined" style="font-size:18px;">close</span>' +
      '</button>';

    el.querySelector('button').addEventListener('click', function () { dismissToast(el); });
    container.appendChild(el);

    /* Animate in */
    requestAnimationFrame(function () {
      requestAnimationFrame(function () {
        el.style.transform = 'translateX(0)';
      });
    });

    /* Auto-dismiss after 5s */
    el._toastTimer = setTimeout(function () { dismissToast(el); }, 5000);
  }

  /* ── Backward-compatible window.showToast(message, type) ── */
  window.showToast = function (message, type) {
    showToastInternal(type || 'success', String(message || ''));
  };

  /* ── Convenience API ── */
  window.toast = {
    success: function (msg) { showToastInternal('success', msg, 'check_circle'); },
    error:   function (msg) { showToastInternal('error',   msg, 'error'); },
    warning: function (msg) { showToastInternal('warning', msg, 'warning'); },
    info:    function (msg) { showToastInternal('info',    msg, 'info'); },
  };
})();
