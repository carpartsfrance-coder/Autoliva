(function () {
  var roots = Array.from(document.querySelectorAll('[data-search-autocomplete]'));
  if (!roots.length) return;

  /* Libellés dans la langue de la page, posés par partials/header.ejs
     (window.CPF_SEARCH_I18N), comme CART_TOAST_I18N pour le toast panier. Les
     valeurs françaises restent en repli : si l'objet manque (page servie sans
     le header, cache), l'affichage FR est exactement celui d'avant. */
  var I18N = (window.CPF_SEARCH_I18N && typeof window.CPF_SEARCH_I18N === 'object')
    ? window.CPF_SEARCH_I18N
    : {};

  function tr(key, repli) {
    var value = I18N[key];
    return (typeof value === 'string' && value) ? value : repli;
  }

  function escapeHtml(value) {
    return String(value || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function clearActive(options) {
    options.forEach(function (option) {
      option.classList.remove('bg-slate-50', 'ring-1', 'ring-primary/10');
      option.setAttribute('aria-selected', 'false');
    });
  }

  roots.forEach(function (root) {
    if (!root || root.__searchAutocompleteReady) return;
    root.__searchAutocompleteReady = true;

    var input = root.querySelector('[data-search-autocomplete-input]');
    var panel = root.querySelector('[data-search-autocomplete-panel]');
    var sectionsEl = root.querySelector('[data-search-autocomplete-sections]');
    var allLink = root.querySelector('[data-search-autocomplete-all]');
    var emptyEl = root.querySelector('[data-search-autocomplete-empty]');
    var view = root.getAttribute('data-search-autocomplete-view') || 'compact';

    if (!input || !panel || !sectionsEl || !allLink) return;

    var timer = null;
    var lastQuery = '';
    var abort = null;
    var activeIndex = -1;

    function setVisible(el, visible) {
      if (!el) return;
      if (visible) el.classList.remove('hidden');
      else el.classList.add('hidden');
    }

    /* Href et texte rendus par le serveur : ils portent déjà le préfixe de
       langue (/de/produits) et le bon libellé (« Katalog ansehen » dans le
       header, « Zum Katalog » sur /de/rechercher). On les mémorise au lieu de
       les écraser : avant, setAllLink() posait « /produits » dès le chargement,
       et l'acheteur allemand atterrissait sur le catalogue FRANÇAIS — dont le
       GET remet la session en « fr ». */
    var allLinkBaseHref = allLink.getAttribute('href') || '/produits';
    var allLinkBaseText = String(allLink.textContent || '').trim();

    function setAllLink(query) {
      var q = String(query || '').trim();
      if (!q) {
        allLink.href = allLinkBaseHref;
        allLink.textContent = allLinkBaseText;
        return;
      }
      var separateur = allLinkBaseHref.indexOf('?') === -1 ? '?' : '&';
      allLink.href = allLinkBaseHref + separateur + 'q=' + encodeURIComponent(q);
      allLink.textContent = tr('allResultsFor', 'Voir tous les résultats pour "%q%"').replace('%q%', q);
    }

    function getOptions() {
      return Array.from(panel.querySelectorAll('[data-search-option]'));
    }

    function updateActive(nextIndex) {
      var options = getOptions();
      if (!options.length) {
        activeIndex = -1;
        return;
      }

      if (nextIndex < 0) nextIndex = options.length - 1;
      if (nextIndex >= options.length) nextIndex = 0;

      clearActive(options);
      activeIndex = nextIndex;

      var active = options[activeIndex];
      if (!active) return;
      active.classList.add('bg-slate-50', 'ring-1', 'ring-primary/10');
      active.setAttribute('aria-selected', 'true');
      if (typeof active.scrollIntoView === 'function') {
        active.scrollIntoView({ block: 'nearest' });
      }
    }

    function closePanel() {
      setVisible(panel, false);
      setVisible(emptyEl, false);
      sectionsEl.innerHTML = '';
      activeIndex = -1;
    }

    function openPanel() {
      setVisible(panel, true);
    }

    function renderProductItem(item) {
      var row = document.createElement('a');
      row.href = item.publicPath || '/produits';
      row.className = view === 'page'
        ? 'flex items-center gap-3 p-3 hover:bg-slate-50 transition-colors outline-none'
        : 'flex items-center gap-3 px-4 py-3 hover:bg-slate-50 transition-colors outline-none';
      row.setAttribute('data-search-option', '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');

      var image = item.imageUrl
        ? '<img class="h-10 w-10 rounded-xl object-cover bg-slate-100" alt="" src="' + escapeHtml(item.imageUrl) + '" loading="lazy" />'
        : '<div class="h-10 w-10 rounded-xl bg-slate-100 flex items-center justify-center text-slate-400"><span class="material-symbols-outlined text-xl">inventory_2</span></div>';

      var metaParts = [];
      if (item.sku) metaParts.push(escapeHtml(tr('ref', 'Réf:')) + ' ' + escapeHtml(item.sku));
      if (item.brand) metaParts.push(escapeHtml(item.brand));

      row.innerHTML =
        image +
        '<div class="min-w-0 flex-1">' +
          '<div class="truncate text-sm font-black text-slate-900">' + escapeHtml(item.name || tr('product', 'Produit')) + '</div>' +
          '<div class="mt-0.5 truncate text-[11px] text-slate-500">' + (metaParts.join(' • ') || '') + '</div>' +
        '</div>' +
        '<div class="text-right text-sm font-black text-slate-900">' + escapeHtml(item.price || '') + '</div>';

      return row;
    }

    function renderFacetItem(item, type) {
      var row = document.createElement('a');
      row.href = item.href || '/produits';
      row.className = view === 'page'
        ? 'flex items-center gap-3 p-3 hover:bg-slate-50 transition-colors outline-none'
        : 'flex items-center gap-3 px-4 py-3 hover:bg-slate-50 transition-colors outline-none';
      row.setAttribute('data-search-option', '');
      row.setAttribute('role', 'option');
      row.setAttribute('aria-selected', 'false');

      var icon = type === 'brands' ? 'directions_car' : 'category';
      /* Pluriel porté par la langue : « 1 résultat / 3 résultats » en français,
         « 1 Treffer / 3 Treffer » en allemand (invariable). */
      var count = '';
      if (Number.isFinite(item.count) && item.count > 0) {
        var modele = item.count > 1
          ? tr('countResults', '%count% résultats')
          : tr('countResult', '%count% résultat');
        count = modele.replace('%count%', String(item.count));
      }
      var typeLabel = type === 'brands'
        ? tr('vehicleMake', 'Marque véhicule')
        : tr('category', 'Catégorie');

      row.innerHTML =
        '<div class="flex h-10 w-10 items-center justify-center rounded-xl bg-slate-100 text-slate-500"><span class="material-symbols-outlined text-xl">' + icon + '</span></div>' +
        '<div class="min-w-0 flex-1">' +
          '<div class="truncate text-sm font-black text-slate-900">' + escapeHtml(item.label || item.name || '') + '</div>' +
          '<div class="mt-0.5 truncate text-[11px] text-slate-500">' + escapeHtml(typeLabel) + (count ? ' • ' + escapeHtml(count) : '') + '</div>' +
        '</div>';

      return row;
    }

    function renderSections(payload, query) {
      var sections = payload && Array.isArray(payload.sections) ? payload.sections : [];
      sectionsEl.innerHTML = '';
      setAllLink(query);

      if (!sections.length) {
        setVisible(emptyEl, true);
        openPanel();
        return;
      }

      setVisible(emptyEl, false);

      sections.forEach(function (section, sectionIndex) {
        if (!section || !Array.isArray(section.items) || !section.items.length) return;

        var wrapper = document.createElement('section');
        if (sectionIndex > 0) wrapper.className = 'border-t border-slate-100';

        var title = document.createElement('div');
        title.className = 'px-4 py-3 text-[11px] font-black uppercase tracking-widest text-slate-400';
        title.textContent = section.title || '';
        wrapper.appendChild(title);

        var list = document.createElement('div');
        list.setAttribute('role', 'listbox');

        section.items.forEach(function (item) {
          var row = section.type === 'products'
            ? renderProductItem(item)
            : renderFacetItem(item, section.type);
          list.appendChild(row);
        });

        wrapper.appendChild(list);
        sectionsEl.appendChild(wrapper);
      });

      if (!sectionsEl.children.length) {
        setVisible(emptyEl, true);
      }

      openPanel();
      activeIndex = -1;
      clearActive(getOptions());
    }

    function fetchSuggestions(query) {
      if (abort) {
        try {
          abort.abort();
        } catch (err) {}
      }

      abort = new AbortController();

      return fetch('/rechercher/suggest?q=' + encodeURIComponent(query), {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: abort.signal,
      })
        .then(function (response) { return response.json(); })
        .catch(function () {
          return { sections: [], results: [] };
        });
    }

    function schedule() {
      var query = String(input.value || '').trim();
      lastQuery = query;
      setAllLink(query);

      if (timer) window.clearTimeout(timer);

      if (!query || query.length < 2) {
        closePanel();
        return;
      }

      timer = window.setTimeout(function () {
        fetchSuggestions(query).then(function (payload) {
          if (query !== lastQuery) return;
          renderSections(payload, query);
        });
      }, 300);
    }

    input.addEventListener('input', schedule);
    input.addEventListener('focus', function () {
      var query = String(input.value || '').trim();
      if (query.length >= 2 && sectionsEl.children.length) {
        openPanel();
        return;
      }
      if (query.length >= 2) schedule();
    });

    input.addEventListener('keydown', function (event) {
      var options = getOptions();
      if (event.key === 'ArrowDown') {
        if (!options.length && String(input.value || '').trim().length >= 2) {
          schedule();
          return;
        }
        event.preventDefault();
        updateActive(activeIndex + 1);
        return;
      }

      if (event.key === 'ArrowUp') {
        if (!options.length) return;
        event.preventDefault();
        updateActive(activeIndex - 1);
        return;
      }

      if (event.key === 'Enter') {
        if (activeIndex >= 0 && options[activeIndex]) {
          event.preventDefault();
          options[activeIndex].click();
        }
        return;
      }

      if (event.key === 'Escape') {
        closePanel();
      }
    });

    panel.addEventListener('mousemove', function (event) {
      var option = event.target && event.target.closest ? event.target.closest('[data-search-option]') : null;
      if (!option) return;
      var options = getOptions();
      var nextIndex = options.indexOf(option);
      if (nextIndex >= 0 && nextIndex !== activeIndex) {
        updateActive(nextIndex);
      }
    });

    document.addEventListener('click', function (event) {
      if (!event || !event.target) return;
      if (root.contains(event.target)) return;
      closePanel();
    });

    setAllLink(String(input.value || '').trim());
  });
})();
