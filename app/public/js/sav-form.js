/* SAV — wizard client refondu (vanilla JS, mobile-first)
 * - Stepper 6 étapes (cliquable sur étapes passées)
 * - Validation inline (blur), bouton Continuer désactivé tant que invalide
 * - Drag & drop multi-fichiers, miniatures, suppression, compression auto > 2 Mo
 * - Codes OBD multi-tags avec suggestions
 * - Étape 6 récapitulatif avec édition
 * - Reset avec modale
 */
(function () {
  'use strict';

  var form = document.getElementById('sav-form');
  if (!form) return;

  var STEP_LABELS = ['Commande', 'Pièce', 'Symptômes', 'Documents', 'Engagement', 'Récapitulatif'];
  var TOTAL = STEP_LABELS.length;
  var current = 1;
  var furthestReached = 1;
  var orderInfo = null;
  var STORAGE_KEY = 'sav:draft:v2';

  // ----------------- IndexedDB (persistance des pièces jointes) -----------------
  var IDB_NAME = 'sav-draft';
  var IDB_STORE = 'files';
  function idbOpen() {
    return new Promise(function (resolve, reject) {
      if (!('indexedDB' in window)) return reject(new Error('no idb'));
      var req = indexedDB.open(IDB_NAME, 1);
      req.onupgradeneeded = function () {
        var db = req.result;
        if (!db.objectStoreNames.contains(IDB_STORE)) db.createObjectStore(IDB_STORE, { keyPath: 'kind' });
      };
      req.onsuccess = function () { resolve(req.result); };
      req.onerror = function () { reject(req.error); };
    });
  }
  function idbTx(mode) {
    return idbOpen().then(function (db) { return db.transaction(IDB_STORE, mode).objectStore(IDB_STORE); });
  }
  function idbPutFile(kind, file) {
    return idbTx('readwrite').then(function (store) {
      return new Promise(function (resolve, reject) {
        var r = store.put({ kind: kind, file: file, name: file.name, type: file.type, size: file.size });
        r.onsuccess = resolve; r.onerror = function () { reject(r.error); };
      });
    }).catch(function () {});
  }
  function idbDeleteFile(kind) {
    return idbTx('readwrite').then(function (store) {
      return new Promise(function (resolve) { var r = store.delete(kind); r.onsuccess = resolve; r.onerror = resolve; });
    }).catch(function () {});
  }
  function idbClearFiles() {
    return idbTx('readwrite').then(function (store) {
      return new Promise(function (resolve) { var r = store.clear(); r.onsuccess = resolve; r.onerror = resolve; });
    }).catch(function () {});
  }
  function idbGetAllFiles() {
    return idbTx('readonly').then(function (store) {
      return new Promise(function (resolve) {
        var out = []; var r = store.openCursor();
        r.onsuccess = function () { var c = r.result; if (c) { out.push(c.value); c.continue(); } else resolve(out); };
        r.onerror = function () { resolve(out); };
      });
    }).catch(function () { return []; });
  }

  // ----------------- Helpers -----------------
  function $(sel, ctx) { return (ctx || document).querySelector(sel); }
  function $$(sel, ctx) { return Array.prototype.slice.call((ctx || document).querySelectorAll(sel)); }
  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function fmtSize(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' o';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' Ko';
    return (n / (1024 * 1024)).toFixed(2) + ' Mo';
  }
  function toast(message, type) {
    var root = document.getElementById('sav-toast-root');
    if (!root) return;
    var el = document.createElement('div');
    el.className = 'sav-toast sav-toast--' + (type || 'success');
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.innerHTML = '<span class="material-symbols-rounded" aria-hidden="true">' +
      (type === 'error' ? 'error' : 'check_circle') + '</span><span>' + escapeHtml(message) + '</span>';
    root.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('sav-toast--visible'); });
    setTimeout(function () {
      el.classList.remove('sav-toast--visible');
      setTimeout(function () { el.remove(); }, 250);
    }, 4000);
  }

  // ----------------- Stepper -----------------
  function showStep(n) {
    if (n < 1 || n > TOTAL) return;
    current = n;
    if (n > furthestReached) furthestReached = n;
    $$('.sav-form-step').forEach(function (s) {
      var step = parseInt(s.getAttribute('data-step'), 10);
      var active = step === n;
      s.classList.toggle('sav-form-step--active', active);
      if (active) s.removeAttribute('hidden'); else s.setAttribute('hidden', '');
    });
    // Desktop stepper
    $$('[data-step-indicator]').forEach(function (el) {
      var i = parseInt(el.getAttribute('data-step-indicator'), 10);
      el.classList.toggle('is-current', i === n);
      el.classList.toggle('is-done', i < n);
      var clickable = i < furthestReached;
      el.classList.toggle('is-clickable', clickable);
    });
    // Mobile bar
    var mc = document.getElementById('sav-mobile-current');
    var ml = document.getElementById('sav-mobile-label');
    var mp = document.getElementById('sav-mobile-pct');
    var mb = document.getElementById('sav-mobile-bar');
    if (mc) mc.textContent = String(n);
    if (ml) ml.textContent = STEP_LABELS[n - 1];
    var pct = Math.round((n / TOTAL) * 100);
    if (mp) mp.textContent = String(pct);
    if (mb) mb.style.width = pct + '%';
    var prog = document.getElementById('sav-progress');
    if (prog) prog.setAttribute('aria-valuenow', String(n));
    window.scrollTo({ top: 0, behavior: 'smooth' });
    revalidateCurrentStep();
    if (n === TOTAL) {
      renderRecap();
      // Reset le bouton submit au cas où un envoi précédent l'a laissé en état loading
      var submitBtn = document.getElementById('sav-submit');
      if (submitBtn) {
        submitBtn.disabled = false;
        var sl = submitBtn.querySelector('[data-submit-label]');
        var ss = submitBtn.querySelector('[data-submit-spinner]');
        if (sl) sl.textContent = 'Envoyer ma demande';
        if (ss) ss.classList.add('hidden');
      }
    }
  }

  // Stepper : clic sur étape passée pour revenir
  document.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-go-step]');
    if (!btn) return;
    var target = parseInt(btn.getAttribute('data-go-step'), 10);
    if (target && target < furthestReached) showStep(target);
  });

  // ----------------- Draft persistance -----------------
  function saveDraft() {
    try {
      var data = { step: current, fields: {}, codes: getCodes(), files: filesMeta(), furthest: furthestReached };
      $$('input, select, textarea', form).forEach(function (el) {
        if (!el.name || el.type === 'file' || el.type === 'password') return;
        if (el.type === 'checkbox' || el.type === 'radio') {
          if (el.checked) {
            if (el.type === 'checkbox') {
              (data.fields[el.name] = data.fields[el.name] || []).push(el.value);
            } else {
              data.fields[el.name] = el.value;
            }
          }
        } else {
          data.fields[el.name] = el.value;
        }
      });
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      pingAutosave();
    } catch (_) {}
  }

  // Indicateur "Brouillon enregistré il y a X"
  var lastSaveAt = 0;
  function pingAutosave() {
    lastSaveAt = Date.now();
    var el = document.getElementById('sav-autosave');
    var lb = document.getElementById('sav-autosave-label');
    if (!el || !lb) return;
    el.style.opacity = '1';
    lb.textContent = 'Brouillon enregistré';
  }
  setInterval(function () {
    if (!lastSaveAt) return;
    var el = document.getElementById('sav-autosave');
    var lb = document.getElementById('sav-autosave-label');
    if (!el || !lb) return;
    var s = Math.floor((Date.now() - lastSaveAt) / 1000);
    if (s < 3) lb.textContent = 'Brouillon enregistré';
    else if (s < 60) lb.textContent = 'Enregistré il y a ' + s + ' s';
    else lb.textContent = 'Enregistré il y a ' + Math.floor(s / 60) + ' min';
  }, 5000);
  function restoreDraft() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      var data = JSON.parse(raw);
      if (!data || !data.fields) return;
      Object.keys(data.fields).forEach(function (name) {
        var val = data.fields[name];
        var els = form.querySelectorAll('[name="' + name + '"]');
        if (!els.length) return;
        if (els[0].type === 'checkbox' || els[0].type === 'radio') {
          var values = Array.isArray(val) ? val : [val];
          els.forEach(function (el) { el.checked = values.indexOf(el.value) !== -1; });
        } else {
          els[0].value = val;
        }
      });
      if (Array.isArray(data.codes)) data.codes.forEach(addCode);
      if (data.furthest) furthestReached = data.furthest;
      var step = data.step && data.step > 1 && data.step <= TOTAL ? data.step : 1;
      showStep(step);
      if (step > 1) {
        var banner = document.getElementById('sav-restore-banner');
        if (banner) banner.classList.remove('hidden');
      }
    } catch (_) {}
  }
  function clearDraft() { try { localStorage.removeItem(STORAGE_KEY); } catch (_) {} idbClearFiles(); }

  // ----------------- Validation inline -----------------
  function setError(name, msg) {
    var inputs = form.querySelectorAll('[name="' + name + '"], #' + name);
    var p = form.querySelector('[data-error-for="' + name + '"]');
    var errorId = 'err-' + name;
    inputs.forEach(function (input) {
      input.classList.toggle('sav-input--invalid', !!msg);
      input.classList.toggle('sav-input--valid', !msg && input.value);
      // a11y : annonce l'état + lie le champ au message d'erreur
      if (msg) {
        input.setAttribute('aria-invalid', 'true');
        input.setAttribute('aria-describedby', errorId);
      } else {
        input.removeAttribute('aria-invalid');
        input.removeAttribute('aria-describedby');
      }
    });
    if (p) {
      p.id = errorId;
      p.setAttribute('role', 'alert');
      p.setAttribute('aria-live', 'polite');
      p.innerHTML = msg ? '<span class="material-symbols-rounded text-base align-middle" aria-hidden="true">warning</span> ' + escapeHtml(msg) : '';
      p.classList.toggle('hidden', !msg);
    }
    // Annonce globale dans le live region status
    var status = document.getElementById('sav-form-status');
    if (status && msg) status.textContent = name + ' : ' + msg;
  }

  // VIN sans I, O, Q ; 17 caractères alphanumériques
  var VIN_RE = /^[A-HJ-NPR-Z0-9]{17}$/;
  // Plaque FR moderne (AA-123-AA) ou ancien (1234 AB 56 — souple)
  var PLAQUE_FR_RE = /^([A-Z]{2}-?\d{3}-?[A-Z]{2}|\d{1,4}\s?[A-Z]{1,3}\s?\d{1,3})$/;
  // Code OBD-II
  // Codes standard (P0741 = 5 car) + codes constructeur étendus (P0617E = 6 car, ex VW/Audi)
  var OBD_RE = /^[PCBU][0-9A-F]{4,5}$/i;

  function validateField(name) {
    var v = function (id) { var el = document.getElementById(id); return el ? el.value : ''; };
    if (name === 'email') {
      var em = v('email').trim();
      if (!em) return 'Indiquez votre email.';
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em)) return "Cet email ne semble pas valide.";
      return '';
    }
    if (name === 'numeroCommande') {
      var radio = form.querySelector('input[type="radio"][name="numeroCommande"]:checked');
      var manualOpen = !document.getElementById('sav-manual-block') || !document.getElementById('sav-manual-block').classList.contains('hidden');
      var num = v('numeroCommande').trim() || (radio && radio.value) || (manualOpen && v('numeroCommandeManual').trim());
      if (!num) return 'Sélectionnez ou indiquez votre numéro de commande.';
      return '';
    }
    if (name === 'pieceType') return v('pieceType') ? '' : 'Sélectionnez le type de pièce.';
    if (name === 'dateMontage') {
      var d = v('dateMontage');
      if (!d) return 'Indiquez la date du montage.';
      var dt = new Date(d);
      var now = new Date();
      var twoYearsAgo = new Date(); twoYearsAgo.setFullYear(now.getFullYear() - 2);
      if (dt > now) return 'La date ne peut pas être dans le futur.';
      if (dt < twoYearsAgo) return 'Le montage doit dater de moins de 2 ans (garantie légale).';
      return '';
    }
    if (name === 'garageNom') return v('garageNom').trim() ? '' : 'Indiquez le nom du garage.';
    if (name === 'description') {
      var d2 = v('description').trim();
      if (d2.length < 20) return 'Décrivez vos symptômes (au moins 20 caractères).';
      return '';
    }
    if (name === 'vin') {
      var vin = v('vin').trim().toUpperCase();
      if (!vin) return ''; // optionnel si plaque
      if (!VIN_RE.test(vin)) return 'VIN invalide (17 caractères, sans I/O/Q).';
      return '';
    }
    if (name === 'immatriculation') {
      var im = v('immatriculation').trim().toUpperCase();
      if (!im) return ''; // optionnel si VIN
      if (!PLAQUE_FR_RE.test(im)) return 'Plaque française invalide (ex: AA-123-AA).';
      return '';
    }
    if (name === 'kilometrage') {
      var km = v('kilometrage').trim();
      if (!km) return '';
      var n = parseInt(km, 10);
      if (isNaN(n) || n < 0) return 'Kilométrage invalide.';
      if (n > 1500000) return 'Kilométrage trop élevé.';
      return '';
    }
    if (name === 'vAnnee') {
      var y = v('vAnnee').trim();
      if (!y) return '';
      var yi = parseInt(y, 10);
      var cy = new Date().getFullYear();
      if (isNaN(yi) || yi < 1980 || yi > cy + 1) return 'Année invalide.';
      return '';
    }
    return '';
  }

  function validateStep(step) {
    var ok = true;
    function check(name) {
      var msg = validateField(name);
      setError(name, msg);
      if (msg) ok = false;
    }
    if (step === 1) {
      // Au moins une commande sélectionnée OU saisie manuelle
      var radio = form.querySelector('input[type="radio"][name="numeroCommande"]:checked');
      var manualBlock = document.getElementById('sav-manual-block');
      var manualOpen = manualBlock && !manualBlock.classList.contains('hidden');
      if (!radio && !manualOpen) {
        var loose = document.getElementById('numeroCommande');
        if (!loose || !loose.value.trim()) {
          setError('numeroCommande', 'Sélectionnez votre commande.');
          ok = false;
        }
      }
      if (manualOpen) {
        var em = (document.getElementById('emailManual') || {}).value || '';
        var nm = (document.getElementById('numeroCommandeManual') || {}).value || '';
        if (!em.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em.trim())) { setError('numeroCommande', 'Email invalide.'); ok = false; }
        if (!nm.trim()) { setError('numeroCommande', 'Indiquez votre n° de commande.'); ok = false; }
      }
      // Mode invité (sans currentUser)
      if (document.getElementById('email') && !document.getElementById('email').value.startsWith('') && !manualOpen) {
        // rien — déjà checké si visible
      }
    }
    if (step === 2) {
      check('pieceType');
      check('dateMontage');
      check('garageNom');
      var rb = (form.querySelector('input[name="reglageBase"]:checked') || {}).value || '';
      if (!rb) { ok = false; }
    }
    if (step === 3) {
      check('description');
      // codes OBD : optionnels mais doivent être au bon format si présents
      var codes = getCodes();
      var bad = codes.filter(function (c) { return !OBD_RE.test(c); });
      if (bad.length) { setError('codesDefaut', 'Code(s) invalide(s) : ' + bad.join(', ')); ok = false; }
      else setError('codesDefaut', '');
    }
    if (step === 4) {
      // VIN ou plaque obligatoire
      check('vin'); check('immatriculation');
      var vin = (document.getElementById('vin') || {}).value || '';
      var imm = (document.getElementById('immatriculation') || {}).value || '';
      if (!vin && !imm) {
        setError('vin', 'Renseignez le VIN ou la plaque.');
        ok = false;
      }
      // Documents : facture + photo pièce + photo OBD + photo compteur obligatoires
      var hasKinds = {};
      droppedFiles.forEach(function (f) { hasKinds[f.kind] = true; });
      var REQ = [
        { k: 'factureMontage', l: 'Facture du garage' },
        { k: 'photoObd',       l: 'Photo OBD' },
        { k: 'photoCompteur',  l: 'Photo du compteur' },
      ];
      // (état visuel des slots géré par renderFileList)
      var missing = REQ.filter(function (r) { return !hasKinds[r.k]; }).map(function (r) { return r.l; });
      if (missing.length) {
        setError('files', 'Il manque encore : ' + missing.join(', ') + '. Ajoutez le(s) fichier(s) puis choisissez leur catégorie dans le menu à droite.');
        ok = false;
      } else setError('files', '');
    }
    if (step === 5) {
      var c1 = document.getElementById('cgvSav').checked;
      var c2 = document.getElementById('accept149').checked;
      var c3 = document.getElementById('rgpdSav').checked;
      if (!(c1 && c2 && c3)) {
        setError('acceptances', 'Cochez les 3 cases pour continuer.');
        ok = false;
      } else {
        setError('acceptances', '');
      }
    }
    return ok;
  }

  function revalidateCurrentStep() {
    var btn = document.querySelector('[data-step="' + current + '"] [data-action="next"], [data-step="' + current + '"] [type="submit"]');
    if (!btn) return;
    var ok = validateStepSilently(current);
    btn.disabled = !ok;
    btn.classList.toggle('sav-cta--disabled', !ok);
    if (ok) btn.removeAttribute('title');
    else if (btn.dataset.tooltip) btn.setAttribute('title', btn.dataset.tooltip);
  }

  // Variante "silencieuse" : ne pose pas les messages d'erreur, juste retourne ok/pas ok
  function validateStepSilently(step) {
    var saved = {};
    $$('[data-error-for]').forEach(function (p) { saved[p.getAttribute('data-error-for')] = { html: p.innerHTML, hidden: p.classList.contains('hidden') }; });
    var savedClasses = [];
    $$('input, select, textarea', form).forEach(function (i) {
      savedClasses.push({ el: i, valid: i.classList.contains('sav-input--valid'), invalid: i.classList.contains('sav-input--invalid') });
    });
    var ok = validateStep(step);
    // Restaure
    $$('[data-error-for]').forEach(function (p) {
      var s = saved[p.getAttribute('data-error-for')];
      if (s) { p.innerHTML = s.html; p.classList.toggle('hidden', s.hidden); }
    });
    savedClasses.forEach(function (s) {
      s.el.classList.toggle('sav-input--valid', s.valid);
      s.el.classList.toggle('sav-input--invalid', s.invalid);
    });
    return ok;
  }

  // Validation au blur — tous les champs ayant une règle dans validateField
  var BLUR_FIELDS = ['email','numeroCommande','pieceType','dateMontage','garageNom','description','vin','immatriculation','kilometrage','vAnnee'];
  form.addEventListener('blur', function (e) {
    var t = e.target;
    if (!t || !t.name) return;
    var key = t.name || t.id;
    if (BLUR_FIELDS.indexOf(key) >= 0) {
      var msg = validateField(key);
      setError(key, msg);
    }
    revalidateCurrentStep();
  }, true);

  form.addEventListener('input', function () { saveDraft(); revalidateCurrentStep(); });
  form.addEventListener('change', function () { saveDraft(); revalidateCurrentStep(); });

  // Description compteur
  var descTextarea = document.getElementById('description');
  var descCount = document.getElementById('descCount');
  if (descTextarea && descCount) {
    descTextarea.addEventListener('input', function () {
      descCount.textContent = String(descTextarea.value.trim().length);
    });
  }

  // ----------------- Codes OBD multi-tags -----------------
  var SUGGESTIONS_OBD = ['P0741','P17BF','P189C','P173A','P0842','P0843','P2711','P2723','P0700','P0734'];
  function getCodes() {
    var hidden = document.getElementById('codesDefaut');
    return (hidden && hidden.value ? hidden.value.split(',').filter(Boolean) : []);
  }
  function setCodes(arr) {
    document.getElementById('codesDefaut').value = arr.join(',');
    renderTags();
    saveDraft();
    revalidateCurrentStep();
  }
  // Nettoie un texte collé : supprime tous les caractères non alphanumériques sauf séparateurs
  function cleanObdText(raw) {
    // Supprime caractères invisibles (zero-width, BOM, etc.) mais garde lettres/chiffres/séparateurs
    return raw.replace(/[\u200B-\u200D\uFEFF\u00A0]/g, '').replace(/[^\w,;\s-]/g, '');
  }
  function addCode(code) {
    code = cleanObdText(String(code || '')).trim().toUpperCase();
    if (!code) return;
    var codes = getCodes();
    if (codes.length >= 10) { toast('10 codes maximum', 'error'); return; }
    if (codes.indexOf(code) >= 0) return;
    codes.push(code);
    setCodes(codes);
  }
  function removeCode(code) {
    setCodes(getCodes().filter(function (c) { return c !== code; }));
  }
  function renderTags() {
    var box = document.getElementById('obdTagBox');
    if (!box) return;
    var input = document.getElementById('obdInput');
    // Détacher l'input AVANT de vider le conteneur (sinon innerHTML='' le détruit)
    if (input && input.parentNode === box) box.removeChild(input);
    // Supprimer tous les chips existants
    while (box.firstChild) box.removeChild(box.firstChild);
    // Recréer les chips
    getCodes().forEach(function (c) {
      var chip = document.createElement('span');
      var bad = !OBD_RE.test(c);
      chip.className = 'sav-tag' + (bad ? ' sav-tag--bad' : '');
      chip.innerHTML = '<span>' + escapeHtml(c) + '</span><button type="button" class="sav-tag__rm" aria-label="Retirer">\u00d7</button>';
      chip.querySelector('.sav-tag__rm').addEventListener('click', function () { removeCode(c); });
      box.appendChild(chip);
    });
    // Remettre l'input à la fin
    if (input) box.appendChild(input);
  }
  var obdInput = document.getElementById('obdInput');
  if (obdInput) {
    // Empêcher Enter de soumettre le formulaire ET ajouter le code comme tag
    obdInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ',') {
        e.preventDefault();
        e.stopPropagation();
        var v = cleanObdText(obdInput.value).trim();
        // Vider l'input AVANT renderTags pour éviter que blur ne re-ajoute
        obdInput.value = '';
        // Gérer le cas où le texte contient plusieurs codes (collé avant Enter)
        if (v) {
          var parts = v.split(/[\s,;\n\r]+/).filter(Boolean);
          parts.forEach(function (p) { addCode(p); });
        }
      } else if (e.key === 'Backspace' && !obdInput.value) {
        var codes = getCodes();
        if (codes.length) removeCode(codes[codes.length - 1]);
      }
    });
    // Sécurité : bloquer aussi keypress Enter (soumission implicite navigateur)
    obdInput.addEventListener('keypress', function (e) {
      if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); e.stopPropagation(); }
    });
    // Gestion du copier-coller : nettoyer et séparer les codes collés
    obdInput.addEventListener('paste', function (e) {
      e.preventDefault();
      var pasted = (e.clipboardData || window.clipboardData).getData('text') || '';
      // Séparer par virgule, espace, point-virgule, retour à la ligne
      var parts = cleanObdText(pasted).split(/[\s,;\n\r]+/).filter(Boolean);
      if (parts.length === 0) return;
      if (parts.length === 1) {
        // Un seul code : le mettre dans l'input pour que l'utilisateur puisse valider
        obdInput.value = parts[0].trim().toUpperCase();
        obdInput.dispatchEvent(new Event('input', {bubbles: true}));
      } else {
        // Plusieurs codes : les ajouter tous directement comme tags
        parts.forEach(function (p) { addCode(p); });
        obdInput.value = '';
      }
    });
    obdInput.addEventListener('blur', function () {
      var v = cleanObdText(obdInput.value).trim();
      if (v) { obdInput.value = ''; addCode(v); }
    });
  }

  // Protection globale : empêcher Enter dans les inputs texte de soumettre le form
  form.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT' && e.target.type !== 'submit') {
      e.preventDefault();
    }
  });
  var sg = document.getElementById('obdSuggest');
  if (sg) {
    sg.innerHTML = SUGGESTIONS_OBD.slice(0, 6).map(function (c) {
      return '<button type="button" class="sav-suggest" data-code="' + c + '">' + c + '</button>';
    }).join(' ');
    sg.addEventListener('click', function (e) {
      var b = e.target.closest('[data-code]');
      if (b) addCode(b.getAttribute('data-code'));
    });
  }
  renderTags();

  // ----------------- Drag & drop fichiers -----------------
  var droppedFiles = []; // {file, kind, preview, id}
  var KIND_OPTIONS = [
    { v: 'factureMontage', l: 'Facture garage' },
    { v: 'photoPiece', l: 'Photo pièce installée' },
    { v: 'photoObd', l: 'Photo OBD' },
    { v: 'photoCompteur', l: 'Photo compteur (km)' },
    { v: 'bonGarantie', l: 'Bon garantie (optionnel)' },
  ];
  function filesMeta() { return droppedFiles.map(function (f) { return { name: f.file.name, kind: f.kind, size: f.file.size }; }); }

  function guessKind(file) {
    var n = (file.name || '').toLowerCase();
    if (/facture|invoice/.test(n)) return 'factureMontage';
    if (/obd|defaut|fault/.test(n)) return 'photoObd';
    if (/compteur|km|odometre/.test(n)) return 'photoCompteur';
    if (/garantie|warranty/.test(n)) return 'bonGarantie';
    return 'photoPiece';
  }

  function renderFileList() {
    // Met à jour l'état visuel de chaque slot (rempli / vide)
    $$('.sav-doc-slot').forEach(function (slot) {
      var kind = slot.getAttribute('data-kind');
      var entry = droppedFiles.find(function (f) { return f.kind === kind; });
      var filled = slot.querySelector('.sav-doc-slot__filled');
      if (entry) {
        slot.classList.add('is-filled');
        var thumb = filled.querySelector('.sav-doc-slot__thumb');
        if (entry.preview) {
          thumb.src = entry.preview;
          thumb.style.display = '';
        } else {
          thumb.style.display = 'none';
        }
        filled.querySelector('.sav-doc-slot__name').textContent = entry.file.name;
        filled.querySelector('.sav-doc-slot__meta').textContent = fmtSize(entry.file.size);
        filled.removeAttribute('hidden');
      } else {
        slot.classList.remove('is-filled');
        filled.setAttribute('hidden', '');
      }
    });
  }

  function readPreview(file) {
    return new Promise(function (resolve) {
      if (!/^image\//.test(file.type)) return resolve('');
      var fr = new FileReader();
      fr.onload = function () { resolve(fr.result); };
      fr.onerror = function () { resolve(''); };
      fr.readAsDataURL(file);
    });
  }

  function compressIfNeeded(file) {
    if (!/^image\//.test(file.type)) return Promise.resolve(file);
    if (file.size < 2 * 1024 * 1024) return Promise.resolve(file);
    if (typeof window.imageCompression !== 'function') return Promise.resolve(file);
    return window.imageCompression(file, {
      maxSizeMB: 1.8,
      maxWidthOrHeight: 2400,
      useWebWorker: true,
    }).catch(function () { return file; });
  }

  function addFiles(files, forcedKind) {
    var arr = Array.from(files || []);
    var errors = [];
    arr.forEach(function (file) {
      if (droppedFiles.length >= 5) { errors.push('Maximum 5 fichiers'); return; }
      if (!/^application\/pdf$|^image\/(jpe?g|png|heic|heif)$/i.test(file.type)) {
        errors.push(file.name + ' : format non autorisé'); return;
      }
      if (file.size > 10 * 1024 * 1024) { errors.push(file.name + ' : > 10 Mo'); return; }
      compressIfNeeded(file).then(function (final) {
        readPreview(final).then(function (preview) {
          var kind = forcedKind || guessKind(final);
          // Si un fichier existe déjà pour ce kind, on le remplace
          var existingIdx = droppedFiles.findIndex(function (f) { return f.kind === kind; });
          var entry = { file: final, kind: kind, preview: preview, progress: 0 };
          if (existingIdx >= 0) droppedFiles[existingIdx] = entry;
          else droppedFiles.push(entry);
          idbPutFile(kind, final);
          renderFileList();
          revalidateCurrentStep();
          saveDraft();
        });
      });
    });
    if (errors.length) toast(errors.join(' · '), 'error');
  }

  // Wire chaque slot indépendamment
  $$('.sav-doc-slot').forEach(function (slot) {
    var kind = slot.getAttribute('data-kind');
    var input = slot.querySelector('.sav-doc-slot__input');
    var rmBtn = slot.querySelector('.sav-doc-slot__rm');
    if (!input) return;

    function openPicker() { input.click(); }
    // Clic sur la zone ou sur le filled
    slot.addEventListener('click', function (e) {
      if (e.target.closest('.sav-doc-slot__rm')) return;
      if (e.target.closest('.sav-doc-slot__input')) return;
      openPicker();
    });
    slot.setAttribute('tabindex', '0');
    slot.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openPicker(); }
    });

    // Drag & drop sur le slot
    slot.addEventListener('dragover', function (e) { e.preventDefault(); slot.classList.add('is-drop'); });
    slot.addEventListener('dragleave', function () { slot.classList.remove('is-drop'); });
    slot.addEventListener('drop', function (e) {
      e.preventDefault();
      slot.classList.remove('is-drop');
      if (e.dataTransfer.files.length) addFiles([e.dataTransfer.files[0]], kind);
    });

    input.addEventListener('change', function () {
      if (input.files.length) addFiles([input.files[0]], kind);
      input.value = '';
    });

    if (rmBtn) {
      rmBtn.addEventListener('click', function (e) {
        e.stopPropagation();
        var idx = droppedFiles.findIndex(function (f) { return f.kind === kind; });
        if (idx >= 0) {
          droppedFiles.splice(idx, 1);
          idbDeleteFile(kind);
          renderFileList();
          revalidateCurrentStep();
          saveDraft();
        }
      });
    }
  });

  // ----------------- Sélection commande : recherche + saisie manuelle -----------------
  var searchInput = document.getElementById('sav-orders-search');
  if (searchInput) {
    searchInput.addEventListener('input', function () {
      var q = searchInput.value.trim().toLowerCase();
      var matches = 0;
      $$('#sav-orders-list .sav-order-card').forEach(function (card) {
        var hay = card.getAttribute('data-order-search') || '';
        var ok = !q || hay.indexOf(q) >= 0;
        card.style.display = ok ? '' : 'none';
        if (ok) matches++;
      });
      var empty = document.getElementById('sav-orders-empty');
      if (empty) empty.classList.toggle('hidden', matches > 0);
    });
  }
  $$('#sav-orders-manual-toggle').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var b = document.getElementById('sav-manual-block');
      if (b) b.classList.toggle('hidden');
    });
  });

  // ----------------- Récap (étape 6) -----------------
  function val(id) { var el = document.getElementById(id); return el ? (el.value || '') : ''; }
  function buildRecap() {
    var radio = form.querySelector('input[type="radio"][name="numeroCommande"]:checked');
    var manualOpen = document.getElementById('sav-manual-block') && !document.getElementById('sav-manual-block').classList.contains('hidden');
    var num = val('numeroCommande') || (radio && radio.value) || (manualOpen && val('numeroCommandeManual')) || '';
    return {
      commande: {
        numero: num,
        email: val('email') || val('emailManual'),
      },
      piece: {
        type: val('pieceType'),
        dateMontage: val('dateMontage'),
        garage: val('garageNom'),
        garageAdresse: val('garageAdresse'),
        reglageBase: (form.querySelector('input[name="reglageBase"]:checked') || {}).value || '',
        huileQuantite: val('huileQuantite'),
        huileType: val('huileType'),
      },
      symptomes: {
        list: $$('input[name="symptomes"]:checked').map(function (i) { return i.value; }),
        codes: getCodes(),
        description: val('description'),
        momentPanne: val('momentPanne'),
      },
      vehicule: {
        vin: val('vin').toUpperCase(),
        immatriculation: val('immatriculation').toUpperCase(),
        marque: val('vMarque'),
        modele: val('vModele'),
        annee: val('vAnnee'),
        motorisation: val('vMotor'),
        kilometrage: val('kilometrage'),
      },
      documents: droppedFiles.map(function (f) { return { name: f.file.name, kind: f.kind, size: f.file.size }; }),
      engagement: {
        cgv: document.getElementById('cgvSav').checked,
        accept149: document.getElementById('accept149').checked,
        rgpd: document.getElementById('rgpdSav').checked,
      },
    };
  }
  function renderRecap() {
    var box = document.getElementById('sav-recap');
    if (!box) return;
    var d = buildRecap();
    // Masquer le bandeau "brouillon restauré" — plus pertinent à l'étape récap
    var rb = document.getElementById('sav-restore-banner');
    if (rb) rb.classList.add('hidden');

    // Bandeau de statut : OK ou champs manquants
    var missing = [];
    if (!d.commande.numero) missing.push({ label: 'Commande', step: 1 });
    if (!d.piece.type || !d.piece.dateMontage || !d.piece.garage || !d.piece.reglageBase) missing.push({ label: 'Pièce / garage', step: 2 });
    if (!d.symptomes.description || d.symptomes.description.length < 20) missing.push({ label: 'Description', step: 3 });
    if (!d.vehicule.vin && !d.vehicule.immatriculation) missing.push({ label: 'VIN ou plaque', step: 4 });
    var hasReqDocs = ['factureMontage','photoObd','photoCompteur'].every(function (k) {
      return d.documents.some(function (f) { return f.kind === k; });
    });
    if (!hasReqDocs) missing.push({ label: 'Documents obligatoires', step: 4 });
    if (!d.engagement.cgv || !d.engagement.accept149 || !d.engagement.rgpd) missing.push({ label: 'Engagements', step: 5 });

    var banner = '';
    if (missing.length === 0) {
      banner = '<div class="sav-recap__strip sav-recap__strip--ok">' +
        '<span class="material-symbols-rounded" aria-hidden="true">check_circle</span>' +
        'Tout est prêt — vérifiez ci-dessous puis envoyez.</div>';
    } else {
      banner = '<div class="sav-recap__strip sav-recap__strip--warn">' +
        '<span class="material-symbols-rounded" aria-hidden="true">warning</span>' +
        'Il manque ' + missing.length + ' élément' + (missing.length > 1 ? 's' : '') + ' : ' +
        missing.map(function (m) {
          return '<button type="button" class="sav-recap__jump" data-go-step="' + m.step + '">' + escapeHtml(m.label) + '</button>';
        }).join(' · ') + '</div>';
    }

    function section(title, icon, body, step) {
      return '<div class="sav-recap__section">' +
        '<div class="sav-recap__head">' +
          '<span class="sav-recap__head-icon material-symbols-rounded" aria-hidden="true">' + icon + '</span>' +
          '<h3>' + escapeHtml(title) + '</h3>' +
          '<button type="button" class="sav-recap__edit" data-go-step="' + step + '" aria-label="Modifier ' + escapeHtml(title) + '">' +
            '<span class="material-symbols-rounded" aria-hidden="true">edit</span>' +
          '</button>' +
        '</div>' +
        '<dl class="sav-recap__dl">' + body + '</dl></div>';
    }
    function row(k, v) {
      if (!v) return '';
      return '<dt>' + escapeHtml(k) + '</dt><dd>' + escapeHtml(v) + '</dd>';
    }
    function rowHtml(k, html) {
      if (!html) return '';
      return '<dt>' + escapeHtml(k) + '</dt><dd>' + html + '</dd>';
    }

    // Vignettes des pièces jointes
    var docsHtml = '';
    if (droppedFiles.length) {
      docsHtml = '<div class="sav-recap__files">' +
        droppedFiles.map(function (f) {
          var labelMap = { factureMontage: 'Facture', photoObd: 'Photo OBD', photoCompteur: 'Compteur', photoPiece: 'Pièce', bonGarantie: 'Garantie' };
          var label = labelMap[f.kind] || f.kind;
          var thumb = f.preview
            ? '<img src="' + f.preview + '" alt="">'
            : '<span class="material-symbols-rounded" aria-hidden="true">description</span>';
          return '<div class="sav-recap__file">' +
            '<div class="sav-recap__file-thumb">' + thumb + '</div>' +
            '<div class="sav-recap__file-meta">' +
              '<div class="sav-recap__file-label">' + escapeHtml(label) + '</div>' +
              '<div class="sav-recap__file-name">' + escapeHtml(f.file.name) + '</div>' +
              '<div class="sav-recap__file-size">' + fmtSize(f.file.size) + '</div>' +
            '</div></div>';
        }).join('') +
        '</div>';
    } else {
      docsHtml = '<div class="sav-recap__empty">Aucun document ajouté</div>';
    }

    var html = banner;
    html += section('Commande', 'receipt_long',
      row('Numéro', d.commande.numero) + row('Email', d.commande.email), 1);
    html += section('Pièce & montage', 'build',
      row('Type', d.piece.type) + row('Date de montage', d.piece.dateMontage) +
      row('Garage', d.piece.garage) + row('Adresse garage', d.piece.garageAdresse) +
      row('Réglage de base', d.piece.reglageBase) +
      (d.piece.huileQuantite ? row('Huile (quantité)', d.piece.huileQuantite + ' L') : '') +
      (d.piece.huileType ? row('Huile (type)', d.piece.huileType) : ''), 2);
    var MOMENT_LABELS = {
      au_montage: 'Pendant le montage', premier_demarrage: 'Au premier démarrage',
      moins_100km: 'Moins de 100 km', '100_500km': '100 - 500 km',
      '500_1000km': '500 - 1 000 km', '1000_5000km': '1 000 - 5 000 km',
      plus_5000km: 'Plus de 5 000 km', inconnu: 'Inconnu'
    };
    var sympBody =
      (d.symptomes.momentPanne ? row('Moment de la panne', MOMENT_LABELS[d.symptomes.momentPanne] || d.symptomes.momentPanne) : '') +
      (d.symptomes.list.length ? row('Symptômes', d.symptomes.list.join(', ')) : '') +
      (d.symptomes.codes.length ? row('Codes OBD', d.symptomes.codes.join(', ')) : '') +
      (d.symptomes.description ? rowHtml('Description', '<span class="sav-recap__quote">' + escapeHtml(d.symptomes.description) + '</span>') : '');
    html += section('Symptômes', 'stethoscope', sympBody, 3);
    html += section('Véhicule & documents', 'directions_car',
      row('VIN', d.vehicule.vin) + row('Plaque', d.vehicule.immatriculation) +
      row('Véhicule', [d.vehicule.marque, d.vehicule.modele, d.vehicule.annee].filter(Boolean).join(' ')) +
      row('Motorisation', d.vehicule.motorisation) +
      row('Kilométrage', d.vehicule.kilometrage ? d.vehicule.kilometrage + ' km' : '') +
      rowHtml('Pièces jointes', docsHtml), 4);
    box.innerHTML = html;
  }

  // ----------------- Wiring nav -----------------
  form.addEventListener('click', function (e) {
    var btn = e.target.closest('[data-action]');
    if (!btn) return;
    var action = btn.getAttribute('data-action');
    if (action === 'next') {
      var step = parseInt(btn.getAttribute('data-validate-step'), 10);
      if (validateStep(step) && current < TOTAL) showStep(current + 1);
    } else if (action === 'prev') {
      if (current > 1) showStep(current - 1);
    }
  });

  // ----------------- Reset wizard -----------------
  function resetWizard() {
    clearDraft();
    droppedFiles = [];
    setCodes([]);
    try { form.reset(); } catch (_) {}
    $$('input', form).forEach(function (el) {
      if (el.type === 'checkbox' || el.type === 'radio') el.checked = false;
      else if (el.type !== 'submit' && el.type !== 'button') el.value = '';
      el.classList.remove('sav-input--invalid', 'sav-input--valid');
    });
    $$('textarea, select', form).forEach(function (el) {
      el.value = '';
      el.classList.remove('sav-input--invalid', 'sav-input--valid');
    });
    renderFileList();
    $$('[data-error-for]').forEach(function (p) { p.classList.add('hidden'); p.innerHTML = ''; });
    var alert = document.getElementById('reglageBaseAlert');
    var help = document.getElementById('reglageBaseHelp');
    if (alert) alert.classList.add('hidden');
    if (help) help.classList.add('hidden');
    var banner = document.getElementById('sav-restore-banner');
    if (banner) banner.classList.add('hidden');
    furthestReached = 1;
    showStep(1);
    toast('Formulaire réinitialisé', 'success');
  }
  var resetBtn = document.getElementById('sav-reset-btn');
  var resetModal = document.getElementById('sav-reset-modal');
  var resetConfirm = document.getElementById('sav-reset-confirm');
  var resetCancel = document.getElementById('sav-reset-cancel');
  function openResetModal() {
    if (!resetModal) return;
    resetModal.classList.remove('hidden'); resetModal.classList.add('flex');
    if (resetCancel) resetCancel.focus();
  }
  function closeResetModal() {
    if (!resetModal) return;
    resetModal.classList.add('hidden'); resetModal.classList.remove('flex');
  }
  if (resetBtn) resetBtn.addEventListener('click', openResetModal);
  if (resetCancel) resetCancel.addEventListener('click', closeResetModal);
  if (resetConfirm) resetConfirm.addEventListener('click', function () { closeResetModal(); resetWizard(); });
  if (resetModal) resetModal.addEventListener('click', function (e) { if (e.target === resetModal) closeResetModal(); });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && resetModal && !resetModal.classList.contains('hidden')) closeResetModal();
  });

  // ----------------- Soumission finale -----------------
  form.addEventListener('submit', function (e) {
    e.preventDefault();
    if (!validateStep(5) || !validateStep(4) || !validateStep(3) || !validateStep(2) || !validateStep(1)) {
      toast('Vérifiez les étapes en erreur.', 'error');
      return;
    }
    var btn = document.getElementById('sav-submit');
    var lbl = btn.querySelector('[data-submit-label]');
    var sp = btn.querySelector('[data-submit-spinner]');
    btn.disabled = true;
    lbl.textContent = 'Envoi en cours…';
    sp.classList.remove('hidden');

    var emailVal = (val('email') || val('emailManual')).trim();
    var radio = form.querySelector('input[type="radio"][name="numeroCommande"]:checked');
    var numeroCmd = val('numeroCommande').trim() || (radio && radio.value) || val('numeroCommandeManual').trim();

    var payload = {
      motifSav: 'piece_defectueuse',
      pieceType: val('pieceType'),
      numeroCommande: numeroCmd,
      dateAchat: orderInfo && orderInfo.dateCommande,
      client: { nom: val('clientNom') || emailVal.split('@')[0], email: emailVal },
      vehicule: {
        vin: val('vin').toUpperCase(),
        immatriculation: val('immatriculation').toUpperCase(),
        marque: val('vMarque'),
        modele: val('vModele'),
        annee: val('vAnnee') ? Number(val('vAnnee')) : undefined,
        motorisation: val('vMotor'),
        kilometrage: val('kilometrage') ? Number(val('kilometrage')) : undefined,
      },
      garage: { nom: val('garageNom'), adresse: val('garageAdresse') },
      montage: {
        date: val('dateMontage'),
        reglageBase: (form.querySelector('input[name="reglageBase"]:checked') || {}).value || '',
        momentPanne: val('momentPanne'),
        huileQuantite: val('huileQuantite'),
        huileType: val('huileType'),
      },
      diagnostic: {
        symptomes: $$('input[name="symptomes"]:checked').map(function (i) { return i.value; }),
        codesDefaut: getCodes(),
        description: val('description'),
      },
      cgvAcceptance: { version: 'cgv-sav-v2-2026-04', acceptedAt: new Date().toISOString() },
      rgpdAcceptance: { version: 'rgpd-v1-2026-04', acceptedAt: new Date().toISOString() },
    };

    function uploadOne(numero, entry) {
      var fd = new FormData();
      fd.append('document', entry.file, entry.file.name);
      fd.append('email', emailVal);
      fd.append('kind', entry.kind);
      return new Promise(function (resolve, reject) {
        var xhr = new XMLHttpRequest();
        xhr.open('POST', '/api/sav/tickets/' + encodeURIComponent(numero) + '/documents');
        xhr.upload.onprogress = function (e) {
          if (e.lengthComputable) {
            entry.progress = Math.round((e.loaded / e.total) * 100);
            renderFileList();
          }
        };
        xhr.onload = function () {
          if (xhr.status >= 200 && xhr.status < 300) { entry.progress = 100; renderFileList(); resolve(); }
          else reject(new Error('upload échoué (' + xhr.status + ') ' + entry.kind));
        };
        xhr.onerror = function () { reject(new Error('erreur réseau ' + entry.kind)); };
        xhr.send(fd);
      });
    }

    function resetBtn() { btn.disabled = false; lbl.textContent = 'Envoyer ma demande'; sp.classList.add('hidden'); }

    function postTicket(force) {
      var p = Object.assign({}, payload);
      if (force) p.forceNew = true;
      return fetch('/api/sav/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(p),
      }).then(function (r) {
        return r.text().then(function (txt) { var j = {}; try { j = JSON.parse(txt); } catch (_) {} return { ok: r.ok, status: r.status, j: j }; });
      });
    }
    postTicket(false).then(function (res) {
      // Détection de doublon : 409 avec un ticket existant
      if (res.status === 409 && res.j && res.j.error === 'duplicate') {
        var ex = (res.j.data && res.j.data.existingTicket) || {};
        var msg = "Vous avez déjà un ticket sur cette commande (" + (ex.numero || '?') + ").\n\n" +
                  "OK = créer un nouveau ticket\nAnnuler = suivre le ticket existant";
        if (window.confirm(msg)) {
          return postTicket(true).then(handleResponse);
        } else {
          window.location.href = '/sav/suivi?numero=' + encodeURIComponent(ex.numero || '');
          return;
        }
      }
      handleResponse(res);
    }).catch(function (err) {
      console.error('[SAV] exception', err);
      toast('Erreur réseau : ' + (err && err.message ? err.message : 'inconnue'), 'error');
      resetBtn();
    });

    function handleResponse(res) {
      if (!res || !res.ok || !res.j.success) {
        toast((res && res.j && res.j.error) || ('Erreur serveur ' + (res && res.status)), 'error');
        resetBtn();
        return;
      }
      var numero = res.j.data.numero;
      // Upload séquentiel pour ne pas saturer
      var p = Promise.resolve();
      droppedFiles.forEach(function (entry) { p = p.then(function () { return uploadOne(numero, entry); }); });
      p.then(function () {
        clearDraft();
        toast('Votre demande est enregistrée. Redirection…', 'success');
        setTimeout(function () { window.location.href = '/sav/confirmation/' + encodeURIComponent(numero); }, 700);
      }).catch(function (err) {
        console.error('[SAV] upload', err);
        toast("Ticket créé mais l'envoi de certains documents a échoué. Notre équipe vous contactera.", 'error');
        setTimeout(function () { window.location.href = '/sav/confirmation/' + encodeURIComponent(numero); }, 1500);
      });
    }
  });

  // ----------------- Auto-sélection commande unique (utilisateur connecté) -----------------
  function autoPickSingleOrder() {
    var radios = $$('input[type="radio"][name="numeroCommande"]', form);
    if (radios.length !== 1) return;
    if (radios[0].checked) return;
    radios[0].checked = true;
    var card = radios[0].closest('.sav-order-card');
    if (card) card.classList.add('is-auto-selected');
    // Indique au client que c'est pré-rempli
    var note = document.createElement('div');
    note.className = 'mt-2 text-xs text-emerald-700 inline-flex items-center gap-1';
    note.innerHTML = '<span class="material-symbols-rounded text-base" aria-hidden="true">auto_awesome</span>Commande pré-sélectionnée — vous pouvez continuer.';
    var list = document.getElementById('sav-orders-list');
    if (list && !list.parentNode.querySelector('.sav-auto-pick-note')) {
      note.classList.add('sav-auto-pick-note');
      list.parentNode.insertBefore(note, list.nextSibling);
    }
    saveDraft();
    revalidateCurrentStep();
  }

  // ----------------- Init -----------------
  restoreDraft();
  autoPickSingleOrder();
  showStep(current);

  // Restaure les pièces jointes depuis IndexedDB
  idbGetAllFiles().then(function (rows) {
    if (!rows || !rows.length) return;
    var pending = rows.length;
    rows.forEach(function (row) {
      if (!row || !row.file) { if (--pending === 0) { renderFileList(); revalidateCurrentStep(); } return; }
      readPreview(row.file).then(function (preview) {
        var existingIdx = droppedFiles.findIndex(function (f) { return f.kind === row.kind; });
        var entry = { file: row.file, kind: row.kind, preview: preview, progress: 0 };
        if (existingIdx >= 0) droppedFiles[existingIdx] = entry;
        else droppedFiles.push(entry);
        if (--pending === 0) { renderFileList(); revalidateCurrentStep(); }
      });
    });
  });
})();
