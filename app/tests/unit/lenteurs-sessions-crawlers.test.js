/**
 * Tests unitaires — correctifs du diagnostic « site lent parfois » (08/2026).
 *
 * Lancé par : npm test  (aucune base de données, aucun appel réseau)
 *
 * Deux mécanismes mesurés en production :
 *   1. chaque heure pile, le cron des paniers abandonnés rapatriait les
 *      1 897 283 sessions vivantes (~1,4 Go) pour en garder 334 ;
 *   2. les sitemaps et le flux Merchant, montés hors du limiteur de débit,
 *      se reconstruisaient à chaque demande de crawler (jusqu'à >120 s).
 * Et un amplificateur : chaque visiteur, robot compris, persistait une session
 * de 30 jours parce que trois endroits écrivaient une valeur PAR DÉFAUT
 * (accountType, preferredLang, et l'anti double-clic des landings).
 *
 * Ces tests verrouillent les trois choses qu'on ne veut plus revoir.
 */

const test = require('node:test');
const assert = require('node:assert');

const { SESSION_AVEC_ARTICLE } = require('../../src/jobs/detectAbandonedCarts');
const i18nMiddleware = require('../../src/middlewares/i18n');
const feed = require('../../src/routes/google-merchant-feed');

/* Une session telle que connect-mongo la sérialise : JSON.stringify de
   l'objet de session. C'est la forme réelle constatée en production. */
const serialiser = (session) => JSON.stringify({ cookie: { originalMaxAge: 2592000000 }, ...session });

test('le cron ne rapatrie que les sessions qui ont un article', async (t) => {
  await t.test('un panier avec au moins un article correspond', () => {
    const s = serialiser({
      accountType: 'particulier',
      cart: { items: { '64a1b2c3d4e5f6a7b8c9d0e1__455f30caa3e8': { lineId: 'x', productId: '64a1b2c3d4e5f6a7b8c9d0e1', quantity: 1 } } },
    });
    assert.match(s, SESSION_AVEC_ARTICLE);
  });

  await t.test('un panier vide ne correspond pas', () => {
    /* C'est le cas des 92 % de sessions « vides » : un objet cart est parfois
       présent, mais sans article. Elles ne doivent plus être transférées. */
    assert.doesNotMatch(serialiser({ accountType: 'particulier', cart: { items: {} } }), SESSION_AVEC_ARTICLE);
  });

  await t.test('une session sans panier ne correspond pas', () => {
    assert.doesNotMatch(serialiser({ accountType: 'particulier', preferredLang: 'fr' }), SESSION_AVEC_ARTICLE);
    assert.doesNotMatch(serialiser({ user: { email: 'a@example.com' } }), SESSION_AVEC_ARTICLE);
  });

  await t.test('l’ordre des clés du panier n’a pas d’importance tant que items vient en premier', () => {
    /* JSON.stringify respecte l'ordre d'insertion. Le code du panier crée
       `items` d'abord (vérifié sur les documents réels) ; si un jour une clé
       passait devant, ce test signalerait la rupture au lieu de laisser le
       cron rater silencieusement tous les paniers. */
    const s = serialiser({ cart: { items: { k: { quantity: 2 } }, updatedAt: 1 } });
    assert.match(s, SESSION_AVEC_ARTICLE);
  });
});

test('la langue préférée n’est écrite que si elle change', async (t) => {
  const appel = (session, url) => {
    const req = { session, method: 'GET', originalUrl: url, url, path: url, headers: {}, query: {} };
    const res = { locals: {} };
    i18nMiddleware(req, res, () => {});
    return req.session;
  };

  await t.test('une page FR sur une session vierge n’écrit RIEN', () => {
    /* Écrire « fr » (le défaut) suffisait à persister la session 30 jours.
       Le tunnel lit `preferredLang === 'de' ? 'de' : 'fr'` : absent = fr. */
    const s = appel({}, '/produits');
    assert.deepEqual(s, {}, 'la session doit rester vierge : ' + JSON.stringify(s));
  });

  await t.test('une page DE écrit « de »', () => {
    assert.equal(appel({}, '/de/produkte').preferredLang, 'de');
  });

  await t.test('revenir sur une page FR après une page DE remet « fr »', () => {
    /* Le bug historique : un visiteur FR passé par /de restait en allemand
       au panier. Ce retour doit continuer à fonctionner. */
    assert.equal(appel({ preferredLang: 'de' }, '/produits').preferredLang, 'fr');
  });

  await t.test('une page DE sur une session déjà en « de » ne réécrit pas', () => {
    const session = { preferredLang: 'de' };
    const s = appel(session, '/de/produkte');
    assert.equal(s.preferredLang, 'de');
    assert.equal(Object.keys(s).length, 1);
  });

  await t.test('le tunnel d’achat ne fixe jamais la langue', () => {
    assert.deepEqual(appel({}, '/panier'), {});
    assert.equal(appel({ preferredLang: 'de' }, '/commande').preferredLang, 'de');
  });
});

test('le flux Merchant ne se reconstruit qu’une fois à la fois', async (t) => {
  const original = feed.loadProducts;
  t.after(() => { feed.loadProducts = original; });

  await t.test('deux demandes concurrentes partagent une seule construction', async () => {
    /* Sans verrou, deux crawlers pendant l'expiration du cache lançaient deux
       chargements de 14 464 fiches (2 × 28 Mo). */
    let chargements = 0;
    feed.loadProducts = () => new Promise((resolve) => {
      chargements += 1;
      setTimeout(() => resolve([]), 30);
    });
    const [a, b] = await Promise.all([feed.buildFeedCached(), feed.buildFeedCached()]);
    assert.equal(chargements, 1, 'un seul chargement pour deux demandes');
    assert.equal(a, b, 'le même XML est servi aux deux');
    assert.ok(typeof a === 'string' && a.includes('<rss'));
  });

  await t.test('une troisième demande, plus tard, vient du cache', async () => {
    let chargements = 0;
    feed.loadProducts = async () => { chargements += 1; return []; };
    await feed.buildFeedCached();
    assert.equal(chargements, 0, 'le cache du test précédent est encore valable');
  });
});

test('l’anti double-clic des landings vit dans un cookie, plus en session', async (t) => {
  const formTimestamp = require('../../src/services/formTimestamp');

  await t.test('poser() écrit un cookie httpOnly, jamais la session', () => {
    /* Les trois landings Google Ads écrivaient `req.session.moteurFormTs` à
       chaque AFFICHAGE : chaque clic, chaque robot, persistait une session de
       30 jours. Le cookie porte la même information sans rien écrire en base. */
    const cookies = [];
    const res = { cookie: (nom, valeur, opts) => cookies.push({ nom, valeur, opts }) };
    const avant = Date.now();
    formTimestamp.poser(res);
    assert.equal(cookies.length, 1);
    assert.equal(cookies[0].nom, formTimestamp.NOM_COOKIE);
    assert.ok(Number(cookies[0].valeur) >= avant, 'la valeur est un horodatage');
    assert.equal(cookies[0].opts.httpOnly, true);
    assert.equal(cookies[0].opts.sameSite, 'lax');
  });

  await t.test('lire() retrouve le cookie', () => {
    const req = { headers: { cookie: 'autre=1; ' + formTimestamp.NOM_COOKIE + '=1700000000000; x=y' } };
    assert.equal(formTimestamp.lire(req), 1700000000000);
  });

  await t.test('lire() retombe sur l’ancienne valeur de session si le cookie manque', () => {
    /* Compatibilité pour les visiteurs dont la session date d'avant. */
    assert.equal(formTimestamp.lire({ headers: {}, session: { moteurFormTs: 1234 } }), 1234);
  });

  await t.test('lire() renvoie null sans cookie ni session, et ignore une valeur forgée non numérique', () => {
    assert.equal(formTimestamp.lire({ headers: {} }), null);
    assert.equal(formTimestamp.lire({ headers: { cookie: formTimestamp.NOM_COOKIE + '=abc' } }), null);
    assert.equal(formTimestamp.lire(null), null);
  });
});
