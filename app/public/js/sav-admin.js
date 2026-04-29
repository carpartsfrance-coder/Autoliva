/* SAV admin — front unifié pour les pages /admin/sav/*
 *
 * Pages couvertes :
 *   /admin/sav                 → dashboard KPI + chart Chart.js
 *   /admin/sav/tickets         → liste paginée, triable, bulk actions, raccourcis
 *   /admin/sav/tickets/:numero → fiche 2 col + onglets + assignation + WYSIWYG + diag enrichi + fournisseur
 *   /admin/parametres/sav      → settings (SLA per piece, automations)
 *   /admin/parametres/audit    → journal d'audit
 */
(function () {
  'use strict';

  var root = document.querySelector('[data-sav-token]');
  if (!root) return;
  var TOKEN = root.getAttribute('data-sav-token') || '';
  var CURRENT_USER_ID = root.getAttribute('data-current-user-id') || '';
  var H = { 'Authorization': 'Bearer ' + TOKEN, 'Content-Type': 'application/json' };

  function api(path, opts) {
    opts = opts || {};
    opts.headers = Object.assign({}, H, opts.headers || {});
    return fetch('/admin/api/sav' + path, opts).then(function (r) {
      return r.json().then(function (j) { return { ok: r.ok, j: j }; });
    });
  }

  function toast(msg, type) {
    var rootEl = document.getElementById('sav-toast-root');
    if (!rootEl) {
      // Si pas de root toast (pages list/dashboard), on crée à la volée
      rootEl = document.createElement('div');
      rootEl.id = 'sav-toast-root';
      rootEl.className = 'sav-toast-root';
      document.body.appendChild(rootEl);
    }
    var el = document.createElement('div');
    el.className = 'sav-toast sav-toast--' + (type || 'success');
    el.setAttribute('role', type === 'error' ? 'alert' : 'status');
    el.innerHTML = '<span class="material-symbols-outlined">' + (type === 'error' ? 'error' : 'check_circle') + '</span><span>' + msg + '</span>';
    rootEl.appendChild(el);
    requestAnimationFrame(function () { el.classList.add('sav-toast--visible'); });
    setTimeout(function () { el.classList.remove('sav-toast--visible'); setTimeout(function () { el.remove(); }, 250); }, 4000);
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  // -------- Modal a11y utilities (focus trap + Esc + restore focus) --------
  var FOCUSABLE_SELECTOR = 'a[href],area[href],button:not([disabled]),input:not([disabled]):not([type="hidden"]),select:not([disabled]),textarea:not([disabled]),iframe,object,embed,[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
  var modalStack = [];

  function getFocusable(el) {
    return Array.prototype.slice
      .call(el.querySelectorAll(FOCUSABLE_SELECTOR))
      .filter(function (n) {
        return !n.hasAttribute('disabled') && n.offsetParent !== null;
      });
  }

  function openModal(el) {
    if (!el || !el.classList.contains('hidden') === false && el.__savModalOpen) return;
    var prev = document.activeElement;
    el.classList.remove('hidden');
    el.classList.add('flex');
    el.__savModalOpen = true;
    el.__savPrevFocus = prev;

    var nodes = getFocusable(el);
    var first = nodes[0] || el;
    try { first.focus(); } catch (_) {}

    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); closeModal(el); return; }
      if (e.key !== 'Tab') return;
      var f = getFocusable(el);
      if (!f.length) { e.preventDefault(); return; }
      var firstN = f[0]; var lastN = f[f.length - 1];
      var active = document.activeElement;
      if (e.shiftKey) {
        if (active === firstN || !el.contains(active)) { e.preventDefault(); lastN.focus(); }
      } else {
        if (active === lastN) { e.preventDefault(); firstN.focus(); }
      }
    }
    el.__savModalKey = onKey;
    document.addEventListener('keydown', onKey, true);
    modalStack.push(el);
  }

  function closeModal(el) {
    if (!el || !el.__savModalOpen) {
      // Fallback : juste cacher
      if (el) { el.classList.add('hidden'); el.classList.remove('flex'); }
      return;
    }
    el.classList.add('hidden');
    el.classList.remove('flex');
    el.__savModalOpen = false;
    if (el.__savModalKey) {
      document.removeEventListener('keydown', el.__savModalKey, true);
      el.__savModalKey = null;
    }
    var i = modalStack.indexOf(el);
    if (i !== -1) modalStack.splice(i, 1);
    var prev = el.__savPrevFocus;
    if (prev && typeof prev.focus === 'function') {
      try { prev.focus(); } catch (_) {}
    }
    el.__savPrevFocus = null;
  }
  window.openModal = openModal;
  window.closeModal = closeModal;

  function fmtSize(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return n + ' o';
    if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' Ko';
    return (n / (1024 * 1024)).toFixed(2) + ' Mo';
  }

  function fmtDuration(ms) {
    if (ms < 0) return 'dépassé';
    var d = Math.floor(ms / (24 * 3600 * 1000));
    var h = Math.floor((ms % (24 * 3600 * 1000)) / (3600 * 1000));
    if (d > 0) return d + 'j ' + h + 'h restantes';
    var m = Math.floor((ms % (3600 * 1000)) / 60000);
    return h + 'h ' + m + 'min restantes';
  }

  function fmtRelative(date) {
    if (!date) return '';
    var diff = Date.now() - new Date(date).getTime();
    if (diff < 0) return 'à l\'instant';
    var s = Math.floor(diff / 1000);
    if (s < 60) return 'à l\'instant';
    var m = Math.floor(s / 60);
    if (m < 60) return 'il y a ' + m + ' min';
    var h = Math.floor(m / 60);
    if (h < 24) return 'il y a ' + h + ' h';
    var d = Math.floor(h / 24);
    if (d < 30) return 'il y a ' + d + ' j';
    var mo = Math.floor(d / 30);
    if (mo < 12) return 'il y a ' + mo + ' mois';
    return 'il y a ' + Math.floor(mo / 12) + ' an' + (mo >= 24 ? 's' : '');
  }

  function initials(name) {
    if (!name) return '?';
    var parts = String(name).trim().split(/\s+/);
    return ((parts[0] || '')[0] || '' + (parts[1] || '')[0] || '').toUpperCase().slice(0, 2) || '?';
  }

  // Couleurs par type de pièce (badges)
  var PIECE_COLORS = {
    mecatronique_dq200: 'bg-sky-100 text-sky-800',
    mecatronique_dq250: 'bg-blue-100 text-blue-800',
    mecatronique_dq381: 'bg-indigo-100 text-indigo-800',
    mecatronique_dq500: 'bg-violet-100 text-violet-800',
    boite_transfert: 'bg-orange-100 text-orange-800',
    pont: 'bg-amber-100 text-amber-800',
    differentiel: 'bg-yellow-100 text-yellow-800',
    haldex: 'bg-emerald-100 text-emerald-800',
    reducteur: 'bg-teal-100 text-teal-800',
    cardan: 'bg-rose-100 text-rose-800',
    autre: 'bg-slate-100 text-slate-700',
  };
  var LBL = (window.SAV_LABELS || {});
  function labelStatut(s) { return (LBL.statutLabel && LBL.statutLabel(s)) || s || '—'; }
  function labelPiece(t)  { return (LBL.pieceLabel  && LBL.pieceLabel(t))  || t || '—'; }
  var MOTIF_LABELS = {
    piece_defectueuse: 'Pièce défectueuse', colis_abime: 'Colis abîmé', colis_non_recu: 'Colis non reçu',
    retard_livraison: 'Retard livraison', erreur_preparation: 'Erreur préparation', retractation: 'Rétractation 14j',
    non_compatible: 'Non compatible', facture_document: 'Facture / document', remboursement: 'Remboursement', autre: 'Autre',
  };
  function labelMotif(m) { return MOTIF_LABELS[m] || m || '—'; }
  function classStatut(s) { return (LBL.statutClass && LBL.statutClass(s)) || 'bg-slate-100 text-slate-700'; }
  function pieceBadge(t) {
    var cls = PIECE_COLORS[t] || PIECE_COLORS.autre;
    return '<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold ' + cls + '">' + escapeHtml(labelPiece(t)) + '</span>';
  }
  function statutBadge(s) {
    return '<span class="px-2 py-0.5 rounded-full text-[11px] font-semibold ' + classStatut(s) + '">' + escapeHtml(labelStatut(s)) + '</span>';
  }

  function avatar(name) {
    var n = (name || '').trim();
    if (!n) return '<span class="inline-flex w-6 h-6 rounded-full bg-slate-200 text-slate-400 items-center justify-center text-[10px]">·</span>';
    var initials = n.split(/\s+/).map(function (p) { return p[0]; }).join('').slice(0, 2).toUpperCase();
    var hue = 0;
    for (var i = 0; i < n.length; i++) hue = (hue + n.charCodeAt(i)) % 360;
    return '<span class="inline-flex w-6 h-6 rounded-full text-white items-center justify-center text-[10px] font-bold" style="background: hsl(' + hue + ',55%,45%)">' + initials + '</span>';
  }

  // slaState — cls progressive selon % de temps écoulé du SLA (vert > 50%, orange 10-50%, rouge < 10% ou dépassé)
  // opts : { dateOuverture } pour calcul %
  function slaState(d, opts) {
    if (!d) return { cls: 'ok', label: '—', tooltip: 'SLA non défini', remainingMs: null, pct: null };
    var limite = new Date(d).getTime();
    var now = Date.now();
    var diff = limite - now;
    var start = (opts && opts.dateOuverture) ? new Date(opts.dateOuverture).getTime() : null;
    var total = start ? (limite - start) : null;
    var pct = (total && total > 0) ? Math.max(0, Math.min(100, Math.round((diff / total) * 100))) : null;
    var tooltipBase = 'SLA calculé sur jours ouvrés (lun–ven), hors week-ends.\n';
    if (start) tooltipBase += 'Ouvert : ' + new Date(start).toLocaleString('fr-FR') + '\n';
    tooltipBase += 'Échéance : ' + new Date(limite).toLocaleString('fr-FR');

    if (diff < 0) {
      var daysLate = Math.ceil(-diff / (24 * 3600 * 1000));
      return { cls: 'late', label: 'Dépassé ' + daysLate + 'j', tooltip: tooltipBase, remainingMs: diff, pct: 0 };
    }
    // Progressive : warn si <50% restant ou <24h, late si <10%
    var cls = 'ok';
    if (pct != null && pct < 10) cls = 'late';
    else if (pct != null && pct < 50) cls = 'warn';
    else if (diff < 24 * 3600 * 1000) cls = 'warn';

    var label;
    if (diff < 60 * 60 * 1000) {
      // < 1h : précision à la minute
      var mins = Math.max(1, Math.floor(diff / (60 * 1000)));
      label = mins + ' min';
      cls = 'late';
    } else if (diff < 24 * 3600 * 1000) {
      var h = Math.max(1, Math.floor(diff / (3600 * 1000)));
      label = h + 'h';
    } else {
      var days = Math.round(diff / (24 * 3600 * 1000));
      label = days + 'j';
    }
    return { cls: cls, label: label, tooltip: tooltipBase, remainingMs: diff, pct: pct };
  }

  // Tick live des badges SLA — relit l'attribut data-sla-deadline et regénère le label / la classe
  // Activable sur n'importe quel élément avec [data-sla-deadline] (ISO date) et optionnellement [data-sla-start]
  function tickSlaBadges() {
    document.querySelectorAll('[data-sla-deadline]').forEach(function (el) {
      var d = el.getAttribute('data-sla-deadline');
      if (!d) return;
      var s = el.getAttribute('data-sla-start') || null;
      var st = slaState(d, { dateOuverture: s });
      // Conserve les classes non-sla, remplace seulement sav-sla-badge--*
      el.className = el.className.replace(/sav-sla-badge--(ok|warn|late)/g, '').trim() + ' sav-sla-badge--' + st.cls;
      el.textContent = st.label;
      if (st.tooltip) el.setAttribute('title', st.tooltip);
    });
  }
  // Démarre un tick toutes les 30s globalement (fait sans bruit, no-op si pas de badges)
  setInterval(tickSlaBadges, 30000);

  // ============================================================
  // DASHBOARD
  // ============================================================
  if (document.getElementById('sav-kpi-grid')) {
    var qs = CURRENT_USER_ID ? '?userId=' + encodeURIComponent(CURRENT_USER_ID) : '';
    api('/dashboard' + qs).then(function (res) {
      if (!res.ok || !res.j.success) {
        var err = document.getElementById('sav-dashboard-error');
        if (err) { err.textContent = res.j.error || 'Erreur de chargement.'; err.classList.remove('hidden'); }
        return;
      }
      var d = res.j.data;
      document.querySelectorAll('[data-kpi]').forEach(function (card) {
        var k = card.getAttribute('data-kpi');
        var v = d[k];
        if (v == null) v = 0;
        var money = card.getAttribute('data-kpi-money') === '1';
        var pct = card.getAttribute('data-kpi-pct') === '1';
        var unit = card.getAttribute('data-kpi-unit') || '';
        var display = String(v);
        if (money) display = Number(v).toLocaleString('fr-FR') + ' €';
        else if (pct) display = v + ' %';
        else if (unit) display = v + ' ' + unit;
        var el = card.querySelector('[data-kpi-value]');
        if (el) el.textContent = display;
      });

      // Click → liste filtrée
      document.querySelectorAll('[data-kpi]').forEach(function (card) {
        card.addEventListener('click', function () {
          var f = card.getAttribute('data-kpi-filter');
          if (f) window.location.href = '/admin/sav/tickets' + f;
        });
      });

      // Chart.js — attend que la lib soit chargée si elle ne l'est pas encore
      if (d.chart) {
        var ctx = document.getElementById('sav-chart');
        if (ctx) {
          var renderChart = function () {
            try {
              new window.Chart(ctx, {
                type: 'line',
                data: {
                  labels: d.chart.labels,
                  datasets: [
                    {
                      label: 'Ouverts',
                      data: d.chart.ouverts,
                      borderColor: '#0ea5e9',
                      backgroundColor: 'rgba(14,165,233,0.10)',
                      tension: 0.3,
                      fill: true,
                    },
                    {
                      label: 'Clos',
                      data: d.chart.clos,
                      borderColor: '#10b981',
                      backgroundColor: 'rgba(16,185,129,0.10)',
                      tension: 0.3,
                      fill: true,
                    },
                  ],
                },
                options: {
                  responsive: true,
                  plugins: { legend: { display: false } },
                  scales: { y: { beginAtZero: true, ticks: { precision: 0 } } },
                },
              });
            } catch (e) {
              console.error('[sav-dashboard] Chart render failed:', e);
            }
          };
          if (window.Chart) {
            renderChart();
          } else {
            // Chart.js pas encore prêt — on poll jusqu'à 5s
            var tries = 0;
            var iv = setInterval(function () {
              tries++;
              if (window.Chart) { clearInterval(iv); renderChart(); }
              else if (tries > 50) {
                clearInterval(iv);
                console.error('[sav-dashboard] Chart.js non chargé (CDN bloqué ?)');
              }
            }, 100);
          }
        }
      }
    });

    // Liste prioritaire
    api('/tickets?sla_depasse=true&perPage=10').then(function (res) {
      var box = document.getElementById('sav-priority-list');
      if (!box) return;
      if (!res.ok || !res.j.success) { box.innerHTML = '<div class="px-5 py-6 text-sm text-red-700">Erreur de chargement.</div>'; return; }
      var list = res.j.data.tickets || [];
      if (!list.length) { box.innerHTML = '<div class="px-5 py-8 text-center text-sm text-slate-500">Aucun dossier en retard 🎉</div>'; return; }
      box.innerHTML = list.map(function (t) {
        return '<a class="flex items-center justify-between px-5 py-3 hover:bg-slate-50 sav-pulse-row" href="/admin/sav/tickets/' + encodeURIComponent(t.numero) + '">' +
          '<div><div class="font-mono text-sm font-semibold text-slate-900">' + escapeHtml(t.numero) + '</div>' +
          '<div class="text-xs text-slate-500">' + escapeHtml((t.client && t.client.email) || '') + ' · ' + escapeHtml(labelPiece(t.pieceType)) + '</div></div>' +
          '<div class="sav-sla-badge sav-sla-badge--late">en retard</div></a>';
      }).join('');
    });

    // --- KPI Performance SAV (Sprint 3) ---
    function loadPerfKpis(days) {
      var sel = document.getElementById('sav-perf-days');
      var d = days || (sel && sel.value) || 30;
      var win = document.getElementById('sav-perf-window');
      if (win) win.textContent = d + ' jours';
      api('/kpi?days=' + encodeURIComponent(d)).then(function (res) {
        if (!res.ok || !res.j.success) return;
        var k = res.j.data || {};
        var frt = document.getElementById('sav-perf-frt');
        var rt  = document.getElementById('sav-perf-rt');
        var br  = document.getElementById('sav-perf-breach');
        var bk  = document.getElementById('sav-perf-backlog');
        if (frt) frt.textContent = (k.frtHoursMedian != null) ? (Math.round(k.frtHoursMedian) + ' h') : '—';
        if (rt)  rt.textContent  = (k.rtHoursMedian != null)  ? (Math.round(k.rtHoursMedian / 24) + ' j') : '—';
        if (br) {
          var rate = (k.breachRate != null) ? k.breachRate : null;
          br.textContent = (rate != null) ? (rate + ' %') : '—';
          br.classList.remove('text-emerald-600', 'text-amber-600', 'text-red-600', 'text-slate-900');
          if (rate == null) br.classList.add('text-slate-900');
          else if (rate < 10) br.classList.add('text-emerald-600');
          else if (rate < 25) br.classList.add('text-amber-600');
          else br.classList.add('text-red-600');
        }
        if (bk) bk.textContent = (k.totals && k.totals.openNow != null) ? k.totals.openNow : '—';

        // Pyramide d'âges (l'API renvoie backlogAging ; on accepte aussi aging pour compat)
        var aging = document.getElementById('sav-perf-aging');
        var agingData = k.backlogAging || k.aging;
        if (aging && agingData) {
          var order = [['lt1','<1j'],['1-3','1-3j'],['3-7','3-7j'],['7-14','7-14j'],['14plus','>14j']];
          var colors = ['bg-emerald-400','bg-sky-400','bg-amber-400','bg-orange-500','bg-red-500'];
          var max = 0;
          order.forEach(function (o) { if ((agingData[o[0]] || 0) > max) max = agingData[o[0]]; });
          if (max < 1) max = 1;
          aging.innerHTML = order.map(function (o, i) {
            var val = agingData[o[0]] || 0;
            var pct = Math.round((val / max) * 100);
            return '<div class="flex-1 flex flex-col items-center justify-end gap-1">' +
              '<div class="text-[10px] font-bold text-slate-700">' + val + '</div>' +
              '<div class="w-full rounded-t ' + colors[i] + '" style="height:' + pct + '%"></div>' +
              '<div class="text-[9px] text-slate-500">' + o[1] + '</div>' +
              '</div>';
          }).join('');
        }
      });
    }
    if (document.getElementById('sav-perf-kpis')) {
      loadPerfKpis();
      var selDays = document.getElementById('sav-perf-days');
      if (selDays) selDays.addEventListener('change', function () { loadPerfKpis(); });
    }
  }

  // ============================================================
  // LISTE TICKETS (refonte)
  // ============================================================
  if (document.getElementById('sav-tickets-tbody')) {
    var tbody = document.getElementById('sav-tickets-tbody');
    var form = document.getElementById('sav-filters');
    var state = { page: 1, perPage: 20, sort: 'createdAt', dir: 'desc', search: '' };
    var teamCache = [];
    var selected = new Set();

    function buildQs() {
      var fd = new FormData(form);
      var qs = new URLSearchParams();
      // Coalesce multi-values into comma-separated for statut & pieceType
      var multi = { statut: [], pieceType: [] };
      fd.forEach(function (v, k) {
        if (!v || k === 'assignedToMe' || k === 'priority') return;
        if (multi[k]) { multi[k].push(v); return; }
        qs.append(k, v);
      });
      Object.keys(multi).forEach(function (k) {
        if (multi[k].length) qs.set(k, multi[k].join(','));
      });
      qs.append('page', state.page);
      qs.append('perPage', state.perPage);
      // Mode priorité : override le tri
      var priorityOn = fd.get('priority') === 'true';
      if (priorityOn) {
        qs.set('sort', 'priority');
      } else {
        qs.append('sort', state.sort);
        qs.append('dir', state.dir);
      }
      if (fd.get('assignedToMe') === 'true' && CURRENT_USER_ID) qs.append('assignedToUserId', CURRENT_USER_ID);
      return qs;
    }

    function load() {
      tbody.innerHTML = '<tr><td colspan="9" class="px-4 py-10 text-center text-slate-500">Chargement…</td></tr>';
      var qs = buildQs();
      api('/tickets?' + qs.toString()).then(function (res) {
        if (!res.ok || !res.j.success) {
          var err = document.getElementById('sav-tickets-error');
          err.textContent = (res.j && res.j.error) || 'Erreur de chargement.';
          err.classList.remove('hidden');
          tbody.innerHTML = '';
          return;
        }
        var data = res.j.data;
        var list = data.tickets || [];
        if (!list.length) {
          tbody.innerHTML = '<tr><td colspan="10" class="px-4 py-10 text-center text-slate-500">Aucun ticket.</td></tr>';
          updatePagination(data);
          return;
        }
        // Vue cards mobile (rendue en parallèle au tbody desktop)
        var cardsBox = document.getElementById('sav-tickets-cards');
        if (cardsBox) {
          cardsBox.innerHTML = list.map(function (t) {
            var sla2 = slaState(t.sla && t.sla.dateLimite, { dateOuverture: t.sla && t.sla.dateOuverture });
            var v2 = t.vehicule || {};
            var vstr2 = [v2.marque, v2.modele].filter(Boolean).join(' ') + (v2.annee ? ' ' + v2.annee : '');
            return '<a href="/admin/sav/tickets/' + encodeURIComponent(t.numero) + '" class="block p-4 hover:bg-slate-50 ' + (sla2.cls === 'late' ? 'sav-pulse-row' : '') + '">' +
              '<div class="flex items-center justify-between mb-1">' +
                '<span class="font-mono font-bold text-sm">' + escapeHtml(t.numero) + '</span>' +
                '<span class="sav-sla-badge sav-sla-badge--' + sla2.cls + '"' +
                  (t.sla && t.sla.dateLimite ? ' data-sla-deadline="' + escapeHtml(t.sla.dateLimite) + '"' : '') +
                  (t.sla && t.sla.dateOuverture ? ' data-sla-start="' + escapeHtml(t.sla.dateOuverture) + '"' : '') +
                  '>' + sla2.label + '</span>' +
              '</div>' +
              '<div class="text-xs text-slate-700 truncate">' + escapeHtml((t.client && t.client.email) || '') + '</div>' +
              '<div class="mt-1 flex items-center gap-2 flex-wrap">' + pieceBadge(t.pieceType) +
                statutBadge(t.statut) +
              '</div>' +
              (vstr2 ? '<div class="mt-1 text-[11px] text-slate-500">🚗 ' + escapeHtml(vstr2) + (v2.vin ? ' · ' + escapeHtml(v2.vin) : '') + '</div>' : '') +
              (t.assignedToName ? '<div class="mt-1 text-[11px] text-slate-500 flex items-center gap-1">' + avatar(t.assignedToName) + escapeHtml(t.assignedToName) + '</div>' : '') +
              '<div class="mt-1 text-[10px] text-slate-400">' + new Date(t.createdAt).toLocaleDateString('fr-FR') + '</div>' +
            '</a>';
          }).join('') || '<div class="p-6 text-center text-slate-500 text-sm">Aucun ticket.</div>';
        }

        tbody.innerHTML = list.map(function (t, i) {
          var sla = slaState(t.sla && t.sla.dateLimite, { dateOuverture: t.sla && t.sla.dateOuverture });
          var rowPulse = sla.cls === 'late' || (sla.remainingMs != null && sla.remainingMs < 24 * 3600 * 1000) ? 'sav-pulse-row' : '';
          var v = t.vehicule || {};
          var vstr = [v.marque, v.modele].filter(Boolean).join(' ') + (v.annee ? ' ' + v.annee : '');
          var assignHtml = t.assignedToName
            ? '<div class="flex items-center gap-1">' + avatar(t.assignedToName) + '<span class="text-[11px] truncate max-w-[110px]">' + escapeHtml(t.assignedToName) + '</span></div>'
            : '<span class="text-[11px] text-slate-400 italic">Non assigné</span>';
          var awaiting = t.lastClientMessageAt && (!t.lastAdminReadAt || new Date(t.lastClientMessageAt) > new Date(t.lastAdminReadAt));
          var awaitingDot = awaiting ? '<span title="Réponse client en attente" class="inline-block w-2 h-2 rounded-full bg-rose-500 mr-1 align-middle animate-pulse"></span>' : '';
          // Indicateur notes épinglées (couleur max priorité)
          var pinColor = '';
          var pinOrder = ['rose', 'amber', 'blue', 'emerald', 'slate'];
          var pinHexes = { rose: '#e11d48', amber: '#f59e0b', blue: '#2563eb', emerald: '#059669', slate: '#64748b' };
          var pinCount = 0;
          if (t.pinnedNotes && t.pinnedNotes.length) {
            var active = t.pinnedNotes.filter(function (n) { return !n.expiresAt || new Date(n.expiresAt) >= new Date(); });
            pinCount = active.length;
            for (var pi = 0; pi < pinOrder.length && !pinColor; pi++) {
              if (active.some(function (n) { return n.couleur === pinOrder[pi]; })) pinColor = pinHexes[pinOrder[pi]];
            }
          }
          var pinDot = pinCount ? '<span title="' + pinCount + ' note(s) épinglée(s)" class="inline-flex items-center justify-center w-3 h-3 rounded-full mr-1 align-middle text-white text-[8px] font-bold" style="background:' + pinColor + '">' + (pinCount > 1 ? pinCount : '') + '</span>' : '';
          // Badge motif SAV
          var MOTIF_LABELS = {
            piece_defectueuse: { icon: '🔧', label: 'Pièce déf.', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
            retard_livraison:  { icon: '🚚', label: 'Retard',     cls: 'bg-amber-50 text-amber-700 border-amber-200' },
            colis_abime:       { icon: '📦', label: 'Abîmé',      cls: 'bg-orange-50 text-orange-700 border-orange-200' },
            colis_non_recu:    { icon: '📭', label: 'Non reçu',   cls: 'bg-amber-50 text-amber-700 border-amber-200' },
            erreur_preparation:{ icon: '🔀', label: 'Erreur prép',cls: 'bg-purple-50 text-purple-700 border-purple-200' },
            retractation:      { icon: '↩️', label: 'Rétract.',   cls: 'bg-blue-50 text-blue-700 border-blue-200' },
            non_compatible:    { icon: '❌', label: 'Non compat', cls: 'bg-slate-50 text-slate-700 border-slate-200' },
            facture_document:  { icon: '📄', label: 'Facture',    cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
            remboursement:     { icon: '💳', label: 'Rembours.',  cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
            autre:             { icon: '❓', label: 'Autre',      cls: 'bg-slate-50 text-slate-700 border-slate-200' },
          };
          var mInfo = MOTIF_LABELS[t.motifSav] || MOTIF_LABELS.piece_defectueuse;
          var motifBadge = '<span class="inline-flex items-center gap-0.5 px-1.5 py-0.5 rounded border text-[10px] font-medium ' + mInfo.cls + '" title="' + escapeHtml(t.motifSav || '') + '">' + mInfo.icon + ' ' + mInfo.label + '</span>';
          return '<tr class="hover:bg-slate-50 cursor-pointer ' + rowPulse + '" data-row="' + i + '" data-numero="' + escapeHtml(t.numero) + '">' +
            '<td class="px-3 py-2 sav-col-sticky-l"><input type="checkbox" class="rounded sav-row-cb" data-numero="' + escapeHtml(t.numero) + '" ' + (selected.has(t.numero) ? 'checked' : '') + '></td>' +
            '<td class="px-3 py-2 font-mono text-xs font-semibold sav-col-sticky-l2">' + pinDot + awaitingDot + escapeHtml(t.numero) + '</td>' +
            '<td class="px-3 py-2"><div class="text-xs font-medium">' + escapeHtml((t.client && t.client.nom) || '') + '</div><div class="text-[10px] text-slate-500">' + escapeHtml((t.client && t.client.email) || '') + '</div></td>' +
            '<td class="px-3 py-2"><div class="flex flex-col gap-0.5">' + motifBadge + (t.pieceType ? pieceBadge(t.pieceType) : '') + '</div></td>' +
            '<td class="px-3 py-2 text-xs">' + (vstr ? escapeHtml(vstr) : '<span class="text-slate-400">—</span>') + (v.vin ? '<div class="text-[10px] font-mono text-slate-400">' + escapeHtml(v.vin) + '</div>' : '') + '</td>' +
            '<td class="px-3 py-2">' + assignHtml + '</td>' +
            '<td class="px-3 py-2 sav-col-sticky-r2">' + statutBadge(t.statut) + '</td>' +
            '<td class="px-3 py-2 sav-col-sticky-r"><span class="sav-sla-badge sav-sla-badge--' + sla.cls + '" title="' + escapeHtml(sla.tooltip || '') + '"' +
              (t.sla && t.sla.dateLimite ? ' data-sla-deadline="' + escapeHtml(t.sla.dateLimite) + '"' : '') +
              (t.sla && t.sla.dateOuverture ? ' data-sla-start="' + escapeHtml(t.sla.dateOuverture) + '"' : '') +
              '>' + sla.label + '</span></td>' +
            '<td class="px-3 py-2 text-xs text-slate-500">' + new Date(t.createdAt).toLocaleDateString('fr-FR') + '</td>' +
            '<td class="px-3 py-2 text-right">' +
              '<button type="button" class="sav-row-delete inline-flex items-center justify-center w-8 h-8 rounded-lg hover:bg-red-50 text-red-500" data-numero="' + escapeHtml(t.numero) + '" title="Supprimer le ticket ' + escapeHtml(t.numero) + '">' +
                '<span class="material-symbols-outlined text-base">delete</span>' +
              '</button>' +
            '</td>' +
          '</tr>';
        }).join('');
        updatePagination(data);
        bindRows();
        updateSortIcons();
      });
    }

    function updatePagination(data) {
      document.getElementById('sav-pagination-info').textContent = (data.total || 0) + ' ticket(s) au total';
      document.getElementById('sav-page-current').textContent = data.page || 1;
      document.getElementById('sav-page-total').textContent = data.totalPages || 1;
      document.getElementById('sav-page-prev').disabled = (data.page || 1) <= 1;
      document.getElementById('sav-page-next').disabled = (data.page || 1) >= (data.totalPages || 1);
    }

    function updateSortIcons() {
      document.querySelectorAll('[data-sort]').forEach(function (h) {
        var k = h.getAttribute('data-sort');
        var icon = h.querySelector('[data-sort-icon]');
        if (!icon) return;
        if (state.sort === k) icon.textContent = state.dir === 'asc' ? '▲' : '▼';
        else icon.textContent = '⇅';
      });
    }

    var rowIdx = -1;
    function bindRows() {
      var rows = tbody.querySelectorAll('[data-row]');
      rows.forEach(function (r) {
        r.addEventListener('click', function (e) {
          if (e.target.matches('.sav-row-cb')) return;
          window.location.href = '/admin/sav/tickets/' + encodeURIComponent(r.getAttribute('data-numero'));
        });
      });
      tbody.querySelectorAll('.sav-row-cb').forEach(function (cb) {
        cb.addEventListener('click', function (e) {
          e.stopPropagation();
          var n = cb.getAttribute('data-numero');
          if (cb.checked) selected.add(n); else selected.delete(n);
          updateBulkBar();
        });
      });
      tbody.querySelectorAll('.sav-row-delete').forEach(function (btn) {
        btn.addEventListener('click', function (e) {
          e.stopPropagation();
          var n = btn.getAttribute('data-numero');
          if (!n) return;
          if (!confirm('Supprimer définitivement le ticket ' + n + ' ? Cette action est irréversible.')) return;
          btn.disabled = true;
          api('/tickets/' + encodeURIComponent(n), { method: 'DELETE' }).then(function (res) {
            if (!res.ok || !res.j || !res.j.success) {
              btn.disabled = false;
              toast((res.j && res.j.error) || 'Suppression échouée', 'error');
              return;
            }
            selected.delete(n);
            var row = btn.closest('tr');
            if (row && row.parentNode) row.parentNode.removeChild(row);
            updateBulkBar();
            toast('Ticket ' + n + ' supprimé', 'success');
          });
        });
      });
    }

    function updateBulkBar() {
      var bar = document.getElementById('sav-bulk-bar');
      var c = document.getElementById('sav-bulk-count');
      if (!bar) return;
      bar.classList.toggle('hidden', selected.size === 0);
      bar.classList.toggle('flex', selected.size > 0);
      if (c) c.textContent = String(selected.size);
    }

    // Tri
    document.querySelectorAll('[data-sort]').forEach(function (h) {
      h.addEventListener('click', function () {
        var k = h.getAttribute('data-sort');
        if (state.sort === k) state.dir = state.dir === 'asc' ? 'desc' : 'asc';
        else { state.sort = k; state.dir = 'asc'; }
        state.page = 1; load();
      });
    });

    // Pagination
    document.getElementById('sav-page-prev').addEventListener('click', function () { if (state.page > 1) { state.page--; load(); } });
    document.getElementById('sav-page-next').addEventListener('click', function () { state.page++; load(); });

    // Sélection globale
    var allCb = document.getElementById('sav-bulk-all');
    if (allCb) allCb.addEventListener('change', function () {
      tbody.querySelectorAll('.sav-row-cb').forEach(function (cb) {
        cb.checked = allCb.checked;
        var n = cb.getAttribute('data-numero');
        if (allCb.checked) selected.add(n); else selected.delete(n);
      });
      updateBulkBar();
    });

    // Bulk actions
    document.getElementById('sav-bulk-statut-apply').addEventListener('click', function () {
      var st = document.getElementById('sav-bulk-statut').value;
      if (!st || !selected.size) return;
      if (!confirm('Passer ' + selected.size + ' ticket(s) au statut "' + st + '" ?')) return;
      var arr = Array.from(selected);
      Promise.all(arr.map(function (n) {
        return api('/tickets/' + encodeURIComponent(n) + '/statut', { method: 'PATCH', body: JSON.stringify({ statut: st, auteur: 'admin' }) });
      })).then(function () {
        toast(arr.length + ' tickets mis à jour', 'success');
        selected.clear(); updateBulkBar(); load();
      });
    });
    document.getElementById('sav-bulk-assign-apply').addEventListener('click', function () {
      var uid = document.getElementById('sav-bulk-assign').value;
      if (!uid || !selected.size) return;
      var arr = Array.from(selected);
      Promise.all(arr.map(function (n) {
        return api('/tickets/' + encodeURIComponent(n) + '/assign', { method: 'POST', body: JSON.stringify({ userId: uid }) });
      })).then(function () { toast('Assignations OK', 'success'); selected.clear(); updateBulkBar(); load(); });
    });
    document.getElementById('sav-bulk-export').addEventListener('click', function () {
      // Export = juste un CSV des sélectionnés (en pratique on filtre côté csv)
      window.open('/admin/api/sav/tickets.csv?' + buildQs().toString(), '_blank');
    });
    var bulkDeleteBtn = document.getElementById('sav-bulk-delete');
    if (bulkDeleteBtn) bulkDeleteBtn.addEventListener('click', function () {
      if (!selected.size) return;
      if (!confirm('Supprimer définitivement ' + selected.size + ' ticket(s) ? Cette action est irréversible.')) return;
      var arr = Array.from(selected);
      bulkDeleteBtn.disabled = true;
      api('/tickets/bulk-delete', { method: 'POST', body: JSON.stringify({ numeros: arr }) }).then(function (res) {
        bulkDeleteBtn.disabled = false;
        if (!res.ok || !res.j || !res.j.success) {
          toast((res.j && res.j.error) || 'Suppression échouée', 'error');
          return;
        }
        var deleted = (res.j.data && res.j.data.deletedNumeros) || arr;
        deleted.forEach(function (n) {
          selected.delete(n);
          var row = tbody.querySelector('tr[data-numero="' + n.replace(/"/g, '\\"') + '"]');
          if (row && row.parentNode) row.parentNode.removeChild(row);
        });
        updateBulkBar();
        toast(((res.j.data && res.j.data.deletedCount) || deleted.length) + ' ticket(s) supprimé(s)', 'success');
      });
    });

    // Recherche debounce + suggestions (locale, basée sur l'API)
    var searchInput = document.getElementById('sav-search');
    var searchTimer;
    if (searchInput) searchInput.addEventListener('input', function () {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(function () {
        state.page = 1;
        load();
      }, 250);
    });

    form.addEventListener('submit', function (e) { e.preventDefault(); state.page = 1; load(); });
    form.addEventListener('change', function () { state.page = 1; load(); });

    // CSV export
    var csvBtn = document.getElementById('sav-export-csv');
    if (csvBtn) csvBtn.addEventListener('click', function (e) {
      e.preventDefault();
      window.open('/admin/api/sav/tickets.csv?' + buildQs().toString(), '_blank');
    });

    // Charge équipe pour bulk assign + filtre assigné
    api('/team').then(function (res) {
      if (!res.ok || !res.j.success) return;
      teamCache = res.j.data.users || [];
      var ba = document.getElementById('sav-bulk-assign');
      if (ba) {
        ba.innerHTML = '<option value="">— Assigner à —</option>' +
          teamCache.map(function (u) { return '<option value="' + u._id + '">' + escapeHtml((u.firstName || '') + ' ' + (u.lastName || '')) + '</option>'; }).join('');
      }
      var fa = document.getElementById('sav-filter-assignee');
      if (fa) {
        var current = fa.value;
        fa.innerHTML = '<option value="">Assigné : tous</option>' +
          '<option value="__none__">Non assigné</option>' +
          teamCache.map(function (u) { return '<option value="' + u._id + '">' + escapeHtml((u.firstName || '') + ' ' + (u.lastName || '')) + '</option>'; }).join('');
        fa.value = current;
      }
    });

    // Vue Table / Kanban toggle
    var viewMode = 'table';
    var btnTable = document.getElementById('sav-view-table');
    var btnKanban = document.getElementById('sav-view-kanban');
    var tableBox = document.querySelector('.sav-table-scroll');
    var kanbanBox = document.getElementById('sav-kanban');
    function applyView() {
      var isKan = viewMode === 'kanban';
      if (tableBox) tableBox.classList.toggle('hidden', isKan);
      if (kanbanBox) kanbanBox.classList.toggle('hidden', !isKan);
      if (btnTable) {
        btnTable.className = 'px-3 py-1.5 font-semibold ' + (!isKan ? 'bg-primary text-white' : 'text-slate-700 hover:bg-slate-50');
      }
      if (btnKanban) {
        btnKanban.className = 'px-3 py-1.5 font-semibold ' + (isKan ? 'bg-primary text-white' : 'text-slate-700 hover:bg-slate-50');
      }
      if (isKan) loadKanban();
    }
    if (btnTable) btnTable.addEventListener('click', function () { viewMode = 'table'; applyView(); });
    if (btnKanban) btnKanban.addEventListener('click', function () { viewMode = 'kanban'; applyView(); });

    function loadKanban() {
      var host = document.getElementById('sav-kanban-columns');
      if (!host) return;
      host.innerHTML = '<div class="text-slate-500 text-sm p-4">Chargement…</div>';
      var qs = buildQs();
      qs.set('perPage', '200');
      api('/tickets?' + qs.toString()).then(function (res) {
        if (!res.ok || !res.j.success) { host.innerHTML = '<div class="text-red-600 text-sm p-4">Erreur de chargement.</div>'; return; }
        var list = (res.j.data && res.j.data.tickets) || [];
        var cols = (window.SAV_LABELS && window.SAV_LABELS.KANBAN_COLUMNS) || [];
        host.innerHTML = cols.map(function (col) {
          var tickets = list.filter(function (t) { return col.statuts.indexOf(t.statut) !== -1; });
          var cards = tickets.map(function (t) {
            var sla2 = slaState(t.sla && t.sla.dateLimite, { dateOuverture: t.sla && t.sla.dateOuverture });
            var pulse = sla2.cls === 'late' ? 'sav-pulse-row' : '';
            return '<a href="/admin/sav/tickets/' + encodeURIComponent(t.numero) + '" class="block rounded-xl border border-slate-200 bg-white hover:border-primary hover:shadow-sm p-3 text-xs ' + pulse + '">' +
              '<div class="flex items-center justify-between gap-1 mb-1"><span class="font-mono font-bold text-[11px]">' + escapeHtml(t.numero) + '</span>' +
              '<span class="sav-sla-badge sav-sla-badge--' + sla2.cls + '">' + sla2.label + '</span></div>' +
              '<div class="truncate font-medium">' + escapeHtml((t.client && t.client.nom) || (t.client && t.client.email) || '—') + '</div>' +
              '<div class="mt-1">' + pieceBadge(t.pieceType) + '</div>' +
              (t.assignedToName ? '<div class="mt-1 flex items-center gap-1 text-slate-500">' + avatar(t.assignedToName) + '<span>' + escapeHtml(t.assignedToName) + '</span></div>' : '<div class="mt-1 text-slate-400 italic">Non assigné</div>') +
            '</a>';
          }).join('') || '<div class="text-[11px] text-slate-400 italic px-1">Vide</div>';
          return '<div class="flex-shrink-0 w-64 rounded-2xl bg-slate-50 border border-slate-200 p-3">' +
            '<div class="flex items-center justify-between mb-2"><h3 class="text-xs font-bold uppercase tracking-wide text-slate-700">' + escapeHtml(col.label) + '</h3><span class="text-[10px] bg-white border border-slate-200 rounded-full px-2 py-0.5 font-semibold">' + tickets.length + '</span></div>' +
            '<div class="space-y-2">' + cards + '</div>' +
          '</div>';
        }).join('');
      });
    }

    // Raccourcis clavier
    var kbdModal = document.getElementById('sav-kbd-modal');
    function openKbd() { if (kbdModal) openModal(kbdModal); }
    function closeKbd() { if (kbdModal) closeModal(kbdModal); }
    if (kbdModal) kbdModal.addEventListener('click', function (e) { if (e.target === kbdModal || (e.target.matches && e.target.matches('[data-close-kbd]'))) closeKbd(); });

    document.addEventListener('keydown', function (e) {
      if (e.target.matches('input,textarea,select')) {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      var rows = tbody.querySelectorAll('[data-row]');
      if (e.key === '/') { e.preventDefault(); searchInput && searchInput.focus(); return; }
      if (e.key === '?' || (e.shiftKey && e.key === '/')) { e.preventDefault(); openKbd(); return; }
      if (e.key === 'Escape') { closeKbd(); return; }
      if (!rows.length) return;
      if (e.key === 'j') { rowIdx = Math.min(rowIdx + 1, rows.length - 1); }
      else if (e.key === 'k') { rowIdx = Math.max(rowIdx - 1, 0); }
      else if (e.key === 'Enter' && rowIdx >= 0) {
        window.location.href = '/admin/sav/tickets/' + encodeURIComponent(rows[rowIdx].getAttribute('data-numero'));
        return;
      } else if (e.key === 'x' && rowIdx >= 0) {
        var cb = rows[rowIdx].querySelector('.sav-row-cb');
        if (cb) { cb.checked = !cb.checked; cb.dispatchEvent(new Event('click', { bubbles: true })); }
        return;
      } else { return; }
      rows.forEach(function (r, i) { r.classList.toggle('bg-primary/10', i === rowIdx); });
      rows[rowIdx].scrollIntoView({ block: 'nearest' });
    });

    // -------- Multi-select custom --------
    document.querySelectorAll('[data-multiselect]').forEach(function (ms) {
      var btn = ms.querySelector('.sav-multiselect__btn');
      var dd = ms.querySelector('.sav-multiselect__dropdown');
      var labelEl = ms.querySelector('.sav-multiselect__label');
      var countEl = ms.querySelector('[data-multi-count]');
      var baseLabel = labelEl.textContent;
      function updateLabel() {
        var n = dd.querySelectorAll('input:checked').length;
        if (n === 0) {
          labelEl.textContent = baseLabel;
          countEl.classList.add('hidden');
        } else if (n === 1) {
          var only = dd.querySelector('input:checked');
          labelEl.textContent = only.parentElement.querySelector('span').textContent;
          countEl.classList.add('hidden');
        } else {
          labelEl.textContent = baseLabel;
          countEl.textContent = n;
          countEl.classList.remove('hidden');
        }
      }
      btn.addEventListener('click', function (e) {
        e.stopPropagation();
        var open = !dd.classList.contains('hidden');
        document.querySelectorAll('.sav-multiselect__dropdown').forEach(function (d) { d.classList.add('hidden'); });
        if (!open) { dd.classList.remove('hidden'); btn.setAttribute('aria-expanded', 'true'); }
        else btn.setAttribute('aria-expanded', 'false');
      });
      dd.addEventListener('click', function (e) { e.stopPropagation(); });
      dd.querySelectorAll('input').forEach(function (input) {
        input.addEventListener('change', function () {
          updateLabel();
          state.page = 1; load();
        });
      });
      updateLabel();
    });
    document.addEventListener('click', function () {
      document.querySelectorAll('.sav-multiselect__dropdown').forEach(function (d) { d.classList.add('hidden'); });
      document.querySelectorAll('.sav-multiselect__btn').forEach(function (b) { b.setAttribute('aria-expanded', 'false'); });
    });

    // -------- Page size selector --------
    var pageSizeSel = document.getElementById('sav-page-size');
    if (pageSizeSel) {
      pageSizeSel.value = String(state.perPage);
      pageSizeSel.addEventListener('change', function () {
        state.perPage = parseInt(pageSizeSel.value, 10) || 20;
        state.page = 1;
        load();
      });
    }

    // -------- Mini KPIs tête de liste --------
    function loadMiniKpis() {
      api('/dashboard').then(function (res) {
        if (!res.ok || !res.j.success) return;
        var d = res.j.data || {};
        function setV(key, val) {
          var el = document.querySelector('[data-mini-kpi="' + key + '"]');
          if (el) el.textContent = val == null ? '0' : String(val);
        }
        setV('total', d.total || 0);
        setV('ouverts', d.ouverts || 0);
        setV('attenteClient', d.enAttenteClient || d.enAttenteDoc || 0);
        setV('attenteFournisseur', d.enAttenteFournisseur || 0);
        setV('slaDepasse', d.slaDepasse || d.sla_depasse || 0);
        setV('awaitingClient', d.awaiting_client || 0);
        var bt = d.by_team || {};
        setV('teamAtelier', bt.atelier || 0);
        setV('teamLogistique', bt.logistique || 0);
        setV('teamCommercial', bt.commercial || 0);
        setV('teamCompta', bt.compta || 0);
        setV('teamGeneral', bt.sav_general || 0);
      });
    }
    loadMiniKpis();
    document.querySelectorAll('[data-mini-kpi-filter]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var f = btn.getAttribute('data-mini-kpi-filter') || '';
        // Parse & apply to form
        form.reset();
        // clear checked state in multi-selects
        document.querySelectorAll('[data-multiselect] input:checked').forEach(function (cb) { cb.checked = false; });
        if (f) {
          var params = new URLSearchParams(f);
          params.forEach(function (v, k) {
            if (k === 'statut') {
              v.split(',').forEach(function (val) {
                var cb = document.querySelector('[data-multiselect="statut"] input[value="' + val + '"]');
                if (cb) cb.checked = true;
              });
            } else {
              var el = form.querySelector('[name="' + k + '"]');
              if (el) { if (el.type === 'checkbox') el.checked = v === 'true'; else el.value = v; }
            }
          });
        }
        // Refresh labels of multi-selects
        document.querySelectorAll('[data-multiselect]').forEach(function (ms) {
          var evt = new Event('change', { bubbles: true });
          var cb = ms.querySelector('input'); if (cb) cb.dispatchEvent(evt);
        });
        state.page = 1; load();
      });
    });

    // -------- Nouveau ticket modal --------
    var newBtn = document.getElementById('sav-new-ticket-btn');
    var newModal = document.getElementById('sav-new-ticket-modal');
    var newForm = document.getElementById('sav-new-ticket-form');
    if (newBtn && newModal) {
      newBtn.addEventListener('click', function () { openModal(newModal); });
      newModal.addEventListener('click', function (e) {
        if (e.target === newModal || (e.target.matches && e.target.matches('[data-close-new-ticket]'))) closeModal(newModal);
      });
      if (newForm) newForm.addEventListener('submit', function (e) {
        e.preventDefault();
        var fd = new FormData(newForm);
        var body = { client: {}, vehicule: {} };
        fd.forEach(function (v, k) {
          if (!v) return;
          if (k.indexOf('client.') === 0) body.client[k.slice(7)] = v;
          else if (k.indexOf('vehicule.') === 0) body.vehicule[k.slice(9)] = v;
          else body[k] = v;
        });
        api('/tickets', { method: 'POST', body: JSON.stringify(body) }).then(function (res) {
          if (res.ok && res.j.success) {
            toast('Ticket ' + res.j.data.numero + ' créé', 'success');
            closeModal(newModal);
            newForm.reset();
            load();
            loadMiniKpis();
          } else toast((res.j && res.j.error) || 'Erreur', 'error');
        });
      });
    }

    load();
  }

  // ============================================================
  // FICHE TICKET — refonte 2 col + tabs + assignation + WYSIWYG + diag enrichi + fournisseur
  // ============================================================
  var detailEl = document.querySelector('[data-sav-numero]');
  if (detailEl) {
    var numero = detailEl.getAttribute('data-sav-numero');
    var ticket = null;
    var teamUsers = [];

    function renderRefundPanel() {
      var st = document.getElementById('sav-refund-status');
      var btn = document.getElementById('sav-refund-btn');
      if (!st || !btn) return;
      var r = ticket.paiements && ticket.paiements.remboursement;
      if (r && r.status === 'effectue') {
        st.innerHTML = '<span class="text-emerald-700 font-semibold">' + (r.amountCents/100).toFixed(2) + ' € remboursés</span> · ' + (r.mollieRefundId || '');
      } else {
        st.textContent = 'Aucun remboursement enregistré';
      }
    }
    document.addEventListener('click', function (e) {
      if (!e.target.closest('#sav-refund-btn')) return;
      var input = document.getElementById('sav-refund-amount');
      var euros = parseFloat((input && input.value) || '');
      if (!isFinite(euros) || euros <= 0) { toast('Montant invalide', 'error'); return; }
      var cents = Math.round(euros * 100);
      if (!window.confirm('Rembourser ' + euros.toFixed(2) + ' € via Mollie sur la commande ' + (ticket.numeroCommande || '?') + ' ?')) return;
      var btn = document.getElementById('sav-refund-btn');
      btn.disabled = true; btn.classList.add('opacity-60');
      api('/tickets/' + encodeURIComponent(numero) + '/refund', {
        method: 'POST',
        body: JSON.stringify({ amountCents: cents }),
      }).then(function (res) {
        if (res.ok && res.j.success) {
          toast('Remboursement effectué', 'success');
          input.value = '';
          loadTicket();
        } else {
          toast((res.j && res.j.error) || 'Erreur', 'error');
        }
      }).catch(function (err) {
        toast(err.message || 'Erreur', 'error');
      }).finally(function () {
        btn.disabled = false; btn.classList.remove('opacity-60');
      });
    });

    function loadOrderContext() {
      var box = document.getElementById('sav-order-context-body');
      if (!box) return;
      api('/tickets/' + encodeURIComponent(numero) + '/order-context').then(function (res) {
        if (!res.ok || !res.j.success) {
          box.innerHTML = '<div class="text-slate-400 italic">Indisponible</div>';
          return;
        }
        var o = res.j.data && res.j.data.order;
        if (!o) {
          var nc = (res.j.data && res.j.data.numeroCommande) || (ticket && ticket.numeroCommande) || '';
          box.innerHTML = nc
            ? '<div class="text-slate-500">Commande <strong>' + escapeHtml(nc) + '</strong> introuvable en base.</div>'
            : '<div class="text-slate-400 italic">Aucune commande liée.</div>';
          return;
        }
        var html = '';
        // Header : numéro + statut sur une ligne
        var statusHtml = o.status
          ? '<span class="sav-order-status">' + escapeHtml(o.status) + '</span>'
          : '';
        html += '<a href="/admin/orders/' + encodeURIComponent(o.number) + '" target="_blank" class="sav-order-link">'
              + '<span class="sav-order-num">' + escapeHtml(o.number) + '</span>'
              + '<span class="material-symbols-outlined" style="font-size:11px;">open_in_new</span>'
              + statusHtml
              + '</a>';
        // Items
        if (o.items && o.items.length) {
          html += '<div class="sav-order-items">';
          o.items.forEach(function (it) {
            var name = it.name || '—';
            html += '<div class="sav-order-item">'
              + '<span class="sav-order-qty">' + (it.quantity || 1) + '×</span>'
              + '<span class="sav-order-name" title="' + escapeHtml(name) + '">' + escapeHtml(name) + '</span>'
              + '</div>';
            if (it.sku) html += '<div class="sav-order-sku">' + escapeHtml(it.sku) + '</div>';
          });
          html += '</div>';
        }
        // Tracking
        var trackings = [];
        (o.shipments || []).forEach(function (s) {
          if (s.trackingNumber) trackings.push({ label: s.label || s.carrier || 'Envoi', carrier: s.carrier, num: s.trackingNumber });
        });
        if (o.cloningTracking && o.cloningTracking.trackingNumber) {
          trackings.push({ label: 'Clonage', carrier: o.cloningTracking.carrier, num: o.cloningTracking.trackingNumber, url: o.cloningTracking.trackingUrl });
        }
        if (trackings.length) {
          html += '<div class="sav-order-tracking">';
          trackings.forEach(function (t) {
            var trackUrl = t.url || '';
            html += '<div class="sav-order-track-row">'
              + '<span class="material-symbols-outlined" style="font-size:13px;">local_shipping</span>'
              + '<span>' + escapeHtml(t.label) + (t.carrier ? ' · ' + escapeHtml(t.carrier) : '') + '</span>'
              + ' — ';
            if (trackUrl) html += '<a href="' + escapeHtml(trackUrl) + '" target="_blank" class="sav-order-track-link">' + escapeHtml(t.num) + '</a>';
            else html += '<span class="font-mono">' + escapeHtml(t.num) + '</span>';
            html += '</div>';
          });
          html += '</div>';
        }
        box.innerHTML = html;
      }).catch(function () {
        box.innerHTML = '<div class="text-slate-400 italic">Erreur de chargement</div>';
      });
    }

    function loadTicket() {
      api('/tickets/' + encodeURIComponent(numero)).then(function (res) {
        if (!res.ok || !res.j.success) {
          var err = document.getElementById('sav-detail-error');
          if (err) { err.textContent = res.j.error || 'Erreur de chargement.'; err.classList.remove('hidden'); }
          return;
        }
        ticket = res.j.data;
        renderHeader();
        renderPinnedNotes();
        renderDossier();
        renderTimeline();
        renderDocuments();
        renderMessages();
        renderPaiement();
        prefillDiagEnrichi();
        prefillFournisseur();
        renderPreview();
        renderTabBadges();
        loadOrderContext();
        renderRefundPanel();
        // Skeletons → clear aria-busy (innerHTML already replaced)
        ['sav-header-meta', 'sav-dossier', 'sav-timeline', 'sav-documents'].forEach(function (id) {
          var el = document.getElementById(id);
          if (el) el.removeAttribute('aria-busy');
        });
      });
    }

    // -------- Stepper cycle SAV --------
    var STEPPER_STAGES = [
      { key: 'recu',       label: 'Reçu',                statuts: ['ouvert','pre_qualification','en_attente_documents','retour_demande','en_transit_retour'] },
      { key: 'atelier',    label: 'Pièce reçue atelier', statuts: ['recu_atelier'] },
      { key: 'analyse',    label: 'En analyse',          statuts: ['en_analyse'] },
      { key: 'diagnostic', label: 'Diagnostic',          statuts: ['analyse_terminee'] },
      { key: 'resolution', label: 'Résolution',          statuts: ['en_attente_decision_client'] },
      { key: 'cloture',    label: 'Clôturé',             statuts: ['clos'] }
    ];

    // Extrait les dates de changement de statut depuis l'historique messages
    function buildStageDates() {
      var dates = {};
      var msgs = (ticket && ticket.messages) || [];
      // Par défaut : date de création → étape 0
      if (ticket && ticket.createdAt) dates[STEPPER_STAGES[0].key] = ticket.createdAt;
      msgs.forEach(function (m) {
        var c = m && m.contenu;
        if (!c) return;
        var match = String(c).match(/Changement de statut[^→]*→\s*([a-z_0-9]+)/i);
        if (!match) return;
        var newStatut = match[1];
        for (var k = 0; k < STEPPER_STAGES.length; k++) {
          if (STEPPER_STAGES[k].statuts.indexOf(newStatut) !== -1) {
            dates[STEPPER_STAGES[k].key] = m.date || dates[STEPPER_STAGES[k].key];
            break;
          }
        }
      });
      return dates;
    }

    function renderStepper(statut) {
      var host = document.getElementById('sav-stepper');
      if (!host) return;
      var idx = -1;
      for (var i = 0; i < STEPPER_STAGES.length; i++) {
        if (STEPPER_STAGES[i].statuts.indexOf(statut) !== -1) { idx = i; break; }
      }
      if (idx === -1) idx = 0;
      var stageDates = buildStageDates();
      var html = '<ol class="sav-stepper__list">';
      for (var j = 0; j < STEPPER_STAGES.length; j++) {
        var st = STEPPER_STAGES[j];
        var state = j < idx ? 'done' : (j === idx ? 'current' : 'todo');
        var icon = state === 'done'
          ? '<svg viewBox="0 0 20 20" fill="currentColor" aria-hidden="true"><path fill-rule="evenodd" d="M16.7 5.3a1 1 0 0 1 0 1.4l-7.5 7.5a1 1 0 0 1-1.4 0L3.3 9.7a1 1 0 1 1 1.4-1.4l3.8 3.8 6.8-6.8a1 1 0 0 1 1.4 0z" clip-rule="evenodd"/></svg>'
          : '<span>' + (j + 1) + '</span>';
        var d = stageDates[st.key];
        var dateHtml = (state !== 'todo' && d) ? '<span class="sav-stepper__date">' + new Date(d).toLocaleDateString('fr-FR') + '</span>' : '';
        html += '<li class="sav-stepper__step sav-stepper__step--' + state + '" aria-current="' + (state === 'current' ? 'step' : 'false') + '">'
              +   '<span class="sav-stepper__bullet">' + icon + '</span>'
              +   '<span class="sav-stepper__label">' + escapeHtml(st.label) + dateHtml + '</span>'
              + '</li>';
        if (j < STEPPER_STAGES.length - 1) {
          var barState = j < idx ? 'done' : 'todo';
          html += '<li class="sav-stepper__bar sav-stepper__bar--' + barState + '" aria-hidden="true"></li>';
        }
      }
      html += '</ol>';
      host.innerHTML = html;
    }
    window.renderStepper = renderStepper;

    // -------- Header sticky --------
    function icon(name, size) {
      return '<span class="material-symbols-outlined" style="font-size:' + (size || 14) + 'px;vertical-align:middle;">' + name + '</span>';
    }

    function statutBadgeClass(statut) {
      switch (statut) {
        case 'ouvert':
        case 'pre_qualification':
        case 'en_attente_documents':
        case 'retour_demande':
        case 'en_transit_retour':
          return 'bg-sky-100 text-sky-700';
        case 'recu_atelier':       return 'bg-blue-100 text-blue-700';
        case 'en_analyse':         return 'bg-violet-100 text-violet-700';
        case 'analyse_terminee':   return 'bg-amber-100 text-amber-700';
        case 'en_attente_decision_client': return 'bg-orange-100 text-orange-700';
        case 'clos':               return 'bg-slate-200 text-slate-600';
        default:                   return 'bg-slate-100 text-slate-700';
      }
    }

    // Next Best Action : bouton primaire contextualisé selon le statut courant
    var NEXT_ACTIONS = {
      ouvert:                       { label: 'Demander les documents manquants', icon: 'mail', hint: 'Client à contacter pour compléter le dossier.', type: 'tab', target: 'communications' },
      pre_qualification:            { label: 'Qualifier la demande',              icon: 'quiz', hint: 'Vérifier VIN, plaque et symptômes avant retour.', type: 'tab', target: 'apercu' },
      en_attente_documents:         { label: 'Relancer le client',                icon: 'campaign', hint: 'Documents manquants — relance email/whatsapp.', type: 'tab', target: 'communications' },
      relance_1:                    { label: 'Envoyer la 2ᵉ relance',             icon: 'campaign', hint: '1ʳᵉ relance envoyée, sans réponse.', type: 'tab', target: 'communications' },
      relance_2:                    { label: 'Clôturer sans réponse',             icon: 'block', hint: 'Aucune réponse après 2 relances.', type: 'statut', target: 'clos_sans_reponse', confirm: 'Clôturer ce ticket sans réponse client ?' },
      retour_demande:               { label: 'Envoyer l\'étiquette de retour',    icon: 'local_shipping', hint: 'Générer & transmettre l\'étiquette retour.', type: 'tab', target: 'communications' },
      en_transit_retour:            { label: 'Marquer pièce reçue atelier',       icon: 'inventory_2', hint: 'Quand la pièce arrive physiquement.', type: 'statut', target: 'recu_atelier' },
      recu_atelier:                 { label: 'Démarrer l\'analyse',                icon: 'science', hint: 'Lancer le diagnostic banc.', type: 'statut', target: 'en_analyse' },
      en_analyse:                   { label: 'Conclure l\'analyse',                icon: 'fact_check', hint: 'Passer les résultats au client.', type: 'statut', target: 'analyse_terminee' },
      analyse_terminee:             { label: 'Choisir la résolution',              icon: 'swap_horiz', hint: 'Échange, remboursement ou refus.', type: 'scroll', target: 'sav-actions' },
      en_attente_decision_client:   { label: 'Relancer pour décision',             icon: 'campaign', hint: 'Client n\'a pas encore validé.', type: 'tab', target: 'communications' },
      en_attente_fournisseur:       { label: 'Suivre le retour fournisseur',       icon: 'local_shipping', hint: 'Mettre à jour RMA / tracking.', type: 'tab', target: 'fournisseur' },
      resolu_garantie:              { label: 'Clôturer le ticket',                 icon: 'lock', hint: 'Résolution sous garantie validée.', type: 'statut', target: 'clos', confirm: 'Clôturer définitivement ce ticket ?' },
      resolu_facture:               { label: 'Clôturer le ticket',                 icon: 'lock', hint: 'Facture payée, résolution validée.', type: 'statut', target: 'clos', confirm: 'Clôturer définitivement ce ticket ?' },
      clos:                         { label: 'Ticket clôturé',                     icon: 'check_circle', hint: 'Aucune action restante.', type: 'none', disabled: true },
      clos_sans_reponse:            { label: 'Ticket clôturé',                     icon: 'check_circle', hint: 'Clos sans réponse du client.', type: 'none', disabled: true },
      refuse:                       { label: 'Ticket refusé',                      icon: 'block', hint: 'Demande refusée — pas d\'action.', type: 'none', disabled: true },
    };

    function renderNextAction(t) {
      var host = document.getElementById('sav-next-action');
      var hint = document.getElementById('sav-next-action-hint');
      if (!host) return;

      // Si le playbook a une macro recommandée, on l'utilise en priorité
      var recommendedMacro = (playbookData && playbookData.macros || []).find(function (m) { return m.recommended; });
      var def;
      if (recommendedMacro) {
        def = {
          label: recommendedMacro.label,
          icon: recommendedMacro.icon || 'star',
          hint: 'Action recommandée par le playbook pour cette étape.',
          type: 'macro',
          macro: recommendedMacro,
          disabled: false,
        };
      } else {
        def = NEXT_ACTIONS[t.statut] || { label: 'Aucune action suggérée', icon: 'help', hint: '', type: 'none', disabled: true };
      }
      var disabled = def.disabled ? 'disabled' : '';
      var btnClass = def.disabled
        ? 'bg-slate-100 text-slate-400 cursor-not-allowed border-slate-200'
        : 'bg-primary text-white hover:bg-primary-hover border-primary shadow-sm';
      host.innerHTML =
        '<button type="button" id="sav-next-action-btn" ' + disabled +
        ' class="w-full inline-flex items-center justify-center gap-2 px-4 py-3 rounded-xl border text-sm font-semibold transition ' + btnClass + '">' +
          '<span class="material-symbols-outlined" style="font-size:20px;">' + def.icon + '</span>' +
          '<span>' + escapeHtml(def.label) + '</span>' +
        '</button>';
      if (hint) hint.textContent = def.hint || '';

      var btn = document.getElementById('sav-next-action-btn');
      if (!btn || def.disabled) return;
      btn.addEventListener('click', function () {
        if (def.type === 'macro' && def.macro) {
          runPlaybookMacro(def.macro);
        } else if (def.type === 'statut') {
          if (def.confirm && !window.confirm(def.confirm)) return;
          var target = document.querySelector('[data-action-statut="' + def.target + '"]');
          if (target) { target.click(); return; }
          // Fallback: direct API call
          api('/tickets/' + encodeURIComponent(numero) + '/statut', {
            method: 'PATCH', body: JSON.stringify({ statut: def.target, auteur: 'admin' })
          }).then(function (res) {
            if (res.ok && res.j.success) { toast('Statut mis à jour', 'success'); loadTicket(); }
            else { toast((res.j && res.j.error) || 'Erreur', 'error'); }
          });
        } else if (def.type === 'tab') {
          // Legacy tab → scroll to corresponding accordion/section
          var accMap = { communications: 'sav-messages', diagnostic: 'sav-diag-form', fournisseur: 'panel-fournisseur', documents: 'sav-documents' };
          var targetEl = document.getElementById(accMap[def.target] || def.target);
          if (targetEl) {
            var det = targetEl.closest('details.sav-sidebar-accordion');
            if (det) det.open = true;
            targetEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        } else if (def.type === 'scroll') {
          var el = document.getElementById(def.target);
          if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      });
    }

    // Dim/hide les boutons d'actions rapides qui ne correspondent pas à la phase courante
    function dimIrrelevantActions(statut) {
      // Map status → phase active
      var phases = {
        recu_atelier: ['recu_atelier','en_transit_retour','retour_demande','ouvert','pre_qualification','en_attente_documents'],
        en_analyse: ['recu_atelier','en_analyse'],
        analyse_terminee: ['en_analyse','analyse_terminee'],
        echange: ['analyse_terminee','en_attente_decision_client'],
        remboursement: ['analyse_terminee','en_attente_decision_client'],
        clos: ['analyse_terminee','en_attente_decision_client','en_attente_fournisseur','resolu_garantie','resolu_facture'],
        refuse: ['ouvert','pre_qualification','en_attente_documents','analyse_terminee'],
      };
      document.querySelectorAll('[data-action-statut]').forEach(function (btn) {
        var next = btn.getAttribute('data-action-statut');
        var allowed = phases[next];
        var relevant = !allowed || allowed.indexOf(statut) !== -1;
        btn.classList.toggle('opacity-40', !relevant);
        btn.classList.toggle('pointer-events-none', !relevant);
        btn.setAttribute('aria-disabled', relevant ? 'false' : 'true');
        if (!relevant) btn.title = 'Non disponible au statut actuel (' + labelStatut(statut) + ')';
        else btn.removeAttribute('title');
      });
      document.querySelectorAll('[data-action-resolution]').forEach(function (btn) {
        var reso = btn.getAttribute('data-action-resolution');
        var allowed = phases[reso];
        var relevant = !allowed || allowed.indexOf(statut) !== -1;
        btn.classList.toggle('opacity-40', !relevant);
        btn.classList.toggle('pointer-events-none', !relevant);
        btn.setAttribute('aria-disabled', relevant ? 'false' : 'true');
        if (!relevant) btn.title = 'Non disponible au statut actuel (' + labelStatut(statut) + ')';
        else btn.removeAttribute('title');
      });
    }

    // SLA objectives : 3 jalons métier (Réponse 4h, Diagnostic 48h, Résolution 7j)
    function renderSlaObjectives(t) {
      var host = document.getElementById('sav-sla-objectives');
      if (!host) return;
      var openedAt = t.sla && t.sla.dateOuverture ? new Date(t.sla.dateOuverture).getTime() : (t.createdAt ? new Date(t.createdAt).getTime() : null);
      if (!openedAt) { host.innerHTML = ''; return; }
      var msgs = (t.messages || []).filter(function (m) { return m && m.canal !== 'interne'; });
      var firstReplyAt = msgs.length ? new Date(msgs[0].date).getTime() : null;

      // Détection diagnostic fait = statut >= analyse_terminee ou présence conclusion
      var diagDoneStatuts = ['analyse_terminee', 'en_attente_decision_client', 'en_attente_fournisseur', 'resolu_garantie', 'resolu_facture', 'clos'];
      var diagDone = diagDoneStatuts.indexOf(t.statut) !== -1 || (t.analyse && t.analyse.conclusion);
      var resolDone = ['resolu_garantie', 'resolu_facture', 'clos'].indexOf(t.statut) !== -1;

      var objectives = [
        { key: 'reponse',    label: 'Première réponse', target: 4 * 3600 * 1000,        doneAt: firstReplyAt },
        { key: 'diagnostic', label: 'Diagnostic',        target: 48 * 3600 * 1000,       doneAt: diagDone ? (t.updatedAt ? new Date(t.updatedAt).getTime() : Date.now()) : null },
        { key: 'resolution', label: 'Résolution',        target: 7 * 24 * 3600 * 1000,   doneAt: resolDone ? (t.updatedAt ? new Date(t.updatedAt).getTime() : Date.now()) : null },
      ];

      host.innerHTML = objectives.map(function (o) {
        var deadline = openedAt + o.target;
        var now = Date.now();
        var pctUsed;
        var cls, statusLabel, iconName;
        if (o.doneAt) {
          var ok = o.doneAt <= deadline;
          cls = ok ? 'ok' : 'late';
          statusLabel = ok ? 'Atteint' : 'Manqué';
          iconName = ok ? 'check_circle' : 'cancel';
          pctUsed = 100;
        } else {
          var elapsed = now - openedAt;
          pctUsed = Math.max(0, Math.min(100, Math.round((elapsed / o.target) * 100)));
          if (now > deadline) { cls = 'late'; statusLabel = 'Dépassé'; iconName = 'error'; }
          else if (pctUsed > 75) { cls = 'warn'; statusLabel = 'Risque'; iconName = 'schedule'; }
          else { cls = 'ok'; statusLabel = 'Dans les temps'; iconName = 'schedule'; }
        }
        var targetLabel = o.target >= 24 * 3600 * 1000 ? Math.round(o.target / (24 * 3600 * 1000)) + 'j' : Math.round(o.target / (3600 * 1000)) + 'h';
        var tip = 'Objectif ' + o.label + ' : ' + targetLabel + ' après ouverture du ticket.\nÉchéance : ' + new Date(deadline).toLocaleString('fr-FR');
        return '<div class="sav-obj sav-obj--' + cls + '" title="' + escapeHtml(tip) + '">' +
          '<div class="sav-obj__head"><span class="material-symbols-outlined text-base">' + iconName + '</span>' +
          '<span class="sav-obj__label">' + o.label + '</span>' +
          '<span class="sav-obj__target">' + targetLabel + '</span></div>' +
          '<div class="sav-obj__bar"><div class="sav-obj__bar-fill" style="width:' + pctUsed + '%"></div></div>' +
          '<div class="sav-obj__status">' + statusLabel + '</div>' +
        '</div>';
      }).join('');
    }

    function renderHeader() {
      var t = ticket || {};
      var c = t.client || {};

      var hm = document.getElementById('sav-header-meta');
      if (hm) {
        var parts = [];
        if (c.nom || c.email) {
          var clientHref = c.email ? '/admin/clients?q=' + encodeURIComponent(c.email) : '#';
          parts.push('<a href="' + clientHref + '" class="inline-flex items-center gap-1 hover:text-primary">' +
            icon('person') + '<span>' + escapeHtml(c.nom || c.email) + '</span></a>');
        }
        if (t.commandeId || t.commandeNumero) {
          var num = t.commandeNumero || t.commandeId;
          parts.push('<a href="/admin/commandes/' + encodeURIComponent(t.commandeId || num) + '" class="inline-flex items-center gap-1 hover:text-primary">' +
            icon('receipt_long') + '<span>' + escapeHtml(num) + '</span></a>');
        }
        if (t.createdAt) {
          parts.push('<span class="inline-flex items-center gap-1" title="' + escapeHtml(new Date(t.createdAt).toLocaleString('fr-FR')) + '">' +
            icon('schedule') + '<span>' + fmtRelative(t.createdAt) + '</span></span>');
        }
        hm.innerHTML = parts.join('<span class="text-slate-300">·</span>');
      }

      var sb = document.getElementById('sav-statut-badge');
      if (sb) {
        sb.textContent = labelStatut(t.statut);
        sb.className = 'px-3 py-1 rounded-full text-xs font-semibold ' + classStatut(t.statut);
      }

      var main = document.querySelector('main.sav-module');
      if (main) main.setAttribute('data-current-statut', t.statut || '');
      if (typeof renderStepper === 'function') renderStepper(t.statut);

      var sla = document.getElementById('sav-sla-badge');
      var d = t.sla && t.sla.dateLimite;
      if (sla && d) {
        var s = slaState(d, { dateOuverture: t.sla && t.sla.dateOuverture });
        sla.className = 'sav-sla-badge sav-sla-badge--' + s.cls + ' inline-flex items-center gap-1';
        sla.title = s.tooltip || '';
        sla.setAttribute('data-sla-deadline', d);
        if (t.sla && t.sla.dateOuverture) sla.setAttribute('data-sla-start', t.sla.dateOuverture);
        sla.innerHTML = icon('schedule') + '<span data-sla-text>SLA ' + s.label + '</span>';
        // Le tick global ne touche pas aux innerHTML complexes — on relit le label nous-mêmes
        if (!sla.__slaTick) {
          sla.__slaTick = setInterval(function () {
            var st = slaState(sla.getAttribute('data-sla-deadline'), { dateOuverture: sla.getAttribute('data-sla-start') });
            sla.className = 'sav-sla-badge sav-sla-badge--' + st.cls + ' inline-flex items-center gap-1';
            sla.title = st.tooltip || '';
            var txt = sla.querySelector('[data-sla-text]');
            if (txt) txt.textContent = 'SLA ' + st.label;
          }, 30000);
        }
      }
      // SLA objectives timeline
      renderSlaObjectives(t);
      // Next Best Action + dim actions non pertinentes
      renderNextAction(t);
      dimIrrelevantActions(t.statut);

      var assignLabel = document.getElementById('sav-assign-label');
      var assignIcon = document.getElementById('sav-assign-icon');
      var assignAvatar = document.getElementById('sav-assign-avatar');
      if (t.assignedToName) {
        if (assignLabel) assignLabel.textContent = t.assignedToName;
        if (assignAvatar) {
          assignAvatar.textContent = initials(t.assignedToName);
          assignAvatar.classList.remove('hidden');
          assignAvatar.classList.add('inline-flex');
        }
        if (assignIcon) assignIcon.classList.add('hidden');
      } else {
        if (assignLabel) assignLabel.textContent = 'Assigner';
        if (assignAvatar) { assignAvatar.classList.add('hidden'); assignAvatar.classList.remove('inline-flex'); }
        if (assignIcon) assignIcon.classList.remove('hidden');
      }
    }

    // -------- Notes épinglées (UX agent) --------
    var PIN_COLORS = {
      rose:    { bg: '#ffe4e6', border: '#e11d48', text: '#881337', hex: '#e11d48' },
      amber:   { bg: '#fef3c7', border: '#f59e0b', text: '#78350f', hex: '#f59e0b' },
      blue:    { bg: '#dbeafe', border: '#2563eb', text: '#1e3a8a', hex: '#2563eb' },
      emerald: { bg: '#d1fae5', border: '#059669', text: '#064e3b', hex: '#059669' },
      slate:   { bg: '#f1f5f9', border: '#64748b', text: '#0f172a', hex: '#64748b' },
    };
    var PIN_ORDER = ['rose', 'amber', 'blue', 'emerald', 'slate'];
    var pinState = {
      denseMode: (typeof localStorage !== 'undefined' && localStorage.getItem('savPinDense') === '1'),
      showAll: false,
      selectedColor: 'amber',
    };

    function isPinExpired(n) {
      return n && n.expiresAt && new Date(n.expiresAt) < new Date();
    }
    function sortedPins() {
      var notes = ((ticket && ticket.pinnedNotes) || []).slice();
      notes.sort(function (a, b) {
        var ea = isPinExpired(a) ? 1 : 0;
        var eb = isPinExpired(b) ? 1 : 0;
        if (ea !== eb) return ea - eb; // non-expirées d'abord
        var ia = PIN_ORDER.indexOf(a.couleur); if (ia === -1) ia = 99;
        var ib = PIN_ORDER.indexOf(b.couleur); if (ib === -1) ib = 99;
        if (ia !== ib) return ia - ib;
        return new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
      });
      return notes;
    }
    function autoLinkAndMentions(text) {
      var safe = escapeHtml(text || '');
      // #SAV-YYYY-NNNN → lien
      safe = safe.replace(/#?(SAV-\d{4}-\d{3,5})/gi, function (m, num) {
        return '<a href="/admin/sav/tickets/' + encodeURIComponent(num.toUpperCase()) + '" class="underline font-semibold">' + num.toUpperCase() + '</a>';
      });
      // @mentions
      safe = safe.replace(/@([a-zA-Z0-9_.-]{2,40})/g, '<span class="font-semibold" style="opacity:.85;">@$1</span>');
      return safe;
    }

    function renderPinnedNotes() {
      var wrap = document.getElementById('sav-pinned-notes-wrap');
      var empty = document.getElementById('sav-pinned-empty');
      var box = document.getElementById('sav-pinned-notes');
      var countEl = document.getElementById('sav-pinned-count');
      var showAllBtn = document.getElementById('sav-pinned-showall');
      if (!box || !wrap || !empty) return;
      var notes = sortedPins();
      if (!notes.length) {
        wrap.classList.add('hidden');
        empty.classList.remove('hidden');
        return;
      }
      empty.classList.add('hidden');
      wrap.classList.remove('hidden');
      if (countEl) countEl.textContent = String(notes.length);

      var visible = pinState.showAll ? notes : notes.slice(0, 3);
      var dense = pinState.denseMode;

      box.className = dense ? 'flex flex-col gap-1' : 'flex flex-wrap gap-2';
      box.innerHTML = visible.map(function (n) {
        var c = PIN_COLORS[n.couleur] || PIN_COLORS.amber;
        var expired = isPinExpired(n);
        var date = n.createdAt ? new Date(n.createdAt).toLocaleDateString('fr-FR') : '';
        var expLabel = '';
        if (n.expiresAt) {
          var d = new Date(n.expiresAt);
          expLabel = (expired ? ' · ⏰ expiré ' : ' · ⏰ ') + d.toLocaleDateString('fr-FR');
        }
        var auteur = n.auteur ? escapeHtml(n.auteur) + ' · ' : '';
        var body = autoLinkAndMentions(n.texte || '');
        var opacity = expired ? 'opacity:.55;filter:grayscale(.4);' : '';
        var id = escapeHtml(String(n._id));
        if (dense) {
          return '<div data-pin-id="' + id + '" class="flex items-center gap-2 rounded-md px-2 py-1 text-[11px] cursor-pointer" ' +
            'style="background:' + c.bg + ';border-left:3px solid ' + c.border + ';color:' + c.text + ';' + opacity + '" ' +
            'title="Double-clic pour éditer">' +
            '<span class="w-1.5 h-1.5 rounded-full flex-shrink-0" style="background:' + c.border + '"></span>' +
            '<span class="flex-1 truncate">' + body + '</span>' +
            '<span class="text-[9px] opacity-60">' + auteur + escapeHtml(date) + escapeHtml(expLabel) + '</span>' +
            '<button type="button" data-pin-del="' + id + '" class="opacity-50 hover:opacity-100" style="color:' + c.text + ';" title="Retirer">' +
              '<span class="material-symbols-outlined" style="font-size:12px;">close</span>' +
            '</button>' +
          '</div>';
        }
        return '<div data-pin-id="' + id + '" class="inline-flex items-start gap-2 rounded-lg px-3 py-2 text-xs shadow-sm cursor-pointer" ' +
          'style="background:' + c.bg + ';border-left:3px solid ' + c.border + ';color:' + c.text + ';max-width:340px;' + opacity + '" ' +
          'title="Double-clic pour éditer">' +
          '<span class="material-symbols-outlined" style="font-size:14px;flex-shrink:0;margin-top:1px;">push_pin</span>' +
          '<div class="flex-1 min-w-0">' +
            '<div class="font-medium break-words">' + body + '</div>' +
            '<div class="text-[10px] opacity-70 mt-0.5">' + auteur + escapeHtml(date) + escapeHtml(expLabel) + '</div>' +
          '</div>' +
          '<button type="button" data-pin-del="' + id + '" title="Retirer" class="opacity-60 hover:opacity-100" style="color:' + c.text + ';">' +
            '<span class="material-symbols-outlined" style="font-size:14px;">close</span>' +
          '</button>' +
        '</div>';
      }).join('');

      // "Voir plus"
      if (showAllBtn) {
        if (notes.length > 3) {
          showAllBtn.classList.remove('hidden');
          showAllBtn.textContent = pinState.showAll ? '↑ Replier' : ('↓ Voir les ' + (notes.length - 3) + ' autres notes');
        } else {
          showAllBtn.classList.add('hidden');
        }
      }

      // Wire delete (undo pattern — no confirm)
      box.querySelectorAll('[data-pin-del]').forEach(function (btn) {
        btn.addEventListener('click', function (ev) {
          ev.stopPropagation();
          var id = btn.getAttribute('data-pin-del');
          var snapshot = (ticket.pinnedNotes || []).find(function (x) { return String(x._id) === String(id); });
          // Optimistic remove
          ticket.pinnedNotes = (ticket.pinnedNotes || []).filter(function (x) { return String(x._id) !== String(id); });
          renderPinnedNotes();
          var undone = false;
          toastUndo('Note retirée', function () {
            undone = true;
            if (snapshot) {
              api('/tickets/' + encodeURIComponent(numero) + '/pinned-notes/' + encodeURIComponent(id) + '/restore', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ texte: snapshot.texte, couleur: snapshot.couleur }),
              }).then(function (res) {
                if (res.ok && res.j.success) {
                  ticket.pinnedNotes = res.j.data.pinnedNotes;
                  renderPinnedNotes();
                }
              });
            }
          }, 5000, function () {
            if (undone) return;
            api('/tickets/' + encodeURIComponent(numero) + '/pinned-notes/' + encodeURIComponent(id), { method: 'DELETE' }).then(function (res) {
              if (res.ok && res.j.success) {
                ticket.deletedPinnedNotes = res.j.data.deletedPinnedNotes;
              }
            });
          });
        });
      });
      // Wire edit (double-click)
      box.querySelectorAll('[data-pin-id]').forEach(function (el) {
        el.addEventListener('dblclick', function () {
          var id = el.getAttribute('data-pin-id');
          var n = (ticket.pinnedNotes || []).find(function (x) { return String(x._id) === String(id); });
          if (n) openPinForm(n);
        });
      });
    }

    // Toast undo simple (fallback si pas de lib)
    function toastUndo(message, onUndo, ms, onExpire) {
      var root = document.getElementById('sav-toast-root') || document.body;
      var el = document.createElement('div');
      el.className = 'sav-toast sav-toast--info';
      el.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);background:#0f172a;color:#fff;padding:10px 16px;border-radius:8px;box-shadow:0 10px 25px rgba(0,0,0,.2);z-index:9999;display:flex;gap:12px;align-items:center;font-size:13px;';
      el.innerHTML = '<span>' + escapeHtml(message) + '</span>';
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = 'Annuler';
      btn.style.cssText = 'background:#fff;color:#0f172a;padding:4px 10px;border-radius:6px;font-weight:600;cursor:pointer;';
      el.appendChild(btn);
      root.appendChild(el);
      var timer = setTimeout(function () {
        el.remove();
        try { onExpire && onExpire(); } catch (_) {}
      }, ms || 5000);
      btn.addEventListener('click', function () {
        clearTimeout(timer);
        el.remove();
        try { onUndo && onUndo(); } catch (_) {}
      });
    }

    // Form ajout/édition
    function openPinForm(editingNote) {
      var form = document.getElementById('sav-pinned-add-form');
      var input = document.getElementById('sav-pinned-input');
      var editIdInput = document.getElementById('sav-pinned-edit-id');
      var expInput = document.getElementById('sav-pinned-expires');
      var submitBtn = document.getElementById('sav-pinned-submit');
      if (!form || !input) return;
      form.classList.remove('hidden');
      if (editingNote) {
        input.value = editingNote.texte || '';
        editIdInput.value = String(editingNote._id || '');
        pinState.selectedColor = editingNote.couleur || 'amber';
        if (expInput) expInput.value = editingNote.expiresAt ? new Date(editingNote.expiresAt).toISOString().slice(0, 10) : '';
        if (submitBtn) submitBtn.textContent = 'Mettre à jour';
      } else {
        input.value = '';
        editIdInput.value = '';
        pinState.selectedColor = 'amber';
        if (expInput) expInput.value = '';
        if (submitBtn) submitBtn.textContent = 'Épingler';
      }
      updatePinColorUI();
      setTimeout(function () { input.focus(); input.setSelectionRange(input.value.length, input.value.length); }, 30);
    }
    function closePinForm() {
      var form = document.getElementById('sav-pinned-add-form');
      if (form) form.classList.add('hidden');
    }
    function updatePinColorUI() {
      document.querySelectorAll('.sav-pinned-color').forEach(function (b) {
        if (b.getAttribute('data-color') === pinState.selectedColor) {
          b.style.borderColor = '#0f172a';
          b.style.transform = 'scale(1.15)';
        } else {
          b.style.borderColor = 'transparent';
          b.style.transform = 'scale(1)';
        }
      });
    }

    (function wirePinnedForm() {
      var addTop = document.getElementById('sav-pinned-add-btn-top');
      var addEmpty = document.getElementById('sav-pinned-add-btn-empty');
      var form = document.getElementById('sav-pinned-add-form');
      var cancel = document.getElementById('sav-pinned-cancel');
      var input = document.getElementById('sav-pinned-input');
      var expInput = document.getElementById('sav-pinned-expires');
      var showAllBtn = document.getElementById('sav-pinned-showall');
      var denseBtn = document.getElementById('sav-pinned-dense-toggle');
      var historyBtn = document.getElementById('sav-pinned-history-btn');
      var historyBox = document.getElementById('sav-pinned-history');
      var historyClose = document.getElementById('sav-pinned-history-close');
      if (!form || !input) return;

      addTop && addTop.addEventListener('click', function () { openPinForm(null); });
      addEmpty && addEmpty.addEventListener('click', function () { openPinForm(null); });
      cancel && cancel.addEventListener('click', closePinForm);

      // Shift+P global shortcut
      document.addEventListener('keydown', function (e) {
        if (e.key === 'P' && e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) {
          var t = e.target;
          var tag = t && t.tagName;
          if (tag === 'INPUT' || tag === 'TEXTAREA' || (t && t.isContentEditable)) return;
          e.preventDefault();
          openPinForm(null);
        }
        if (e.key === 'Escape' && !form.classList.contains('hidden')) {
          closePinForm();
        }
      });
      // Entrée = submit (sans Shift)
      input.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          form.requestSubmit ? form.requestSubmit() : form.dispatchEvent(new Event('submit', { cancelable: true }));
        }
      });

      // Templates
      document.querySelectorAll('.sav-pinned-tpl').forEach(function (b) {
        b.addEventListener('click', function () {
          var tpl = b.getAttribute('data-tpl') || '';
          input.value = input.value ? (input.value + ' ' + tpl) : tpl;
          input.focus();
          input.setSelectionRange(input.value.length, input.value.length);
        });
      });
      // Color picker
      document.querySelectorAll('.sav-pinned-color').forEach(function (b) {
        b.addEventListener('click', function () {
          pinState.selectedColor = b.getAttribute('data-color') || 'amber';
          updatePinColorUI();
          input.focus();
        });
      });

      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var texte = (input.value || '').trim();
        if (!texte) return;
        var editId = document.getElementById('sav-pinned-edit-id').value;
        var payload = {
          texte: texte,
          couleur: pinState.selectedColor,
          expiresAt: expInput && expInput.value ? expInput.value : null,
        };
        var url = '/tickets/' + encodeURIComponent(numero) + '/pinned-notes' + (editId ? '/' + encodeURIComponent(editId) : '');
        var method = editId ? 'PATCH' : 'POST';
        api(url, {
          method: method,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        }).then(function (res) {
          if (res.ok && res.j.success) {
            ticket.pinnedNotes = res.j.data.pinnedNotes;
            renderPinnedNotes();
            closePinForm();
            toast(editId ? 'Note mise à jour' : 'Note épinglée', 'success');
          } else {
            toast((res.j && res.j.error) || 'Erreur', 'error');
          }
        });
      });

      showAllBtn && showAllBtn.addEventListener('click', function () {
        pinState.showAll = !pinState.showAll;
        renderPinnedNotes();
      });
      denseBtn && denseBtn.addEventListener('click', function () {
        pinState.denseMode = !pinState.denseMode;
        try { localStorage.setItem('savPinDense', pinState.denseMode ? '1' : '0'); } catch (_) {}
        renderPinnedNotes();
      });
      historyBtn && historyBtn.addEventListener('click', function () {
        historyBox.classList.toggle('hidden');
        if (!historyBox.classList.contains('hidden')) renderPinHistory();
      });
      historyClose && historyClose.addEventListener('click', function () { historyBox.classList.add('hidden'); });
    })();

    function renderPinHistory() {
      var list = document.getElementById('sav-pinned-history-list');
      if (!list) return;
      var del = (ticket && ticket.deletedPinnedNotes) || [];
      if (!del.length) { list.innerHTML = '<div class="text-[11px] text-slate-400 italic">Aucune note supprimée.</div>'; return; }
      list.innerHTML = del.slice().reverse().map(function (n) {
        var c = PIN_COLORS[n.couleur] || PIN_COLORS.slate;
        var d = n.deletedAt ? new Date(n.deletedAt).toLocaleString('fr-FR') : '';
        return '<div class="flex items-center gap-2 text-[11px] p-1.5 rounded bg-white border border-slate-200">' +
          '<span class="w-1.5 h-1.5 rounded-full" style="background:' + c.border + '"></span>' +
          '<span class="flex-1 truncate text-slate-700">' + escapeHtml(n.texte || '') + '</span>' +
          '<span class="text-[10px] text-slate-400">' + escapeHtml(n.deletedBy || '') + ' · ' + escapeHtml(d) + '</span>' +
          '<button type="button" data-pin-restore=\'' + escapeHtml(JSON.stringify({ texte: n.texte, couleur: n.couleur })) + '\' class="text-primary hover:underline text-[10px]">Restaurer</button>' +
        '</div>';
      }).join('');
      list.querySelectorAll('[data-pin-restore]').forEach(function (b) {
        b.addEventListener('click', function () {
          var data = {};
          try { data = JSON.parse(b.getAttribute('data-pin-restore') || '{}'); } catch (_) {}
          api('/tickets/' + encodeURIComponent(numero) + '/pinned-notes', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(data),
          }).then(function (res) {
            if (res.ok && res.j.success) {
              ticket.pinnedNotes = res.j.data.pinnedNotes;
              renderPinnedNotes();
              toast('Note restaurée', 'success');
            }
          });
        });
      });
    }

    // -------- Dossier (Aperçu : KPIs + 4 cards) --------
    function businessDaysSince(date) {
      if (!date) return 0;
      var start = new Date(date); start.setHours(0,0,0,0);
      var end = new Date(); end.setHours(0,0,0,0);
      var n = 0;
      for (var d = new Date(start); d < end; d.setDate(d.getDate() + 1)) {
        var w = d.getDay();
        if (w !== 0 && w !== 6) n++;
      }
      return n;
    }

    function cardTpl(iconName, title, body) {
      return '<div class="rounded-2xl border border-slate-200 bg-white p-4">' +
        '<div class="flex items-center gap-2 mb-3">' +
          '<span class="material-symbols-outlined text-slate-500" style="font-size:18px;">' + iconName + '</span>' +
          '<h3 class="text-sm font-semibold text-slate-700">' + title + '</h3>' +
        '</div>' +
        '<div class="text-sm text-slate-700 space-y-1.5">' + body + '</div>' +
      '</div>';
    }

    function renderBriefing() {
      var box = document.getElementById('sav-briefing');
      var body = document.getElementById('sav-briefing-body');
      if (!box || !body) return;
      var t = ticket || {};
      var c = t.client || {};
      var v = t.vehicule || {};
      var diag = t.diagnostic || {};
      var p = t.piece || {};

      // Résumé client : prénom nom — pièce — véhicule
      var clientName = (c.prenom || c.firstName || '') + ' ' + (c.nom || c.lastName || '');
      clientName = clientName.trim() || (c.email || 'Client');
      var pieceLabel = p.designation || labelPiece(t.pieceType) || '—';
      var vehLabel = [v.marque, v.modele, v.annee].filter(Boolean).join(' ');

      // Problème : description du diagnostic ou du motif
      var probleme = diag.description || t.description || t.motif || '';
      if (probleme.length > 180) probleme = probleme.slice(0, 177) + '…';

      // Dernière interaction : dernier message non-système
      var lastMsg = null;
      var msgs = t.messages || [];
      for (var i = msgs.length - 1; i >= 0; i--) {
        var m = msgs[i];
        if (!m) continue;
        var isSys = /^(Statut|Document|Assignation|Procédure|Remboursement)\b/i.test(m.contenu || '');
        if (!isSys && (m.auteur === 'client' || m.auteur === 'admin')) { lastMsg = m; break; }
      }
      var lastMsgLine = '';
      if (lastMsg) {
        var who = lastMsg.auteur === 'client' ? '📩 <strong>Client</strong>' : '✉️ <strong>Vous</strong>';
        var when = lastMsg.createdAt ? new Date(lastMsg.createdAt).toLocaleString('fr-FR', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }) : '';
        var excerpt = (lastMsg.contenu || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        if (excerpt.length > 120) excerpt = excerpt.slice(0, 117) + '…';
        lastMsgLine = who + ' · <span class="text-slate-500">' + escapeHtml(when) + '</span> — ' + escapeHtml(excerpt);
      } else {
        lastMsgLine = '<span class="text-slate-400">Aucun échange client/agent pour l\'instant</span>';
      }

      // Action attendue : déduite du statut + contexte réel du dossier
      var statut = t.statut || '';
      var docs = t.documents || {};
      var docsList = t.documentsList || [];
      var hasPhotos = (docs.photosObd && docs.photosObd.length > 0) ||
                      (docs.photosVisuelles && docs.photosVisuelles.length > 0) ||
                      docsList.some(function(d) { return /photo|obd|visuel/i.test(d.type || d.label || ''); });
      var hasFacture = !!docs.factureMontage || docsList.some(function(d) { return /facture/i.test(d.type || d.label || ''); });
      var hasDocs = hasPhotos || hasFacture || docsList.length > 0;
      var hasDiag = diag && (diag.description || (diag.codesDefaut && diag.codesDefaut.filter(Boolean).length) || diag.symptomes);

      // Actions intelligentes pour pre_qualification et ouvert
      var smartPreQual;
      if (hasDocs && hasDiag) {
        smartPreQual = { who: '👤 Nous', what: 'Analyser le dossier et décider : demander un retour pièce ou résoudre directement' };
      } else if (hasDocs) {
        smartPreQual = { who: '👤 Nous', what: 'Analyser les documents reçus et qualifier le problème' };
      } else {
        smartPreQual = { who: '👤 Nous', what: 'Demander les documents au client (photos, facture montage…)' };
      }

      var actionMap = {
        'ouvert': hasDocs
          ? { who: '👤 Nous', what: 'Qualifier le dossier — documents déjà fournis par le client' }
          : { who: '👤 Nous', what: 'Qualifier le dossier et demander les documents manquants' },
        'pre_qualification': smartPreQual,
        'en_attente_documents': { who: '🧍 Client', what: 'Envoyer les documents demandés (on relance à J+3)' },
        'retour_demande': { who: '🧍 Client', what: 'Expédier la pièce avec l\'étiquette retour' },
        'en_transit_retour': { who: '🚚 Transporteur', what: 'Acheminement en cours vers l\'atelier' },
        'recu_atelier': { who: '🔧 Atelier', what: 'Démarrer l\'analyse de la pièce' },
        'en_analyse': { who: '🔧 Atelier', what: 'Finaliser le diagnostic banc' },
        'analyse_terminee': { who: '👤 Nous', what: 'Communiquer la conclusion au client' },
        'en_attente_decision_client': { who: '🧍 Client', what: 'Accepter ou refuser la proposition' },
        'en_attente_fournisseur': { who: '🏭 Fournisseur', what: 'Attente réponse fournisseur / RMA' },
        'remboursement_initie': { who: '💸 Compta', what: 'Finaliser le remboursement Mollie' },
        'resolu_garantie': { who: '✅ Terminé', what: 'Dossier résolu sous garantie' },
        'resolu_facture': { who: '✅ Terminé', what: 'Dossier résolu (facturé)' },
        'clos': { who: '🔒 Clos', what: 'Aucune action' },
        'refuse': { who: '🔒 Clos', what: 'Demande refusée' },
      };
      var act = actionMap[statut] || { who: '—', what: '—' };

      // Motif
      var motifLabel = t.motifSav ? labelMotif(t.motifSav) : '';

      // Codes défaut et symptômes (critiques pour le diagnostic rapide)
      var quickDiag = [];
      if (diag.symptomes && diag.symptomes.length) {
        quickDiag.push(diag.symptomes.join(', '));
      }
      if (diag.codesDefaut && diag.codesDefaut.filter(Boolean).length) {
        quickDiag.push('OBD: ' + diag.codesDefaut.filter(Boolean).join(', '));
      }

      // Garage et réglage de base (critique pour DSG)
      var garage = t.garage || {};
      var montage = t.montage || {};

      // Assemble
      var head =
        '<div class="flex items-start gap-2 flex-wrap">' +
          '<span class="material-symbols-outlined text-primary" style="font-size:18px;">person</span>' +
          '<div class="font-semibold text-slate-900">' + escapeHtml(clientName) + '</div>' +
          (vehLabel ? '<span class="text-slate-400">·</span><span class="text-slate-700">' + escapeHtml(vehLabel) + '</span>' : '') +
          '<span class="text-slate-400">·</span><span class="text-slate-700">' + escapeHtml(pieceLabel) + '</span>' +
          (motifLabel ? '<span class="text-slate-400">·</span><span class="text-[11px] px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 font-medium">' + escapeHtml(motifLabel) + '</span>' : '') +
        '</div>';

      var probLine = probleme
        ? '<div class="flex items-start gap-2 text-slate-700"><span class="material-symbols-outlined text-slate-400 shrink-0" style="font-size:16px;">format_quote</span><em>' + escapeHtml(probleme) + '</em></div>'
        : '<div class="flex items-start gap-2 text-slate-400"><span class="material-symbols-outlined shrink-0" style="font-size:16px;">format_quote</span><em>Pas de description fournie par le client</em></div>';

      // Ligne diagnostic rapide (symptômes + codes)
      var diagLine = quickDiag.length
        ? '<div class="flex items-start gap-2 text-slate-600"><span class="material-symbols-outlined text-amber-500 shrink-0" style="font-size:16px;">warning</span><div class="text-[13px]">' + escapeHtml(quickDiag.join(' — ')) + '</div></div>'
        : '';

      // Ligne garage/montage (si pertinent)
      var garageLine = '';
      if (garage.nom || montage.reglageBase || montage.momentPanne) {
        var gParts = [];
        if (garage.nom) gParts.push('Garage : ' + garage.nom);
        if (montage.date) gParts.push('Monté le ' + new Date(montage.date).toLocaleDateString('fr-FR'));
        if (montage.reglageBase) {
          var rbText = montage.reglageBase === 'oui' ? '✅ Réglage de base fait' : (montage.reglageBase === 'non' ? '❌ Réglage de base NON fait' : '❓ Réglage de base inconnu');
          gParts.push(rbText);
        }
        if (montage.huileQuantite || montage.huileType) {
          var hParts = [];
          if (montage.huileQuantite) hParts.push(montage.huileQuantite + 'L');
          if (montage.huileType) hParts.push(montage.huileType);
          gParts.push('Huile : ' + hParts.join(' '));
        }
        if (montage.momentPanne) {
          var mpMap = { au_montage:'au montage', premier_demarrage:'1er démarrage', moins_100km:'<100km', '100_500km':'100-500km', '500_1000km':'500-1000km', '1000_5000km':'1-5kkm', plus_5000km:'>5000km', inconnu:'?' };
          gParts.push('Panne : ' + (mpMap[montage.momentPanne] || montage.momentPanne));
        }
        garageLine = '<div class="flex items-start gap-2 text-slate-600"><span class="material-symbols-outlined text-slate-400 shrink-0" style="font-size:16px;">home_repair_service</span><div class="text-[13px]">' + escapeHtml(gParts.join(' — ')) + '</div></div>';
      }

      // Ligne livraison (si transporteur renseigné)
      var livLine = '';
      var liv = t.livraison || {};
      if (liv.transporteur || liv.numeroSuivi) {
        var livParts = [];
        if (liv.transporteur) livParts.push(liv.transporteur);
        if (liv.numeroSuivi) livParts.push('Suivi : ' + liv.numeroSuivi);
        livLine = '<div class="flex items-start gap-2 text-slate-600"><span class="material-symbols-outlined text-slate-400 shrink-0" style="font-size:16px;">local_shipping</span><div class="text-[13px]">' + escapeHtml(livParts.join(' — ')) + '</div></div>';
      }

      var msgLine = '<div class="flex items-start gap-2 text-slate-600"><span class="material-symbols-outlined text-slate-400 shrink-0" style="font-size:16px;">schedule</span><div class="text-[13px]">' + lastMsgLine + '</div></div>';

      var actLine =
        '<div class="mt-2 pt-2 border-t border-primary/20 flex items-start gap-2">' +
          '<span class="material-symbols-outlined text-primary shrink-0" style="font-size:18px;">flag</span>' +
          '<div class="text-[13px]"><span class="text-[10px] uppercase tracking-wide font-bold text-primary">À faire · </span>' +
          '<strong>' + escapeHtml(act.who) + '</strong> — ' + escapeHtml(act.what) + '</div>' +
        '</div>';

      body.innerHTML = head + probLine + diagLine + garageLine + livLine + msgLine + actLine;
      box.setAttribute('aria-busy', 'false');
      // Show toggle button if briefing overflows
      setTimeout(function() {
        var toggle = document.getElementById('sav-briefing-toggle');
        if (toggle && body.scrollHeight > body.clientHeight + 4) {
          toggle.classList.remove('hidden');
        }
      }, 50);
    }

    // ------------------------------------------------------------
    // PLAYBOOK — stepper + actions 1-clic + transitions manuelles
    // ------------------------------------------------------------
    var playbookData = null;            // dernier payload reçu de l'API
    var playbookPendingNextStatut = null; // statut cible après envoi d'une macro email

    function interpolateMacro(text, t) {
      var c = t.client || {}, v = t.vehicule || {}, p = t.piece || {};
      var nom = ((c.prenom || c.firstName || '') + ' ' + (c.nom || c.lastName || '')).trim() || 'Client';
      var veh = [v.marque, v.modele, v.annee].filter(Boolean).join(' ');
      return String(text || '')
        .replace(/\{nom\}/g, nom)
        .replace(/\{numero\}/g, t.numero || '')
        .replace(/\{piece\}/g, p.designation || t.pieceType || 'la pièce')
        .replace(/\{vehicule\}/g, veh || 'votre véhicule');
    }

    function renderPlaybook() {
      var box = document.getElementById('sav-playbook');
      if (!box) return;
      api('/tickets/' + encodeURIComponent(numero) + '/playbook').then(function (res) {
        if (!(res.ok && res.j.success)) {
          box.classList.add('hidden');
          return;
        }
        playbookData = res.j.data;
        box.classList.remove('hidden');
        box.setAttribute('aria-busy', 'false');

        // Titre + owner
        var titleEl = document.getElementById('sav-playbook-title');
        var ownerEl = document.getElementById('sav-playbook-owner');
        if (titleEl) titleEl.textContent = 'Playbook · ' + (playbookData.title || '');
        if (ownerEl) ownerEl.textContent = playbookData.owner || '';

        // Stepper
        var stepper = document.getElementById('sav-playbook-stepper');
        if (stepper) {
          stepper.innerHTML = '';
          (playbookData.steps || []).forEach(function (s, i) {
            var li = document.createElement('li');
            li.className = 'flex-1 min-w-0';
            var state = s.done ? 'done' : (s.current ? 'current' : 'todo');
            var colorDot = state === 'done' ? 'bg-emerald-500 text-white'
              : state === 'current' ? 'bg-primary text-white ring-4 ring-primary/20'
              : 'bg-slate-200 text-slate-500';
            var colorLabel = state === 'current' ? 'text-primary font-semibold'
              : state === 'done' ? 'text-emerald-700'
              : 'text-slate-500';
            var icon = state === 'done' ? 'check' : String(i + 1);
            li.innerHTML =
              '<div class="flex items-center gap-1.5">' +
                '<div class="h-6 w-6 rounded-full flex items-center justify-center text-[11px] font-bold ' + colorDot + '">' +
                  (state === 'done' ? '<span class="material-symbols-outlined" style="font-size:14px;">check</span>' : icon) +
                '</div>' +
                (i < (playbookData.steps.length - 1) ? '<div class="flex-1 h-0.5 ' + (s.done ? 'bg-emerald-400' : 'bg-slate-200') + '"></div>' : '') +
              '</div>' +
              '<div class="mt-1 text-[11px] leading-tight ' + colorLabel + '">' + escapeHtml(s.label) + '</div>';
            stepper.appendChild(li);
          });
        }

        // Hint étape courante + arbre de décision
        var hintEl = document.getElementById('sav-playbook-hint');
        var currentStep = (playbookData.steps || []).find(function (s) { return s.current; });
        if (hintEl) {
          if (currentStep && (currentStep.hint || (currentStep.decisionTree && currentStep.decisionTree.length))) {
            var hintHtml = currentStep.hint ? '<div>' + escapeHtml(currentStep.hint) + '</div>' : '';
            // Arbre de décision contextuel
            var tree = currentStep.decisionTree || playbookData.decisionTree || [];
            if (tree.length) {
              hintHtml += '<div class="mt-2 space-y-1.5">';
              tree.forEach(function (d) {
                var hasMacro = d.macroId ? ' data-decision-macro="' + escapeHtml(d.macroId) + '"' : '';
                hintHtml += '<div class="flex items-start gap-1.5 text-[11px] leading-snug cursor-default group/decision rounded-md px-2 py-1 -mx-2 hover:bg-slate-100 transition"' + hasMacro + '>' +
                  '<span class="text-amber-500 font-bold shrink-0">Si</span>' +
                  '<span class="text-slate-600">' + escapeHtml(d.si) + '</span>' +
                  '<span class="text-emerald-600 font-semibold shrink-0 ml-auto whitespace-nowrap">' + escapeHtml(d.alors) + '</span>' +
                  '</div>';
              });
              hintHtml += '</div>';
            }
            hintEl.innerHTML = hintHtml;
            hintEl.classList.remove('hidden');
            // Rendre les lignes du decision tree cliquables si elles ont un macroId
            hintEl.querySelectorAll('[data-decision-macro]').forEach(function (row) {
              row.style.cursor = 'pointer';
              row.addEventListener('click', function () {
                var macroId = row.getAttribute('data-decision-macro');
                var macro = (playbookData.macros || []).find(function (m) { return m.id === macroId; });
                if (macro) runPlaybookMacro(macro);
              });
            });
          } else {
            hintEl.innerHTML = '';
            hintEl.classList.add('hidden');
          }
        }

        // Macros contextuelles (filtrées par étape + FSM côté serveur)
        var macrosEl = document.getElementById('sav-playbook-macros');
        if (macrosEl) {
          macrosEl.innerHTML = '';
          var macros = playbookData.macros || [];
          if (!macros.length) {
            macrosEl.innerHTML = '<div class="text-xs text-slate-400">Aucune action rapide disponible à cette étape.</div>';
          } else {
            // Trier : recommandée en premier
            var sorted = macros.slice().sort(function (a, b) { return (b.recommended ? 1 : 0) - (a.recommended ? 1 : 0); });
            sorted.forEach(function (m) {
              var btn = document.createElement('button');
              btn.type = 'button';
              if (m.recommended) {
                btn.className = 'inline-flex items-center gap-1.5 rounded-lg border-2 border-primary bg-primary/5 text-primary hover:bg-primary hover:text-white transition-colors px-3 py-1.5 text-xs font-bold shadow-sm';
              } else {
                btn.className = 'inline-flex items-center gap-1.5 rounded-lg border border-slate-300 bg-white hover:bg-primary hover:text-white hover:border-primary transition-colors px-3 py-1.5 text-xs font-medium';
              }
              btn.innerHTML = (m.recommended ? '<span class="material-symbols-outlined" style="font-size:16px;">star</span>' : '') +
                '<span class="material-symbols-outlined" style="font-size:16px;">' + (m.icon || 'bolt') + '</span><span>' + escapeHtml(m.label) + '</span>';
              btn.addEventListener('click', function () { runPlaybookMacro(m); });
              macrosEl.appendChild(btn);
            });
          }
        }

        // Templates du playbook (dans l'onglet Répondre)
        var tplWrap = document.getElementById('sav-playbook-templates-wrap');
        var tplChips = document.getElementById('sav-playbook-templates-chips');
        if (tplWrap && tplChips) {
          var tpls = playbookData.templates || [];
          tplChips.innerHTML = '';
          if (!tpls.length) {
            tplWrap.classList.add('hidden');
          } else {
            tplWrap.classList.remove('hidden');
            tpls.forEach(function (tp) {
              var b = document.createElement('button');
              b.type = 'button';
              b.className = 'sav-tpl-chip sav-tpl-chip--sm';
              b.innerHTML = '<span>#' + escapeHtml(tp.label) + '</span>';
              b.addEventListener('click', function () {
                var body = interpolateMacro(tp.body || '', ticket || {});
                var ed = document.getElementById('sav-msg-editor');
                if (!ed) return;
                // Insertion : remplace si vide, sinon append en fin
                var current = (ed.innerHTML || '').trim();
                ed.innerHTML = current ? (current + '<br><br>' + body) : body;
                var htmlField = document.getElementById('sav-msg-html');
                var textField = document.getElementById('sav-msg-contenu');
                if (htmlField) htmlField.value = ed.innerHTML;
                if (textField) textField.value = ed.innerText;
                toast('Modèle inséré : ' + tp.label);
                ed.focus();
              });
              tplChips.appendChild(b);
            });
          }
        }

        // Re-render "ACTION SUIVANTE" maintenant que playbookData est dispo
        if (ticket) renderNextAction(ticket);

        // Transitions manuelles autorisées (fallback)
        var transEl = document.getElementById('sav-playbook-transitions');
        if (transEl) {
          transEl.innerHTML = '';
          (playbookData.allowedNextStatuts || []).forEach(function (tr) {
            var b = document.createElement('button');
            b.type = 'button';
            b.className = 'rounded-full border border-slate-300 bg-white hover:bg-slate-100 px-2.5 py-1 text-[11px] text-slate-600';
            b.textContent = '→ ' + tr.label;
            b.addEventListener('click', function () {
              // Si la cible est un statut terminal → ouvre la modale de clôture qualifiée
              if (isTerminalStatut(tr.key)) {
                openCloseModal(tr.key);
                return;
              }
              if (!confirm('Changer le statut vers "' + tr.label + '" ?')) return;
              api('/tickets/' + encodeURIComponent(numero) + '/statut', {
                method: 'PATCH',
                body: JSON.stringify({ statut: tr.key, auteur: 'admin' }),
              }).then(function (r) {
                if (r.ok && r.j.success) { toast('Statut → ' + tr.label); loadTicket(); }
                else toast((r.j && r.j.error) || 'Transition refusée', 'error');
              });
            });
            transEl.appendChild(b);
          });
        }
      }).catch(function () {
        box.classList.add('hidden');
      });
    }

    function runPlaybookMacro(macro) {
      if (!macro) return;
      var t = ticket || {};

      // Macro sans email : change juste le statut (ex: clôture directe).
      if (macro.action === 'status_only') {
        if (!macro.nextStatut) return;
        // Si la macro mène à un statut terminal → passe par la modale de clôture qualifiée
        if (isTerminalStatut(macro.nextStatut)) {
          openCloseModal(macro.nextStatut);
          return;
        }
        if (!confirm('Exécuter : ' + macro.label + ' ?')) return;
        api('/tickets/' + encodeURIComponent(numero) + '/macro', {
          method: 'POST',
          body: JSON.stringify({ macroId: macro.id }),
        }).then(function (r) {
          if (r.ok && r.j.success) { toast(macro.label + ' ✓'); loadTicket(); }
          else toast((r.j && r.j.error) || 'Erreur', 'error');
        });
        return;
      }

      // Macro email / return_label : pré-remplit le composer et bascule sur Répondre.
      var subjectFilled = interpolateMacro(macro.subject || '', t);
      var bodyFilled = interpolateMacro(macro.body || '', t);

      // Ouvrir le composer et scroller vers la zone chat
      var composerWrap = document.getElementById('sav-composer-wrap');
      if (composerWrap) composerWrap.classList.remove('hidden');
      var chatArea = document.getElementById('sav-messages');
      if (chatArea) chatArea.scrollIntoView({ behavior: 'smooth', block: 'start' });

      // Remplit sujet + éditeur
      setTimeout(function () {
        var sujetInput = document.querySelector('[name="sujet"]');
        if (sujetInput) sujetInput.value = subjectFilled;
        var ed = document.getElementById('sav-msg-editor');
        if (ed) {
          ed.innerHTML = bodyFilled;
          // sync hidden fields
          var htmlField = document.getElementById('sav-msg-html');
          var textField = document.getElementById('sav-msg-contenu');
          if (htmlField) htmlField.value = bodyFilled;
          if (textField) textField.value = ed.innerText;
        }
        // Mémorise le statut cible pour être appliqué après envoi
        playbookPendingNextStatut = macro.nextStatut || null;

        // Si c'est une étiquette retour, on délègue au bouton existant pour
        // générer et attacher le PDF, puis on pré-remplit quand même le body.
        if (macro.action === 'return_label') {
          var labelBtn = document.getElementById('sav-attach-label-btn');
          if (labelBtn) labelBtn.click();
        }

        toast('Action pré-remplie : ' + macro.label + ' — vérifie et envoie');
      }, 80);
    }
    // ------------------------------------------------------------
    // Modale Clôture qualifiée (checklist + cause racine)
    // ------------------------------------------------------------
    function openCloseModal(defaultStatut) {
      var modal = document.getElementById('sav-close-modal');
      if (!modal) return;
      modal.classList.remove('hidden');
      modal.classList.add('flex');
      var form = document.getElementById('sav-close-form');
      if (form) {
        form.reset();
        var sel = form.querySelector('[name="targetStatut"]');
        if (sel && defaultStatut) sel.value = defaultStatut;
      }
    }
    function closeCloseModal() {
      var modal = document.getElementById('sav-close-modal');
      if (!modal) return;
      modal.classList.add('hidden');
      modal.classList.remove('flex');
    }
    (function wireCloseModal() {
      var form = document.getElementById('sav-close-form');
      if (!form) return;
      var btnCancel1 = document.getElementById('sav-close-cancel');
      var btnCancel2 = document.getElementById('sav-close-cancel-2');
      if (btnCancel1) btnCancel1.addEventListener('click', closeCloseModal);
      if (btnCancel2) btnCancel2.addEventListener('click', closeCloseModal);
      form.addEventListener('submit', function (e) {
        e.preventDefault();
        var fd = new FormData(form);
        var payload = {
          targetStatut: fd.get('targetStatut'),
          clientNotified: fd.get('clientNotified') === 'on',
          refundDone: fd.get('refundDone') === 'on',
          docsArchived: fd.get('docsArchived') === 'on',
          rootCause: fd.get('rootCause'),
          rootCauseDetail: fd.get('rootCauseDetail') || '',
        };
        api('/tickets/' + encodeURIComponent(numero) + '/close', {
          method: 'POST',
          body: JSON.stringify(payload),
        }).then(function (r) {
          if (r.ok && r.j.success) {
            toast('Ticket clôturé · cause : ' + payload.rootCause);
            closeCloseModal();
            loadTicket();
          } else {
            toast((r.j && r.j.error) || 'Erreur de clôture', 'error');
          }
        });
      });
    })();

    // Helper : détecte si un statut est terminal → déclenche la modale
    function isTerminalStatut(s) {
      return ['clos', 'resolu_garantie', 'resolu_facture', 'refuse'].indexOf(s) !== -1;
    }

    // Exposé pour pouvoir être consulté depuis doSend()
    function consumePlaybookPendingStatut() {
      var s = playbookPendingNextStatut;
      playbookPendingNextStatut = null;
      return s;
    }
    // On attache la fonction au scope de l'IIFE via une closure capture :
    // doSend() la lira via cette fonction locale.
    // (déclaration plus haut nécessaire car doSend est défini après)
    window.__savConsumePlaybookPending = consumePlaybookPendingStatut;

    function renderDossier() {
      var box = document.getElementById('sav-dossier');
      var t = ticket || {};
      var c = t.client || {};
      var v = t.vehicule || {};

      renderBriefing();
      renderPlaybook();

      // --- Masquage conditionnel onglet Fournisseur ---
      // On ne l'affiche que si un nom fournisseur est saisi OU si le ticket est en attente fournisseur
      var fournBtn = document.getElementById('tab-fournisseur');
      if (fournBtn) {
        var f = t.fournisseur || {};
        var hasFourn = !!(f.nom || f.contact || f.rmaNumero || t.statut === 'en_attente_fournisseur');
        if (hasFourn) {
          fournBtn.classList.remove('hidden');
        } else {
          fournBtn.classList.add('hidden');
        }
      }

      // --- KPIs ---
      var kpiDuree = document.querySelector('[data-kpi="duree"]');
      var kpiMsgs = document.querySelector('[data-kpi="messages"]');
      var kpiRel = document.querySelector('[data-kpi="relances"]');
      if (kpiDuree) kpiDuree.textContent = String(businessDaysSince(t.createdAt));
      if (kpiMsgs)  kpiMsgs.textContent  = String((t.messages || []).length);
      if (kpiRel) {
        var nbRelances = (t.messages || []).filter(function (m) {
          return /relance/i.test(m.contenu || '') || /relance/i.test(m.type || '');
        }).length;
        kpiRel.textContent = String(nbRelances);
      }

      if (!box) return;

      // --- Card 1 : Client ---
      var clientHref = c.email ? '/admin/clients?q=' + encodeURIComponent(c.email) : '#';
      var clientBody = [
        c.nom ? '<div class="font-medium text-slate-900">' + escapeHtml(c.nom) + '</div>' : '',
        c.email ? '<div><a href="mailto:' + escapeHtml(c.email) + '" class="text-primary hover:underline">' + escapeHtml(c.email) + '</a></div>' : '',
        c.telephone ? '<div><a href="tel:' + escapeHtml(c.telephone) + '" class="text-primary hover:underline">' + escapeHtml(c.telephone) + '</a></div>' : '',
        '<div class="pt-2"><a href="' + clientHref + '" class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-300 text-xs hover:border-primary hover:text-primary">Voir fiche client</a></div>',
      ].filter(Boolean).join('') || '<span class="text-slate-400">Non renseigné</span>';

      // --- Card 2 : Véhicule ---
      var vehBody = [
        (v.marque || v.modele || v.annee) ? '<div class="font-medium text-slate-900">' + escapeHtml([v.marque, v.modele, v.annee].filter(Boolean).join(' ')) + '</div>' : '',
        v.vin ? '<div class="flex items-center gap-1"><span class="text-slate-500">VIN&nbsp;:</span> <span class="font-mono">' + escapeHtml(v.vin) + '</span>' +
          '<button type="button" data-copy="' + escapeHtml(v.vin) + '" class="sav-copy-mini text-slate-400 hover:text-primary" title="Copier"><span class="material-symbols-outlined" style="font-size:14px;vertical-align:middle;">content_copy</span></button></div>' : '',
        v.immatriculation ? '<div><span class="text-slate-500">Plaque&nbsp;:</span> ' + escapeHtml(v.immatriculation) + '</div>' : '',
        v.kilometrage ? '<div><span class="text-slate-500">Kilométrage&nbsp;:</span> ' + escapeHtml(String(v.kilometrage)) + ' km</div>' : '',
        v.motorisation ? '<div><span class="text-slate-500">Motorisation&nbsp;:</span> ' + escapeHtml(v.motorisation) + '</div>' : '',
      ].filter(Boolean).join('') || '<span class="text-slate-400">Non renseigné</span>';

      // --- Card 3 : Pièce SAV ---
      var p = t.piece || {};
      var pieceBody = [
        p.reference ? '<div class="font-mono text-slate-900">' + escapeHtml(p.reference) + '</div>' : (t.pieceType ? '<div class="font-medium text-slate-900">' + escapeHtml(labelPiece(t.pieceType)) + '</div>' : ''),
        p.designation ? '<div>' + escapeHtml(p.designation) + '</div>' : '',
        (p.prixHT != null) ? '<div><span class="text-slate-500">Prix HT&nbsp;:</span> ' + Number(p.prixHT).toFixed(2) + ' €</div>' : '',
        p.url ? '<div class="pt-2"><a href="' + escapeHtml(p.url) + '" target="_blank" rel="noopener" class="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border border-slate-300 text-xs hover:border-primary hover:text-primary">Fiche produit</a></div>' : '',
      ].filter(Boolean).join('') || '<span class="text-slate-400">Non renseigné</span>';

      // --- Card 4 : Commande liée ---
      var cmdNum = t.numeroCommande || t.commandeNumero || (t.commande && t.commande.numero);
      var cmdDate = t.dateAchat || (t.commande && t.commande.date);
      var cmdTotal = (t.commande && t.commande.total) || t.commandeTotal;
      var cmdPaiement = (t.commande && t.commande.statutPaiement) || t.commandeStatutPaiement;
      var cmdBody = cmdNum
        ? [
            '<div><a href="/admin/commandes/' + encodeURIComponent(cmdNum) + '" class="text-primary font-mono hover:underline">' + escapeHtml(cmdNum) + '</a></div>',
            cmdDate ? '<div><span class="text-slate-500">Date&nbsp;:</span> ' + new Date(cmdDate).toLocaleDateString('fr-FR') + '</div>' : '',
            (cmdTotal != null) ? '<div><span class="text-slate-500">Total&nbsp;:</span> ' + Number(cmdTotal).toFixed(2) + ' €</div>' : '',
            cmdPaiement ? '<div><span class="text-slate-500">Paiement&nbsp;:</span> <span class="px-1.5 py-0.5 rounded text-xs ' +
              (cmdPaiement === 'paye' ? 'bg-emerald-100 text-emerald-800' : 'bg-amber-100 text-amber-800') + '">' + escapeHtml(cmdPaiement) + '</span></div>' : '',
          ].filter(Boolean).join('')
        : '<span class="text-slate-400">Aucune commande liée</span>';

      // --- Card 5 : Diagnostic (symptômes + codes défaut + description) ---
      var diag = t.diagnostic || {};
      var diagParts = [];
      if (diag.description) {
        diagParts.push('<div class="text-slate-900 font-medium">' + escapeHtml(diag.description) + '</div>');
      }
      if (diag.symptomes && diag.symptomes.length) {
        diagParts.push('<div class="flex flex-wrap gap-1 mt-1">' + diag.symptomes.map(function (s) {
          return '<span class="inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium bg-amber-100 text-amber-800">' + escapeHtml(s) + '</span>';
        }).join('') + '</div>');
      }
      if (diag.codesDefaut && diag.codesDefaut.length) {
        var codes = diag.codesDefaut.filter(Boolean);
        if (codes.length) {
          diagParts.push('<div class="mt-1"><span class="text-slate-500">Codes OBD :</span> <span class="font-mono text-red-700 font-semibold">' + codes.map(escapeHtml).join(', ') + '</span></div>');
        }
      }
      // Description dommage (pour colis_abime, etc.)
      if (t.descriptionDommage) {
        diagParts.push('<div><span class="text-slate-500">Dommage :</span> ' + escapeHtml(t.descriptionDommage) + '</div>');
      }
      var diagBody = diagParts.length
        ? diagParts.join('')
        : '<span class="text-slate-400">Aucune info diagnostic</span>';

      // --- Card 6 : Garage & Montage ---
      var garage = t.garage || {};
      var montage = t.montage || {};
      var garageParts = [];
      if (garage.nom) garageParts.push('<div class="font-medium text-slate-900">' + escapeHtml(garage.nom) + '</div>');
      if (garage.adresse) garageParts.push('<div class="text-slate-600">' + escapeHtml(garage.adresse) + '</div>');
      if (montage.date) {
        var dateMontStr = new Date(montage.date).toLocaleDateString('fr-FR');
        garageParts.push('<div><span class="text-slate-500">Monté le :</span> ' + dateMontStr + '</div>');
      }
      if (montage.reglageBase) {
        var rbColor = montage.reglageBase === 'oui' ? 'bg-emerald-100 text-emerald-800' : (montage.reglageBase === 'non' ? 'bg-red-100 text-red-800' : 'bg-slate-100 text-slate-700');
        var rbLabel = montage.reglageBase === 'oui' ? 'Oui ✓' : (montage.reglageBase === 'non' ? 'Non ✗' : 'Inconnu');
        garageParts.push('<div class="flex items-center gap-2"><span class="text-slate-500">Réglage de base :</span> <span class="inline-flex px-2 py-0.5 rounded-full text-[11px] font-bold ' + rbColor + '">' + rbLabel + '</span></div>');
      }
      // Huile
      if (montage.huileQuantite || montage.huileType) {
        var huileText = [];
        if (montage.huileQuantite) huileText.push(montage.huileQuantite + ' L');
        if (montage.huileType) huileText.push(escapeHtml(montage.huileType));
        garageParts.push('<div><span class="text-slate-500">Huile :</span> <span class="font-medium">' + huileText.join(' — ') + '</span></div>');
      }
      // Moment de la panne
      if (montage.momentPanne) {
        var mpLabels = {
          au_montage: 'Pendant le montage', premier_demarrage: 'Au premier démarrage',
          moins_100km: '< 100 km', '100_500km': '100-500 km',
          '500_1000km': '500-1000 km', '1000_5000km': '1000-5000 km',
          plus_5000km: '> 5000 km', inconnu: 'Inconnu'
        };
        var mpLabel = mpLabels[montage.momentPanne] || montage.momentPanne;
        var mpColor = ['au_montage', 'premier_demarrage', 'moins_100km'].indexOf(montage.momentPanne) !== -1
          ? 'bg-red-100 text-red-800'
          : 'bg-slate-100 text-slate-700';
        garageParts.push('<div class="flex items-center gap-2"><span class="text-slate-500">Panne :</span> <span class="inline-flex px-2 py-0.5 rounded-full text-[11px] font-bold ' + mpColor + '">' + mpLabel + '</span></div>');
      }
      var showGarage = garageParts.length > 0;

      // --- Card 7 : Livraison (transporteur, suivi, dates) ---
      var liv = t.livraison || {};
      var livParts = [];
      if (liv.transporteur) livParts.push('<div><span class="text-slate-500">Transporteur :</span> <strong>' + escapeHtml(liv.transporteur) + '</strong></div>');
      if (liv.numeroSuivi) {
        livParts.push('<div class="flex items-center gap-1"><span class="text-slate-500">N° suivi :</span> <span class="font-mono">' + escapeHtml(liv.numeroSuivi) + '</span>' +
          '<button type="button" data-copy="' + escapeHtml(liv.numeroSuivi) + '" class="sav-copy-mini text-slate-400 hover:text-primary"><span class="material-symbols-outlined" style="font-size:14px;">content_copy</span></button></div>');
      }
      if (liv.dateReceptionPrevue) livParts.push('<div><span class="text-slate-500">Réception prévue :</span> ' + new Date(liv.dateReceptionPrevue).toLocaleDateString('fr-FR') + '</div>');
      if (liv.dateReceptionReelle) livParts.push('<div><span class="text-slate-500">Réception réelle :</span> ' + new Date(liv.dateReceptionReelle).toLocaleDateString('fr-FR') + '</div>');
      var showLiv = livParts.length > 0;

      // --- Card 8 : Documents joints ---
      var docs = t.documentsList || [];
      var docParts = [];
      if (docs.length) {
        docs.forEach(function (d) {
          var label = d.kind || d.originalName || 'Document';
          var kindLabels = {
            factureMontage: 'Facture montage',
            photoObd: 'Photo OBD',
            confirmationReglageBase: 'Confirmation réglage',
            photoPiece: 'Photo pièce',
            photoColisExterieur: 'Photo colis ext.',
            photoBordereau: 'Photo bordereau',
            photoPieceEndommagee: 'Photo pièce endommagée',
          };
          var displayLabel = kindLabels[d.kind] || label;
          var icon = /photo|image/i.test(d.kind || '') ? 'image' : 'description';
          docParts.push('<div class="flex items-center gap-2">' +
            '<span class="material-symbols-outlined text-slate-400" style="font-size:16px;">' + icon + '</span>' +
            (d.url ? '<a href="' + escapeHtml(d.url) + '" target="_blank" class="text-primary hover:underline text-[13px]">' + escapeHtml(displayLabel) + '</a>' : '<span class="text-[13px]">' + escapeHtml(displayLabel) + '</span>') +
            '</div>');
        });
      }
      var showDocs = docParts.length > 0;

      // --- Card : N° série (si existe) ---
      if (t.numeroSerie) {
        var serieLine = '<div class="flex items-center gap-1"><span class="text-slate-500">N° série :</span> <span class="font-mono font-medium">' + escapeHtml(t.numeroSerie) + '</span>' +
          '<button type="button" data-copy="' + escapeHtml(t.numeroSerie) + '" class="sav-copy-mini text-slate-400 hover:text-primary"><span class="material-symbols-outlined" style="font-size:14px;">content_copy</span></button></div>';
        pieceBody += serieLine;
      }
      // Ajouter referencePiece si pas dans piece.reference
      if (t.referencePiece && !p.reference) {
        pieceBody = '<div class="font-mono text-slate-900">' + escapeHtml(t.referencePiece) + '</div>' + pieceBody;
      }

      // --- Assemble ALL cards ---
      var html =
        cardTpl('person',        'Client',                clientBody) +
        cardTpl('error',         'Problème signalé',      diagBody) +
        cardTpl('directions_car','Véhicule',              vehBody) +
        cardTpl('settings',      'Pièce SAV',             pieceBody) +
        cardTpl('receipt_long',  'Commande liée',         cmdBody);

      if (showGarage) html += cardTpl('home_repair_service', 'Garage & montage', garageParts.join(''));
      if (showLiv)    html += cardTpl('local_shipping',      'Livraison',        livParts.join(''));
      if (showDocs)   html += cardTpl('attach_file',         'Documents client (' + docs.length + ')', docParts.join(''));

      box.innerHTML = html;

      // Wire copy mini buttons
      box.querySelectorAll('.sav-copy-mini').forEach(function (b) {
        b.addEventListener('click', function () {
          var val = b.getAttribute('data-copy') || '';
          if (navigator.clipboard) navigator.clipboard.writeText(val).then(function(){ toast('Copié'); });
          else toast('Copié');
        });
      });
    }

    function renderDossier_legacy_unused() {
      var box = document.getElementById('sav-dossier');
      if (!box) return;
      var t = ticket || {};
      var v = t.vehicule || {};
      var g = t.garage || {};
      var m = t.montage || {};
      var diag = t.diagnostic || {};
      var cgv = t.cgvAcceptance || {};
      var rgpd = t.rgpdAcceptance || {};

      var commandeBlock = '';
      if (t.numeroCommande) {
        commandeBlock =
          '<a href="/admin/commandes/' + encodeURIComponent(t.numeroCommande) + '" class="text-primary underline font-mono">' +
          escapeHtml(t.numeroCommande) + '</a>' +
          (t.dateAchat ? ' · ' + new Date(t.dateAchat).toLocaleDateString('fr-FR') : '');
      } else commandeBlock = '<span class="text-slate-400">—</span>';

      var vehiculeBlock = [
        v.vin ? '<div><strong>VIN&nbsp;:</strong> <span class="font-mono">' + escapeHtml(v.vin) + '</span></div>' : '',
        v.immatriculation ? '<div><strong>Plaque&nbsp;:</strong> ' + escapeHtml(v.immatriculation) + '</div>' : '',
        (v.marque || v.modele) ? '<div><strong>Modèle&nbsp;:</strong> ' + escapeHtml([v.marque, v.modele, v.annee].filter(Boolean).join(' ')) + '</div>' : '',
        v.motorisation ? '<div><strong>Motorisation&nbsp;:</strong> ' + escapeHtml(v.motorisation) + '</div>' : '',
        v.kilometrage ? '<div><strong>Kilométrage&nbsp;:</strong> ' + escapeHtml(v.kilometrage) + ' km</div>' : '',
      ].filter(Boolean).join('') || '<span class="text-slate-400">Non renseigné</span>';

      var montageBlock = [
        m.date ? '<div><strong>Date&nbsp;:</strong> ' + new Date(m.date).toLocaleDateString('fr-FR') + '</div>' : '',
        g.nom ? '<div><strong>Garage&nbsp;:</strong> ' + escapeHtml(g.nom) + '</div>' : '',
        g.adresse ? '<div class="text-xs text-slate-500">' + escapeHtml(g.adresse) + '</div>' : '',
        m.reglageBase ? '<div><strong>Réglage de base&nbsp;:</strong> <span class="px-1.5 py-0.5 rounded text-xs ' +
          (m.reglageBase === 'oui' ? 'bg-emerald-100 text-emerald-800'
          : m.reglageBase === 'non' ? 'bg-red-100 text-red-800'
          : 'bg-amber-100 text-amber-800') + '">' + escapeHtml(m.reglageBase) + '</span></div>' : '',
      ].filter(Boolean).join('') || '<span class="text-slate-400">Non renseigné</span>';

      var symptomesBlock = (diag.symptomes && diag.symptomes.length)
        ? diag.symptomes.map(function (s) { return '<span class="inline-block px-2 py-0.5 rounded-full text-xs bg-amber-100 text-amber-900 mr-1 mb-1">' + escapeHtml(s) + '</span>'; }).join('')
        : '<span class="text-slate-400 text-sm">Aucun symptôme coché</span>';

      var codesBlock = (diag.codesDefaut && diag.codesDefaut.length)
        ? diag.codesDefaut.map(function (c) { return '<button type="button" data-copy-code="' + escapeHtml(c) + '" class="inline-block px-2 py-0.5 rounded text-xs bg-slate-900 text-white font-mono mr-1 mb-1 hover:bg-primary cursor-pointer" title="Cliquer pour copier">' + escapeHtml(c) + '</button>'; }).join('')
        : '<span class="text-slate-400 text-sm">Aucun</span>';

      var descrBlock = diag.description
        ? '<blockquote class="border-l-4 border-primary/40 bg-slate-50 px-3 py-2 text-sm italic text-slate-700">' + escapeHtml(diag.description) + '</blockquote>'
        : '<span class="text-slate-400 text-sm">Pas de description libre</span>';

      var cgvBlock = cgv.acceptedAt
        ? '<div class="text-xs text-slate-700 space-y-0.5">' +
          '<div>Version CGV : <strong>' + escapeHtml(cgv.version || 'v1') + '</strong></div>' +
          '<div>Acceptée : ' + new Date(cgv.acceptedAt).toLocaleString('fr-FR') + '</div>' +
          (cgv.ip ? '<div>IP : <span class="font-mono">' + escapeHtml(cgv.ip) + '</span></div>' : '') +
          (cgv.userAgent ? '<div class="text-[10px] text-slate-500 truncate">UA : ' + escapeHtml((cgv.userAgent || '').slice(0, 80)) + '</div>' : '') +
          (cgv.pdfUrl ? '<div class="mt-1"><a href="' + escapeHtml(cgv.pdfUrl) + '" target="_blank" rel="noopener" class="text-primary underline">📄 Justificatif PDF</a></div>' : '') +
          (rgpd.acceptedAt ? '<div class="mt-2 pt-2 border-t border-slate-100"><strong>RGPD :</strong> accepté le ' + new Date(rgpd.acceptedAt).toLocaleString('fr-FR') + '</div>' : '') +
          '</div>'
        : '<span class="text-slate-400 text-xs">Non horodaté</span>';

      box.innerHTML =
        '<details open class="rounded-xl border border-slate-200 bg-white p-4"><summary class="cursor-pointer text-sm font-semibold text-slate-700">Commande liée</summary><div class="mt-2 text-sm">' + commandeBlock + '</div></details>' +
        '<details open class="rounded-xl border border-slate-200 bg-white p-4"><summary class="cursor-pointer text-sm font-semibold text-slate-700">Véhicule</summary><div class="mt-2 text-sm space-y-1">' + vehiculeBlock + '</div></details>' +
        '<details open class="rounded-xl border border-slate-200 bg-white p-4"><summary class="cursor-pointer text-sm font-semibold text-slate-700">Montage</summary><div class="mt-2 text-sm space-y-1">' + montageBlock + '</div></details>' +
        '<details open class="rounded-xl border border-slate-200 bg-white p-4"><summary class="cursor-pointer text-sm font-semibold text-slate-700">Symptômes</summary><div class="mt-2">' + symptomesBlock + '</div></details>' +
        '<details class="rounded-xl border border-slate-200 bg-white p-4"><summary class="cursor-pointer text-sm font-semibold text-slate-700">Codes défaut OBD</summary><div class="mt-2">' + codesBlock + '</div></details>' +
        '<details class="rounded-xl border border-slate-200 bg-white p-4"><summary class="cursor-pointer text-sm font-semibold text-slate-700">Description du client</summary><div class="mt-2">' + descrBlock + '</div></details>' +
        '<details class="rounded-xl border border-slate-200 bg-white p-4"><summary class="cursor-pointer text-sm font-semibold text-slate-700">CGV / RGPD</summary><div class="mt-2">' + cgvBlock + '</div></details>';
    }

    var tlFilter = 'all';
    var TL_TYPE_ICON = {
      message:     'forum',
      statut:      'flag',
      systeme:     'settings_suggest',
      fournisseur: 'local_shipping',
      diagnostic:  'biotech',
    };

    // Analyse un message pour détecter le type et extraire un objet structuré
    function parseTlEntry(m) {
      var contenu = m.contenu || '';
      var canal = (m.canal || '').toLowerCase();

      // Changement de statut : "Changement de statut : X → Y"
      var mStatut = contenu.match(/^Changement de statut\s*:\s*(\S+)\s*(?:→|->)\s*(\S+)/i);
      if (mStatut) {
        return { kind: 'statut', from: mStatut[1], to: mStatut[2] };
      }
      // Document upload/ajout : "Document uploadé (kind) : nomfichier (size octets)" ou "Document ajouté (kind) : /uploads/.../file.ext"
      var mDoc = contenu.match(/^Document\s+(uploadé|ajouté)\s*\(([^)]+)\)\s*:\s*(.+?)(?:\s*\((\d+)\s*octets?\))?$/i);
      if (mDoc) {
        var raw = mDoc[3].trim();
        var filename = raw.split('/').pop();
        return { kind: 'doc', docKind: mDoc[2], filename: fixMojibake(filename), action: mDoc[1], size: mDoc[4] ? parseInt(mDoc[4], 10) : null };
      }
      // Procédure envoyée : "Procédure envoyée : Titre (url)"
      var mProc = contenu.match(/^Procédure envoyée\s*:\s*(.+?)\s*\(([^)]+)\)\s*$/i);
      if (mProc) return { kind: 'procedure', title: mProc[1], url: mProc[2] };
      // Assignation
      if (/^Ticket (assigné|désassigné|pris en charge)/i.test(contenu)) return { kind: 'assign', text: contenu };
      // Remboursement Mollie
      if (/^Remboursement Mollie/i.test(contenu)) return { kind: 'refund', text: contenu };
      // Message client/admin (inapp, email[legacy], whatsapp, tel, interne)
      var isIntern = canal === 'interne' || canal === 'note';
      if (canal === 'inapp' || canal === 'email' || canal === 'whatsapp' || canal === 'tel' || canal === 'phone' || isIntern) {
        return { kind: 'message', canal: canal || 'note', isIntern: isIntern, isClient: (m.auteur === 'client'), html: m.html, text: contenu, sujet: m.sujet, attachments: Array.isArray(m.attachments) ? m.attachments : [] };
      }
      // Fallback
      return { kind: 'systeme', text: contenu };
    }

    // Réparation des filenames mal encodés (UTF-8 lu comme Latin-1)
    function fixMojibake(s) {
      if (!s || typeof s !== 'string') return s;
      if (!/[Ã¢â€ÂÌÈ]/.test(s)) return s;
      try {
        var bytes = new Uint8Array(s.length);
        for (var i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i) & 0xff;
        return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
      } catch (_) { return s; }
    }

    function fmtSizeShort(bytes) {
      if (!bytes) return '';
      if (bytes < 1024) return bytes + ' o';
      if (bytes < 1024 * 1024) return Math.round(bytes / 1024) + ' Ko';
      return (bytes / 1024 / 1024).toFixed(1) + ' Mo';
    }

    function detectTlType(m) {
      var p = parseTlEntry(m);
      if (p.kind === 'statut') return 'statut';
      if (p.kind === 'doc' || p.kind === 'procedure') return 'systeme';
      if (p.kind === 'assign' || p.kind === 'refund') return 'systeme';
      if (p.kind === 'message') return 'message';
      return 'systeme';
    }

    function renderTimeline() {
      var box = document.getElementById('sav-timeline');
      if (!box) return;
      var msgs = (ticket.messages || []).slice().reverse();
      if (!msgs.length) {
        box.className = 'sav-timeline sav-timeline--v2';
        box.innerHTML = '<div class="text-sm text-slate-500">Aucun événement.</div>';
        return;
      }
      var filtered = msgs.filter(function (m) {
        if (tlFilter === 'all') return true;
        return detectTlType(m) === tlFilter;
      });
      box.className = 'sav-timeline sav-timeline--v2';
      if (!filtered.length) {
        box.innerHTML = '<div class="text-sm text-slate-500">Aucun événement pour ce filtre.</div>';
        return;
      }
      box.innerHTML = filtered.map(function (m, idx) {
        var p = parseTlEntry(m);
        var dateAbs = new Date(m.date).toLocaleString('fr-FR');
        var dateRel = fmtRelative(m.date);
        var relHtml = '<span class="sav-tl-time" title="' + escapeHtml(dateAbs) + '">' + escapeHtml(dateRel) + '</span>';

        // -- Status change : ligne compacte inline
        if (p.kind === 'statut') {
          return '<div class="sav-tl-compact">' +
            '<span class="material-symbols-outlined sav-tl-compact__icon">flag</span>' +
            '<span class="sav-tl-compact__text"><strong>Statut :</strong> ' +
              '<span class="sav-tl-statutpill">' + escapeHtml(labelStatut(p.from)) + '</span>' +
              ' <span class="text-slate-400">→</span> ' +
              '<span class="sav-tl-statutpill sav-tl-statutpill--to">' + escapeHtml(labelStatut(p.to)) + '</span>' +
            '</span>' +
            relHtml +
          '</div>';
        }

        // -- Document upload / procédure / assign / refund : ligne compacte aussi
        if (p.kind === 'doc') {
          return '<div class="sav-tl-compact">' +
            '<span class="material-symbols-outlined sav-tl-compact__icon" style="color:#6366f1;">attach_file</span>' +
            '<span class="sav-tl-compact__text"><strong>' + escapeHtml(p.action === 'uploadé' ? 'Doc client' : 'Doc ajouté') + '</strong> <span class="text-slate-400">·</span> ' +
              '<span class="text-slate-600">' + escapeHtml(p.docKind) + '</span> <span class="text-slate-400">·</span> ' +
              '<span class="font-mono text-[11px]">' + escapeHtml(p.filename) + '</span>' +
              (p.size ? ' <span class="text-slate-400 text-[11px]">(' + fmtSizeShort(p.size) + ')</span>' : '') +
            '</span>' +
            relHtml +
          '</div>';
        }
        if (p.kind === 'procedure') {
          return '<div class="sav-tl-compact">' +
            '<span class="material-symbols-outlined sav-tl-compact__icon" style="color:#e11d48;">menu_book</span>' +
            '<span class="sav-tl-compact__text"><strong>Procédure envoyée :</strong> ' + escapeHtml(p.title) + '</span>' +
            relHtml +
          '</div>';
        }
        if (p.kind === 'assign') {
          return '<div class="sav-tl-compact">' +
            '<span class="material-symbols-outlined sav-tl-compact__icon" style="color:#64748b;">person</span>' +
            '<span class="sav-tl-compact__text">' + escapeHtml(p.text) + '</span>' +
            relHtml +
          '</div>';
        }
        if (p.kind === 'refund') {
          return '<div class="sav-tl-compact">' +
            '<span class="material-symbols-outlined sav-tl-compact__icon" style="color:#059669;">payments</span>' +
            '<span class="sav-tl-compact__text">' + escapeHtml(p.text) + '</span>' +
            relHtml +
          '</div>';
        }

        // -- Message (email/whatsapp/interne) : carte collapsable
        if (p.kind === 'message') {
          var isClient = p.isClient;
          var canalLabel = p.canal.charAt(0).toUpperCase() + p.canal.slice(1);
          var direction = isClient ? 'IN' : 'OUT';
          var dirIcon = isClient ? 'call_received' : 'send';
          var sideCls = isClient ? 'sav-tl-msg--client' : (p.isIntern ? 'sav-tl-msg--intern' : 'sav-tl-msg--admin');
          var authorLabel = isClient ? 'Client' : (m.auteur || 'Admin');
          var preview = (p.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 140);
          var needExpand = (p.text || '').length > 140 || /<[^>]+>/.test(p.text || '') || p.html;
          var fullBody = p.html
            ? sanitizeHtml(p.html)
            : '<div>' + escapeHtml(p.text || '').replace(/\n/g, '</div><div>') + '</div>';
          return '<div class="sav-tl-msg ' + sideCls + '">' +
            '<div class="sav-tl-msg__head">' +
              '<span class="material-symbols-outlined sav-tl-msg__dir" title="' + direction + '">' + dirIcon + '</span>' +
              '<span class="sav-tl-msg__author">' + escapeHtml(authorLabel) + '</span>' +
              '<span class="sav-tl-msg__pill sav-tl-msg__pill--' + p.canal + '">' + escapeHtml(canalLabel) + '</span>' +
              (p.isIntern ? '<span class="sav-tl-msg__pill sav-tl-msg__pill--intern">Interne</span>' : '') +
              relHtml +
            '</div>' +
            (p.sujet ? '<div class="sav-tl-msg__subject">' + escapeHtml(p.sujet) + '</div>' : '') +
            (needExpand
              ? '<details class="sav-tl-msg__details"><summary class="sav-tl-msg__preview">' + escapeHtml(preview) + (preview.length === 140 ? '…' : '') + '</summary><div class="sav-tl-msg__full">' + fullBody + '</div></details>'
              : '<div class="sav-tl-msg__preview sav-tl-msg__preview--static">' + escapeHtml(preview) + '</div>') +
          '</div>';
        }

        // Fallback système
        return '<div class="sav-tl-compact">' +
          '<span class="material-symbols-outlined sav-tl-compact__icon" style="color:#94a3b8;">info</span>' +
          '<span class="sav-tl-compact__text text-slate-500">' + escapeHtml(p.text || '') + '</span>' +
          relHtml +
        '</div>';
      }).join('');
    }

    // Wire timeline filter chips (one-time)
    document.addEventListener('click', function (e) {
      var btn = e.target.closest && e.target.closest('[data-tl-filter]');
      if (!btn) return;
      tlFilter = btn.getAttribute('data-tl-filter');
      document.querySelectorAll('[data-tl-filter]').forEach(function (b) {
        b.classList.toggle('is-active', b === btn);
      });
      renderTimeline();
    });

    function renderDocuments() {
      var box = document.getElementById('sav-documents');
      if (!box) return;
      var docs = [];
      if (Array.isArray(ticket.documentsList) && ticket.documentsList.length) docs = ticket.documentsList.slice();
      else {
        var d = ticket.documents || {};
        if (d.factureMontage) docs.push({ kind: 'factureMontage', url: d.factureMontage });
        (d.photosObd || []).forEach(function (u) { docs.push({ kind: 'photoObd', url: u }); });
        if (d.confirmationReglageBase) docs.push({ kind: 'confirmationReglageBase', url: d.confirmationReglageBase });
        (d.photosVisuelles || []).forEach(function (u) { docs.push({ kind: 'photoPiece', url: u }); });
      }
      if (!docs.length) {
        box.innerHTML = '<div class="col-span-full flex flex-col items-center justify-center py-10 text-center text-slate-500"><span class="material-symbols-outlined text-5xl text-slate-300">folder_off</span><div class="mt-2 text-sm font-medium">Aucun document.</div></div>';
        return;
      }
      box.innerHTML = docs.map(function (x) {
        var img = x.mime ? /^image\//i.test(x.mime) : /\.(png|jpe?g|gif|webp|avif|heic)$/i.test(x.url || '');
        var thumb = img
          ? '<div class="aspect-video w-full overflow-hidden rounded-lg bg-slate-100 cursor-zoom-in" data-lightbox="' + escapeHtml(x.url) + '"><img src="' + escapeHtml(x.url) + '" loading="lazy" class="w-full h-full object-cover pointer-events-none"></div>'
          : '<div class="aspect-video w-full flex items-center justify-center rounded-lg bg-slate-100 text-slate-400"><span class="material-symbols-outlined text-5xl">picture_as_pdf</span></div>';
        var name = escapeHtml(x.originalName || (x.url || '').split('/').pop() || 'document');
        var meta = [];
        if (x.size) meta.push(fmtSize(x.size));
        if (x.uploadedAt) meta.push(new Date(x.uploadedAt).toLocaleDateString('fr-FR'));
        var annotateBtn = img ? '<button type="button" data-annotate="' + escapeHtml(x.url) + '" class="flex-1 text-center text-[11px] rounded-lg bg-primary text-white px-2 py-1" title="Annoter cette photo"><span class="material-symbols-outlined" style="font-size:12px;vertical-align:middle;">edit</span> Annoter</button>' : '';
        return '<div class="rounded-xl border border-slate-200 p-2 flex flex-col gap-2 bg-white">' + thumb +
          '<div class="text-xs font-semibold text-slate-700 truncate">' + escapeHtml(x.kind || 'doc') + '</div>' +
          '<div class="text-[11px] text-slate-500 truncate">' + name + '</div>' +
          (meta.length ? '<div class="text-[10px] text-slate-400">' + escapeHtml(meta.join(' · ')) + '</div>' : '') +
          '<div class="flex gap-1 mt-auto flex-wrap">' +
            '<a href="' + escapeHtml(x.url) + '" target="_blank" class="flex-1 text-center text-[11px] rounded-lg border border-slate-200 px-2 py-1 hover:bg-slate-50">Ouvrir</a>' +
            '<a href="' + escapeHtml(x.url) + '" download class="flex-1 text-center text-[11px] rounded-lg bg-slate-900 text-white px-2 py-1">Télécharger</a>' +
            annotateBtn +
          '</div></div>';
      }).join('');
      // Bind annotate buttons
      box.querySelectorAll('[data-annotate]').forEach(function (btn) {
        btn.addEventListener('click', function () { openAnnotateModal(btn.getAttribute('data-annotate')); });
      });
    }

    function avatarColor(name) {
      var s = String(name || '?');
      var h = 0;
      for (var i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
      var palette = ['#3b82f6','#10b981','#f59e0b','#8b5cf6','#ec4899','#06b6d4','#f43f5e','#22c55e','#0ea5e9'];
      return palette[h % palette.length];
    }

    function sanitizeHtml(html) {
      var div = document.createElement('div');
      div.innerHTML = String(html || '');
      div.querySelectorAll('script,style,iframe,object,embed').forEach(function (n) { n.remove(); });
      div.querySelectorAll('*').forEach(function (n) {
        for (var i = n.attributes.length - 1; i >= 0; i--) {
          var a = n.attributes[i];
          if (/^on/i.test(a.name)) n.removeAttribute(a.name);
          if ((a.name === 'href' || a.name === 'src') && /^javascript:/i.test(a.value)) n.removeAttribute(a.name);
        }
      });
      return div.innerHTML;
    }

    // ── Communications filter state ──
    var commFilter = 'messages'; // 'messages' | 'all'

    function renderMessages() {
      var box = document.getElementById('sav-messages');
      if (!box) return;
      var msgs = ticket.messages || [];
      if (!msgs.length) {
        box.innerHTML = '<div style="text-align:center;padding:2rem 0;color:#94a3b8;font-size:0.875rem;">' +
          '<span class="material-symbols-outlined" style="display:block;margin-bottom:0.25rem;font-size:32px;color:#cbd5e1;">forum</span>' +
          'Aucun message pour le moment.</div>';
        return;
      }

      var showAll = commFilter === 'all';
      var realMsgCount = 0;

      var html = msgs.map(function (m, idx) {
        var p = parseTlEntry(m);
        var dateAbs = new Date(m.date).toLocaleString('fr-FR');
        var dateRel = fmtRelative(m.date);

        // Auto-generated system messages masquerading as "messages"
        // e.g. "Ticket créé via formulaire public" — treat as system
        var isAutoMsg = p.kind === 'message' && /^(Ticket créé|Ticket crée|Ticket cré)/i.test(p.text || '');

        // ── System events (compact inline) ──
        if (p.kind !== 'message' || isAutoMsg) {
          // In "messages" mode, skip system events entirely
          if (!showAll) return '';
          var icon = 'info'; var iconColor = '#94a3b8'; var label = '';
          if (p.kind === 'statut') {
            icon = 'flag'; iconColor = '#3b82f6';
            label = '<span class="sav-tl-statutpill">' + escapeHtml(labelStatut(p.from)) + '</span> ' +
              '<span style="color:#cbd5e1;">&rarr;</span> ' +
              '<span class="sav-tl-statutpill sav-tl-statutpill--to">' + escapeHtml(labelStatut(p.to)) + '</span>';
          } else if (p.kind === 'doc') {
            icon = 'attach_file'; iconColor = '#6366f1';
            label = '<strong>' + escapeHtml(p.action === 'uploadé' ? 'Doc client' : 'Doc') + '</strong> · ' +
              '<span style="color:#64748b;">' + escapeHtml(p.docKind) + '</span> · ' +
              '<span style="font-family:monospace;font-size:11px;">' + escapeHtml(p.filename) + '</span>' +
              (p.size ? ' <span style="color:#94a3b8;font-size:11px;">(' + fmtSizeShort(p.size) + ')</span>' : '');
          } else if (p.kind === 'procedure') {
            icon = 'menu_book'; iconColor = '#e11d48';
            label = '<strong>Procédure</strong> ' + escapeHtml(p.title);
          } else if (p.kind === 'assign') {
            icon = 'person'; iconColor = '#64748b';
            label = escapeHtml(p.text);
          } else if (p.kind === 'refund') {
            icon = 'payments'; iconColor = '#059669';
            label = escapeHtml(p.text);
          } else if (isAutoMsg) {
            icon = 'smart_toy'; iconColor = '#94a3b8';
            label = escapeHtml(p.text || '');
          } else {
            label = escapeHtml(p.text || '');
          }
          return '<div class="sav-chat-sep" data-msg-type="system">' +
            '<span class="material-symbols-outlined" style="font-size:13px;color:' + iconColor + ';">' + icon + '</span> ' +
            '<span>' + label + '</span> ' +
            '<span style="font-size:10px;white-space:nowrap;color:#94a3b8;" title="' + escapeHtml(dateAbs) + '">' + escapeHtml(dateRel) + '</span>' +
          '</div>';
        }

        // ── Message bubble (chat row with avatar) ──
        realMsgCount++;
        var isClient = p.isClient;
        var isIntern = p.isIntern;
        var side = isClient ? 'client' : (isIntern ? 'intern' : 'admin');

        // Author name
        var authorLabel;
        if (isClient) {
          if (ticket.client && ticket.client.prenom) {
            authorLabel = ticket.client.prenom + ' ' + (ticket.client.nom || '');
          } else if (ticket.client && ticket.client.garage) {
            authorLabel = ticket.client.garage;
          } else {
            authorLabel = 'Client';
          }
        } else {
          authorLabel = (m.auteur && m.auteur !== 'admin') ? m.auteur : 'Agent';
        }

        // Time formatting
        var msgDate = new Date(m.date);
        var timeStr = msgDate.toLocaleTimeString('fr-FR', {hour:'2-digit', minute:'2-digit'});

        // Date separator: check if different day from previous message
        var dateSepHtml = '';
        var msgDateStr = msgDate.toLocaleDateString('fr-FR', {day:'numeric', month:'long', year:'numeric'});
        if (idx === 0 || !msgs[idx - 1] || new Date(msgs[idx - 1].date).toDateString() !== msgDate.toDateString()) {
          dateSepHtml = '<div class="sav-chat-date">' + msgDateStr + '</div>';
        }

        var rawText = p.text || '';
        // Separate attachment lines from message text
        var textParts = rawText.split(/\n*---\s*Pièces jointes\s*---\n*/);
        var mainText = textParts[0] || '';
        var pjText = textParts[1] || '';

        var fullBody = p.html
          ? sanitizeHtml(p.html)
          : '<div>' + escapeHtml(mainText).replace(/\n/g, '</div><div>') + '</div>';

        // Render attachments as clickable chips
        if (pjText) {
          var pjLines = pjText.split('\n').filter(function(l) { return l.trim(); });
          var pjHtml = '<div class="sav-bubble__attachments">';
          pjLines.forEach(function(line) {
            var parts = line.replace(/^📎\s*/, '').split(' — ');
            var label = parts[0] || '';
            var url = (parts[1] || '').trim();
            if (url) {
              pjHtml += '<a href="' + escapeHtml(url) + '" target="_blank" class="sav-bubble__pj">' +
                '<span class="material-symbols-outlined" style="font-size:14px;">attach_file</span>' +
                '<span>' + escapeHtml(label) + '</span></a>';
            }
          });
          pjHtml += '</div>';
          fullBody += pjHtml;
        }

        // Nouveau format : attachments structurés sur le message (m.attachments[])
        if (Array.isArray(p.attachments) && p.attachments.length) {
          var attHtml = '<div class="sav-bubble__attachments">';
          p.attachments.forEach(function(a) {
            if (!a || !a.url) return;
            var name = fixMojibake(a.originalName || 'pièce jointe');
            var sz = fmtSizeShort(a.size);
            attHtml += '<a href="' + escapeHtml(a.url) + '" target="_blank" rel="noopener" class="sav-bubble__pj" title="' + escapeHtml(name) + '">' +
              '<span class="material-symbols-outlined" style="font-size:14px;">attach_file</span>' +
              '<span>' + escapeHtml(name) + (sz ? ' (' + sz + ')' : '') + '</span></a>';
          });
          attHtml += '</div>';
          fullBody += attHtml;
        }
        var plainText = (p.text || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        var isLong = plainText.length > 300 || (p.html && p.html.length > 500);

        var bodyHtml;
        if (isLong) {
          bodyHtml = '<div class="sav-bubble__body sav-bubble__body--collapsed" data-bubble-body="' + idx + '">' + fullBody + '</div>' +
            '<button type="button" class="sav-bubble__expand" data-expand-idx="' + idx + '">Voir tout</button>';
        } else {
          bodyHtml = '<div class="sav-bubble__body">' + fullBody + '</div>';
        }

        // Avatar icons per side
        var avatarIcon = isClient ? 'chat_bubble' : (isIntern ? 'sticky_note_2' : 'headset_mic');

        // Build bubble content
        var bubbleHtml = '<div class="sav-bubble sav-bubble--' + side + '">' +
          (p.sujet ? '<div class="sav-bubble__subject">' + escapeHtml(p.sujet) + '</div>' : '') +
          (isIntern ? '<div class="sav-bubble__body" style="font-style:italic;">' + fullBody + '</div>' : bodyHtml) +
        '</div>';

        // Indicateur "(modifié)" si le message a été édité par un admin
        var editedHint = m.editedAt ? ' &middot; <span class="sav-chat-meta__edited" title="Modifié le ' + escapeHtml(new Date(m.editedAt).toLocaleString('fr-FR')) + (m.editedBy ? ' par ' + escapeHtml(m.editedBy) : '') + '">(modifié)</span>' : '';

        // Meta line
        var metaHtml;
        if (isIntern) {
          metaHtml = '<div class="sav-chat-meta sav-chat-meta--intern">' +
            '<span>NOTE INTERNE</span> &middot; <span>' + timeStr + '</span>' + editedHint +
          '</div>';
        } else if (isClient) {
          metaHtml = '<div class="sav-chat-meta sav-chat-meta--client">' +
            '<span>' + timeStr + '</span> &middot; <span>' + escapeHtml(authorLabel) + '</span>' + editedHint +
          '</div>';
        } else {
          metaHtml = '<div class="sav-chat-meta sav-chat-meta--admin">' +
            '<span>' + timeStr + '</span> &middot; <span>' + escapeHtml(authorLabel) + '</span>' + editedHint +
          '</div>';
        }

        // Actions : Répondre (sauf notes internes) + Modifier + Supprimer (admin only, sur tous les messages)
        var msgIdAttr = m._id ? String(m._id) : '';
        var actionButtons = '';
        if (!isIntern) {
          actionButtons += '<button type="button" class="sav-bubble__reply" data-reply-idx="' + idx + '">' +
            '<span class="material-symbols-outlined" style="font-size:13px;">reply</span> Répondre' +
          '</button>';
        }
        if (msgIdAttr) {
          actionButtons += '<button type="button" class="sav-bubble__edit" data-edit-mid="' + escapeHtml(msgIdAttr) + '" data-edit-idx="' + idx + '" title="Modifier ce message">' +
            '<span class="material-symbols-outlined" style="font-size:13px;">edit</span> Modifier' +
          '</button>';
          actionButtons += '<button type="button" class="sav-bubble__delete" data-delete-mid="' + escapeHtml(msgIdAttr) + '" title="Supprimer définitivement">' +
            '<span class="material-symbols-outlined" style="font-size:13px;">delete</span> Supprimer' +
          '</button>';
        }
        var replyHtml = actionButtons ? '<div class="sav-bubble__actions">' + actionButtons + '</div>' : '';

        // Avatar element
        var avatarHtml = '<div class="sav-chat-avatar sav-chat-avatar--' + side + '">' +
          '<span class="material-symbols-outlined">' + avatarIcon + '</span>' +
        '</div>';

        // Content block
        var contentHtml = '<div class="sav-chat-content">' + bubbleHtml + metaHtml + replyHtml + '</div>';

        // Row: client = avatar left, admin/intern = avatar right
        var rowInner;
        if (isClient) {
          rowInner = avatarHtml + contentHtml;
        } else {
          rowInner = contentHtml + avatarHtml;
        }

        return dateSepHtml + '<div class="sav-chat-row sav-chat-row--' + side + '" data-msg-idx="' + idx + '" data-msg-type="message">' +
          rowInner +
        '</div>';
      }).join('');

      // If messages-only mode and no real messages, show hint
      if (!showAll && realMsgCount === 0) {
        html = '<div style="text-align:center;padding:2rem 0;color:#94a3b8;font-size:0.875rem;">' +
          '<span class="material-symbols-outlined" style="display:block;margin-bottom:0.25rem;font-size:28px;color:#cbd5e1;">chat_bubble_outline</span>' +
          'Aucune conversation. Seuls des événements système existent.' +
          '<br><button type="button" style="color:#3b82f6;font-size:0.75rem;margin-top:0.5rem;background:none;border:none;cursor:pointer;text-decoration:underline;" ' +
          'onclick="document.querySelector(\'[data-comm-filter=all]\').click();">Voir tout l\'historique</button></div>';
      }

      box.innerHTML = html;

      // Wire expand buttons
      box.querySelectorAll('[data-expand-idx]').forEach(function (b) {
        b.addEventListener('click', function () {
          var idx = b.getAttribute('data-expand-idx');
          var body = box.querySelector('[data-bubble-body="' + idx + '"]');
          if (body) {
            body.classList.remove('sav-bubble__body--collapsed');
            b.style.display = 'none';
          }
        });
      });

      // Wire reply buttons
      box.querySelectorAll('[data-reply-idx]').forEach(function (b) {
        b.addEventListener('click', function () {
          var i = Number(b.getAttribute('data-reply-idx'));
          var m = (ticket.messages || [])[i];
          if (!m || !editor) return;
          var quoted = String(m.contenu || m.html || '').replace(/<[^>]+>/g, '').split('\n').map(function (l) { return '> ' + l; }).join('\n');
          var existing = editor.innerHTML;
          editor.innerHTML = existing + '<div><br></div><blockquote style="border-left:3px solid #cbd5e1;padding-left:8px;color:#64748b;">' +
            escapeHtml(quoted).replace(/\n/g, '<br>') + '</blockquote><div><br></div>';
          syncContenu();
          editor.focus();
          // Open composer if closed
          var wrap = document.getElementById('sav-composer-wrap');
          if (wrap && wrap.classList.contains('hidden')) wrap.classList.remove('hidden');
          // Scroll to chat (no more tabs)
          var chatEl = document.getElementById('sav-messages');
          if (chatEl) chatEl.scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      });

      // Wire edit buttons (admin uniquement) — édition inline
      box.querySelectorAll('[data-edit-mid]').forEach(function (b) {
        b.addEventListener('click', function () {
          var mid = b.getAttribute('data-edit-mid');
          var idx = Number(b.getAttribute('data-edit-idx'));
          var m = (ticket.messages || [])[idx];
          if (!m || !mid) return;
          var row = b.closest('.sav-chat-row');
          var bubble = row && row.querySelector('.sav-bubble');
          if (!bubble) return;
          if (bubble.querySelector('.sav-bubble__edit-form')) return; // déjà en édition
          var bodyEl = bubble.querySelector('.sav-bubble__body');
          var prevBodyHtml = bodyEl ? bodyEl.innerHTML : '';
          var currentText = String(m.contenu || '').replace(/<[^>]+>/g, '');
          var form = document.createElement('div');
          form.className = 'sav-bubble__edit-form';
          form.innerHTML =
            '<textarea class="sav-bubble__edit-textarea" rows="4">' + escapeHtml(currentText) + '</textarea>' +
            '<div class="sav-bubble__edit-actions">' +
              '<button type="button" class="sav-bubble__edit-cancel">Annuler</button>' +
              '<button type="button" class="sav-bubble__edit-save">Enregistrer</button>' +
            '</div>';
          if (bodyEl) bodyEl.style.display = 'none';
          bubble.appendChild(form);
          var ta = form.querySelector('textarea');
          ta.focus();
          form.querySelector('.sav-bubble__edit-cancel').addEventListener('click', function () {
            form.remove();
            if (bodyEl) bodyEl.style.display = '';
          });
          form.querySelector('.sav-bubble__edit-save').addEventListener('click', function () {
            var newVal = (ta.value || '').trim();
            if (!newVal) { toast('Contenu vide', 'error'); return; }
            if (newVal === currentText) { form.remove(); if (bodyEl) bodyEl.style.display = ''; return; }
            var saveBtn = form.querySelector('.sav-bubble__edit-save');
            saveBtn.disabled = true; saveBtn.textContent = 'Enregistrement…';
            api('/tickets/' + encodeURIComponent(numero) + '/messages/' + encodeURIComponent(mid), {
              method: 'PATCH',
              body: JSON.stringify({ contenu: newVal }),
            }).then(function (res) {
              if (res.ok && res.j && res.j.success) {
                toast('Message modifié');
                loadTicket();
              } else {
                toast((res.j && res.j.error) || 'Erreur lors de la modification', 'error');
                saveBtn.disabled = false; saveBtn.textContent = 'Enregistrer';
              }
            }).catch(function () {
              toast('Erreur réseau', 'error');
              saveBtn.disabled = false; saveBtn.textContent = 'Enregistrer';
            });
          });
        });
      });

      // Wire delete buttons (admin uniquement) — hard delete + GridFS cleanup
      box.querySelectorAll('[data-delete-mid]').forEach(function (b) {
        b.addEventListener('click', function () {
          var mid = b.getAttribute('data-delete-mid');
          if (!mid) return;
          if (!window.confirm('Supprimer définitivement ce message ?\nCette action est irréversible et supprimera également les pièces jointes associées.')) return;
          b.disabled = true;
          api('/tickets/' + encodeURIComponent(numero) + '/messages/' + encodeURIComponent(mid), {
            method: 'DELETE',
          }).then(function (res) {
            if (res.ok && res.j && res.j.success) {
              toast('Message supprimé');
              loadTicket();
            } else {
              toast((res.j && res.j.error) || 'Erreur lors de la suppression', 'error');
              b.disabled = false;
            }
          }).catch(function () {
            toast('Erreur réseau', 'error');
            b.disabled = false;
          });
        });
      });

      // Scroll to bottom (latest messages)
      box.scrollTop = box.scrollHeight;
    }

    function deriveP149State(p) {
      if (!p || !p.status || p.status === 'na') return 'non_applicable';
      if (p.status === 'payee') return 'paye';
      if (p.status === 'impayee' || p.status === 'expired' || p.status === 'failed') return 'echec';
      if (p.paymentUrl || p.mollieId) return 'lien_genere';
      return 'non_facture';
    }

    function callFacturer149(label) {
      api('/tickets/' + encodeURIComponent(numero) + '/facturer-149', { method: 'POST' })
        .then(function (res) {
          if (res.ok && res.j.success) {
            toast(label || 'Lien de paiement généré');
            if (res.j.data && res.j.data.paymentUrl) window.open(res.j.data.paymentUrl, '_blank');
            loadTicket();
          } else toast((res.j && res.j.error) || 'Erreur', 'error');
        });
    }

    function renderPaiement() {
      var box = document.getElementById('sav-paiement');
      if (!box) return;
      var p = (ticket.paiements && ticket.paiements.facture149) || {};
      var state = deriveP149State(p);

      if (state === 'non_applicable') {
        box.innerHTML = '<div class="text-sm text-slate-400">Non applicable</div>';
        return;
      }

      var amount = (p.montant != null ? p.montant : 149);
      var url = p.paymentUrl || '';

      if (state === 'non_facture') {
        box.innerHTML =
          '<div class="space-y-2">' +
            '<div class="text-sm text-slate-600">Aucun lien de paiement généré.</div>' +
            '<button type="button" class="btn btn-primary w-full text-sm" data-p149-action="create">' +
              '<span class="material-symbols-outlined" style="font-size:16px;vertical-align:middle;">add_link</span> Créer le lien Mollie' +
            '</button>' +
          '</div>';
      } else if (state === 'lien_genere') {
        box.innerHTML =
          '<div class="space-y-2">' +
            '<div><span class="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-amber-100 text-amber-800">En attente paiement</span></div>' +
            '<div class="text-sm font-semibold text-slate-900">' + Number(amount).toFixed(2) + ' €</div>' +
            (url ? '<div class="flex items-center gap-1"><a href="' + escapeHtml(url) + '" target="_blank" rel="noopener" class="text-xs text-primary underline truncate flex-1">' + escapeHtml(url) + '</a>' +
              '<button type="button" class="sav-copy-mini text-slate-400 hover:text-primary" data-copy="' + escapeHtml(url) + '" title="Copier"><span class="material-symbols-outlined" style="font-size:14px;">content_copy</span></button></div>' : '') +
            (p.dateGeneration ? '<div class="text-[10px] text-slate-400">Généré : ' + new Date(p.dateGeneration).toLocaleString('fr-FR') + '</div>' : '') +
            '<button type="button" class="btn btn-secondary w-full text-sm" data-p149-action="resend">' +
              '<span class="material-symbols-outlined" style="font-size:16px;vertical-align:middle;">forward_to_inbox</span> Renvoyer le lien' +
            '</button>' +
          '</div>';
      } else if (state === 'paye') {
        box.innerHTML =
          '<div class="space-y-2">' +
            '<div class="flex items-center gap-2 text-emerald-700"><span class="material-symbols-outlined">check_circle</span><span class="font-semibold">Payé</span></div>' +
            '<div class="text-sm font-semibold text-slate-900">' + Number(amount).toFixed(2) + ' €</div>' +
            (p.datePaiement ? '<div class="text-xs text-slate-500">Le ' + new Date(p.datePaiement).toLocaleString('fr-FR') + '</div>' : '') +
            (p.mollieId ? '<div class="text-xs"><a href="https://my.mollie.com/dashboard/payments/' + escapeHtml(p.mollieId) + '" target="_blank" rel="noopener" class="text-primary underline">Voir transaction Mollie ↗</a></div>' : '') +
            (p.qontoInvoiceUrl ? '<div class="text-xs"><a href="' + escapeHtml(p.qontoInvoiceUrl) + '" target="_blank" rel="noopener" class="text-primary underline">Facture Qonto ↗</a></div>' : '') +
          '</div>';
      } else if (state === 'echec') {
        box.innerHTML =
          '<div class="space-y-2">' +
            '<div><span class="inline-block px-2 py-0.5 rounded-full text-xs font-semibold bg-red-100 text-red-800">Échec / Expiré</span></div>' +
            '<div class="text-xs text-slate-500">Le lien précédent a échoué ou expiré.</div>' +
            '<button type="button" class="btn btn-primary w-full text-sm" data-p149-action="regenerate">' +
              '<span class="material-symbols-outlined" style="font-size:16px;vertical-align:middle;">refresh</span> Régénérer le lien' +
            '</button>' +
          '</div>';
      }

      // Wire actions
      box.querySelectorAll('[data-p149-action]').forEach(function (b) {
        b.addEventListener('click', function () {
          var act = b.getAttribute('data-p149-action');
          var label = act === 'create' ? 'Lien créé' : act === 'resend' ? 'Lien renvoyé' : 'Lien régénéré';
          callFacturer149(label);
        });
      });
      box.querySelectorAll('.sav-copy-mini').forEach(function (b) {
        b.addEventListener('click', function () {
          var v = b.getAttribute('data-copy') || '';
          if (navigator.clipboard) navigator.clipboard.writeText(v).then(function () { toast('Copié'); });
          else toast('Copié');
        });
      });
    }

    function prefillDiagEnrichi() {
      var f = document.getElementById('sav-diag-enrichi-form');
      if (!f) return;
      var d = (ticket.diagnosticEnrichi || {});
      var m = d.mesures || {};
      ['pressionHydraulique','fuiteInterne','temperatureAvant','temperatureApres'].forEach(function (k) {
        if (f.elements[k] != null) f.elements[k].value = m[k] != null ? m[k] : '';
      });
      if (f.elements.codesAvantReset) f.elements.codesAvantReset.value = (m.codesAvantReset || []).join(', ');
      if (f.elements.codesApresReset) f.elements.codesApresReset.value = (m.codesApresReset || []).join(', ');
      if (f.elements.videoUrl) f.elements.videoUrl.value = d.videoUrl || '';
      if (f.elements.courbeBancUrl) f.elements.courbeBancUrl.value = d.courbeBancUrl || '';
      if (f.elements.avis2eTechnicienTexte) f.elements.avis2eTechnicienTexte.value = d.avis2eTechnicienTexte || '';
      var sc = document.getElementById('sav-diag-score');
      if (sc) sc.textContent = d.scoreCalcule != null ? d.scoreCalcule : '—';
    }

    function prefillFournisseur() {
      var f = document.getElementById('sav-fourn-form');
      if (!f) return;
      var fo = ticket.fournisseur || {};
      ['nom','contact','rmaNumero','transporteur','colisNumero','trackingUrl','rapportUrl','reponse'].forEach(function (k) {
        if (f.elements[k] != null) f.elements[k].value = fo[k] || '';
      });
      if (f.elements.coutAnalyse) f.elements.coutAnalyse.value = fo.coutAnalyse || '';
      if (f.elements.coutRefacture) f.elements.coutRefacture.value = fo.coutRefacture || '';
      if (f.elements.dateEnvoi && fo.dateEnvoi) f.elements.dateEnvoi.value = new Date(fo.dateEnvoi).toISOString().slice(0,10);
      if (f.elements.dateRetour && fo.dateRetour) f.elements.dateRetour.value = new Date(fo.dateRetour).toISOString().slice(0,10);
    }

    // -------- Bottom sheet actions (mobile) --------
    var bottomToggle = document.getElementById('sav-bottom-toggle');
    var bottomWrap = bottomToggle && bottomToggle.closest('.sav-bottom-actions');
    if (bottomToggle && bottomWrap) {
      bottomToggle.addEventListener('click', function () {
        var open = bottomWrap.classList.toggle('is-open');
        bottomToggle.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
      // Ferme sur clic d'un bouton d'action à l'intérieur (pour libérer la vue)
      bottomWrap.addEventListener('click', function (e) {
        var btn = e.target.closest && e.target.closest('[data-action-statut],[data-action-resolution],[data-action-facturer],[data-action-pdf]');
        if (btn && bottomWrap.classList.contains('is-open')) {
          bottomWrap.classList.remove('is-open');
          bottomToggle.setAttribute('aria-expanded', 'false');
        }
      });
      // Esc ferme
      document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && bottomWrap.classList.contains('is-open')) {
          bottomWrap.classList.remove('is-open');
          bottomToggle.setAttribute('aria-expanded', 'false');
        }
      });
    }

    // -------- Onglets (legacy — no-op si pas de [data-tab] dans le DOM) --------
    document.querySelectorAll('[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () {
        var k = b.getAttribute('data-tab');
        document.querySelectorAll('[data-tab]').forEach(function (x) {
          var on = x.getAttribute('data-tab') === k;
          x.classList.toggle('is-active', on);
          x.setAttribute('aria-selected', on ? 'true' : 'false');
          x.setAttribute('tabindex', on ? '0' : '-1');
        });
        document.querySelectorAll('[data-tab-panel]').forEach(function (x) { x.classList.toggle('hidden', x.getAttribute('data-tab-panel') !== k); });
      });
    });

    // -------- Compteurs + indicateur "à compléter" sur les onglets --------
    function renderTabBadges() {
      var t = ticket || {};
      var nbDocs = Array.isArray(t.documentsList)
        ? t.documentsList.length
        : (function () {
            var d = t.documents || {}; var n = 0;
            if (d.factureMontage) n++;
            if (d.confirmationReglageBase) n++;
            n += (d.photosObd || []).length;
            n += (d.photosVisuelles || []).length;
            return n;
          })();
      // Count only real messages (not system events like status changes, docs, etc.)
      var nbMsgs = (t.messages || []).filter(function (m) {
        var p = parseTlEntry(m);
        if (p.kind !== 'message') return false;
        // Exclude auto-generated system messages
        if (/^(Ticket créé|Ticket crée|Ticket cré)/i.test(p.text || '')) return false;
        return true;
      }).length;
      var counts = { documents: nbDocs, communications: nbMsgs };

      Object.keys(counts).forEach(function (k) {
        var el = document.querySelector('[data-tab-count="' + k + '"]');
        if (!el) return;
        if (counts[k] > 0) {
          el.textContent = '(' + counts[k] + ')';
          el.classList.remove('hidden');
        } else {
          el.classList.add('hidden');
        }
      });

      // Dots "à compléter"
      var statut = t.statut || '';
      var diag = t.diagnosticEnrichi || t.diagnostic || {};
      var diagEmpty = !(diag && (diag.conclusion || diag.scoreCalcule || (diag.mesures && Object.keys(diag.mesures).length)));
      var fourn = t.fournisseur || {};
      var fournEmpty = !(fourn && (fourn.nom || fourn.contact || fourn.rmaNumero));
      var hasUnreadClient = (t.messages || []).some(function (m) {
        return m && m.lu === false && (m.auteur === 'client' || (m.canal && m.canal !== 'interne' && /client/i.test(m.auteur || '')));
      });

      var dots = {
        diagnostic: diagEmpty && /en[_ ]?analyse|analyse_terminee/i.test(statut),
        fournisseur: fournEmpty && /attente.*fourn|en_attente_fournisseur/i.test(statut),
        communications: hasUnreadClient,
      };
      Object.keys(dots).forEach(function (k) {
        var el = document.querySelector('[data-tab-dot="' + k + '"]');
        if (!el) return;
        el.classList.toggle('hidden', !dots[k]);
      });
    }
    window.renderTabBadges = renderTabBadges;

    // -------- Templates + variables + WYSIWYG + preview --------
    var TEMPLATES = {
      reception: 'Bonjour {client_prenom},\n\nNous avons bien reçu votre pièce ({piece_type}) à notre atelier. L\'analyse sur banc démarrera dans les jours qui viennent.\n\nDossier : {ticket_numero}',
      analyse_ok: 'Bonjour {client_prenom},\n\nBonne nouvelle : notre analyse confirme un défaut produit sur votre {piece_type}. Nous allons procéder à l\'échange/remboursement.\n\nDossier : {ticket_numero}',
      analyse_neg: 'Bonjour {client_prenom},\n\nNotre rapport d\'analyse est terminé. La pièce {piece_type} ne présente pas de défaut produit : un forfait de 149 € TTC vous sera facturé conformément aux CGV SAV.\n\nDossier : {ticket_numero}',
      relance_doc: 'Bonjour {client_prenom},\n\nPour traiter votre dossier {ticket_numero}, nous avons besoin de la facture du garage {garage_nom} et de la confirmation du réglage de base.',
      rdv: 'Bonjour {client_prenom},\n\nPouvez-vous nous confirmer le rendez-vous {rendez_vous_date} pour la prise en charge de votre dossier {ticket_numero} ?',
    };
    function interpolate(text) {
      if (!ticket) return text;
      var c = ticket.client || {};
      var prenom = (c.nom || c.email || '').split(' ')[0];
      return String(text || '')
        .replace(/{client_prenom}/g, escapeHtml(prenom))
        .replace(/{ticket_numero}/g, escapeHtml(ticket.numero || ''))
        .replace(/{piece_type}/g, escapeHtml(ticket.pieceType || ''))
        .replace(/{garage_nom}/g, escapeHtml((ticket.garage && ticket.garage.nom) || ''))
        .replace(/{rendez_vous_date}/g, '[à compléter]');
    }

    var editor = document.getElementById('sav-msg-editor');
    function syncContenu() {
      if (!editor) return;
      var html = editor.innerHTML;
      document.getElementById('sav-msg-html').value = html;
      document.getElementById('sav-msg-contenu').value = editor.innerText;
      renderPreview();
    }
    function renderPreview() {
      var preview = document.getElementById('sav-msg-preview');
      if (!preview || !editor) return;
      preview.innerHTML = interpolate(editor.innerHTML.replace(/&nbsp;/g, ' '));
      // Aperçu en-tête email
      var to = document.getElementById('sav-preview-to');
      var subj = document.getElementById('sav-preview-subject');
      var ref = document.getElementById('sav-preview-ref');
      var c = (ticket && ticket.client) || {};
      var sujetInput = document.querySelector('input[name="sujet"]');
      if (to) to.textContent = c.nom ? c.nom + ' <' + (c.email || '—') + '>' : (c.email || '—');
      if (subj) {
        var s = sujetInput && sujetInput.value ? sujetInput.value : '(sans objet)';
        subj.textContent = '[SAV ' + (ticket ? ticket.numero : '') + '] ' + s;
      }
      if (ref) ref.textContent = ticket ? ticket.numero : '—';
    }
    var sujetInput = document.querySelector('input[name="sujet"]');
    if (sujetInput) sujetInput.addEventListener('input', renderPreview);
    if (editor) {
      editor.addEventListener('input', syncContenu);
      document.querySelectorAll('[data-cmd]').forEach(function (b) {
        b.addEventListener('click', function () {
          document.execCommand(b.getAttribute('data-cmd'), false, null);
          editor.focus(); syncContenu();
        });
      });
      var linkBtn = document.querySelector('[data-cmd-link]');
      if (linkBtn) linkBtn.addEventListener('click', function () {
        var url = window.prompt('URL ?', 'https://');
        if (url) { document.execCommand('createLink', false, url); syncContenu(); }
      });
    }
    var tplSelect = document.getElementById('sav-template');
    function applyTemplate(v) {
      if (TEMPLATES[v] && editor) {
        editor.innerHTML = TEMPLATES[v].split('\n').map(function (l) { return '<div>' + escapeHtml(l) + '</div>'; }).join('');
        syncContenu();
      }
    }
    if (tplSelect) tplSelect.addEventListener('change', function (e) { applyTemplate(e.target.value); });

    // Templates en chips
    document.querySelectorAll('[data-template]').forEach(function (chip) {
      chip.addEventListener('click', function () { applyTemplate(chip.getAttribute('data-template')); });
    });

    function appendTemplateChip(host, t, isPerso) {
      if (TEMPLATES[t.key]) return;
      TEMPLATES[t.key] = t.body;
      var btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'sav-tpl-chip sav-tpl-chip--sm' + (isPerso ? ' sav-tpl-chip--perso' : '');
      btn.setAttribute('data-template', t.key);
      btn.setAttribute('title', t.title);
      btn.innerHTML = '<span>#' + escapeHtml(t.title) + '</span>' +
        (isPerso ? '<button type="button" class="sav-tpl-del" data-del-tpl="' + escapeHtml(t.key) + '" aria-label="Supprimer ce favori">×</button>' : '');
      btn.addEventListener('click', function (e) {
        if (e.target && e.target.matches('[data-del-tpl]')) return;
        applyTemplate(t.key);
      });
      host.appendChild(btn);
    }

    // Charge la bibliothèque de templates depuis l'API et ajoute les chips
    api('/message-templates').then(function (res) {
      if (!res.ok || !res.j.success) return;
      var list = (res.j.data && res.j.data.templates) || [];
      var host = document.getElementById('sav-templates-chips');
      if (!host) return;
      list.forEach(function (t) { appendTemplateChip(host, t, false); });
    });

    // Charge les templates personnels de l'agent connecté
    function loadPersonalTemplates() {
      if (!CURRENT_USER_ID) return;
      api('/personal-templates?userId=' + encodeURIComponent(CURRENT_USER_ID)).then(function (res) {
        if (!res.ok || !res.j.success) return;
        var list = (res.j.data && res.j.data.templates) || [];
        var host = document.getElementById('sav-templates-chips');
        if (!host) return;
        // Remove existing perso chips before re-rendering
        host.querySelectorAll('.sav-tpl-chip--perso').forEach(function (n) { n.remove(); });
        list.forEach(function (t) { delete TEMPLATES[t.key]; appendTemplateChip(host, t, true); });
      });
    }
    loadPersonalTemplates();

    // Bouton "Sauver comme favori" : ajoute un chip avec le contenu courant
    var saveFavBtn = document.getElementById('sav-save-favorite');
    if (saveFavBtn) saveFavBtn.addEventListener('click', function () {
      if (!CURRENT_USER_ID) { toast('Connecte-toi en tant qu\'agent pour sauver un favori', 'error'); return; }
      var content = editor && editor.innerText ? editor.innerText.trim() : '';
      if (!content) { toast('Le message est vide', 'error'); return; }
      var title = window.prompt('Nom du favori ?', content.split('\n')[0].slice(0, 40));
      if (!title) return;
      api('/personal-templates', { method: 'POST', body: JSON.stringify({ userId: CURRENT_USER_ID, title: title, body: content }) }).then(function (res) {
        if (res.ok && res.j.success) { toast('Favori ajouté', 'success'); loadPersonalTemplates(); }
        else toast((res.j && res.j.error) || 'Erreur', 'error');
      });
    });

    // Suppression d'un favori
    document.addEventListener('click', function (e) {
      var btn = e.target && e.target.matches && e.target.matches('[data-del-tpl]') ? e.target : null;
      if (!btn || !CURRENT_USER_ID) return;
      e.preventDefault(); e.stopPropagation();
      var key = btn.getAttribute('data-del-tpl');
      if (!confirm('Supprimer ce favori ?')) return;
      api('/personal-templates/' + encodeURIComponent(key) + '?userId=' + encodeURIComponent(CURRENT_USER_ID), { method: 'DELETE' })
        .then(function (res) {
          if (res.ok && res.j.success) { toast('Supprimé'); loadPersonalTemplates(); }
        });
    });

    // ── Communications filter (Conversation / Tout) ──
    document.querySelectorAll('.sav-comm-filter').forEach(function (btn) {
      btn.addEventListener('click', function () {
        document.querySelectorAll('.sav-comm-filter').forEach(function (x) { x.classList.remove('is-active'); });
        btn.classList.add('is-active');
        commFilter = btn.getAttribute('data-comm-filter');
        renderMessages();
      });
    });

    // ── Composer open/close ──
    var composerWrap = document.getElementById('sav-composer-wrap');
    var openComposerBtn = document.getElementById('sav-open-composer');
    var closeComposerBtn = document.getElementById('sav-close-composer');
    if (openComposerBtn && composerWrap) {
      openComposerBtn.addEventListener('click', function () {
        composerWrap.classList.remove('hidden');
        var ed = document.getElementById('sav-msg-editor');
        if (ed) ed.focus();
      });
    }
    if (closeComposerBtn && composerWrap) {
      closeComposerBtn.addEventListener('click', function () {
        composerWrap.classList.add('hidden');
      });
    }

    // ── Reformulation IA (OpenAI) ──
    (function setupReformulate() {
      var btn = document.getElementById('sav-reformulate-btn');
      var panel = document.getElementById('sav-reformulate-panel');
      var textBox = document.getElementById('sav-reformulate-text');
      var modelLbl = document.getElementById('sav-reformulate-model');
      var btnApply = document.getElementById('sav-reformulate-apply');
      var btnCancel = document.getElementById('sav-reformulate-cancel');
      var btnClose = document.getElementById('sav-reformulate-close');
      var editor = document.getElementById('sav-msg-editor');
      if (!btn || !panel || !textBox || !btnApply || !btnCancel || !editor) return;

      function hidePanel() {
        panel.classList.add('hidden');
        textBox.textContent = '';
        if (modelLbl) modelLbl.textContent = '';
      }
      function showPanel(text, model) {
        textBox.textContent = text;
        if (modelLbl) modelLbl.textContent = model ? '· ' + model : '';
        panel.classList.remove('hidden');
        panel.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      }

      btn.addEventListener('click', function () {
        var draft = (editor.innerText || '').trim();
        if (!draft) {
          toast('Tapez d\'abord un brouillon à reformuler.', 'error');
          editor.focus();
          return;
        }
        if (draft.length > 5000) {
          toast('Brouillon trop long (max 5000 caractères).', 'error');
          return;
        }
        // Animation de chargement sur le bouton
        var prev = btn.innerHTML;
        btn.disabled = true;
        btn.innerHTML = '<span class="material-symbols-outlined" style="font-size:18px;animation:spin 1s linear infinite;">progress_activity</span>';
        api('/tickets/' + encodeURIComponent(numero) + '/reformulate', {
          method: 'POST',
          body: JSON.stringify({ draft: draft }),
        }).then(function (res) {
          btn.disabled = false;
          btn.innerHTML = prev;
          if (!res.ok || !res.j || !res.j.success) {
            var msg = (res.j && res.j.error) || 'Erreur reformulation';
            toast(msg, 'error');
            return;
          }
          var d = res.j.data || {};
          if (!d.reformulated) {
            toast('Reformulation vide', 'error');
            return;
          }
          showPanel(d.reformulated, d.model || '');
        }).catch(function (e) {
          btn.disabled = false;
          btn.innerHTML = prev;
          toast('Erreur réseau : ' + (e && e.message ? e.message : 'inconnue'), 'error');
        });
      });

      btnApply.addEventListener('click', function () {
        var t = textBox.textContent || '';
        if (!t.trim()) { hidePanel(); return; }
        // Remplace l'éditeur par la version reformulée (texte brut, sauts de ligne préservés)
        editor.innerText = t;
        // Met à jour les hidden inputs de la même manière que la frappe utilisateur
        var contenuField = document.getElementById('sav-msg-contenu');
        var htmlField = document.getElementById('sav-msg-html');
        if (contenuField) contenuField.value = t;
        if (htmlField) htmlField.value = editor.innerHTML;
        hidePanel();
        toast('Reformulation appliquée', 'success');
        editor.focus();
      });
      btnCancel.addEventListener('click', hidePanel);
      if (btnClose) btnClose.addEventListener('click', hidePanel);
    })();

    // Pills toggle canaux + show/hide subject & preview
    var canalInput = document.getElementById('sav-canal-input');
    var subjectInput = document.getElementById('sav-msg-subject');
    var emailPreviewWrap = document.getElementById('sav-email-preview-wrap');

    function updateCanalUI(canal) {
      var isEmail = canal === 'email';
      if (subjectInput) subjectInput.classList.toggle('is-hidden', !isEmail);
      if (emailPreviewWrap) emailPreviewWrap.classList.toggle('hidden', !isEmail);
      // Adapte le placeholder de l'éditeur selon le canal
      var ed = document.getElementById('sav-msg-editor');
      if (ed) {
        var ph = canal === 'inapp' ? 'Message visible dans l\'espace client (sans email)…'
               : canal === 'interne' ? 'Note interne (visible uniquement par l\'équipe)…'
               : 'Tapez votre réponse…';
        ed.setAttribute('data-placeholder', ph);
      }
    }

    document.querySelectorAll('.sav-canal-pill').forEach(function (p) {
      p.addEventListener('click', function () {
        document.querySelectorAll('.sav-canal-pill').forEach(function (x) {
          x.classList.remove('is-active');
          x.setAttribute('aria-checked', 'false');
        });
        p.classList.add('is-active');
        p.setAttribute('aria-checked', 'true');
        var canal = p.getAttribute('data-canal');
        if (canalInput) canalInput.value = canal;
        updateCanalUI(canal);
      });
    });

    // Init canal UI on page load (défaut = inapp)
    updateCanalUI(canalInput ? canalInput.value : 'inapp');

    // -------- Brouillon localStorage --------
    var DRAFT_KEY = 'sav-draft-' + numero;
    var draftStatus = document.getElementById('sav-draft-status');
    var draftSavedAt = null;
    var draftTimer = null;

    function setDraftStatus() {
      if (!draftStatus) return;
      if (!draftSavedAt) { draftStatus.textContent = ''; return; }
      var s = Math.max(1, Math.floor((Date.now() - draftSavedAt) / 1000));
      draftStatus.textContent = 'Brouillon sauvegardé · il y a ' + s + ' s';
    }
    setInterval(setDraftStatus, 5000);

    function persistDraft() {
      try {
        var payload = {
          html: editor ? editor.innerHTML : '',
          sujet: (document.querySelector('[name="sujet"]') || {}).value || '',
          canal: canalInput ? canalInput.value : 'inapp',
          ts: Date.now(),
        };
        localStorage.setItem(DRAFT_KEY, JSON.stringify(payload));
        draftSavedAt = Date.now();
        setDraftStatus();
      } catch (_) {}
    }
    function clearDraft() {
      try { localStorage.removeItem(DRAFT_KEY); } catch (_) {}
      draftSavedAt = null; setDraftStatus();
    }
    function restoreDraft() {
      try {
        var raw = localStorage.getItem(DRAFT_KEY);
        if (!raw) return;
        var d = JSON.parse(raw);
        if (d.html && editor) { editor.innerHTML = d.html; syncContenu(); }
        if (d.sujet) { var s = document.querySelector('[name="sujet"]'); if (s) s.value = d.sujet; }
        if (d.canal) {
          var pill = document.querySelector('.sav-canal-pill[data-canal="' + d.canal + '"]');
          if (pill) pill.click();
        }
        draftSavedAt = d.ts || Date.now();
        setDraftStatus();
      } catch (_) {}
    }
    function scheduleDraftSave() {
      clearTimeout(draftTimer);
      draftTimer = setTimeout(persistDraft, 500);
    }
    if (editor) editor.addEventListener('input', scheduleDraftSave);
    var sujetInput = document.querySelector('[name="sujet"]');
    if (sujetInput) sujetInput.addEventListener('input', scheduleDraftSave);
    restoreDraft();

    // -------- Split button menu --------
    var sendMore = document.getElementById('sav-send-more');
    var sendMenu = document.getElementById('sav-send-menu');
    if (sendMore && sendMenu) {
      sendMore.addEventListener('click', function () {
        var open = !sendMenu.classList.contains('hidden');
        sendMenu.classList.toggle('hidden', open);
        sendMore.setAttribute('aria-expanded', String(!open));
      });
      document.addEventListener('click', function (e) {
        if (!sendMenu.contains(e.target) && e.target !== sendMore && !sendMore.contains(e.target)) {
          sendMenu.classList.add('hidden');
          sendMore.setAttribute('aria-expanded', 'false');
        }
      });
    }

    // -------- Submit (avec actions) --------
    var pendingAction = 'send';
    document.querySelectorAll('[data-send-action]').forEach(function (b) {
      b.addEventListener('click', function (e) {
        pendingAction = b.getAttribute('data-send-action');
        if (pendingAction === 'save_draft') {
          e.preventDefault();
          persistDraft();
          toast('Brouillon sauvegardé');
          if (sendMenu) sendMenu.classList.add('hidden');
          return;
        }
        if (b.tagName !== 'BUTTON' || b.type !== 'submit') {
          e.preventDefault();
          if (msgForm) msgForm.requestSubmit();
        }
      });
    });

    var msgForm = document.getElementById('sav-msg-form');

    // -------- Pièces jointes (ad-hoc + étiquette retour) --------
    var attachFiles = []; // { file, isReturnLabel }
    var attachBtn = document.getElementById('sav-attach-btn');
    var attachInput = document.getElementById('sav-attach-input');
    var attachList = document.getElementById('sav-attach-list');
    var returnLabelBtn = document.getElementById('sav-return-label-btn');
    var returnLabelInput = document.getElementById('sav-return-label-input');

    function renderAttachList() {
      if (!attachList) return;
      if (!attachFiles.length) { attachList.classList.add('hidden'); attachList.innerHTML = ''; return; }
      attachList.classList.remove('hidden');
      attachList.innerHTML = attachFiles.map(function (a, i) {
        var size = a.file.size < 1024 * 1024 ? (Math.round(a.file.size / 102.4) / 10) + ' Ko' : (Math.round(a.file.size / 104857.6) / 10) + ' Mo';
        var label = a.isReturnLabel ? '<span class="ml-1 px-1.5 py-0.5 rounded bg-amber-100 text-amber-800 text-[9px] font-semibold uppercase">Étiquette retour</span>' : '';
        return '<li class="flex items-center gap-2 text-xs bg-white border border-slate-200 rounded px-2 py-1">'
          + '<span class="material-symbols-outlined text-slate-500" style="font-size:14px;">' + (a.file.type.indexOf('image') === 0 ? 'image' : 'picture_as_pdf') + '</span>'
          + '<span class="flex-1 truncate">' + escapeHtml(a.file.name) + '</span>'
          + label
          + '<span class="text-slate-400">' + size + '</span>'
          + '<button type="button" data-attach-remove="' + i + '" class="text-slate-400 hover:text-rose-600" title="Retirer">'
          + '<span class="material-symbols-outlined" style="font-size:14px;">close</span></button>'
          + '</li>';
      }).join('');
    }
    if (attachList) {
      attachList.addEventListener('click', function (e) {
        var t = e.target.closest('[data-attach-remove]');
        if (!t) return;
        attachFiles.splice(parseInt(t.getAttribute('data-attach-remove'), 10), 1);
        renderAttachList();
      });
    }
    if (attachBtn && attachInput) {
      attachBtn.addEventListener('click', function () { attachInput.click(); });
      attachInput.addEventListener('change', function () {
        for (var i = 0; i < attachInput.files.length; i++) {
          if (attachFiles.length >= 5) { toast('Maximum 5 fichiers', 'error'); break; }
          attachFiles.push({ file: attachInput.files[i], isReturnLabel: false });
        }
        attachInput.value = '';
        renderAttachList();
      });
    }
    if (returnLabelBtn && returnLabelInput) {
      returnLabelBtn.addEventListener('click', function () { returnLabelInput.click(); });
      returnLabelInput.addEventListener('change', function () {
        var f = returnLabelInput.files[0];
        if (!f) return;
        // retirer précédente étiquette retour s'il y en a une
        attachFiles = attachFiles.filter(function (a) { return !a.isReturnLabel; });
        attachFiles.push({ file: f, isReturnLabel: true });
        returnLabelInput.value = '';
        renderAttachList();

        // Pré-remplir sujet et corps
        var sujet = document.querySelector('[name="sujet"]');
        if (sujet && !sujet.value) sujet.value = 'Votre étiquette de retour prépayée — SAV ' + numero;
        if (editor && !editor.textContent.trim()) {
          editor.innerHTML = '<p>Bonjour {client_prenom},</p>'
            + '<p>Vous trouverez en pièce jointe votre <strong>étiquette de retour prépayée</strong> pour le renvoi de votre pièce concernant le ticket SAV <strong>{ticket_numero}</strong>.</p>'
            + '<p><u>Instructions&nbsp;:</u></p>'
            + '<ul><li>Emballez soigneusement la pièce (carton + calage)</li>'
            + '<li>Collez l\'étiquette sur le colis (bien visible, sans plier le code-barres)</li>'
            + '<li>Déposez le colis au point relais ou bureau indiqué sur l\'étiquette</li>'
            + '<li>Conservez le récépissé de dépôt jusqu\'à réception chez nous</li></ul>'
            + '<p>Dès réception à l\'atelier, nous vous tiendrons informé de l\'avancement de l\'analyse.</p>'
            + '<p>Cordialement,<br>L\'équipe SAV CarParts France</p>';
          syncContenu();
        }
        toast('Étiquette retour ajoutée');
      });
    }

    function doSend(action, nextStatut) {
      var canal = (canalInput && canalInput.value) || 'inapp';
      var sujet = (document.querySelector('[name="sujet"]') || {}).value || '';
      var contenu = interpolate(document.getElementById('sav-msg-contenu').value || '');
      var html = interpolate(document.getElementById('sav-msg-html').value || '');

      var hasFiles = attachFiles.length > 0;
      var fetchOpts;
      if (hasFiles) {
        var fd = new FormData();
        fd.append('canal', canal);
        fd.append('sujet', sujet);
        fd.append('contenu', contenu);
        fd.append('html', html);
        if (attachFiles.some(function (a) { return a.isReturnLabel; })) fd.append('isReturnLabel', '1');
        attachFiles.forEach(function (a) { fd.append('attachments', a.file, a.file.name); });
        fetchOpts = { method: 'POST', headers: { 'Authorization': 'Bearer ' + TOKEN }, body: fd };
      } else {
        fetchOpts = { method: 'POST', headers: H, body: JSON.stringify({ canal: canal, sujet: sujet, contenu: contenu, html: html }) };
      }

      return fetch('/admin/api/sav/tickets/' + encodeURIComponent(numero) + '/communication', fetchOpts)
        .then(function (r) { return r.json().then(function (j) { return { ok: r.ok, j: j }; }); })
        .then(function (res) {
        if (!(res.ok && res.j.success)) { toast(res.j.error || 'Erreur', 'error'); return; }
        toast('Message envoyé via ' + canal + (hasFiles ? ' (+' + attachFiles.length + ' PJ)' : ''));
        editor.innerHTML = '';
        syncContenu();
        clearDraft();
        attachFiles = [];
        renderAttachList();
        // Collapse composer after send
        var cw = document.getElementById('sav-composer-wrap');
        if (cw) cw.classList.add('hidden');
        if (action === 'send_and_status' && nextStatut) {
          return api('/tickets/' + encodeURIComponent(numero) + '/statut', {
            method: 'PATCH', body: JSON.stringify({ statut: nextStatut, auteur: 'admin' }),
          }).then(function () { toast('Statut → ' + nextStatut); loadTicket(); });
        }
        // Si une macro playbook est en attente, applique son statut cible
        var pbNext = (typeof consumePlaybookPendingStatut === 'function') ? consumePlaybookPendingStatut() : null;
        if (pbNext) {
          return api('/tickets/' + encodeURIComponent(numero) + '/statut', {
            method: 'PATCH', body: JSON.stringify({ statut: pbNext, auteur: 'admin' }),
          }).then(function (r) {
            if (r.ok && r.j.success) toast('Statut → ' + pbNext);
            else if (r.j && r.j.error) toast(r.j.error, 'error');
            loadTicket();
          });
        }
        loadTicket();
      });
    }
    if (msgForm) msgForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var nextStatut = null;
      if (pendingAction === 'send_and_status') {
        var btn = document.querySelector('[data-send-action="send_and_status"]');
        nextStatut = btn && btn.getAttribute('data-next-statut');
        if (sendMenu) sendMenu.classList.add('hidden');
      }
      doSend(pendingAction, nextStatut);
      pendingAction = 'send';
    });

    // Cmd+Enter / Cmd+S sur l'éditeur
    if (editor) {
      editor.addEventListener('keydown', function (e) {
        var meta = e.metaKey || e.ctrlKey;
        if (!meta) return;
        if (e.key === 'Enter') { e.preventDefault(); pendingAction = 'send'; if (msgForm) msgForm.requestSubmit(); }
        else if (e.key === 's' || e.key === 'S') { e.preventDefault(); persistDraft(); toast('Brouillon sauvegardé'); }
      });
    }

    // -------- Diagnostic Wizard 4 étapes --------
    var diagState = {
      step: 1,
      data: {
        pressionHydraulique: '', fuiteInterne: '', temperatureAvant: '', temperatureApres: '',
        codesAvantReset: '', codesApresReset: '', codesDefaut: '',
        videoUrl: '', courbeBancUrl: '', rapport: '',
        conclusion: '', avis2eTechnicienTexte: '',
      },
    };
    var STEP_LABELS = { 1: 'Mesures', 2: 'Codes défaut', 3: 'Médias', 4: 'Conclusion' };

    function computeScore(d) {
      var sympts = (ticket && ticket.diagnostic && ticket.diagnostic.symptomes) || [];
      var score = Math.min(40, sympts.length * 5);
      if (d.pressionHydraulique !== '' && Number(d.pressionHydraulique) < 5) score += 20;
      if (d.fuiteInterne && String(d.fuiteInterne).toLowerCase() !== 'non') score += 15;
      if ((d.codesAvantReset || '').split(/[,\s]+/).filter(Boolean).length > 0) score += 10;
      if ((d.codesApresReset || '').split(/[,\s]+/).filter(Boolean).length > 0) score += 15;
      return Math.min(100, score);
    }
    window.computeScore = computeScore;

    // Ranges de validation des mesures banc (min/max hard, warn si hors min_ok/max_ok)
    var DIAG_RANGES = {
      pressionHydraulique: { min: 0, max: 15, min_ok: 3.5, max_ok: 6, unit: 'bar', warn: 'Pression inhabituelle — vérifier le banc (normal : 3,5–6 bar)' },
      temperatureAvant:    { min: -20, max: 150, min_ok: 10, max_ok: 40, unit: '°C', warn: 'Température ambiante inhabituelle' },
      temperatureApres:    { min: -20, max: 150, min_ok: 60, max_ok: 110, unit: '°C', warn: 'Température fonctionnement hors plage (normal : 70–95 °C)' },
    };

    function validateDiagField(key, value) {
      var r = DIAG_RANGES[key];
      if (!r || value === '' || value == null) return { ok: true };
      var v = Number(value);
      if (isNaN(v)) return { ok: false, error: 'Valeur numérique attendue' };
      if (v < r.min || v > r.max) return { ok: false, error: 'Hors plage autorisée (' + r.min + '–' + r.max + ' ' + r.unit + ')' };
      if (v < r.min_ok || v > r.max_ok) return { ok: true, warn: r.warn };
      return { ok: true };
    }

    function renderDiagWizard() {
      var cur = document.querySelector('[data-diag-current]');
      var label = document.querySelector('[data-diag-step-label]');
      var bar = document.querySelector('[data-diag-progress]');
      var pct = document.querySelector('[data-diag-pct]');
      if (cur) cur.textContent = String(diagState.step);
      if (label) label.textContent = STEP_LABELS[diagState.step];
      var width = diagState.step * 25;
      if (bar) bar.style.width = width + '%';
      if (pct) pct.textContent = String(width);
      document.querySelectorAll('.sav-diag-step').forEach(function (el) {
        el.classList.toggle('hidden', Number(el.getAttribute('data-diag-step')) !== diagState.step);
      });
      // Pills stepper : done / current / todo
      document.querySelectorAll('[data-diag-pill]').forEach(function (p) {
        var n = Number(p.getAttribute('data-diag-pill'));
        p.classList.remove('is-done', 'is-current');
        if (n < diagState.step) p.classList.add('is-done');
        else if (n === diagState.step) p.classList.add('is-current');
      });
      var prev = document.getElementById('sav-diag-prev');
      var next = document.getElementById('sav-diag-next');
      var save = document.getElementById('sav-diag-save');
      if (prev) prev.disabled = diagState.step === 1;
      if (next) next.classList.toggle('hidden', diagState.step === 4);
      if (save) save.classList.toggle('hidden', diagState.step !== 4);
      var sc = document.querySelector('[data-diag-score-display]');
      if (sc) sc.textContent = String(computeScore(diagState.data));
      var legacySc = document.getElementById('sav-diag-score');
      if (legacySc) legacySc.textContent = String(computeScore(diagState.data));
    }

    function updateDiagFieldFeedback(el) {
      var key = el.getAttribute('data-diag-field');
      if (!DIAG_RANGES[key]) return;
      var res = validateDiagField(key, el.value);
      var errEl = document.querySelector('[data-diag-error="' + key + '"]');
      el.classList.remove('sav-input--warning');
      el.classList.remove('border-red-500');
      if (errEl) { errEl.classList.add('hidden'); errEl.textContent = ''; }
      if (!res.ok) {
        el.classList.add('border-red-500');
        if (errEl) { errEl.classList.remove('hidden'); errEl.textContent = res.error; }
      } else if (res.warn) {
        el.classList.add('sav-input--warning');
        if (errEl) { errEl.classList.remove('hidden'); errEl.textContent = res.warn; errEl.classList.add('text-amber-700'); }
      }
    }

    document.querySelectorAll('[data-diag-field]').forEach(function (el) {
      el.addEventListener('input', function () {
        diagState.data[el.getAttribute('data-diag-field')] = el.value;
        updateDiagFieldFeedback(el);
        renderDiagWizard();
      });
      el.addEventListener('change', function () {
        diagState.data[el.getAttribute('data-diag-field')] = el.value;
        updateDiagFieldFeedback(el);
        renderDiagWizard();
      });
    });

    // Allow clicking on stepper pills to jump steps
    document.querySelectorAll('[data-diag-pill]').forEach(function (p) {
      p.style.cursor = 'pointer';
      p.addEventListener('click', function () {
        var n = Number(p.getAttribute('data-diag-pill'));
        if (n >= 1 && n <= 4) { diagState.step = n; renderDiagWizard(); }
      });
    });

    var diagPrev = document.getElementById('sav-diag-prev');
    var diagNext = document.getElementById('sav-diag-next');
    var diagSave = document.getElementById('sav-diag-save');
    if (diagPrev) diagPrev.addEventListener('click', function () { if (diagState.step > 1) { diagState.step--; renderDiagWizard(); } });
    if (diagNext) diagNext.addEventListener('click', function () { if (diagState.step < 4) { diagState.step++; renderDiagWizard(); } });
    if (diagSave) diagSave.addEventListener('click', function () {
      if (!diagState.data.conclusion) { toast('Conclusion requise', 'error'); return; }
      api('/tickets/' + encodeURIComponent(numero) + '/diagnostic-complet', {
        method: 'POST', body: JSON.stringify(diagState.data),
      }).then(function (res) {
        if (res.ok && res.j.success) {
          toast('Diagnostic enregistré · score ' + (res.j.data.scoreCalcule || '?'));
          loadTicket();
        } else toast((res.j && res.j.error) || 'Erreur', 'error');
      });
    });
    renderDiagWizard();

    // Stub legacy variables (referenced ailleurs)
    var diagForm = document.getElementById('sav-diag-form');
    var diagEnrichiForm = document.getElementById('sav-diag-enrichi-form');

    // -------- Fournisseur --------
    // Persist <details data-fourn-section> open state in localStorage
    document.querySelectorAll('details[data-fourn-section]').forEach(function (d) {
      var key = 'sav-fourn-section-' + d.getAttribute('data-fourn-section');
      var saved = localStorage.getItem(key);
      if (saved === 'open') d.open = true;
      else if (saved === 'closed') d.open = false;
      d.addEventListener('toggle', function () {
        try { localStorage.setItem(key, d.open ? 'open' : 'closed'); } catch (_) {}
      });
    });

    var fournForm = document.getElementById('sav-fourn-form');
    if (fournForm) fournForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var fd = new FormData(e.target);
      var payload = {};
      fd.forEach(function (v, k) { payload[k] = v; });
      payload.changeStatutToEnAttente = fd.get('changeStatutToEnAttente') === 'on';
      api('/tickets/' + encodeURIComponent(numero) + '/fournisseur', { method: 'POST', body: JSON.stringify(payload) })
        .then(function (res) {
          if (res.ok && res.j.success) { toast('Fournisseur sauvegardé'); loadTicket(); }
          else toast(res.j.error || 'Erreur', 'error');
        });
    });
    var trackBtn = document.getElementById('sav-fourn-track');
    if (trackBtn) trackBtn.addEventListener('click', function () {
      var url = (ticket && ticket.fournisseur && ticket.fournisseur.trackingUrl) || '';
      if (url) window.open(url, '_blank');
      else toast('Pas d\'URL de tracking enregistrée', 'error');
    });

    // -------- WhatsApp fournisseur (4.2) --------
    var waBtn = document.getElementById('sav-fourn-whatsapp');
    var waModal = document.getElementById('sav-wa-modal');
    var waPhone = document.getElementById('sav-wa-phone');
    var waText = document.getElementById('sav-wa-text');
    var waLink = document.getElementById('sav-wa-link');
    var waCopy = document.getElementById('sav-wa-copy');
    var waSend = document.getElementById('sav-wa-send');
    var waSaveReply = document.getElementById('sav-wa-save-reply');
    var waClientScript = document.getElementById('sav-wa-client-script');
    function openWa() {
      var phone = (ticket && ticket.fournisseur && ticket.fournisseur.contact) || '';
      api('/tickets/' + encodeURIComponent(numero) + '/whatsapp-fournisseur/preview?phone=' + encodeURIComponent(phone))
        .then(function (res) {
          if (!res.ok) { toast('Erreur preview', 'error'); return; }
          var d = res.j.data;
          waPhone.value = phone;
          waText.value = d.text || '';
          waClientScript.value = d.clientScript || '';
          waLink.href = d.waUrl || '#';
          openModal(waModal);
        });
    }
    function closeWa() { if (waModal) closeModal(waModal); }
    if (waBtn) waBtn.addEventListener('click', openWa);
    if (waModal) waModal.addEventListener('click', function (e) { if (e.target === waModal || (e.target.matches && e.target.matches('[data-close-wa]'))) closeWa(); });
    if (waPhone) waPhone.addEventListener('input', function () {
      var clean = waPhone.value.replace(/[^\d]/g, '');
      waLink.href = clean ? 'https://wa.me/' + clean + '?text=' + encodeURIComponent(waText.value) : '#';
    });
    if (waText) waText.addEventListener('input', function () {
      var clean = (waPhone.value || '').replace(/[^\d]/g, '');
      waLink.href = clean ? 'https://wa.me/' + clean + '?text=' + encodeURIComponent(waText.value) : '#';
    });
    if (waCopy) waCopy.addEventListener('click', function () {
      navigator.clipboard.writeText(waText.value).then(function () { toast('Texte copié'); });
    });
    if (waSend) waSend.addEventListener('click', function () {
      api('/tickets/' + encodeURIComponent(numero) + '/whatsapp-fournisseur/send', {
        method: 'POST', body: JSON.stringify({ phone: waPhone.value }),
      }).then(function (res) {
        if (res.ok && res.j.success) { toast('Envoi enregistré'); loadTicket(); }
        else toast(res.j.error || 'Erreur', 'error');
      });
    });
    if (waSaveReply) waSaveReply.addEventListener('click', function () {
      var reply = document.getElementById('sav-wa-reply').value;
      api('/tickets/' + encodeURIComponent(numero) + '/whatsapp-fournisseur/send', {
        method: 'POST', body: JSON.stringify({ phone: waPhone.value, parsedReply: reply }),
      }).then(function (res) {
        if (res.ok && res.j.success) { toast('Réponse enregistrée'); closeWa(); loadTicket(); }
        else toast(res.j.error || 'Erreur', 'error');
      });
    });

    // -------- Actions sidebar --------
    function withConfirm(btn, action) {
      var msg = btn.getAttribute('data-confirm');
      if (!msg) return action();
      var modal = document.getElementById('sav-confirm-modal');
      var text = document.getElementById('sav-confirm-text');
      var ok = document.getElementById('sav-confirm-ok');
      var cancel = document.getElementById('sav-confirm-cancel');
      if (!modal) { if (window.confirm(msg)) action(); return; }
      text.textContent = msg;
      openModal(modal);
      function close() { closeModal(modal); ok.removeEventListener('click', go); cancel.removeEventListener('click', close); }
      function go() { close(); action(); }
      ok.addEventListener('click', go);
      cancel.addEventListener('click', close);
    }

    document.querySelectorAll('[data-action-statut]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var statut = btn.getAttribute('data-action-statut');
        withConfirm(btn, function () {
          api('/tickets/' + encodeURIComponent(numero) + '/statut', { method: 'PATCH', body: JSON.stringify({ statut: statut, auteur: 'admin' }) })
            .then(function (res) { if (res.ok && res.j.success) { toast('Statut → ' + statut); loadTicket(); } else toast(res.j.error || 'Erreur', 'error'); });
        });
      });
    });
    document.querySelectorAll('[data-action-resolution]').forEach(function (btn) {
      btn.addEventListener('click', function () {
        var type = btn.getAttribute('data-action-resolution');
        api('/tickets/' + encodeURIComponent(numero) + '/resolution', { method: 'POST', body: JSON.stringify({ type: type }) })
          .then(function (res) { if (res.ok && res.j.success) { toast('Résolution : ' + type); loadTicket(); } else toast(res.j.error || 'Erreur', 'error'); });
      });
    });
    var fact = document.querySelector('[data-action-facturer]');
    if (fact) fact.addEventListener('click', function () {
      withConfirm(fact, function () {
        api('/tickets/' + encodeURIComponent(numero) + '/facturer-149', { method: 'POST' })
          .then(function (res) {
            if (res.ok && res.j.success) {
              toast('Lien de paiement généré');
              if (res.j.data.paymentUrl) window.open(res.j.data.paymentUrl, '_blank');
              loadTicket();
            } else toast(res.j.error || 'Erreur', 'error');
          });
      });
    });
    // -------- Modal annotations photos (canvas overlay) --------
    function openAnnotateModal(imageUrl) {
      var modal = document.getElementById('sav-annotate-modal');
      if (!modal) return;
      openModal(modal);
      var img = modal.querySelector('[data-annotate-img]');
      var canvas = modal.querySelector('[data-annotate-canvas]');
      var saveBtn = modal.querySelector('[data-annotate-save]');
      var clearBtn = modal.querySelector('[data-annotate-clear]');
      var colorBtns = modal.querySelectorAll('[data-annotate-color]');
      var toolBtns = modal.querySelectorAll('[data-annotate-tool]');
      var ctx = canvas.getContext('2d');
      var state = { color: '#ef4444', tool: 'pen', drawing: false, startX: 0, startY: 0, lastX: 0, lastY: 0, snapshot: null };

      img.crossOrigin = 'anonymous';
      img.onload = function () {
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.style.width = img.clientWidth + 'px';
        canvas.style.height = img.clientHeight + 'px';
        ctx.clearRect(0, 0, canvas.width, canvas.height);
      };
      img.src = imageUrl;

      function getPos(e) {
        var rect = canvas.getBoundingClientRect();
        var sx = canvas.width / rect.width;
        var sy = canvas.height / rect.height;
        var clientX = e.touches ? e.touches[0].clientX : e.clientX;
        var clientY = e.touches ? e.touches[0].clientY : e.clientY;
        return { x: (clientX - rect.left) * sx, y: (clientY - rect.top) * sy };
      }

      function start(e) {
        e.preventDefault();
        var p = getPos(e);
        state.drawing = true;
        state.startX = p.x; state.startY = p.y;
        state.lastX = p.x; state.lastY = p.y;
        state.snapshot = ctx.getImageData(0, 0, canvas.width, canvas.height);
        ctx.strokeStyle = state.color;
        ctx.fillStyle = state.color;
        ctx.lineWidth = 4;
        ctx.lineCap = 'round';
        if (state.tool === 'text') {
          var t = window.prompt('Texte ?');
          state.drawing = false;
          if (t) {
            ctx.font = 'bold 22px sans-serif';
            ctx.fillText(t, p.x, p.y);
          }
        }
      }
      function move(e) {
        if (!state.drawing) return;
        e.preventDefault();
        var p = getPos(e);
        if (state.tool === 'pen') {
          ctx.beginPath();
          ctx.moveTo(state.lastX, state.lastY);
          ctx.lineTo(p.x, p.y);
          ctx.stroke();
          state.lastX = p.x; state.lastY = p.y;
        } else {
          ctx.putImageData(state.snapshot, 0, 0);
          if (state.tool === 'rect') {
            ctx.strokeRect(state.startX, state.startY, p.x - state.startX, p.y - state.startY);
          } else if (state.tool === 'circle') {
            ctx.beginPath();
            var r = Math.hypot(p.x - state.startX, p.y - state.startY);
            ctx.arc(state.startX, state.startY, r, 0, 2 * Math.PI);
            ctx.stroke();
          } else if (state.tool === 'arrow') {
            ctx.beginPath();
            ctx.moveTo(state.startX, state.startY);
            ctx.lineTo(p.x, p.y);
            ctx.stroke();
            // arrowhead
            var ang = Math.atan2(p.y - state.startY, p.x - state.startX);
            ctx.beginPath();
            ctx.moveTo(p.x, p.y);
            ctx.lineTo(p.x - 14 * Math.cos(ang - Math.PI / 7), p.y - 14 * Math.sin(ang - Math.PI / 7));
            ctx.lineTo(p.x - 14 * Math.cos(ang + Math.PI / 7), p.y - 14 * Math.sin(ang + Math.PI / 7));
            ctx.closePath();
            ctx.fill();
          }
        }
      }
      function end() { state.drawing = false; }

      canvas.onmousedown = start; canvas.onmousemove = move; canvas.onmouseup = end; canvas.onmouseleave = end;
      canvas.ontouchstart = start; canvas.ontouchmove = move; canvas.ontouchend = end;

      colorBtns.forEach(function (b) {
        b.onclick = function () {
          state.color = b.getAttribute('data-annotate-color');
          colorBtns.forEach(function (x) { x.classList.remove('ring-2', 'ring-offset-2', 'ring-slate-900'); });
          b.classList.add('ring-2', 'ring-offset-2', 'ring-slate-900');
        };
      });
      toolBtns.forEach(function (b) {
        b.onclick = function () {
          state.tool = b.getAttribute('data-annotate-tool');
          toolBtns.forEach(function (x) { x.classList.remove('bg-primary', 'text-white'); x.classList.add('bg-slate-100'); });
          b.classList.add('bg-primary', 'text-white'); b.classList.remove('bg-slate-100');
        };
      });
      clearBtn.onclick = function () { ctx.clearRect(0, 0, canvas.width, canvas.height); };

      saveBtn.onclick = function () {
        // Compose la photo + overlay sur un canvas hors-écran
        var out = document.createElement('canvas');
        out.width = canvas.width; out.height = canvas.height;
        var octx = out.getContext('2d');
        octx.drawImage(img, 0, 0, out.width, out.height);
        octx.drawImage(canvas, 0, 0);
        out.toBlob(function (blob) {
          var fd = new FormData();
          fd.append('file', blob, 'annotation-' + Date.now() + '.png');
          fd.append('kind', 'annotation');
          fetch('/admin/api/sav/tickets/' + encodeURIComponent(numero) + '/upload', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + TOKEN },
            body: fd,
          }).then(function (r) { return r.json(); }).then(function (j) {
            if (j.success) { toast('Annotation enregistrée', 'success'); closeModal(modal); loadTicket(); }
            else toast(j.error || 'Erreur', 'error');
          });
        }, 'image/png');
      };
    }
    var annotateModal = document.getElementById('sav-annotate-modal');
    if (annotateModal) annotateModal.addEventListener('click', function (e) {
      if (e.target === annotateModal || (e.target.matches && e.target.matches('[data-close-annotate]'))) closeModal(annotateModal);
    });

    // -------- Modal rapport PDF : choix de template + preview iframe --------
    var pdfTemplatesCache = null;
    function openPdfModal() {
      var modal = document.getElementById('sav-pdf-modal');
      if (!modal) return;
      if (modal.__savBuilt) { openModal(modal); return; }
      modal.__savBuilt = true;
      openModal(modal);
      var listEl = modal.querySelector('[data-pdf-templates]');
      var previewEl = modal.querySelector('[data-pdf-preview]');
      var summaryEl = modal.querySelector('[data-pdf-summary]');
      var genBtn = modal.querySelector('[data-pdf-generate]');
      var selected = 'client';

      function renderTemplates(templates) {
        listEl.innerHTML = templates.map(function (t) {
          var active = t.key === selected;
          return '<button type="button" data-pdf-tpl="' + t.key + '" class="text-left rounded-xl border-2 p-3 transition ' + (active ? 'border-primary bg-primary/5' : 'border-slate-200 hover:border-slate-300 bg-white') + '">' +
            '<div class="flex items-center gap-2 mb-1">' +
            '<span class="material-symbols-outlined text-base text-primary">' + (t.key === 'client' ? 'person' : t.key === 'interne' ? 'shield' : 'local_shipping') + '</span>' +
            '<span class="font-semibold text-sm">' + escapeHtml(t.title.replace('Rapport d\'analyse — ', '')) + '</span>' +
            '</div>' +
            '<div class="text-[11px] text-slate-500">' + escapeHtml(t.sections.length + ' sections') + '</div>' +
            '</button>';
        }).join('');
        listEl.querySelectorAll('[data-pdf-tpl]').forEach(function (btn) {
          btn.addEventListener('click', function () {
            selected = btn.getAttribute('data-pdf-tpl');
            renderTemplates(templates);
            renderSummary(templates);
          });
        });
      }
      function renderSummary(templates) {
        var current = templates.find(function (t) { return t.key === selected; });
        if (!current) return;
        summaryEl.innerHTML =
          '<div class="font-semibold text-sm mb-2">' + escapeHtml(current.title) + '</div>' +
          (current.note ? '<div class="text-[11px] text-amber-700 bg-amber-50 border border-amber-200 rounded p-2 mb-2">⚠ ' + escapeHtml(current.note) + '</div>' : '') +
          '<div class="text-xs font-semibold text-slate-600 mb-1">Sections incluses :</div>' +
          '<ul class="text-xs text-slate-700 space-y-1">' +
            current.sections.map(function (s) { return '<li class="flex items-center gap-1"><span class="material-symbols-outlined text-base text-emerald-600">check_circle</span>' + escapeHtml(s) + '</li>'; }).join('') +
          '</ul>';
        previewEl.innerHTML = '<div class="h-full flex items-center justify-center text-slate-400 text-sm text-center p-6">Cliquez sur « Générer & prévisualiser » pour voir le PDF.</div>';
      }

      function loadTemplates() {
        if (pdfTemplatesCache) { renderTemplates(pdfTemplatesCache); renderSummary(pdfTemplatesCache); return; }
        api('/report-templates').then(function (res) {
          if (!res.ok || !res.j.success) { listEl.innerHTML = '<div class="text-red-600 text-sm">Erreur de chargement des templates.</div>'; return; }
          pdfTemplatesCache = res.j.data.templates;
          renderTemplates(pdfTemplatesCache);
          renderSummary(pdfTemplatesCache);
        });
      }

      genBtn.addEventListener('click', function () {
        genBtn.disabled = true;
        genBtn.textContent = 'Génération…';
        api('/tickets/' + encodeURIComponent(numero) + '/rapport-pdf', {
          method: 'POST', body: JSON.stringify({ template: selected }),
        }).then(function (res) {
          genBtn.disabled = false;
          genBtn.textContent = 'Générer & prévisualiser';
          if (res.ok && res.j.success && res.j.data.url) {
            var url = res.j.data.url + '?t=' + Date.now();
            previewEl.innerHTML = '<iframe src="' + url + '" class="w-full h-full rounded-lg border border-slate-200" title="Aperçu PDF"></iframe>' +
              '<div class="mt-2 flex items-center justify-between text-xs">' +
                '<a href="' + res.j.data.url + '" target="_blank" class="text-primary hover:underline inline-flex items-center gap-1"><span class="material-symbols-outlined text-base">open_in_new</span>Ouvrir dans un onglet</a>' +
                '<a href="' + res.j.data.url + '" download class="text-primary hover:underline inline-flex items-center gap-1"><span class="material-symbols-outlined text-base">download</span>Télécharger</a>' +
              '</div>';
            toast('Rapport ' + selected + ' généré', 'success');
            loadTicket();
          } else toast((res.j && res.j.error) || 'Erreur', 'error');
        });
      });

      loadTemplates();
    }

    var pdf = document.querySelector('[data-action-pdf]');
    if (pdf) pdf.addEventListener('click', function (e) { e.preventDefault(); openPdfModal(); });
    var pdfModal = document.getElementById('sav-pdf-modal');
    if (pdfModal) pdfModal.addEventListener('click', function (e) {
      if (e.target === pdfModal || (e.target.matches && e.target.matches('[data-close-pdf]'))) closeModal(pdfModal);
    });

    // -------- Assignation --------
    var assignBtn = document.getElementById('sav-assign-btn');
    var assignModal = document.getElementById('sav-assign-modal');
    var assignSelect = document.getElementById('sav-assign-select');
    function openAssign() {
      api('/team').then(function (res) {
        if (!res.ok || !res.j.success) return;
        teamUsers = res.j.data.users || [];
        assignSelect.innerHTML = '<option value="">— Désassigner —</option>' +
          teamUsers.map(function (u) { return '<option value="' + u._id + '"' + (ticket && String(ticket.assignedToUserId) === String(u._id) ? ' selected' : '') + '>' + escapeHtml((u.firstName || '') + ' ' + (u.lastName || '')) + '</option>'; }).join('');
        openModal(assignModal);
      });
    }
    function closeAssign() { if (assignModal) closeModal(assignModal); }
    if (assignBtn) assignBtn.addEventListener('click', openAssign);
    if (assignModal) assignModal.addEventListener('click', function (e) { if (e.target === assignModal || (e.target.matches && e.target.matches('[data-close-assign]'))) closeAssign(); });
    var assignConfirm = document.getElementById('sav-assign-confirm');
    if (assignConfirm) assignConfirm.addEventListener('click', function () {
      var uid = assignSelect.value || null;
      api('/tickets/' + encodeURIComponent(numero) + '/assign', { method: 'POST', body: JSON.stringify({ userId: uid }) })
        .then(function (res) {
          if (res.ok && res.j.success) { closeAssign(); toast(uid ? ('Assigné à ' + res.j.data.assignedToName) : 'Désassigné'); loadTicket(); }
          else toast(res.j.error || 'Erreur', 'error');
        });
    });

    // -------- Copy numéro ticket --------
    var copyBtn = document.getElementById('sav-copy-numero');
    if (copyBtn) {
      copyBtn.addEventListener('click', function () {
        var val = copyBtn.getAttribute('data-copy') || '';
        var done = function () { toast('Copié'); };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(val).then(done).catch(function () {
            try { var ta = document.createElement('textarea'); ta.value = val; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); done(); } catch (_) { toast('Erreur copie', 'error'); }
          });
        } else {
          try { var ta = document.createElement('textarea'); ta.value = val; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); done(); } catch (_) { toast('Erreur copie', 'error'); }
        }
      });
    }

    // -------- Bannière bienvenue (once per user) --------
    var welcomeBanner = document.getElementById('sav-welcome-banner');
    var welcomeClose = document.getElementById('sav-welcome-close');
    var WELCOME_KEY = 'sav-welcome-dismissed-v1';
    function showWelcome() { if (welcomeBanner) welcomeBanner.classList.remove('hidden'); }
    function hideWelcome() {
      if (welcomeBanner) welcomeBanner.classList.add('hidden');
      try { localStorage.setItem(WELCOME_KEY, String(Date.now())); } catch (_) {}
    }
    try {
      if (!localStorage.getItem(WELCOME_KEY)) showWelcome();
    } catch (_) {}
    if (welcomeClose) welcomeClose.addEventListener('click', hideWelcome);

    // -------- Modale aide raccourcis --------
    var helpBtn = document.getElementById('sav-help-btn');
    var kbdModalDetail = document.getElementById('sav-kbd-modal');
    function openKbdDetail() { if (kbdModalDetail) openModal(kbdModalDetail); }
    function closeKbdDetail() { if (kbdModalDetail) closeModal(kbdModalDetail); }
    if (helpBtn) helpBtn.addEventListener('click', function () { showWelcome(); openKbdDetail(); });
    if (kbdModalDetail) kbdModalDetail.addEventListener('click', function (e) { if (e.target === kbdModalDetail || (e.target.matches && e.target.matches('[data-close-kbd]'))) closeKbdDetail(); });

    // Raccourcis fiche
    document.addEventListener('keydown', function (e) {
      if (e.target.matches('input,textarea,select,[contenteditable]')) return;
      if (e.key >= '1' && e.key <= '6') {
        // Legacy tab shortcuts — scroll to accordion sections instead
        var accIds = ['sav-messages', 'sav-pinned-notes-section', 'sav-documents', 'sav-diag-form', 'panel-fournisseur', 'sav-timeline-box'];
        var idx = parseInt(e.key, 10) - 1;
        var tgt = document.getElementById(accIds[idx]);
        if (tgt) {
          var det = tgt.closest('details.sav-sidebar-accordion');
          if (det) det.open = true;
          tgt.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
      if (e.key === 'a') { openAssign(); }
      if (e.key === 'e') { var c = document.querySelector('#sav-diag-form [name="conclusion"]'); if (c) { var det = c.closest('details.sav-sidebar-accordion'); if (det) det.open = true; c.scrollIntoView({ behavior: 'smooth', block: 'center' }); c.focus(); } }
      if (e.key === 's') { var b = document.querySelector('[data-action-statut]'); if (b) b.focus(); }
      if (e.key === '?' || (e.shiftKey && e.key === '/')) { e.preventDefault(); openKbdDetail(); }
      // Escape : géré par chaque modal individuellement via le focus trap
    });

    // Copier code OBD
    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-copy-code]');
      if (!b) return;
      var code = b.getAttribute('data-copy-code');
      if (navigator.clipboard) navigator.clipboard.writeText(code).then(function () { toast(code + ' copié'); });
      else toast(code);
    });

    // ----------- Réponses 1-clic (actions composites) -----------
    var QUICK_ACTIONS = {
      approve_refund: {
        confirm: 'Approuver le remboursement et notifier le client ?',
        statut: 'remboursement_initie',
        resolution: { type: 'remboursement' },
        email: {
          sujet: 'Remboursement approuvé — ticket {ticket_numero}',
          contenu: "Bonjour {client_prenom},\n\nNous vous confirmons l'approbation du remboursement de votre dossier {ticket_numero}. Le virement sera effectué sous 3 à 5 jours ouvrés sur le moyen de paiement initial.\n\nMerci de votre confiance,\nL'équipe SAV",
        },
        toast: 'Remboursement approuvé · email envoyé',
      },
      ask_photo: {
        confirm: 'Envoyer une demande de photo au client ?',
        statut: 'en_attente_documents',
        email: {
          sujet: 'Photo complémentaire requise — ticket {ticket_numero}',
          contenu: "Bonjour {client_prenom},\n\nPour avancer sur votre dossier {ticket_numero}, nous avons besoin d'une photo complémentaire de la pièce concernée. Merci de répondre directement à cet email en joignant l'image.\n\nL'équipe SAV",
        },
        toast: 'Demande de photo envoyée',
      },
      goodwill: {
        promptMontant: true,
        confirm: null,
        pinNote: '💰 Geste commercial accordé : ',
        email: {
          sujet: 'Geste commercial — ticket {ticket_numero}',
          contenu: "Bonjour {client_prenom},\n\nPour vous remercier de votre patience sur le dossier {ticket_numero}, nous vous accordons un geste commercial de {montant} €. Vous recevrez les détails sous 24h.\n\nL'équipe SAV",
        },
        toast: 'Geste commercial enregistré',
      },
    };
    function interpolateAction(str, t, extra) {
      var prenom = ((t.client && t.client.nom) || '').split(' ')[0] || 'client';
      return String(str || '')
        .replace(/\{client_prenom\}/g, prenom)
        .replace(/\{ticket_numero\}/g, t.numero || '')
        .replace(/\{montant\}/g, (extra && extra.montant) || '');
    }
    function runQuickAction(key) {
      var def = QUICK_ACTIONS[key];
      if (!def || !ticket) return;
      var extra = {};
      if (def.promptMontant) {
        var m = window.prompt('Montant du geste commercial (€) :', '20');
        if (!m) return;
        extra.montant = m;
      }
      if (def.confirm && !window.confirm(def.confirm)) return;
      var fb = document.getElementById('sav-quick-action-feedback');
      if (fb) { fb.className = 'mt-2 text-[11px] text-slate-500'; fb.textContent = 'Envoi en cours…'; }
      // Désactive les boutons pendant l'opération
      document.querySelectorAll('[data-quick-action]').forEach(function (b) { b.disabled = true; b.classList.add('opacity-50'); });

      var chain = Promise.resolve();
      // 1) Email
      if (def.email) {
        chain = chain.then(function () {
          return api('/tickets/' + encodeURIComponent(numero) + '/communication', {
            method: 'POST',
            body: JSON.stringify({
              canal: 'email',
              sujet: interpolateAction(def.email.sujet, ticket, extra),
              contenu: interpolateAction(def.email.contenu, ticket, extra),
            }),
          });
        });
      }
      // 2) Statut
      if (def.statut) {
        chain = chain.then(function () {
          return api('/tickets/' + encodeURIComponent(numero) + '/statut', {
            method: 'PATCH',
            body: JSON.stringify({ statut: def.statut, auteur: 'admin' }),
          });
        });
      }
      // 3) Résolution
      if (def.resolution) {
        chain = chain.then(function () {
          return api('/tickets/' + encodeURIComponent(numero) + '/resolution', {
            method: 'POST',
            body: JSON.stringify(def.resolution),
          });
        });
      }
      // 4) Note épinglée
      if (def.pinNote) {
        chain = chain.then(function () {
          return api('/tickets/' + encodeURIComponent(numero) + '/pinned-notes', {
            method: 'POST',
            body: JSON.stringify({ texte: def.pinNote + (extra.montant ? extra.montant + ' €' : ''), couleur: 'amber' }),
          });
        });
      }
      chain.then(function () {
        toast(def.toast || 'Action effectuée');
        if (fb) { fb.className = 'mt-2 text-[11px] text-emerald-600'; fb.textContent = '✓ ' + (def.toast || 'Fait'); }
        loadTicket();
      }).catch(function (err) {
        toast((err && err.message) || 'Erreur', 'error');
        if (fb) { fb.className = 'mt-2 text-[11px] text-red-600'; fb.textContent = '✗ ' + ((err && err.message) || 'Erreur'); }
      }).then(function () {
        document.querySelectorAll('[data-quick-action]').forEach(function (b) { b.disabled = false; b.classList.remove('opacity-50'); });
      });
    }
    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-quick-action]');
      if (!b) return;
      runQuickAction(b.getAttribute('data-quick-action'));
    });

    // -------- Picker procédure --------
    var procPickerSelected = null;
    var procPickerTimer = null;
    function openProcPicker() {
      var m = document.getElementById('sav-proc-modal');
      m.classList.remove('hidden'); m.classList.add('flex');
      procPickerSelected = null;
      document.getElementById('sav-proc-compose').classList.add('hidden');
      document.getElementById('sav-proc-message').value = '';
      document.getElementById('sav-proc-search').value = '';
      loadProcPickerList('');
    }
    function closeProcPicker() {
      var m = document.getElementById('sav-proc-modal');
      m.classList.add('hidden'); m.classList.remove('flex');
    }
    function loadProcPickerList(q) {
      var box = document.getElementById('sav-proc-list');
      box.innerHTML = '<div class="text-sm text-slate-400 py-6 text-center">Chargement…</div>';
      api('/procedures' + (q ? '?q=' + encodeURIComponent(q) : '')).then(function (res) {
        if (!res.ok || !res.j.success) { box.innerHTML = '<div class="text-sm text-rose-500 py-6 text-center">Erreur</div>'; return; }
        var items = res.j.data.procedures || [];
        if (!items.length) {
          box.innerHTML = '<div class="text-sm text-slate-400 py-6 text-center">Aucune procédure. <a href="/admin/sav/procedures" class="text-primary hover:underline">Ajouter</a></div>';
          return;
        }
        box.innerHTML = items.map(function (p) {
          var tags = (p.tags || []).map(function (t) { return '<span class="inline-block text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded mr-1">' + escapeHtml(t) + '</span>'; }).join('');
          return '<button type="button" data-proc-pick="' + escapeHtml(p._id) + '" data-proc-title="' + escapeHtml(p.title) + '" class="w-full text-left p-3 rounded-lg border border-slate-200 hover:border-rose-400 hover:bg-rose-50 mb-2 transition">' +
            '<div class="flex items-start gap-2">' +
            '<span class="material-symbols-outlined text-rose-500" style="font-size:20px;">picture_as_pdf</span>' +
            '<div class="flex-1 min-w-0">' +
              '<div class="text-sm font-semibold text-slate-800">' + escapeHtml(p.title) + '</div>' +
              (p.description ? '<div class="text-xs text-slate-500 mt-0.5">' + escapeHtml(p.description) + '</div>' : '') +
              (tags ? '<div class="mt-1">' + tags + '</div>' : '') +
            '</div></div></button>';
        }).join('');
      });
    }
    document.addEventListener('click', function (e) {
      if (e.target.closest('#sav-open-procedure-picker')) { openProcPicker(); return; }
      if (e.target.closest('#sav-proc-close') || e.target.closest('#sav-proc-cancel')) { closeProcPicker(); return; }
      var pick = e.target.closest('[data-proc-pick]');
      if (pick) {
        procPickerSelected = pick.getAttribute('data-proc-pick');
        document.getElementById('sav-proc-selected-title').textContent = pick.getAttribute('data-proc-title');
        document.getElementById('sav-proc-compose').classList.remove('hidden');
        return;
      }
      if (e.target.closest('#sav-proc-send')) {
        if (!procPickerSelected) { toast('Sélectionnez une procédure', 'error'); return; }
        var btn = document.getElementById('sav-proc-send');
        btn.disabled = true; btn.classList.add('opacity-60');
        var msg = document.getElementById('sav-proc-message').value;
        api('/tickets/' + encodeURIComponent(numero) + '/send-procedure', {
          method: 'POST',
          body: JSON.stringify({ procedureId: procPickerSelected, message: msg }),
        }).then(function (res) {
          btn.disabled = false; btn.classList.remove('opacity-60');
          if (res.ok && res.j.success) {
            toast('Procédure envoyée au client', 'success');
            closeProcPicker();
            loadTicket();
          } else {
            toast((res.j && res.j.error) || 'Erreur', 'error');
          }
        }).catch(function (err) {
          btn.disabled = false; btn.classList.remove('opacity-60');
          toast(err.message || 'Erreur', 'error');
        });
      }
    });
    document.getElementById('sav-proc-search').addEventListener('input', function (e) {
      clearTimeout(procPickerTimer);
      var v = e.target.value;
      procPickerTimer = setTimeout(function () { loadProcPickerList(v); }, 200);
    });

    // -------- Lightbox photos --------
    var lbState = { urls: [], idx: 0, zoom: 1, rot: 0 };
    function lbApply() {
      var img = document.getElementById('sav-lightbox-img');
      if (!img) return;
      img.style.transform = 'scale(' + lbState.zoom + ') rotate(' + lbState.rot + 'deg)';
      var z = document.getElementById('sav-lb-zoom-level');
      if (z) z.textContent = Math.round(lbState.zoom * 100) + '%';
      var c = document.getElementById('sav-lb-counter');
      if (c) c.textContent = (lbState.idx + 1) + ' / ' + lbState.urls.length;
    }
    function lbShow(i) {
      if (!lbState.urls.length) return;
      lbState.idx = (i + lbState.urls.length) % lbState.urls.length;
      lbState.zoom = 1; lbState.rot = 0;
      document.getElementById('sav-lightbox-img').src = lbState.urls[lbState.idx];
      lbApply();
    }
    function lbOpen(url) {
      lbState.urls = Array.prototype.map.call(document.querySelectorAll('[data-lightbox]'), function (n) { return n.getAttribute('data-lightbox'); });
      var i = lbState.urls.indexOf(url);
      if (i < 0) i = 0;
      var m = document.getElementById('sav-lightbox');
      m.classList.remove('hidden'); m.classList.add('flex');
      lbShow(i);
    }
    function lbClose() {
      var m = document.getElementById('sav-lightbox');
      m.classList.add('hidden'); m.classList.remove('flex');
    }
    document.addEventListener('click', function (e) {
      var t = e.target.closest('[data-lightbox]');
      if (t) { lbOpen(t.getAttribute('data-lightbox')); return; }
      if (e.target.closest('#sav-lightbox-close')) { lbClose(); return; }
      if (e.target.closest('#sav-lightbox-prev'))  { lbShow(lbState.idx - 1); return; }
      if (e.target.closest('#sav-lightbox-next'))  { lbShow(lbState.idx + 1); return; }
      if (e.target.closest('#sav-lb-zoom-in'))     { lbState.zoom = Math.min(5, lbState.zoom + 0.25); lbApply(); return; }
      if (e.target.closest('#sav-lb-zoom-out'))    { lbState.zoom = Math.max(0.25, lbState.zoom - 0.25); lbApply(); return; }
      if (e.target.closest('#sav-lb-rot-l'))       { lbState.rot -= 90; lbApply(); return; }
      if (e.target.closest('#sav-lb-rot-r'))       { lbState.rot += 90; lbApply(); return; }
      if (e.target.closest('#sav-lb-reset'))       { lbState.zoom = 1; lbState.rot = 0; lbApply(); return; }
    });
    document.addEventListener('keydown', function (e) {
      var m = document.getElementById('sav-lightbox');
      if (!m || m.classList.contains('hidden')) return;
      if (e.key === 'Escape') lbClose();
      else if (e.key === 'ArrowLeft') lbShow(lbState.idx - 1);
      else if (e.key === 'ArrowRight') lbShow(lbState.idx + 1);
      else if (e.key === '+' || e.key === '=') { lbState.zoom = Math.min(5, lbState.zoom + 0.25); lbApply(); }
      else if (e.key === '-') { lbState.zoom = Math.max(0.25, lbState.zoom - 0.25); lbApply(); }
      else if (e.key === 'r') { lbState.rot += 90; lbApply(); }
    });

    // -------- Arbre de décision 149€ --------
    var DECISION_TREE = {
      start: {
        q: 'La pièce a-t-elle été testée à l\'atelier ?',
        choices: [
          { label: 'Oui, test effectué', next: 'test_result' },
          { label: 'Non, pas encore', next: 'need_test' }
        ]
      },
      need_test: {
        recommendation: {
          title: 'Tester la pièce avant tout',
          desc: 'Aucune décision possible sans test technique. Démarrer l\'analyse atelier.',
          tone: 'blue',
          actionLabel: 'Passer en analyse',
          run: function () {
            return api('/tickets/' + encodeURIComponent(numero) + '/statut', { method: 'POST', body: JSON.stringify({ statut: 'en_analyse' }) });
          }
        }
      },
      test_result: {
        q: 'Le test confirme-t-il un défaut sur la pièce ?',
        choices: [
          { label: 'Défaut confirmé', next: 'defect_confirmed' },
          { label: 'Aucun défaut trouvé', next: 'no_defect' },
          { label: 'Défaut non lié à la pièce', next: 'wrong_diagnosis' }
        ]
      },
      defect_confirmed: {
        q: 'La pièce est-elle encore sous garantie ?',
        choices: [
          { label: 'Oui, sous garantie', next: 'warranty_ok' },
          { label: 'Non, hors garantie', next: 'out_warranty' }
        ]
      },
      warranty_ok: {
        recommendation: {
          title: 'Remboursement / échange sous garantie',
          desc: 'Pièce défectueuse confirmée + garantie valide. Approuver le remboursement intégral.',
          tone: 'emerald',
          actionLabel: 'Approuver remboursement',
          run: function () { return runQuickActionPromise('approve_refund'); }
        }
      },
      out_warranty: {
        q: 'Le client est-il un habitué (>3 commandes) ?',
        choices: [
          { label: 'Oui, client fidèle', next: 'goodwill_loyal' },
          { label: 'Non / occasionnel', next: 'invoice_149' }
        ]
      },
      goodwill_loyal: {
        recommendation: {
          title: 'Geste commercial recommandé',
          desc: 'Hors garantie mais fidélité client. Avoir partiel ou bon d\'achat conseillé.',
          tone: 'amber',
          actionLabel: 'Geste commercial',
          run: function () { return runQuickActionPromise('goodwill'); }
        }
      },
      no_defect: {
        q: 'Le client a-t-il accepté les frais d\'analyse 149€ à l\'ouverture ?',
        choices: [
          { label: 'Oui, accord signé', next: 'invoice_149' },
          { label: 'Non / pas clair', next: 'goodwill_clemence' }
        ]
      },
      invoice_149: {
        recommendation: {
          title: 'Facturer 149 € (analyse atelier)',
          desc: 'Aucun défaut OU hors garantie + accord client. Lien Mollie à envoyer.',
          tone: 'violet',
          actionLabel: 'Conclure analyse négative',
          run: function () {
            return api('/tickets/' + encodeURIComponent(numero) + '/statut', { method: 'POST', body: JSON.stringify({ statut: 'analyse_terminee' }) });
          }
        }
      },
      goodwill_clemence: {
        recommendation: {
          title: 'Clore en geste commercial',
          desc: 'Pas de défaut mais accord 149€ non documenté. Risque litige > coût analyse. Clore sans frais.',
          tone: 'amber',
          actionLabel: 'Geste commercial',
          run: function () { return runQuickActionPromise('goodwill'); }
        }
      },
      wrong_diagnosis: {
        recommendation: {
          title: 'Réorienter le client',
          desc: 'La panne ne vient pas de la pièce livrée. Expliquer le diagnostic et clore sans frais.',
          tone: 'blue',
          actionLabel: 'Demander une photo (clarification)',
          run: function () { return runQuickActionPromise('ask_photo'); }
        }
      }
    };

    function runQuickActionPromise(key) {
      return new Promise(function (resolve) {
        runQuickAction(key);
        setTimeout(resolve, 100);
      });
    }

    var decisionStack = [];
    function openDecisionTree() {
      decisionStack = ['start'];
      document.getElementById('sav-decision-modal').classList.remove('hidden');
      document.getElementById('sav-decision-modal').classList.add('flex');
      renderDecisionStep();
    }
    function closeDecisionTree() {
      var m = document.getElementById('sav-decision-modal');
      m.classList.add('hidden');
      m.classList.remove('flex');
    }
    function renderDecisionStep() {
      var key = decisionStack[decisionStack.length - 1];
      var node = DECISION_TREE[key];
      var body = document.getElementById('sav-decision-body');
      var trail = document.getElementById('sav-decision-trail');
      var back = document.getElementById('sav-decision-back');
      back.disabled = decisionStack.length <= 1;
      trail.textContent = 'Étape ' + decisionStack.length;
      if (!node) { body.innerHTML = '<div class="text-slate-500">Étape inconnue</div>'; return; }
      if (node.q) {
        var html = '<div class="text-base font-semibold text-slate-800 mb-4">' + escapeHtml(node.q) + '</div>';
        html += '<div class="space-y-2">';
        node.choices.forEach(function (c, i) {
          html += '<button type="button" data-decision-next="' + escapeHtml(c.next) + '" class="w-full text-left px-4 py-3 rounded-lg border border-slate-200 hover:border-violet-500 hover:bg-violet-50 text-sm font-medium text-slate-700 transition">' + escapeHtml(c.label) + '</button>';
        });
        html += '</div>';
        body.innerHTML = html;
      } else if (node.recommendation) {
        var r = node.recommendation;
        var TONES = {
          emerald: { box: 'border-emerald-200 bg-emerald-50', icon: 'text-emerald-600', title: 'text-emerald-800', desc: 'text-emerald-700' },
          amber:   { box: 'border-amber-200 bg-amber-50',     icon: 'text-amber-600',   title: 'text-amber-800',   desc: 'text-amber-700' },
          blue:    { box: 'border-blue-200 bg-blue-50',       icon: 'text-blue-600',    title: 'text-blue-800',    desc: 'text-blue-700' },
          violet:  { box: 'border-violet-200 bg-violet-50',   icon: 'text-violet-600',  title: 'text-violet-800',  desc: 'text-violet-700' }
        };
        var t = TONES[r.tone] || TONES.violet;
        var html = '<div class="rounded-xl border ' + t.box + ' p-4 mb-4">';
        html += '<div class="flex items-center gap-2 mb-2"><span class="material-symbols-outlined ' + t.icon + '">lightbulb</span><div class="text-base font-semibold ' + t.title + '">' + escapeHtml(r.title) + '</div></div>';
        html += '<div class="text-sm ' + t.desc + '">' + escapeHtml(r.desc) + '</div></div>';
        html += '<button type="button" id="sav-decision-run" class="btn btn-primary w-full inline-flex items-center justify-center gap-2"><span class="material-symbols-outlined" style="font-size:18px;">check</span>' + escapeHtml(r.actionLabel) + '</button>';
        body.innerHTML = html;
        document.getElementById('sav-decision-run').addEventListener('click', function () {
          var btn = this;
          btn.disabled = true; btn.classList.add('opacity-60');
          Promise.resolve(r.run()).then(function () {
            toast('Action exécutée', 'success');
            closeDecisionTree();
            loadTicket();
          }).catch(function (err) {
            toast((err && err.message) || 'Erreur', 'error');
            btn.disabled = false; btn.classList.remove('opacity-60');
          });
        });
      }
    }
    document.addEventListener('click', function (e) {
      if (e.target.closest('#sav-open-decision-tree')) { openDecisionTree(); return; }
      if (e.target.closest('#sav-decision-close')) { closeDecisionTree(); return; }
      if (e.target.closest('#sav-decision-back')) {
        if (decisionStack.length > 1) { decisionStack.pop(); renderDecisionStep(); }
        return;
      }
      var n = e.target.closest('[data-decision-next]');
      if (n) {
        decisionStack.push(n.getAttribute('data-decision-next'));
        renderDecisionStep();
      }
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        var m = document.getElementById('sav-decision-modal');
        if (m && !m.classList.contains('hidden')) closeDecisionTree();
      }
    });

    loadTicket();
  }

  // ============================================================
  // PROCÉDURES PAGE
  // ============================================================
  if (document.getElementById('proc-list')) {
    var procSearchTimer = null;
    function loadProcedures(q) {
      var box = document.getElementById('proc-list');
      var cnt = document.getElementById('proc-count');
      box.innerHTML = '<div class="text-sm text-slate-400 py-6 text-center">Chargement…</div>';
      api('/procedures' + (q ? '?q=' + encodeURIComponent(q) : '')).then(function (res) {
        if (!res.ok || !res.j.success) {
          box.innerHTML = '<div class="text-sm text-rose-500 py-4">Erreur</div>';
          return;
        }
        var items = res.j.data.procedures || [];
        cnt.textContent = items.length;
        if (!items.length) {
          box.innerHTML = '<div class="text-sm text-slate-400 py-6 text-center">Aucune procédure.</div>';
          return;
        }
        box.innerHTML = items.map(function (p) {
          var size = p.sizeBytes ? (Math.round(p.sizeBytes / 1024) + ' Ko') : '';
          var date = p.updatedAt ? new Date(p.updatedAt).toLocaleDateString('fr-FR') : '';
          var tags = (p.tags || []).map(function (t) { return '<span class="inline-block text-[10px] bg-slate-100 text-slate-600 px-1.5 py-0.5 rounded mr-1">' + escapeHtml(t) + '</span>'; }).join('');
          return '<div class="py-3 flex items-start gap-3">' +
            '<span class="material-symbols-outlined text-rose-500 mt-0.5">picture_as_pdf</span>' +
            '<div class="flex-1 min-w-0">' +
              '<div class="text-sm font-semibold text-slate-800">' + escapeHtml(p.title) + '</div>' +
              (p.description ? '<div class="text-xs text-slate-500 mt-0.5">' + escapeHtml(p.description) + '</div>' : '') +
              (tags ? '<div class="mt-1">' + tags + '</div>' : '') +
              '<div class="text-[10px] text-slate-400 mt-1">' + escapeHtml(p.originalName || '') + (size ? ' · ' + size : '') + (date ? ' · ' + date : '') + ' · ' + (p.downloads || 0) + ' envois</div>' +
            '</div>' +
            '<div class="flex items-center gap-1 shrink-0">' +
              '<a href="' + escapeHtml(p.fileUrl) + '" target="_blank" class="text-xs px-2 py-1 rounded border border-slate-200 hover:bg-slate-50">Ouvrir</a>' +
              '<button type="button" data-proc-delete="' + escapeHtml(p._id) + '" class="text-xs px-2 py-1 rounded border border-rose-200 text-rose-600 hover:bg-rose-50">Supprimer</button>' +
            '</div>' +
          '</div>';
        }).join('');
      });
    }
    document.getElementById('proc-search').addEventListener('input', function (e) {
      clearTimeout(procSearchTimer);
      var v = e.target.value;
      procSearchTimer = setTimeout(function () { loadProcedures(v); }, 200);
    });
    document.getElementById('proc-upload-form').addEventListener('submit', function (e) {
      e.preventDefault();
      var form = e.target;
      var fd = new FormData(form);
      var status = document.getElementById('proc-upload-status');
      status.textContent = 'Upload…';
      var token = document.querySelector('[data-sav-token]').getAttribute('data-sav-token') || '';
      fetch('/admin/api/sav/procedures', { method: 'POST', headers: { Authorization: 'Bearer ' + token }, body: fd })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          if (j.success) {
            toast('Procédure ajoutée', 'success');
            form.reset();
            status.textContent = '';
            loadProcedures('');
          } else {
            status.textContent = j.error || 'Erreur';
            toast(j.error || 'Erreur', 'error');
          }
        })
        .catch(function (err) { status.textContent = err.message; toast(err.message, 'error'); });
    });
    document.addEventListener('click', function (e) {
      var b = e.target.closest('[data-proc-delete]');
      if (!b) return;
      if (!window.confirm('Supprimer cette procédure ?')) return;
      api('/procedures/' + encodeURIComponent(b.getAttribute('data-proc-delete')), { method: 'DELETE' }).then(function (res) {
        if (res.ok && res.j.success) { toast('Supprimée', 'success'); loadProcedures(document.getElementById('proc-search').value); }
        else toast((res.j && res.j.error) || 'Erreur', 'error');
      });
    });
    loadProcedures('');
  }

  // ============================================================
  // ANALYTICS PAGE (4.5)
  // ============================================================
  if (document.getElementById('ana-monthly')) {
    api('/analytics').then(function (res) {
      if (!res.ok) { document.getElementById('sav-analytics-error').classList.remove('hidden'); return; }
      var d = res.j.data;
      // KPI top
      document.getElementById('ana-ca-recup').textContent = (d.financier.caRecupere || 0).toLocaleString('fr-FR') + ' €';
      document.getElementById('ana-cout-gar').textContent = (d.financier.coutGarantie || 0).toLocaleString('fr-FR') + ' €';
      document.getElementById('ana-balance').textContent = (d.financier.balance || 0).toLocaleString('fr-FR') + ' €';
      document.getElementById('ana-recidive').textContent = d.recidive.tauxRecidive + ' %';

      // Chart monthly
      if (window.Chart) {
        new window.Chart(document.getElementById('ana-monthly'), {
          type: 'bar',
          data: { labels: d.monthly.labels, datasets: [{ label: 'SAV', data: d.monthly.counts, backgroundColor: '#ec1313' }] },
          options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true, ticks: { precision: 0 } } } },
        });

        // Chart fournisseur (camembert : nb tickets par fournisseur, % défaut en tooltip)
        if (d.fournisseur && d.fournisseur.length) {
          new window.Chart(document.getElementById('ana-fournisseur'), {
            type: 'doughnut',
            data: {
              labels: d.fournisseur.map(function (f) { return f.nom + ' (' + f.taux + '% défaut)'; }),
              datasets: [{
                data: d.fournisseur.map(function (f) { return f.total; }),
                backgroundColor: ['#ec1313','#f97316','#f59e0b','#10b981','#0ea5e9','#6366f1','#a855f7','#ec4899'],
              }],
            },
            options: { responsive: true, plugins: { legend: { position: 'right', labels: { font: { size: 11 } } } } },
          });
        } else {
          document.getElementById('ana-fournisseur-empty').classList.remove('hidden');
        }
      }

      // Top pieces table
      var topBody = document.getElementById('ana-top-pieces');
      if (topBody) topBody.innerHTML = (d.topPieces || []).map(function (p) {
        return '<tr class="border-t border-slate-100"><td class="py-1">' + escapeHtml(p._id) + '</td><td class="text-right py-1 font-mono">' + p.count + '</td></tr>';
      }).join('') || '<tr><td colspan="2" class="py-3 text-center text-slate-400">Aucune donnée</td></tr>';

      // Avg by type table
      var avgBody = document.getElementById('ana-avg-by-type');
      if (avgBody) avgBody.innerHTML = (d.avgByType || []).map(function (p) {
        return '<tr class="border-t border-slate-100"><td class="py-1">' + escapeHtml(p.pieceType) + '</td><td class="text-right py-1">' + p.avgDays + '</td><td class="text-right py-1 text-slate-400">' + p.count + '</td></tr>';
      }).join('') || '<tr><td colspan="3" class="py-3 text-center text-slate-400">Aucune donnée</td></tr>';

      // Departments
      var deptBox = document.getElementById('ana-departments');
      if (deptBox) deptBox.innerHTML = (d.departments || []).map(function (x) {
        return '<div class="rounded-lg border border-slate-200 px-2 py-2 text-center"><div class="font-mono font-bold text-sm">' + escapeHtml(x.dept) + '</div><div class="text-[10px] text-slate-500">' + x.count + ' SAV</div></div>';
      }).join('') || '<div class="col-span-full text-center text-slate-400 text-xs">Aucun code postal détecté dans les adresses garage.</div>';
    });

    var exp = document.getElementById('sav-analytics-export');
    if (exp) exp.addEventListener('click', function (e) {
      e.preventDefault();
      window.open('/admin/api/sav/analytics.csv', '_blank');
    });
  }

  // ============================================================
  // REPUTATION PAGE (4.4)
  // ============================================================
  if (document.getElementById('rep-private-tbody')) {
    api('/reputation').then(function (res) {
      if (!res.ok) return;
      var d = res.j.data;
      document.getElementById('rep-sent').textContent = d.sent || 0;
      document.getElementById('rep-completed').textContent = d.completed || 0;
      document.getElementById('rep-avg').textContent = d.avgNote ? d.avgNote + ' / 5' : '—';
      document.getElementById('rep-redirected').textContent = d.redirected || 0;
      var tb = document.getElementById('rep-private-tbody');
      var items = d.privateFeedbacks || [];
      tb.innerHTML = items.length
        ? items.map(function (t) {
            var rf = t.reviewFeedback || {};
            return '<tr><td class="px-4 py-2 text-xs text-slate-500">' + new Date(rf.completedAt).toLocaleString('fr-FR') + '</td>' +
              '<td class="px-4 py-2 font-mono text-xs"><a class="text-primary underline" href="/admin/sav/tickets/' + encodeURIComponent(t.numero) + '">' + escapeHtml(t.numero) + '</a></td>' +
              '<td class="px-4 py-2"><span class="text-amber-500">' + ('★'.repeat(rf.note || 0)) + '</span><span class="text-slate-300">' + ('★'.repeat(5 - (rf.note || 0))) + '</span></td>' +
              '<td class="px-4 py-2 text-xs">' + escapeHtml((rf.comment || '').slice(0, 200)) + '</td></tr>';
          }).join('')
        : '<tr><td colspan="4" class="px-4 py-6 text-center text-slate-400">Aucun feedback privé.</td></tr>';
    });
  }

  // ============================================================
  // INTEGRATIONS PAGE (4.3)
  // ============================================================
  if (document.getElementById('sav-integrations-form')) {
    var intForm = document.getElementById('sav-integrations-form');
    api('/settings').then(function (res) {
      if (!res.ok) return;
      var i = res.j.data.integrations || {};
      if (intForm.elements.slackWebhookUrl) intForm.elements.slackWebhookUrl.value = i.slackWebhookUrl || '';
      if (intForm.elements.slackChannel) intForm.elements.slackChannel.value = i.slackChannel || '#sav';
      if (intForm.elements.googleReviewsUrl) intForm.elements.googleReviewsUrl.value = i.googleReviewsUrl || '';
      if (intForm.elements.whatsappEnabled) intForm.elements.whatsappEnabled.checked = !!i.whatsappEnabled;
      if (intForm.elements.qontoEnabled) intForm.elements.qontoEnabled.checked = !!i.qontoEnabled;
    });
    intForm.addEventListener('submit', function (e) {
      e.preventDefault();
      var fd = new FormData(intForm);
      var integrations = {
        slackWebhookUrl: fd.get('slackWebhookUrl') || '',
        slackChannel: fd.get('slackChannel') || '#sav',
        googleReviewsUrl: fd.get('googleReviewsUrl') || '',
        whatsappEnabled: fd.get('whatsappEnabled') === 'on',
        qontoEnabled: fd.get('qontoEnabled') === 'on',
      };
      api('/settings', { method: 'POST', body: JSON.stringify({ integrations: integrations }) }).then(function (res) {
        var fb = document.getElementById('sav-integrations-feedback');
        fb.classList.remove('hidden');
        if (res.ok && res.j.success) { fb.className = 'rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-900 p-3 text-sm'; fb.textContent = 'Intégrations sauvegardées.'; }
        else { fb.className = 'rounded-xl border border-red-200 bg-red-50 text-red-900 p-3 text-sm'; fb.textContent = (res.j && res.j.error) || 'Erreur'; }
      });
    });
  }

  // ============================================================
  // SETTINGS PAGE
  // ============================================================
  if (document.getElementById('sav-sla-grid')) {
    var slaGrid = document.getElementById('sav-sla-grid');
    var autoList = document.getElementById('sav-auto-list');
    var current = null;

    api('/settings').then(function (res) {
      if (!res.ok) return;
      current = res.j.data;
      slaGrid.innerHTML = (current.slaPerPiece || []).map(function (p, i) {
        return '<div class="rounded-xl border border-slate-200 p-3"><div class="text-xs font-semibold mb-1">' + escapeHtml(p.pieceType) + '</div>' +
          '<div class="flex items-center gap-2"><input type="number" min="1" max="60" value="' + p.days + '" data-sla-idx="' + i + '" class="w-20 rounded-lg border border-slate-300 px-2 py-1 text-sm"><span class="text-xs text-slate-500">jours</span></div></div>';
      }).join('');
      autoList.innerHTML = (current.automationRules || []).map(function (r, i) {
        return '<div class="rounded-xl border border-slate-200 p-4">' +
          '<div class="flex items-start justify-between gap-3">' +
            '<div><div class="font-semibold text-sm">' + escapeHtml(r.key) + '</div><div class="text-xs text-slate-500 mt-1">' + escapeHtml(r.description || '') + '</div></div>' +
            '<label class="inline-flex items-center cursor-pointer"><input type="checkbox" data-auto-enabled="' + i + '" ' + (r.enabled ? 'checked' : '') + ' class="rounded text-primary"><span class="ml-2 text-xs">Activé</span></label>' +
          '</div>' +
          '<div class="mt-2 flex items-center gap-2"><label class="text-xs text-slate-600">Seuil :</label>' +
          '<input type="number" min="0" max="90" value="' + r.daysThreshold + '" data-auto-days="' + i + '" class="w-20 rounded-lg border border-slate-300 px-2 py-1 text-sm">' +
          '<span class="text-xs text-slate-500">jours</span></div>' +
        '</div>';
      }).join('');
    });

    document.getElementById('sav-settings-save').addEventListener('click', function () {
      if (!current) return;
      var slas = current.slaPerPiece.map(function (p, i) {
        var inp = document.querySelector('[data-sla-idx="' + i + '"]');
        return { pieceType: p.pieceType, days: inp ? Number(inp.value) : p.days };
      });
      var rules = current.automationRules.map(function (r, i) {
        var en = document.querySelector('[data-auto-enabled="' + i + '"]');
        var dy = document.querySelector('[data-auto-days="' + i + '"]');
        return { key: r.key, enabled: en ? en.checked : r.enabled, daysThreshold: dy ? Number(dy.value) : r.daysThreshold, description: r.description };
      });
      api('/settings', { method: 'POST', body: JSON.stringify({ slaPerPiece: slas, automationRules: rules }) })
        .then(function (res) {
          var fb = document.getElementById('sav-settings-feedback');
          fb.classList.remove('hidden');
          if (res.ok && res.j.success) { fb.className = 'mt-3 rounded-xl border border-emerald-200 bg-emerald-50 text-emerald-900 p-3 text-sm'; fb.textContent = 'Paramètres sauvegardés.'; }
          else { fb.className = 'mt-3 rounded-xl border border-red-200 bg-red-50 text-red-900 p-3 text-sm'; fb.textContent = (res.j && res.j.error) || 'Erreur'; }
        });
    });

    document.getElementById('sav-auto-run-now').addEventListener('click', function () {
      api('/automations/run', { method: 'POST' }).then(function (res) {
        if (res.ok) toast('Automations exécutées : ' + JSON.stringify(res.j.data));
        else toast('Erreur', 'error');
      });
    });
  }

  // ============================================================
  // AUDIT LOG PAGE
  // ============================================================
  if (document.getElementById('sav-audit-tbody')) {
    var tbody2 = document.getElementById('sav-audit-tbody');
    function loadAudit() {
      var fd = new FormData(document.getElementById('sav-audit-filters'));
      var qs = new URLSearchParams();
      fd.forEach(function (v, k) { if (v) qs.append(k, v); });
      tbody2.innerHTML = '<tr><td colspan="7" class="px-4 py-10 text-center text-slate-500">Chargement…</td></tr>';
      api('/audit?' + qs.toString()).then(function (res) {
        if (!res.ok) { tbody2.innerHTML = '<tr><td colspan="7" class="px-4 py-6 text-red-700">Erreur de chargement</td></tr>'; return; }
        var items = res.j.data.items || [];
        if (!items.length) { tbody2.innerHTML = '<tr><td colspan="7" class="px-4 py-6 text-slate-500">Aucun log.</td></tr>'; return; }
        tbody2.innerHTML = items.map(function (it) {
          return '<tr>' +
            '<td class="px-3 py-2 whitespace-nowrap">' + new Date(it.createdAt).toLocaleString('fr-FR') + '</td>' +
            '<td class="px-3 py-2">' + escapeHtml(it.userEmail || '—') + '</td>' +
            '<td class="px-3 py-2 font-mono text-[11px]">' + escapeHtml(it.action) + '</td>' +
            '<td class="px-3 py-2 font-mono text-[11px]">' + escapeHtml(it.entityType + ' ' + (it.entityId || '')) + '</td>' +
            '<td class="px-3 py-2 text-[10px] text-slate-500 max-w-xs truncate" title="' + escapeHtml(JSON.stringify(it.before || '')) + '">' + escapeHtml(JSON.stringify(it.before || '').slice(0, 60)) + '</td>' +
            '<td class="px-3 py-2 text-[10px] text-slate-500 max-w-xs truncate" title="' + escapeHtml(JSON.stringify(it.after || '')) + '">' + escapeHtml(JSON.stringify(it.after || '').slice(0, 60)) + '</td>' +
            '<td class="px-3 py-2 font-mono text-[10px]">' + escapeHtml(it.ip || '') + '</td>' +
          '</tr>';
        }).join('');
      });
    }
    document.getElementById('sav-audit-filters').addEventListener('submit', function (e) { e.preventDefault(); loadAudit(); });
    loadAudit();
  }
})();
