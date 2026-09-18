/**
 * Tests unitaires — langue du tunnel d'achat et de l'espace compte (09/2026).
 *
 * Lancé par : npm test  (aucune base de données, aucun appel réseau)
 *
 * Le tunnel (/panier, /commande) et le compte (/compte…) vivent sur des URL
 * françaises : ils SUIVENT la langue mémorisée, ils ne la fixent pas. Avant,
 * toute page /compte… autre que la connexion remettait « fr » : un client
 * allemand qui cliquait « Konto » ou « Bestellung verfolgen » repassait en
 * français jusqu'au paiement Mollie et aux e-mails. En contrepartie, le choix
 * explicite ?lang=fr|de doit rester possible, sans jamais persister une
 * session vierge (diagnostic des 1,9 million de sessions, 08/2026).
 */

const test = require('node:test');
const assert = require('node:assert');

const i18nMiddleware = require('../../src/middlewares/i18n');

const UA_NAVIGATEUR = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const UA_ROBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

/* En-têtes d'une vraie navigation de navigateur (clic sur un lien). */
const NAVIGATION = { accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8', 'sec-fetch-mode': 'navigate', 'sec-fetch-dest': 'document' };
/* fetch() lancé par une page (sélecteur de véhicule, autocomplétion). */
const FETCH = { accept: '*/*', 'sec-fetch-mode': 'cors', 'sec-fetch-dest': 'empty' };

function appel(session, url, { ua = UA_NAVIGATEUR, method = 'GET', headers = NAVIGATION } = {}) {
  const [path, qs] = url.split('?');
  const query = Object.fromEntries(new URLSearchParams(qs || ''));
  const req = { session, method, originalUrl: url, url, path, headers: { 'user-agent': ua, ...headers }, query };
  const res = { locals: {} };
  i18nMiddleware(req, res, () => {});
  return { session: req.session, locals: res.locals };
}

test('l’espace compte suit la langue du tunnel', async (t) => {
  await t.test('aucune page /compte ne remet « fr » sur une session allemande', () => {
    for (const url of [
      '/compte',
      '/compte/',
      '/compte/connexion',
      '/compte/inscription',
      '/compte/mot-de-passe-oublie',
      '/compte/reinitialiser-mot-de-passe',
      '/compte/commandes',
      '/compte/commandes/6988d15c707eef3255a726b6',
      '/compte/adresses?returnTo=/commande/livraison',
      '/compte/garage',
    ]) {
      assert.equal(appel({ preferredLang: 'de' }, url).session.preferredLang, 'de', url);
    }
  });

  await t.test('ni n’écrit quoi que ce soit dans une session vierge', () => {
    assert.deepEqual(appel({}, '/compte').session, {});
    assert.deepEqual(appel({}, '/compte/commandes').session, {});
  });

  await t.test('une page de contenu FR remet toujours « fr »', () => {
    /* Le retour vers le français par une page de contenu doit continuer à
       marcher : seul le tunnel/compte est neutre. */
    assert.equal(appel({ preferredLang: 'de' }, '/produits').session.preferredLang, 'fr');
    assert.equal(appel({ preferredLang: 'de' }, '/comptes-rendus').session.preferredLang, 'fr');
  });

  await t.test('le header sait quelles pages ne portent pas la langue dans l’URL', () => {
    assert.equal(appel({}, '/panier').locals.langFollowsPreference, true);
    assert.equal(appel({}, '/commande/paiement').locals.langFollowsPreference, true);
    assert.equal(appel({}, '/compte/connexion').locals.langFollowsPreference, true);
    assert.equal(appel({}, '/produits').locals.langFollowsPreference, false);
    assert.equal(appel({}, '/de/produits/x').locals.langFollowsPreference, false);
  });
});

test('choix explicite de la langue (?lang=)', async (t) => {
  await t.test('?lang=fr sort de l’allemand, même sur le tunnel', () => {
    assert.equal(appel({ preferredLang: 'de' }, '/compte/connexion?returnTo=%2Fpanier&lang=fr').session.preferredLang, 'fr');
    assert.equal(appel({ preferredLang: 'de' }, '/panier?lang=fr').session.preferredLang, 'fr');
  });

  await t.test('?lang=de passe en allemand, même sur le tunnel', () => {
    assert.equal(appel({}, '/panier?lang=de').session.preferredLang, 'de');
    assert.equal(appel({ preferredLang: 'fr' }, '/compte/connexion?lang=de').session.preferredLang, 'de');
  });

  await t.test('le choix explicite prime sur le chemin', () => {
    assert.equal(appel({ preferredLang: 'fr' }, '/produits?lang=de').session.preferredLang, 'de');
    assert.equal(appel({ preferredLang: 'de' }, '/de/produits/x?lang=fr').session.preferredLang, 'fr');
  });

  await t.test('?lang=fr sur une session vierge n’écrit rien', () => {
    assert.deepEqual(appel({}, '/panier?lang=fr').session, {});
  });

  await t.test('un robot ne crée jamais de session avec ?lang=de', () => {
    assert.deepEqual(appel({}, '/panier?lang=de', { ua: UA_ROBOT }).session, {});
  });

  await t.test('une valeur inconnue ou un POST ne changent rien', () => {
    assert.equal(appel({ preferredLang: 'de' }, '/panier?lang=es').session.preferredLang, 'de');
    assert.equal(appel({ preferredLang: 'de' }, '/panier?lang=fr', { method: 'POST' }).session.preferredLang, 'de');
  });
});

test('seules les navigations HTML fixent la langue (09/2026)', async (t) => {
  /* La page d'accueil /de lance d'elle-même GET /api/vehicules, et
     l'autocomplétion GET /rechercher/suggest : ces URL françaises remettaient
     « fr », et le panier, le paiement et les e-mails d'un acheteur allemand
     repassaient en français. */
  await t.test('un appel d\'API ou d\'autocomplétion ne remet jamais « fr »', () => {
    for (const url of ['/api/vehicules', '/api/vehicules?make=VW', '/rechercher/suggest?q=dq200', '/de/rechercher/suggest?q=dq200']) {
      assert.equal(appel({ preferredLang: 'de' }, url, { headers: FETCH }).session.preferredLang, 'de', url);
      /* Même avec des en-têtes de navigation : ce ne sont jamais des pages. */
      assert.equal(appel({ preferredLang: 'de' }, url).session.preferredLang, 'de', url + ' (navigation)');
    }
  });

  await t.test('un fetch, un XHR, un préchargement ou une iframe ne changent rien', () => {
    const cas = {
      fetch: FETCH,
      xhr: { accept: 'application/json', 'x-requested-with': 'XMLHttpRequest' },
      'ancien navigateur sans Sec-Fetch': { accept: '*/*' },
      json: { accept: 'application/json' },
      prefetch: { ...NAVIGATION, 'sec-purpose': 'prefetch' },
      iframe: { ...NAVIGATION, 'sec-fetch-dest': 'iframe' },
    };
    for (const [nom, headers] of Object.entries(cas)) {
      assert.equal(appel({ preferredLang: 'de' }, '/produits', { headers }).session.preferredLang, 'de', nom + ' sur une page FR');
      assert.deepEqual(appel({}, '/de/produits/x', { headers }).session, {}, nom + ' sur une page DE');
      assert.equal(appel({ preferredLang: 'de' }, '/panier?lang=fr', { headers }).session.preferredLang, 'de', nom + ' avec ?lang=fr');
    }
  });

  await t.test('une navigation, même sans en-têtes Sec-Fetch, garde la règle du chemin', () => {
    assert.equal(appel({ preferredLang: 'de' }, '/produits', { headers: { accept: 'text/html' } }).session.preferredLang, 'fr');
    /* Métadonnées incomplètes (Sec-Fetch-Mode sans Sec-Fetch-Dest : le fetch de
       Node les pose ainsi) : pas un navigateur, c'est l'Accept qui décide. */
    assert.equal(appel({ preferredLang: 'de' }, '/produits', { headers: { accept: 'text/html', 'sec-fetch-mode': 'cors' } }).session.preferredLang, 'fr');
    assert.equal(appel({ preferredLang: 'de' }, '/produits', { headers: { accept: '*/*', 'sec-fetch-mode': 'cors' } }).session.preferredLang, 'de');
    assert.equal(appel({}, '/de/produits/x', { headers: { accept: 'text/html' } }).session.preferredLang, 'de');
    /* Pas d'Accept du tout (script, robot) : la règle robot s'applique toujours. */
    assert.equal(appel({}, '/de/produits/x', { headers: {} }).session.preferredLang, 'de');
  });

  await t.test('estNavigationHtml est exposée pour les autres couches', () => {
    assert.equal(i18nMiddleware.estNavigationHtml({ headers: NAVIGATION }, '/produits'), true);
    assert.equal(i18nMiddleware.estNavigationHtml({ headers: FETCH }, '/produits'), false);
    assert.equal(i18nMiddleware.estNavigationHtml({ headers: NAVIGATION }, '/api/vehicules'), false);
  });
});

test('le header connaît la langue de SESSION sur les pages neutres', async (t) => {
  /* /compte/profil reste rendu en français : le sélecteur doit pourtant montrer
     que le tunnel est en allemand et proposer ?lang=fr. */
  await t.test('tunnelLang suit la session, pas l\'URL', () => {
    assert.equal(appel({ preferredLang: 'de' }, '/compte/profil').locals.tunnelLang, 'de');
    assert.equal(appel({}, '/compte/profil').locals.tunnelLang, 'fr');
    assert.equal(appel({ preferredLang: 'de' }, '/compte/profil?lang=fr').locals.tunnelLang, 'fr');
    assert.equal(appel({}, '/panier?lang=de').locals.tunnelLang, 'de');
  });
});
