(function () {
  'use strict';
  var key = 'autoliva-orders-context';
  var isList = location.pathname === '/admin/commandes';
  function readContext() {
    try {
      var value = JSON.parse(sessionStorage.getItem(key));
      if (!value || typeof value.url !== 'string') return null;
      var url = new URL(value.url, location.origin);
      if (url.origin !== location.origin || url.pathname !== '/admin/commandes') return null;
      return value;
    } catch (_) { return null; }
  }
  if (isList) {
    document.addEventListener('click', function (event) {
      var link = event.target.closest('a[href]');
      if (!link) return;
      var url = new URL(link.href, location.origin);
      if (url.origin !== location.origin || !/^\/admin\/commandes\/[^/]+$/.test(url.pathname) || url.pathname.endsWith('/nouvelle')) return;
      try { sessionStorage.setItem(key, JSON.stringify({url: location.pathname + location.search, scroll: window.scrollY, order: url.pathname})); } catch (_) {}
    });
    var context = readContext();
    if (context && context.url === location.pathname + location.search) {
      requestAnimationFrame(function () { window.scrollTo(0, Number(context.scroll) || 0); });
    }
    document.addEventListener('keydown', function(event) {
      if (event.key !== '/' || event.ctrlKey || event.metaKey || event.altKey || event.target.closest('input,textarea,select,[contenteditable]')) return;
      var search = document.querySelector('#ordersFilterForm input[name="q"]');
      if (search) { event.preventDefault(); search.focus(); }
    });
  } else if (/^\/admin\/commandes\/[^/]+$/.test(location.pathname)) {
    var context = readContext();
    if (!context || context.order !== location.pathname) return;
    document.querySelectorAll('main a[href="/admin/commandes"]').forEach(function(link) {
      link.href = context.url;
      link.setAttribute('aria-label', 'Revenir à la liste filtrée des commandes');
      link.title = 'Revenir à la liste filtrée';
    });
  }
})();
