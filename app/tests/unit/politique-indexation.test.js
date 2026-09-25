'use strict';

/**
 * Politique d'indexation — plan de reprise SEO du 14/09/2026, action A5
 * (PR-1b). Aucune base, aucun réseau : la décision de services/seoIndexPolicy.js
 * est éprouvée sur les listes COMPLÈTES du plan, famille par famille et pour
 * les 64 combinaisons de l'interrupteur SEO_PRUNE.
 *
 *   - Chaque adresse de must-stay-indexable.txt (2 821) reste indexable sous
 *     toutes les combinaisons. Seule exception, décidée par Killian le
 *     14/09/2026 : les fiches « DM- » (copies de distrimotor.com) sortent avec
 *     « products », y compris les 335 que le plan gardait.
 *   - Chaque adresse de chaque liste de retrait sort quand sa famille est
 *     allumée, et reste quand elle ne l'est pas.
 *   - Pour chacune, le middleware pose la balise ET l'en-tête, identiques.
 *
 * Le rendu réel, page par page, est dans tests/integration/politique-indexation.test.js.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const ejs = require('ejs');

delete process.env.SEO_PRUNE;
for (const cle of Object.keys(process.env)) if (cle.startsWith('SEO_PRUNE_SINCE_')) delete process.env[cle];

const politique = require('../../src/services/seoIndexPolicy');
const generateur = require('../../scripts/generer-index-policy');

const RACINE = path.join(__dirname, '..', '..');
const FIXTURES = path.join(__dirname, '..', 'fixtures', 'seo');
const LISTES = path.join(RACINE, 'src', 'data', 'seo', 'listes');
const HOTE = 'https://autoliva.com';

function lire(fichier) {
  const brut = fichier.endsWith('.gz') ? zlib.gunzipSync(fs.readFileSync(fichier)).toString('utf8') : fs.readFileSync(fichier, 'utf8');
  return brut.split('\n').map((l) => l.trim()).filter(Boolean);
}
const chemins = (fichier) => lire(fichier).map((u) => {
  assert.ok(u.startsWith(`${HOTE}/`), `${fichier} : ${u}`);
  return u.slice(HOTE.length);
});
function fichesDe(fichier) {
  const [entete, ...lignes] = lire(fichier);
  assert.equal(entete, 'product_id\tsku\tsegment\turl');
  return lignes.map((l) => {
    const [_id, sku, segment, url] = l.split('\t');
    return { _id, sku, segment, chemin: url.slice(HOTE.length) };
  });
}

const MUST_STAY = chemins(path.join(FIXTURES, 'must-stay-indexable.txt.gz'));
const NOINDEX = {
  blog: chemins(path.join(FIXTURES, 'noindex-blog-fr.txt.gz')),
  reference: chemins(path.join(FIXTURES, 'noindex-reference.txt.gz')),
  'pieces-auto': chemins(path.join(FIXTURES, 'noindex-pieces-auto.txt.gz')),
  de: chemins(path.join(FIXTURES, 'noindex-de.txt.gz')),
};
const DISPARUS = chemins(path.join(LISTES, 'gone-410-blog.txt'));
const FICHES_GARDEES = fichesDe(path.join(FIXTURES, 'products-fr-keep.ids.tsv.gz'));
const FICHES_RETIREES = fichesDe(path.join(LISTES, 'products-fr-noindex.ids.tsv.gz'));
const FICHE_PAR_CHEMIN = new Map([...FICHES_GARDEES, ...FICHES_RETIREES].map((f) => [f.chemin, f]));

const FAMILLES = politique.FAMILLES;
const COMBINAISONS = [];
for (let masque = 0; masque < (1 << FAMILLES.length); masque++) {
  COMBINAISONS.push(new Set(FAMILLES.filter((_, i) => masque & (1 << i))));
}
const sauf = (famille) => new Set(FAMILLES.filter((f) => f !== famille));
const seulement = (...familles) => new Set(familles);

/** 'index', 'noindex' ou '410' pour une adresse du site, sous des familles données. */
function decision(chemin, familles) {
  if (chemin.startsWith('/product/')) {
    const fiche = FICHE_PAR_CHEMIN.get(chemin);
    assert.ok(fiche, `${chemin} : fiche absente des listes d'identifiants`);
    return politique.produitNoindex(fiche, familles) ? 'noindex' : 'index';
  }
  const d = politique.decisionChemin(chemin, familles);
  if (!d) return 'index';
  return d.statut === 410 ? '410' : 'noindex';
}

/* ─── Le fichier commité et son générateur ─────────────────────────────────── */

test('index-policy.json est exactement ce que le générateur tire des listes commitées', () => {
  const attendu = generateur.serialiser(generateur.construirePolitique(generateur.lireListes(generateur.DOSSIER_LISTES)));
  assert.equal(fs.readFileSync(generateur.FICHIER_POLITIQUE, 'utf8'), attendu,
    'index-policy.json n’est plus à jour : node scripts/generer-index-policy.js');
});

test('les listes commitées sont celles du plan : comptes et recoupements', () => {
  const p = require('../../src/data/seo/index-policy.json');
  assert.equal(p.blog.garder.length, 296);
  assert.equal(p.blog.maillage.length, 76);
  assert.equal(p.disparus.fr.length + p.disparus.de.length, 268);
  assert.equal(p.piecesAuto.garder.length, 242);
  assert.deepEqual(p.references.garder, ['0AM927769G', '4797786420', 'C2D3506']);
  assert.equal(p.produits.noindex.length, 11125);
  assert.deepEqual(p.produits.prefixesSku, ['DM-'], 'décision du 14/09/2026 : toutes les copies distrimotor');
  assert.ok(!p.piecesAuto.garder.includes('/pieces-auto'), 'la racine /pieces-auto n’est pas une page de la règle');
  assert.equal(MUST_STAY.length, 2821);
  assert.equal(DISPARUS.length, 268);
});

test('le générateur refuse une page à la fois gardée et en 410, et une racine /pieces-auto dans la liste blanche', () => {
  const brut = generateur.lireListes(generateur.DOSSIER_LISTES);
  const unDisparu = lire(path.join(LISTES, 'gone-410-blog.txt'))[0];
  assert.throws(() => generateur.construirePolitique({ ...brut, 'keep-blog-fr.txt': `${brut['keep-blog-fr.txt']}${unDisparu}\n` }), /gardé et en 410/);
  assert.throws(() => generateur.construirePolitique({ ...brut, 'keep-pieces-auto.txt': `${brut['keep-pieces-auto.txt']}${HOTE}/pieces-auto\n` }), /pas une page véhicule/);
  assert.equal(generateur.serialiser(generateur.construirePolitique(brut)), generateur.serialiser(generateur.construirePolitique(brut)), 'déterministe');
});

/* ─── L'interrupteur ──────────────────────────────────────────────────────── */

test('SEO_PRUNE : absent = aucune famille ; mots inconnus ignorés ; casse, espaces et soulignés tolérés', () => {
  assert.deepEqual([...politique.famillesActives({})], []);
  assert.deepEqual([...politique.famillesActives({ SEO_PRUNE: '' })], []);
  assert.deepEqual([...politique.famillesActives({ SEO_PRUNE: ' Gone , BLOG;pieces_auto  de ' })].sort(), ['blog', 'de', 'gone', 'pieces-auto']);
  assert.deepEqual([...politique.famillesActives({ SEO_PRUNE: 'all,tout,products-fr,*' })], [], 'jamais d’allumage par un mot inconnu');
  assert.deepEqual([...politique.famillesActives({ SEO_PRUNE: 'reference,products' })].sort(), ['products', 'reference']);
});

test('SEO_PRUNE absent : le middleware ne touche à rien, pas même une variable de vue', () => {
  delete process.env.SEO_PRUNE;
  for (const chemin of ['/blog/x', `${DISPARUS[0].replace(HOTE, '')}`, '/de/produits/x', '/reference/X', '/pieces-auto/x/y']) {
    const res = fauxRes();
    let suite = false;
    politique.middleware({ method: 'GET', path: chemin }, res, () => { suite = true; });
    assert.ok(suite, chemin);
    assert.deepEqual(res.locals, {}, chemin);
    assert.deepEqual(res.entetes, {}, chemin);
  }
});

/* ─── Exhaustif, sur les listes complètes ─────────────────────────────────── */

test('must-stay-indexable : les 2 821 adresses restent indexables sous les 64 combinaisons (sauf les copies DM- avec « products »)', () => {
  let dm = 0;
  for (const chemin of MUST_STAY) {
    const fiche = chemin.startsWith('/product/') ? FICHE_PAR_CHEMIN.get(chemin) : null;
    const copieDm = !!(fiche && /^DM-/i.test(fiche.sku));
    if (copieDm) dm++;
    for (const familles of COMBINAISONS) {
      const attendu = copieDm && familles.has('products') ? 'noindex' : 'index';
      assert.equal(decision(chemin, familles), attendu, `${chemin} sous [${[...familles].join(',')}]`);
    }
  }
  assert.equal(dm, 335, 'les 335 copies distrimotor que le plan gardait');
});

for (const [famille, liste] of Object.entries(NOINDEX)) {
  test(`${famille} : chaque adresse de noindex-${famille === 'blog' ? 'blog-fr' : famille}.txt (${liste.length}) sort avec sa famille, et seulement avec elle`, () => {
    for (const chemin of liste) {
      assert.equal(decision(chemin, seulement(famille)), 'noindex', `${chemin} : ${famille} allumée`);
      assert.equal(decision(chemin, new Set()), 'index', `${chemin} : rien d’allumé`);
      /* Les autres familles ne la touchent pas (les 410 allemands suivent « gone »,
         qui n'est pas leur famille ici : ils ne sont pas dans noindex-de.txt). */
      assert.equal(decision(chemin, sauf(famille)), 'index', `${chemin} : toutes les familles sauf ${famille}`);
    }
  });
}

test('gone : les 268 adresses répondent 410 avec « gone », rejoignent leur famille sans elle, restent sans rien', () => {
  for (const chemin of DISPARUS) {
    const de = chemin.startsWith('/de/');
    assert.equal(decision(chemin, seulement('gone')), '410', chemin);
    assert.equal(decision(chemin, sauf('gone')), 'noindex', `${chemin} : sans « gone », ${de ? 'la couche allemande' : 'un article non gardé'}`);
    assert.equal(decision(chemin, new Set()), 'index', chemin);
  }
});

test('pages d’arrivée Google Ads (tier K2, 1 731 adresses publiques) : jamais un 410, quelle que soit la combinaison', () => {
  /* Le seul statut que la politique change est le 410 des articles de
     gone-410-blog.txt : aucune page d'arrivée d'une annonce ne doit s'y
     trouver (une landing indisponible fait refuser l'annonce). Les fiches ne
     reçoivent jamais de 410 ; elles restent en ligne et en vente. */
  const k2 = lire(path.join(FIXTURES, 'pages-ads-k2.txt.gz'));
  assert.equal(k2.length, 1731);
  const tout = new Set(FAMILLES);
  for (const chemin of k2) {
    const d = politique.decisionChemin(chemin, tout);
    assert.ok(!d || d.statut !== 410, `${chemin} : une page d’arrivée Ads répondrait 410`);
  }
});

test('products : les 11 125 fiches de la liste et toutes les DM- sortent avec « products » ; les autres gardées restent', () => {
  for (const fiche of FICHES_RETIREES) {
    assert.equal(politique.produitNoindex(fiche, seulement('products')), true, fiche.chemin);
    assert.equal(politique.produitNoindex(fiche, sauf('products')), false, `${fiche.chemin} : « products » coupée`);
  }
  for (const fiche of FICHES_GARDEES) {
    assert.equal(politique.produitNoindex(fiche, seulement('products')), /^DM-/i.test(fiche.sku), fiche.chemin);
  }
  /* Tout SKU DM-, même absent des listes (fiche future), et en minuscules. */
  assert.equal(politique.produitNoindex({ _id: '0123456789abcdef01234567', sku: ' dm-12345 ' }, seulement('products')), true);
  assert.equal(politique.produitNoindex({ _id: '0123456789abcdef01234567', sku: 'ASY-1' }, seulement('products')), false);
});

test('products : le choix de l’admin passe devant la liste et le préfixe — mais seulement avec « products »', () => {
  const listee = FICHES_RETIREES[0];
  const gardee = FICHES_GARDEES.find((f) => !/^DM-/.test(f.sku));
  const dm = FICHES_GARDEES.find((f) => /^DM-/.test(f.sku));
  const avec = (f, o) => ({ ...f, seo: { indexOverride: o } });
  assert.equal(politique.produitNoindex(avec(listee, 'index'), seulement('products')), false);
  assert.equal(politique.produitNoindex(avec(dm, 'index'), seulement('products')), false);
  assert.equal(politique.produitNoindex(avec(gardee, 'noindex'), seulement('products')), true);
  assert.equal(politique.produitNoindex(avec(gardee, 'NOINDEX '), seulement('products')), true, 'valeur normalisée');
  assert.equal(politique.produitNoindex(avec(listee, 'n’importe quoi'), seulement('products')), true, 'valeur inconnue = automatique');
  assert.equal(politique.produitNoindex(avec(gardee, 'noindex'), sauf('products')), false, 'couper « products » remet tout à l’index');
  assert.deepEqual([
    politique.motifProduit(avec(dm, 'index')), politique.motifProduit(avec(gardee, 'noindex')),
    politique.motifProduit(listee), politique.motifProduit(dm), politique.motifProduit(gardee),
  ], ['index', 'noindex', 'liste', 'prefixe', '']);
});

test('chemins : casse, barre finale, encodage — même décision ; la racine /pieces-auto n’est jamais visée', () => {
  const tout = new Set(FAMILLES);
  const [refGardee] = politique.referencesGardees();
  assert.equal(decision(`/reference/${refGardee.toLowerCase()}`, tout), 'index');
  assert.equal(decision('/reference/abc123', tout), 'noindex');
  /* Une référence avec « / » est servie encodée (sitemap : encodeURIComponent). */
  assert.equal(decision('/reference/M48%2F01', tout), 'noindex');
  assert.equal(decision(`/reference/${encodeURIComponent(refGardee)}`, tout), 'index');
  for (const racine of ['/pieces-auto', '/pieces-auto/', '/PIECES-AUTO']) assert.equal(decision(racine, tout), 'index', racine);
  assert.equal(decision('/pieces-auto/audi/', tout), 'index');
  assert.equal(decision('/Pieces-Auto/AUDI/A4', tout), 'index');
  assert.equal(decision('/pieces-auto/audi/a4/turbos', tout), 'noindex');
  const disparu = DISPARUS.find((c) => c.startsWith('/blog/'));
  assert.equal(decision(`${disparu}/`, tout), '410');
  assert.equal(decision(disparu.toUpperCase(), tout), '410');
  assert.equal(decision(`${disparu}?utm_source=x`, tout), '410');
  for (const statique of ['/', '/blog', '/produits', '/categorie', '/moteurs', '/boites-vitesse', '/legal/cgv', '/panier', '/de-quelque-chose']) {
    assert.equal(decision(statique, tout), 'index', statique);
  }
  for (const de of ['/de', '/de/', '/DE/Blog', '/de/legal/cgv', '/de/produits']) assert.equal(decision(de, tout), 'noindex', de);
});

/* ─── Balise ET en-tête, pour chaque adresse ──────────────────────────────── */

function fauxRes() {
  const res = { locals: {}, entetes: {}, code: 200, vue: null, options: null };
  res.set = (k, v) => { res.entetes[k.toLowerCase()] = v; return res; };
  res.get = (k) => res.entetes[k.toLowerCase()];
  res.status = (c) => { res.code = c; return res; };
  res.render = (vue, options) => { res.vue = vue; res.options = options; return res; };
  return res;
}
function passer(chemin) {
  const res = fauxRes();
  let suite = false;
  politique.middleware({ method: 'GET', path: chemin }, res, () => { suite = true; });
  return { res, suite };
}

test('middleware, toutes familles allumées : pour chaque adresse des listes, la balise et l’en-tête disent la même chose', (t) => {
  process.env.SEO_PRUNE = FAMILLES.join(',');
  t.after(() => { delete process.env.SEO_PRUNE; });
  const cas = [
    ...MUST_STAY.filter((c) => !c.startsWith('/product/')).map((c) => [c, 'index']),
    ...Object.values(NOINDEX).flat().map((c) => [c, 'noindex']),
    ...DISPARUS.map((c) => [c, '410']),
  ];
  for (const [chemin, attendu] of cas) {
    const { res, suite } = passer(chemin);
    if (attendu === 'index') {
      assert.ok(suite, chemin);
      assert.equal(res.locals.seoForceNoindex, undefined, chemin);
      assert.equal(res.entetes['x-robots-tag'], undefined, chemin);
    } else {
      assert.equal(res.locals.seoForceNoindex, 'noindex, follow', chemin);
      assert.equal(res.entetes['x-robots-tag'], res.locals.seoForceNoindex, `${chemin} : balise et en-tête`);
      if (attendu === '410') {
        assert.ok(!suite, chemin);
        assert.equal(res.code, 410, chemin);
        assert.equal(res.vue, 'errors/410', chemin);
        assert.equal(res.options.lienBlog, chemin.startsWith('/de/') ? '/de/blog' : '/blog', chemin);
      } else {
        assert.ok(suite, chemin);
      }
    }
    /* hreflang : la couche allemande n'est plus déclarée nulle part. */
    assert.equal(res.locals.seoHreflangSansDe, true);
  }
});

test('middleware : un en-tête déjà plus strict (hors production, FORCE_NOINDEX) est gardé et recopié dans la balise', (t) => {
  process.env.SEO_PRUNE = 'blog';
  t.after(() => { delete process.env.SEO_PRUNE; });
  const res = fauxRes();
  res.set('X-Robots-Tag', 'noindex, nofollow');
  politique.middleware({ method: 'GET', path: NOINDEX.blog[0] }, res, () => {});
  assert.equal(res.entetes['x-robots-tag'], 'noindex, nofollow');
  assert.equal(res.locals.seoForceNoindex, 'noindex, nofollow');
  /* Un POST n'est jamais servi en 410. */
  process.env.SEO_PRUNE = 'gone';
  let suite = false;
  const post = fauxRes();
  politique.middleware({ method: 'POST', path: DISPARUS[0] }, post, () => { suite = true; });
  assert.ok(suite);
  assert.equal(post.code, 200);
});

/* ─── partials/head.ejs ───────────────────────────────────────────────────── */

const HEAD = path.join(RACINE, 'src', 'views', 'partials', 'head.ejs');
function rendreHead(locaux) {
  const brand = { NAME: 'Autoliva', FAVICON_URL: '/f.png', APPLE_TOUCH_ICON_URL: '' };
  return ejs.render(fs.readFileSync(HEAD, 'utf8'), { brand, ...locaux }, { filename: HEAD });
}
const baliseRobots = (html) => (html.match(/<meta name="robots" content="([^"]*)"\/>/) || [])[1];
const hreflangs = (html) => [...html.matchAll(/<link rel="alternate" hreflang="([^"]*)" href="([^"]*)"\/>/g)].map((m) => m[1]);

test('head.ejs : seoForceNoindex passe devant tout metaRobots ; sans lui, rien ne change', () => {
  assert.equal(baliseRobots(rendreHead({ metaRobots: 'index, follow', seoForceNoindex: 'noindex, follow' })), 'noindex, follow');
  assert.equal(baliseRobots(rendreHead({ metaRobots: undefined, seoForceNoindex: 'noindex, follow' })), 'noindex, follow');
  assert.equal(baliseRobots(rendreHead({ metaRobots: 'index, follow' })), 'index, follow');
  assert.equal(baliseRobots(rendreHead({})), 'index, follow, max-image-preview:large, max-snippet:-1, max-video-preview:-1');
  assert.equal(baliseRobots(rendreHead({ metaRobots: 'noindex, follow' })), 'noindex, follow');
});

test('head.ejs : famille « de » — plus de hreflang de, fr et x-default (français) restent ; sans elle, tout reste', () => {
  const hreflangTags = [
    { lang: 'fr', href: 'https://autoliva.com/product/x/' },
    { lang: 'de', href: 'https://autoliva.com/de/produits/x-1' },
    { lang: 'x-default', href: 'https://autoliva.com/product/x/' },
  ];
  assert.deepEqual(hreflangs(rendreHead({ hreflangTags, seoHreflangSansDe: true })), ['fr', 'x-default']);
  assert.deepEqual(hreflangs(rendreHead({ hreflangTags })), ['fr', 'de', 'x-default']);
  assert.equal(hreflangTags.length, 3, 'les données du sélecteur de langue ne sont pas touchées');
});

/* ─── Articles : filtre des requêtes publiques et liens morts ─────────────── */

test('publicBlogFilter : SEO_PRUNE absent → le filtre reçu, le même objet', () => {
  delete process.env.SEO_PRUNE;
  const filtre = { isPublished: true, slug: { $ne: 'x' } };
  assert.equal(politique.publicBlogFilter(filtre), filtre);
  assert.equal(politique.publicBlogFilter(filtre, { lang: 'de' }), filtre);
  assert.equal(politique.publicBlogFilter(filtre, { page: true }), filtre);
});

test('publicBlogFilter : blog → les gardés ; gone → pas les 410 ; la page d’un article en noindex reste servie ; l’allemand ne perd que ses 410', (t) => {
  t.after(() => { delete process.env.SEO_PRUNE; });
  const garde = politique.articlesGardes();
  process.env.SEO_PRUNE = 'blog';
  assert.deepEqual(politique.publicBlogFilter({ isPublished: true }), { isPublished: true, slug: { $in: garde } });
  assert.deepEqual(politique.publicBlogFilter({ isPublished: true }, { page: true }), { isPublished: true });
  assert.deepEqual(politique.publicBlogFilter({ isPublished: true }, { lang: 'de' }), { isPublished: true });
  /* Une condition existante sur le slug n'est jamais écrasée. */
  assert.deepEqual(politique.publicBlogFilter({ isPublished: true, slug: { $ne: 'courant' }, $and: [{ a: 1 }] }),
    { isPublished: true, slug: { $ne: 'courant' }, $and: [{ a: 1 }, { slug: { $in: garde } }] });

  process.env.SEO_PRUNE = 'gone';
  const fr = DISPARUS.filter((c) => c.startsWith('/blog/')).map((c) => c.slice('/blog/'.length)).sort();
  const de = DISPARUS.filter((c) => c.startsWith('/de/blog/')).map((c) => c.slice('/de/blog/'.length)).sort();
  assert.deepEqual(politique.publicBlogFilter({ isPublished: true }).slug.$nin.slice().sort(), fr);
  assert.deepEqual(politique.publicBlogFilter({ isPublished: true }, { page: true }).slug.$nin.slice().sort(), fr);
  assert.deepEqual(politique.publicBlogFilter({ isPublished: true }, { lang: 'de' }).slug.$nin.slice().sort(), de);

  process.env.SEO_PRUNE = 'gone,blog';
  assert.equal(politique.articleListable(garde[0]), true);
  assert.equal(politique.articleListable(fr[0]), false);
  assert.equal(politique.articleListable(NOINDEX.blog[0].slice('/blog/'.length)), false);
  assert.equal(politique.articleListable(fr[0], { lang: 'de' }), false);
  assert.equal(politique.articleListable(NOINDEX.blog[0].slice('/blog/'.length), { lang: 'de' }), true);
});

test('liens vers un 410 : la balise <a> part sous toutes les écritures, le texte reste ; rien sans « gone »', (t) => {
  t.after(() => { delete process.env.SEO_PRUNE; });
  const disparu = DISPARUS.find((c) => c.startsWith('/blog/')).slice('/blog/'.length);
  const garde = politique.articlesGardes()[0];
  const html = [
    `<p><a href="/blog/${disparu}">relatif</a>`,
    `<a class="x" href="https://autoliva.com/blog/${disparu}/" target="_blank">absolu</a>`,
    `<a href='https://www.carpartsfrance.fr/blog/${disparu}'>ancien domaine</a>`,
    `<a href=http://carpartsfrance.fr/blog/${disparu}?utm=1>sans guillemets</a>`,
    `<a href="//autoliva.com/de/blog/${disparu}#faq"><strong>allemand</strong></a>`,
    `<a href="/blog/${garde}">gardé</a> <a href="https://example.com/blog/${disparu}">autre site</a> <a href="/product/${disparu}/">fiche</a>`,
    /* Seul l'attribut href compte : un data-href vers le 410 ne condamne pas un lien vivant. */
    `<a data-href="/blog/${disparu}" href="/blog/${garde}">vivant</a></p>`,
  ].join(' ');
  process.env.SEO_PRUNE = 'blog';
  assert.equal(politique.retirerLiensDisparus(html), html, '« gone » coupée : rien ne change');
  process.env.SEO_PRUNE = 'gone';
  const net = politique.retirerLiensDisparus(html);
  const restants = [...net.matchAll(/<a\b[^>]*>/g)].map((m) => m[0]).filter((a) => a.includes(disparu));
  assert.deepEqual(restants, [`<a href="https://example.com/blog/${disparu}">`, `<a href="/product/${disparu}/">`, `<a data-href="/blog/${disparu}" href="/blog/${garde}">`],
    'seuls restent les liens qui ne mènent pas à l’article en 410');
  for (const texte of ['relatif', 'absolu', 'ancien domaine', 'sans guillemets', '<strong>allemand</strong>']) assert.ok(net.includes(texte), texte);
  assert.ok(net.includes(`<a href="/blog/${garde}">gardé</a>`));
  assert.ok(net.includes(`<a href="https://example.com/blog/${disparu}">autre site</a>`), 'un autre site n’est pas le nôtre');
  assert.ok(net.includes(`<a href="/product/${disparu}/">fiche</a>`));
});

/* ─── Dates de bascule et sitemaps de retrait ─────────────────────────────── */

test('dates de bascule : la variable Render passe devant le fichier ; invalide ou à venir → rien ; huit semaines de retrait', () => {
  const maintenant = Date.parse('2026-10-01T12:00:00Z');
  const env = { SEO_PRUNE: 'blog,pieces-auto,de', SEO_PRUNE_SINCE_BLOG: '2026-09-16', SEO_PRUNE_SINCE_PIECES_AUTO: '2026-09-18', SEO_PRUNE_SINCE_DE: '16/09/2026' };
  assert.equal(politique.dateBascule('blog', { maintenant, env }), '2026-09-16');
  assert.equal(politique.dateBascule('pieces-auto', { maintenant, env }), '2026-09-18');
  assert.equal(politique.dateBascule('de', { maintenant, env }), '', 'format invalide');
  assert.equal(politique.dateBascule('blog', { maintenant: Date.parse('2026-09-15T00:00:00Z'), env }), '', 'à venir');
  assert.ok(politique.retraitsEnCours('blog', { maintenant, env }));
  assert.ok(politique.retraitsEnCours('de', { maintenant, env }), 'sans date : servi jusqu’à ce qu’on en pose une');
  assert.ok(!politique.retraitsEnCours('gone', { maintenant, env }), 'famille coupée : pas de retrait');
  const fin = Date.parse('2026-09-16T00:00:00Z') + 56 * 24 * 3600 * 1000;
  assert.ok(politique.retraitsEnCours('blog', { maintenant: fin - 1, env }));
  assert.ok(!politique.retraitsEnCours('blog', { maintenant: fin, env }), 'huit semaines plus tard');
  assert.deepEqual(politique.famillesEnRetrait({ maintenant: fin, env }), ['pieces-auto', 'de']);
});

/* ─── Maillage des 76 articles gardés sans lien ───────────────────────────── */

test('maillage : chaque article à mailler publié reçoit un hôte gardé, jamais lui-même, de sa catégorie d’abord', () => {
  const p = require('../../src/data/seo/index-policy.json');
  /* Tous les gardés publiés, répartis sur 4 catégories — les articles à
     mailler d'une catégorie « isolée » doivent trouver un hôte ailleurs. */
  const categories = ['transfert', 'pont', 'mecatronique', 'moteur'];
  const articles = p.blog.garder.map((slug, i) => ({ slug, category: { slug: categories[i % 4] } }));
  articles.push({ slug: 'article-non-garde', category: { slug: 'pont' } });
  const parHote = politique.repartirMaillage(articles);
  const hotes = new Map();
  for (const [hote, cibles] of parHote) for (const c of cibles) hotes.set(c, hote);
  assert.deepEqual([...hotes.keys()].sort(), p.blog.maillage.slice().sort(), 'chacun des 76 a un hôte');
  const categorie = new Map(articles.map((a) => [a.slug, a.category.slug]));
  for (const [cible, hote] of hotes) {
    assert.notEqual(hote, cible);
    assert.ok(p.blog.garder.includes(hote), `${hote} : l’hôte est un article gardé`);
  }
  const memeCategorie = [...hotes].filter(([c, h]) => categorie.get(c) === categorie.get(h)).length;
  assert.ok(memeCategorie >= 70, `la plupart dans leur catégorie (${memeCategorie}/76)`);
  for (const cibles of parHote.values()) assert.ok(cibles.length <= 2, 'au plus deux par hôte');
  assert.deepEqual(politique.repartirMaillage(articles.slice().reverse()), parHote, 'stable, quel que soit l’ordre de la base');
  /* Un article à mailler seul dans sa catégorie trouve un hôte ailleurs ; un
     article non publié n'en demande pas. */
  const seul = p.blog.maillage[0];
  const autre = p.blog.garder.find((s) => !p.blog.maillage.includes(s));
  const petit = politique.repartirMaillage([{ slug: seul, category: { slug: 'seule' } }, { slug: autre, category: { slug: 'ailleurs' } }]);
  assert.deepEqual([...petit], [[autre, [seul]]]);
});
