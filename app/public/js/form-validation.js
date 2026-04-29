/* ============================================================
   CarParts France — Inline Form Validation
   Écoute blur sur [data-validate]. Lit les règles depuis les
   attributs HTML5 standards (required, minlength, type…) +
   attributs custom (data-min, data-max, data-pattern, data-match).
   ============================================================ */
(function () {
  'use strict';

  /* ── Helpers DOM ── */

  function getOrCreateWrap(input) {
    if (input._fvWrap) return input._fvWrap;
    var wrap = document.createElement('span');
    wrap.className = 'fv-wrap';
    wrap.style.cssText = 'position:relative;display:block;';
    input.parentNode.insertBefore(wrap, input);
    wrap.appendChild(input);
    input._fvWrap = wrap;
    return wrap;
  }

  function getOrCreateIcon(wrap) {
    var icon = wrap.querySelector('.fv-icon');
    if (!icon) {
      icon = document.createElement('span');
      icon.className = 'material-symbols-outlined fv-icon';
      icon.setAttribute('aria-hidden', 'true');
      icon.style.cssText = 'position:absolute;right:12px;top:50%;transform:translateY(-50%);font-size:18px;pointer-events:none;display:none;';
      wrap.appendChild(icon);
    }
    return icon;
  }

  function getOrCreateError(input, wrap) {
    if (input._fvError) return input._fvError;
    var err = document.createElement('div');
    err.className = 'fv-error';
    err.style.cssText = 'color:#DC2626;font-size:12px;margin-top:4px;display:none;';
    /* Insert right after the wrap (before any existing hint text) */
    wrap.parentNode.insertBefore(err, wrap.nextSibling);
    input._fvError = err;
    return err;
  }

  /* ── State setters ── */

  function setValid(input, wrap) {
    input.style.borderColor = '#059669';
    var icon = getOrCreateIcon(wrap);
    icon.textContent = 'check_circle';
    icon.style.color = '#059669';
    icon.style.display = '';
    var err = getOrCreateError(input, wrap);
    err.style.display = 'none';
    err.textContent = '';
  }

  function setInvalid(input, wrap, message) {
    input.style.borderColor = '#DC2626';
    var icon = getOrCreateIcon(wrap);
    icon.textContent = 'error';
    icon.style.color = '#DC2626';
    icon.style.display = '';
    var err = getOrCreateError(input, wrap);
    err.textContent = message;
    err.style.display = '';
  }

  function clearState(input, wrap) {
    input.style.borderColor = '';
    var icon = wrap.querySelector('.fv-icon');
    if (icon) icon.style.display = 'none';
    var err = input._fvError;
    if (err) { err.style.display = 'none'; err.textContent = ''; }
  }

  /* ── Core validator ── */

  function validate(input) {
    var wrap = input._fvWrap;
    if (!wrap) return;

    var raw   = input.value;
    var value = raw.trim();
    var type  = (input.getAttribute('type') || 'text').toLowerCase();

    var isRequired  = input.hasAttribute('required');
    var minLen      = input.getAttribute('minlength') ? parseInt(input.getAttribute('minlength'), 10) : null;
    var maxLen      = input.getAttribute('maxlength') ? parseInt(input.getAttribute('maxlength'), 10) : null;
    var dataMin     = input.getAttribute('data-min')  !== null ? parseFloat(input.getAttribute('data-min'))  : null;
    var dataMax     = input.getAttribute('data-max')  !== null ? parseFloat(input.getAttribute('data-max'))  : null;
    var pattern     = input.getAttribute('data-pattern') || input.getAttribute('pattern') || null;
    var matchSel    = input.getAttribute('data-match') || null;
    var customMsg   = input.getAttribute('data-error') || null;

    /* Empty field */
    if (!value) {
      if (isRequired) return setInvalid(input, wrap, customMsg || 'Ce champ est obligatoire');
      return clearState(input, wrap);
    }

    /* Email */
    if (type === 'email') {
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
        return setInvalid(input, wrap, 'Adresse e-mail invalide');
      }
    }

    /* Number — accept both dot and comma decimal */
    if (type === 'number' || dataMin !== null || dataMax !== null) {
      var num = parseFloat(value.replace(',', '.'));
      if (isNaN(num)) return setInvalid(input, wrap, 'Valeur numérique invalide');
      if (dataMin !== null && num < dataMin) {
        return setInvalid(input, wrap, 'La valeur minimale est ' + dataMin);
      }
      if (dataMax !== null && num > dataMax) {
        return setInvalid(input, wrap, 'La valeur maximale est ' + dataMax);
      }
    }

    /* Minlength */
    if (minLen !== null && value.length < minLen) {
      return setInvalid(input, wrap, customMsg || 'Minimum ' + minLen + ' caractères');
    }

    /* Maxlength */
    if (maxLen !== null && value.length > maxLen) {
      return setInvalid(input, wrap, 'Maximum ' + maxLen + ' caractères');
    }

    /* Pattern */
    if (pattern) {
      try {
        if (!new RegExp(pattern).test(value)) {
          return setInvalid(input, wrap, customMsg || 'Format invalide');
        }
      } catch (e) { /* invalid regex — skip */ }
    }

    /* Match (password confirm) */
    if (matchSel) {
      var target = document.querySelector(matchSel);
      if (target && value !== target.value) {
        return setInvalid(input, wrap, 'Les mots de passe ne correspondent pas');
      }
    }

    setValid(input, wrap);
  }

  /* ── Init ── */

  function init() {
    var inputs = document.querySelectorAll('[data-validate]');

    inputs.forEach(function (input) {
      /* Wrap for icon positioning */
      var wrap = getOrCreateWrap(input);

      /* Pre-create the error el to reserve its DOM position */
      getOrCreateError(input, wrap);

      /* Add right padding so text doesn't slide under the icon */
      input.style.paddingRight = '36px';

      /* Validate on blur */
      input.addEventListener('blur', function () { validate(input); });

      /* Re-validate on every keystroke while in error state (fast feedback) */
      input.addEventListener('input', function () {
        if (input._fvError && input._fvError.textContent) validate(input);
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
