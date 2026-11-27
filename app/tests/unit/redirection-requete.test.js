/**
 * Chaîne de requête des redirections 301 (28/11/2026).
 *
 * Pourquoi ces tests : une redirection ne réécrit que le CHEMIN. Quand elle
 * oublie de recopier la chaîne de requête, le ?gclid= d'un clic Google Ads
 * tombe au passage et la conversion n'est plus rattachée à l'annonce — Ads est
 * le premier canal de leads du site, donc un canal qui paraît ne rien
 * rapporter. Les 80 redirections exactes de wpRedirects (anciennes adresses
 * WordPress) perdaient la requête ; les règles dynamiques la recopiaient, mais
 * avec un second « ? » quand la cible portait déjà un paramètre.
 */

const test = require('node:test');
const assert = require('node:assert');

const { avecRequete } = require('../../src/services/redirection');
const wpRedirects = require('../../src/middlewares/wpRedirects');

/** Requête Express minimale : ce que lisent les redirections. */
function faireReq(originalUrl, method = 'GET') {
  const [chemin, requete = ''] = originalUrl.split('?');
  const query = {};
  for (const paire of requete.split('&').filter(Boolean)) {
    const [cle, valeur = ''] = paire.split('=');
    query[decodeURIComponent(cle)] = decodeURIComponent(valeur);
  }
  return { method, path: chemin, originalUrl, query };
}

/** Réponse Express minimale : on ne garde que ce qui a été décidé. */
function faireRes() {
  const res = { statut: null, cible: null, corps: null };
  res.redirect = (statut, cible) => { res.statut = statut; res.cible = cible; };
  res.status = (statut) => { res.statut = statut; return res; };
  res.send = (corps) => { res.corps = corps; return res; };
  return res;
}

/** Passe une URL dans le middleware et dit ce qu'il en a fait. */
function passer(originalUrl, method = 'GET') {
  const res = faireRes();
  let suivant = false;
  const log = console.log;
  console.log = () => {};
  try {
    wpRedirects(faireReq(originalUrl, method), res, () => { suivant = true; });
  } finally {
    console.log = log;
  }
  return { statut: res.statut, cible: res.cible, suivant };
}

test('avecRequete : recolle la requête du visiteur sur la cible', async (t) => {
  await t.test('sans requête, la cible reste nue', () => {
    assert.strictEqual(avecRequete(faireReq('/cgv'), '/legal/cgv'), '/legal/cgv');
  });

  await t.test('le gclid suit', () => {
    assert.strictEqual(
      avecRequete(faireReq('/cgv?gclid=ABC-123_xyz'), '/legal/cgv'),
      '/legal/cgv?gclid=ABC-123_xyz'
    );
  });

  await t.test('plusieurs paramètres suivent, dans l’ordre et tels quels', () => {
    assert.strictEqual(
      avecRequete(faireReq('/shop?gclid=ABC&utm_source=google&utm_campaign=dsg%20200'), '/produits'),
      '/produits?gclid=ABC&utm_source=google&utm_campaign=dsg%20200'
    );
  });

  await t.test('une cible qui a déjà un paramètre est complétée avec « & »', () => {
    /* Le bug : « ? » une seconde fois finissait DANS la valeur de q, donc la
       recherche cherchait « boite-dsg?gclid=ABC » et le gclid disparaissait. */
    assert.strictEqual(
      avecRequete(faireReq('/tag/boite-dsg?gclid=ABC'), '/produits?q=boite-dsg'),
      '/produits?q=boite-dsg&gclid=ABC'
    );
  });

  await t.test('en cas de conflit, le paramètre de la cible gagne', () => {
    /* Deux q= et le listing, qui n'accepte qu'une chaîne, ne cherche plus rien. */
    assert.strictEqual(
      avecRequete(faireReq('/tag/boite-dsg?q=autre-chose'), '/produits?q=boite-dsg'),
      '/produits?q=boite-dsg'
    );
  });

  await t.test('la valeur n’est pas ré-encodée : un gclid est opaque', () => {
    const gclid = 'Cj0KCQiA_-2vBhD1ARIsAA%3Dtest-_x';
    assert.strictEqual(
      avecRequete(faireReq('/cart?gclid=' + gclid), '/panier'),
      '/panier?gclid=' + gclid
    );
  });

  await t.test('une requête vide ne laisse pas de « ? » orphelin', () => {
    assert.strictEqual(avecRequete(faireReq('/cart?'), '/panier'), '/panier');
  });

  await t.test('sans req exploitable, la cible est rendue intacte', () => {
    assert.strictEqual(avecRequete(null, '/panier'), '/panier');
    assert.strictEqual(avecRequete({}, '/panier'), '/panier');
  });
});

test('wpRedirects : la requête traverse les redirections', async (t) => {
  await t.test('redirection exacte : le gclid arrive à destination', () => {
    const r = passer('/cgv?gclid=TEST123');
    assert.strictEqual(r.statut, 301);
    assert.strictEqual(r.cible, '/legal/cgv?gclid=TEST123');
  });

  await t.test('redirection exacte d’un ancien article : la requête suit', () => {
    const r = passer('/mecatronique-dsg-6/?gclid=TEST123&utm_source=newsletter');
    assert.strictEqual(r.statut, 301);
    assert.strictEqual(
      r.cible,
      '/blog/mecatronique-dsg6-dq250-diagnostic-prix-remplacement?gclid=TEST123&utm_source=newsletter'
    );
  });

  await t.test('redirection exacte sans requête : cible nue, comme avant', () => {
    const r = passer('/shop');
    assert.strictEqual(r.statut, 301);
    assert.strictEqual(r.cible, '/produits');
  });

  await t.test('règle dynamique vers une cible paramétrée : un seul « ? »', () => {
    const r = passer('/tag-produit/boite-dsg?gclid=TEST123');
    assert.strictEqual(r.statut, 301);
    assert.strictEqual(r.cible, '/produits?q=boite-dsg&gclid=TEST123');
  });

  await t.test('slash final d’une fiche : le gclid passe le saut', () => {
    const r = passer('/product/moteur-bkd-2-0-tdi?gclid=TEST123');
    assert.strictEqual(r.statut, 301);
    assert.strictEqual(r.cible, '/product/moteur-bkd-2-0-tdi/?gclid=TEST123');
  });

  await t.test('les URLs qui CONSOMMENT la requête ne la recopient pas', () => {
    /* ?add-to-cart= est un ordre WooCommerce, pas un paramètre de suivi :
       le recopier derrière /panier n'aurait aucun sens. */
    const r = passer('/?add-to-cart=12345');
    assert.strictEqual(r.statut, 301);
    assert.strictEqual(r.cible, '/panier');
  });

  await t.test('un POST n’est pas redirigé', () => {
    const r = passer('/cgv?gclid=TEST123', 'POST');
    assert.strictEqual(r.suivant, true);
    assert.strictEqual(r.statut, null);
  });
});
