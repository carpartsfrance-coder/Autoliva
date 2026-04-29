/* ============================================================
   CarParts France — Button loading state utility
   Exposes window.btnSetLoading(btn, text) / window.btnResetLoading(btn)
   ============================================================ */
(function () {
  'use strict';

  /**
   * Put a button into loading state:
   * - adds .btn-loading, disables pointer-events
   * - shows a CSS spinner + optional loading text
   * - saves original innerHTML / disabled state for restore
   */
  window.btnSetLoading = function (btn, loadingText) {
    if (!btn || btn._btnLoading) return;
    btn._btnLoading = true;
    btn._originalHtml = btn.innerHTML;
    btn._originalDisabled = btn.disabled;
    btn.disabled = true;
    btn.classList.add('btn-loading');
    var text = (loadingText != null) ? String(loadingText) : _inferLoadingLabel(btn);
    btn.innerHTML = '<span class="spinner" aria-hidden="true"></span>' +
      '<span style="margin-left:8px;">' + text + '</span>';
  };

  /**
   * Restore a button from loading state.
   */
  window.btnResetLoading = function (btn) {
    if (!btn) return;
    btn._btnLoading = false;
    btn.classList.remove('btn-loading');
    if (btn._originalHtml !== undefined) {
      btn.innerHTML = btn._originalHtml;
      delete btn._originalHtml;
    }
    btn.disabled = !!btn._originalDisabled;
    delete btn._originalDisabled;
  };

  /* Guess a contextual loading label from button text content */
  function _inferLoadingLabel(btn) {
    var t = (btn.textContent || '').trim().toLowerCase();
    if (/enregistr/.test(t))          return 'Enregistrement\u2026';
    if (/cr[eé][eé]r|ajouter/.test(t)) return 'Cr\u00e9ation\u2026';
    if (/supprimer|effacer/.test(t))   return 'Suppression\u2026';
    if (/g[eé]n[eé]r/.test(t))        return 'G\u00e9n\u00e9ration\u2026';
    if (/envoyer|envoie/.test(t))      return 'Envoi\u2026';
    return 'Chargement\u2026';
  }

  /* ── Non-data-ajax form spinner (progressive enhancement) ── */
  /* data-ajax forms are already handled by admin-ajax.js;      */
  /* this covers standard full-page form submissions.           */
  function initNonAjaxFormSpinners() {
    document.querySelectorAll('form:not([data-ajax])').forEach(function (form) {
      if (form._loadingBound) return;
      form._loadingBound = true;
      form.addEventListener('submit', function () {
        var btn = form.querySelector('button[type="submit"]:not([disabled])');
        if (!btn) return;
        window.btnSetLoading(btn);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initNonAjaxFormSpinners);
  } else {
    initNonAjaxFormSpinners();
  }
  window.initNonAjaxFormSpinners = initNonAjaxFormSpinners;
})();
