/**
 * Base de données indisponible — plan de reprise SEO du 14/09/2026, action A4.4.
 *
 * L'application est chargée SANS connexion MongoDB (readyState 0, comme au
 * démarrage sur Render ou pendant un décrochage). Les familles de pages qui
 * vivent de la base doivent répondre 503 + Retry-After — la seule réponse que
 * Google lit comme « revenez plus tard » — et plus un 404 (/reference), une
 * redirection de chaque page vers la racine (/pieces-auto) ou une fiche de
 * démonstration (/product).
 *
 * Aucune base, aucun envoi : clés vides, sessions en mémoire, port éphémère.
 */

const test = require('node:test');
const assert = require('node:assert');

process.env.BRAND = 'autoliva';
delete process.env.MONGODB_URI;
delete process.env.SITE_URL;
for (const cle of ['MAILERSEND_API_KEY', 'BREVO_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'MOLLIE_API_KEY',
  'MOLLIE_ORGANIZATION_TOKEN', 'SCALAPAY_API_KEY', 'PARCELWILL_API_KEY', 'TRACK17_API_KEY', 'MCP_BEARER_TOKEN',
  'BLOG_IMPORT_API_TOKEN', 'SAV_API_TOKEN', 'COMPTOIR_API_KEY']) {
  process.env[cle] = '';
}
process.env.DE_AUTO_TRANSLATE = 'false';

const mongoose = require('mongoose');

test('base indisponible : 503 + Retry-After sur les pages qui en dépendent', async (t) => {
  /* Garde-fou : une requête qui atteindrait la base attendrait 10 s avant
     d'échouer (mise en tampon de Mongoose). On la fait échouer tout de suite,
     pour qu'un trou dans la règle se voie comme une erreur, pas comme un
     test lent. */
  mongoose.set('bufferCommands', false);
  assert.equal(mongoose.connection.readyState, 0);

  const app = require('../../src/app');
  const http = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const base = `http://127.0.0.1:${http.address().port}`;
  t.after(() => new Promise((r) => http.close(r)));

  const get = async (chemin) => {
    const r = await fetch(base + chemin, { redirect: 'manual', headers: { Accept: 'text/html', 'User-Agent': 'Mozilla/5.0 Chrome/126' } });
    return { status: r.status, retryAfter: r.headers.get('retry-after'), location: r.headers.get('location'), corps: await r.text() };
  };

  await t.test('chaque famille répond 503 avec Retry-After', async () => {
    const chemins = [
      '/product/mecatronique-dsg-7-dq200-pour-volkswagen-audi-seat-et-skoda/',
      '/product/wc-4714/',
      '/blog',
      '/blog/mecatronique-dq200-guide',
      '/pieces-auto',
      '/pieces-auto/audi',
      '/pieces-auto/audi/a4',
      '/pieces-auto/audi/a4/boites-de-vitesses',
      '/reference/0AM927769G',
      '/categorie',
      '/categorie/boites-de-vitesses',
      '/de/produits/mechatronik-dsg-7-dq200-6988d15b707eef3255a72556',
      '/de/blog/mechatronik-dq200',
      '/de/categorie/getriebe',
    ];
    for (const chemin of chemins) {
      const r = await get(chemin);
      assert.equal(r.status, 503, `${chemin} : ${r.status} ${r.location || ''}`);
      assert.equal(r.retryAfter, '120', `${chemin} : Retry-After manquant`);
      assert.match(r.corps, /<meta name="robots" content="noindex, nofollow"/);
    }
  });

  await t.test('le reste du site n’est pas concerné', async () => {
    assert.equal((await get('/health')).status, 200);
    const robots = await get('/robots.txt');
    assert.equal(robots.status, 200, 'un 5xx sur robots.txt suspendrait toute l’exploration');
    assert.equal((await get('/securite')).status, 200);
  });

  await t.test('la règle ne déborde pas : landings Ads, tunnel, flux et sitemaps restent hors de son champ', () => {
    const { cheminConcerne } = require('../../src/middlewares/baseRequise');
    for (const chemin of ['/product', '/product/x/', '/blog', '/pieces-auto/audi', '/reference/0AM927769G',
      '/categorie/moteurs', '/de/produits/x-1', '/de/blog/x', '/de/categorie/x', '/Product/WC-4714']) {
      assert.equal(cheminConcerne(chemin), true, `${chemin} : concerné`);
    }
    /* Pages d'arrivée Google Ads, tunnel d'achat, flux Merchant, sitemaps,
       robots.txt, API, admin — et les faux amis (/produits, /blogs,
       /categories, /referencement). */
    for (const chemin of ['/', '/moteurs', '/moteurs-reconditionnes', '/boites-vitesse', '/ponts-differentiels',
      '/devis', '/panier', '/commande/paiement', '/google-merchant-feed.xml', '/google-merchant-feed-de.xml',
      '/sitemap.xml', '/sitemap-products.xml', '/robots.txt', '/api/blog/import-from-url', '/admin/blog',
      '/produits', '/produits/x', '/blogs', '/blog-auto', '/categories', '/referencement', '/de', '/de/panier']) {
      assert.equal(cheminConcerne(chemin), false, `${chemin} : ne doit jamais recevoir ce 503`);
    }
  });
});
