/**
 * hreflang : le chemin de la page, jamais ses paramètres.
 *
 * Lancé par : npm test  (aucune base, aucun réseau)
 *
 * Audit du 25/09/2026 : le middleware i18n bâtissait le chemin des hreflang
 * sur req.originalUrl — « /moteurs?utm_source=… » (clic Ads) ou
 * « /blog?page=2 » (page en noindex) étaient déclarés à Google comme la
 * version française de la page. Le rendu réel est vérifié dans
 * tests/integration/pages-confiance.test.js.
 */

const test = require('node:test');
const assert = require('node:assert');

const i18nMiddleware = require('../../src/middlewares/i18n');
const { buildHreflangSet } = require('../../src/services/i18n');

function passer(originalUrl) {
  const path = originalUrl.split('?')[0];
  const req = { method: 'GET', path, originalUrl, url: originalUrl, query: {}, headers: {} };
  const res = { locals: {} };
  let suite = false;
  i18nMiddleware(req, res, () => { suite = true; });
  assert.ok(suite, originalUrl);
  return res.locals.currentPathWithoutLang;
}

test('middleware i18n : le chemin sans langue ne garde aucun paramètre', () => {
  assert.equal(passer('/moteurs?utm_source=google&utm_campaign=moteurs&gclid=abc'), '/moteurs');
  assert.equal(passer('/blog?page=2'), '/blog');
  assert.equal(passer('/categorie/turbos?condition=occasion#liste'), '/categorie/turbos');
  assert.equal(passer('/de/blog?page=3'), '/blog');
  assert.equal(passer('/de?utm_source=x'), '/');
  assert.equal(passer('/'), '/');
  assert.equal(passer('/product/pont-arriere-bmw/'), '/product/pont-arriere-bmw/');
});

test('buildHreflangSet : jamais de paramètres, même si on lui en passe', () => {
  assert.deepEqual(buildHreflangSet('https://autoliva.com', '/moteurs?utm_source=google'),
    { hreflangFr: 'https://autoliva.com/moteurs', hreflangDefault: 'https://autoliva.com/moteurs' });
  assert.deepEqual(buildHreflangSet('https://autoliva.com', '/blog?page=2', { deHref: 'https://autoliva.com/de/blog' }).hreflangTags, [
    { lang: 'fr', href: 'https://autoliva.com/blog' },
    { lang: 'de', href: 'https://autoliva.com/de/blog' },
    { lang: 'x-default', href: 'https://autoliva.com/blog' },
  ]);
  assert.equal(buildHreflangSet('', '').hreflangFr, '/');
});
