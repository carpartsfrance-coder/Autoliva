/**
 * Admin AJAX Module - Progressive Enhancement
 * Intercepte les formulaires data-ajax pour eviter les rechargements de page.
 */
(function () {
  'use strict';

  /* ── adminFetch ─────────────────────────────────────────────── */
  async function adminFetch(url, opts) {
    opts = opts || {};
    var headers = { Accept: 'application/json' };
    var body = opts.body;

    if (body instanceof FormData) {
      /* let browser set Content-Type with boundary */
    } else if (body instanceof URLSearchParams) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
    }

    var resp;
    try {
      resp = await fetch(url, {
        method: opts.method || 'POST',
        headers: headers,
        body: body,
        credentials: 'same-origin',
      });
    } catch (_e) {
      showToast('Erreur reseau. Verifiez votre connexion.', 'error');
      throw _e;
    }

    if (resp.status === 401) {
      var data;
      try { data = await resp.json(); } catch (_e2) { data = {}; }
      showToast(data.error || 'Session expiree.', 'error');
      setTimeout(function () {
        window.location.href = data.redirect || '/admin/connexion';
      }, 1200);
      throw new Error('auth');
    }

    var json;
    try {
      json = await resp.json();
    } catch (_e3) {
      /* Non-JSON response — fallback redirect (the handler didn't support JSON) */
      window.location.reload();
      return null;
    }

    if (json.ok) {
      if (json.message) showToast(json.message, 'success');
    } else {
      showToast(json.error || 'Une erreur est survenue.', 'error');
    }

    return json;
  }

  window.adminFetch = adminFetch;

  /* ── Confirmation Modal ──────────────────────────────────────── */
  var modalEl = null;
  var modalResolve = null;

  function ensureModal() {
    if (modalEl) return;
    modalEl = document.createElement('div');
    modalEl.id = 'ajax-confirm-modal';
    modalEl.className = 'fixed inset-0 z-[10000] hidden items-center justify-center';
    modalEl.innerHTML =
      '<div id="ajax-confirm-overlay" class="absolute inset-0 bg-black/50 backdrop-blur-sm"></div>' +
      '<div class="relative bg-white rounded-2xl shadow-2xl p-6 max-w-sm mx-4 w-full animate-[fadeInUp_0.2s_ease-out]">' +
        '<p id="ajax-confirm-msg" class="text-gray-800 font-semibold text-base mb-6"></p>' +
        '<div class="flex gap-3 justify-end">' +
          '<button id="ajax-confirm-cancel" class="px-4 py-2 rounded-xl text-sm font-semibold text-gray-600 bg-gray-100 hover:bg-gray-200 transition-colors">Annuler</button>' +
          '<button id="ajax-confirm-ok" class="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-red-600 hover:bg-red-700 transition-colors">Confirmer</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(modalEl);

    var styleTag = document.createElement('style');
    styleTag.textContent = '@keyframes fadeInUp{from{opacity:0;transform:translateY(12px)}to{opacity:1;transform:translateY(0)}}';
    document.head.appendChild(styleTag);

    document.getElementById('ajax-confirm-cancel').onclick = function () { closeModal(false); };
    document.getElementById('ajax-confirm-overlay').onclick = function () { closeModal(false); };
    document.getElementById('ajax-confirm-ok').onclick = function () { closeModal(true); };
  }

  function closeModal(result) {
    modalEl.classList.add('hidden');
    modalEl.classList.remove('flex');
    if (modalResolve) { modalResolve(result); modalResolve = null; }
  }

  window.adminConfirm = function (message) {
    ensureModal();
    document.getElementById('ajax-confirm-msg').textContent = message;
    modalEl.classList.remove('hidden');
    modalEl.classList.add('flex');
    return new Promise(function (resolve) { modalResolve = resolve; });
  };

  /* ── Row removal animation ──────────────────────────────────── */
  window.adminRemoveRow = function (el, duration) {
    if (!el) return;
    duration = duration || 300;
    el.style.transition = 'opacity ' + duration + 'ms, max-height ' + duration + 'ms, padding ' + duration + 'ms, margin ' + duration + 'ms';
    el.style.overflow = 'hidden';
    el.style.maxHeight = el.offsetHeight + 'px';
    requestAnimationFrame(function () {
      el.style.opacity = '0';
      el.style.maxHeight = '0';
      el.style.paddingTop = '0';
      el.style.paddingBottom = '0';
      el.style.marginTop = '0';
      el.style.marginBottom = '0';
    });
    setTimeout(function () { el.remove(); }, duration + 50);
  };

  /* ── Form interception (progressive enhancement) ─────────────── */
  function initAjaxForms() {
    document.querySelectorAll('form[data-ajax]').forEach(function (form) {
      if (form._ajaxBound) return;
      form._ajaxBound = true;

      form.addEventListener('submit', async function (e) {
        e.preventDefault();

        /* Check confirm on submitter button first, then form */
        var submitter = e.submitter;
        var confirmMsg = (submitter && submitter.getAttribute('data-confirm')) || form.getAttribute('data-confirm');
        if (confirmMsg) {
          var ok = await window.adminConfirm(confirmMsg);
          if (!ok) return;
        }

        /* Determine URL from submitter's formaction or form action */
        var url = (submitter && submitter.getAttribute('formaction')) || form.getAttribute('action') || form.action;

        /* Disable submit button */
        var btn = submitter || form.querySelector('button[type="submit"]');
        if (btn) {
          if (window.btnSetLoading) {
            window.btnSetLoading(btn);
          } else {
            btn.disabled = true;
            btn.classList.add('opacity-50', 'cursor-not-allowed');
          }
        }

        var body;
        var enctype = form.getAttribute('enctype');
        if (enctype === 'multipart/form-data') {
          body = new FormData(form);
        } else {
          body = new URLSearchParams(new FormData(form));
        }

        try {
          var result = await adminFetch(url, { method: 'POST', body: body });
          if (!result) return;

          if (result.ok) {
            /* Handle row removal for delete actions */
            var rowId = form.getAttribute('data-row-id') || form.closest('[data-row-id]');
            if (rowId) {
              var rowEl = typeof rowId === 'string'
                ? document.querySelector('[data-row-id="' + rowId + '"]')
                : rowId; /* rowId is already the element from closest() */
              if (rowEl) adminRemoveRow(rowEl);
            }

            /* Handle bulk delete — remove checked rows */
            if (result.data && result.data.deletedIds && Array.isArray(result.data.deletedIds)) {
              result.data.deletedIds.forEach(function (id) {
                var row = document.querySelector('[data-row-id="' + id + '"]');
                if (row) adminRemoveRow(row);
              });
            }

            /* Handle toggle — update visual state */
            if (result.data && typeof result.data.isActive === 'boolean') {
              var toggleId = form.getAttribute('data-toggle-id') || (result.data && result.data.id);
              if (toggleId) {
                var toggleRow = document.querySelector('[data-row-id="' + toggleId + '"]');
                if (toggleRow) {
                  var badge = toggleRow.querySelector('[data-toggle-badge]');
                  if (badge) {
                    if (result.data.isActive) {
                      badge.textContent = 'Actif';
                      badge.className = badge.className.replace(/bg-gray-\d+/g, 'bg-green-100').replace(/text-gray-\d+/g, 'text-green-800');
                    } else {
                      badge.textContent = 'Inactif';
                      badge.className = badge.className.replace(/bg-green-\d+/g, 'bg-gray-100').replace(/text-green-\d+/g, 'text-gray-500');
                    }
                  }
                }
              }
            }

            /* Handle status update — update badge */
            if (result.data && result.data.status) {
              var statusBadge = document.querySelector('[data-status-badge]');
              if (statusBadge) {
                statusBadge.textContent = result.data.statusLabel || result.data.status;
              }
            }

            /* Dispatch custom event for page-specific handling */
            form.dispatchEvent(new CustomEvent('ajax:success', { detail: result, bubbles: true }));
          }
        } catch (_err) {
          /* Error already handled by adminFetch */
        } finally {
          if (btn) {
            if (window.btnResetLoading) {
              window.btnResetLoading(btn);
            } else {
              btn.disabled = false;
              btn.classList.remove('opacity-50', 'cursor-not-allowed');
            }
          }
        }
      });
    });
  }

  /* Init on DOMContentLoaded and also expose for dynamic content */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initAjaxForms);
  } else {
    initAjaxForms();
  }
  window.initAjaxForms = initAjaxForms;
})();
