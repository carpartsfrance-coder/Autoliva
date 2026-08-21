/**
 * Tests unitaires — protections de la recherche produits.
 *
 * Lancé par : npm test  (aucune base de données, aucun appel réseau)
 *
 * Contexte : panne du 21/08/2026. Atlas Search (processus `mongot`, côté
 * cluster) est devenu injoignable. Le `$search` n'échouait pas — il ATTENDAIT
 * vingt secondes en retenant une connexion. Et le repli chargeait les 14 464
 * fiches du catalogue en mémoire (~80 Mo) à CHAQUE recherche.
 *
 * Le filet de sécurité coûtait donc plus cher que ce qu'il remplaçait : pool
 * saturé, mémoire saturée, instance redémarrée en boucle. Ces tests
 * verrouillent les trois garde-fous.
 */

const test = require('node:test');
const assert = require('node:assert');

const svc = require('../../src/services/productListingService');

test('le repli ne rapatrie plus tout le catalogue', async (t) => {
  await t.test('il ne garde que les fiches contenant un des mots cherchés', () => {
    const f = svc.filtreTexteRepli({ archived: false }, 'mecatronique dq200');
    assert.ok(Array.isArray(f.$and), 'le filtre d’origine doit être préservé');
    assert.deepEqual(f.$and[0], { archived: false });
    const ou = f.$and[1].$or;
    assert.ok(ou.length > 0);
    /* On teste le COMPORTEMENT du motif, pas sa forme : il est élargi en
       classes de caractères pour couvrir les accents, donc le mot cherché n'y
       apparaît plus littéralement. */
    const correspond = (champ, texte) => ou.some(
      (c) => c[champ] && new RegExp(c[champ].$regex, 'i').test(texte)
    );
    assert.ok(correspond('name', 'Mécatronique DSG7'), 'le motif doit trouver le nom');
    assert.ok(correspond('sku', 'REF-DQ200-X'), 'le motif doit trouver la référence');
  });

  await t.test('un filtre $or existant n’est pas écrasé', () => {
    /* Les filtres véhicule/état posent déjà des $or. Les fusionner à plat
       élargirait la recherche au lieu de la restreindre — l’inverse du but. */
    const origine = { $or: [{ brand: 'Audi' }, { brand: 'VW' }] };
    const f = svc.filtreTexteRepli(origine, 'boite');
    assert.deepEqual(f.$and[0], origine);
    assert.ok(f.$and[1].$or.every((c) => !c.brand || c.brand.$regex));
  });

  await t.test('les mots d’un seul caractère sont écartés', () => {
    /* Ils ne discriminent rien : « a » ramènerait le catalogue entier, soit
       exactement ce qu’on cherche à éviter. C’est le plafond qui protège. */
    assert.deepEqual(svc.filtreTexteRepli({ x: 1 }, 'a'), { x: 1 });
    assert.deepEqual(svc.filtreTexteRepli({ x: 1 }, 'a b c'), { x: 1 });
    assert.deepEqual(svc.filtreTexteRepli({ x: 1 }, ''), { x: 1 });
    assert.deepEqual(svc.filtreTexteRepli({ x: 1 }, '   '), { x: 1 });
  });

  await t.test('la recherche est insensible aux accents', () => {
    /* RÉGRESSION VÉCUE EN PRODUCTION : le préfiltre était sensible aux accents.
       Le catalogue écrit « Boîte de vitesses » ; les clients tapent « boite ».
       Résultat : 0 fiche sur 3 293 — le préfiltre excluait la premiere gamme
       du site. Mongo n'aide pas ici : la collation accent-insensible ne
       s'applique pas a $regex. On élargit donc le motif nous-mêmes. */
    assert.equal(svc.motifSansAccent('boite'), svc.motifSansAccent('boîte'),
      'accentué ou non, le même motif');
    assert.match('Boîte de vitesses', new RegExp(svc.motifSansAccent('boite'), 'i'));
    assert.match('boite de vitesses', new RegExp(svc.motifSansAccent('boîte'), 'i'));
    assert.match('Mécatronique DQ200', new RegExp(svc.motifSansAccent('mecatronique'), 'i'));
  });

  await t.test('les mots vides sont écartés', () => {
    /* « boîte de vitesses » remontait 13 094 fiches sur 14 464 : le « de »
       matche presque toutes les descriptions, et le plafond tronquait
       ensuite au hasard. */
    const f = svc.filtreTexteRepli({}, 'boite de vitesses');
    const motifs = f.$and[1].$or.map((c) => Object.values(c)[0].$regex);
    assert.ok(!motifs.some((m) => m === 'de'), '« de » ne doit pas être cherché');
    assert.equal(new Set(motifs).size, 2, 'deux mots utiles : boite et vitesses');
  });

  await t.test('une requête faite uniquement de mots vides cherche quand même', () => {
    /* Sinon « le » ne restreindrait rien et ramènerait tout le catalogue. */
    const f = svc.filtreTexteRepli({}, 'le');
    assert.ok(f.$and, 'un filtre doit être posé malgré tout');
  });

  await t.test('aucun métacaractère regex ne peut atteindre la requête', () => {
    /* Sans protection, « .* » depuis la barre de recherche serait un joker
       ramenant tout le catalogue — le moyen le plus simple de refaire tomber
       le site. La protection est plus forte qu'un échappement : le découpage
       sur `[^\p{L}\p{N}]+` ÉLIMINE tout caractère non alphanumérique, donc
       aucun métacaractère ne survit jusqu'à la regex. */
    assert.deepEqual(svc.filtreTexteRepli({}, '.*'), {}, 'aucun mot exploitable');
    assert.deepEqual(svc.filtreTexteRepli({}, '.*.*.*'), {});
    assert.deepEqual(svc.filtreTexteRepli({}, '((('), {});

    const f = svc.filtreTexteRepli({}, 'dq(200)|.*');
    const regexes = f.$and[1].$or.map((c) => Object.values(c)[0].$regex);
    assert.ok(regexes.length, 'les mots alphanumériques sont conservés');
    for (const rx of regexes) {
      /* Seuls [a-z0-9] et les classes de caractères fabriquées par
         motifSansAccent : aucun métacaractère venu de la saisie. */
      assert.match(rx, /^(\[[a-zà-ÿ]+\]|[a-z0-9])+$/iu, 'motif suspect : ' + rx);
    }
    assert.ok(regexes.includes('dq') && regexes.includes('200'));
  });

  await t.test('le nombre de mots est borné', () => {
    /* Une requête de cent mots fabriquerait un $or de six cents branches. */
    const f = svc.filtreTexteRepli({}, Array.from({ length: 50 }, (_, i) => 'mot' + i).join(' '));
    assert.ok(f.$and[1].$or.length <= 6 * 6, 'au plus 6 mots × 6 champs');
  });

  await t.test('le plafond reste modeste', () => {
    /* 1 500 fiches ≈ 8 Mo contre ~80 Mo auparavant. La valeur peut bouger,
       mais pas revenir à l’ordre de grandeur qui a causé la panne. */
    assert.ok(svc.REPLI_MAX_PRODUITS > 0);
    assert.ok(svc.REPLI_MAX_PRODUITS <= 3000, 'au-delà, on retombe dans le problème d’origine');
  });
});

test('le disjoncteur cesse d’appeler Atlas après des échecs répétés', async (t) => {
  t.afterEach(() => svc.reinitialiserDisjoncteur());

  await t.test('une requête vide ne tente rien', async () => {
    assert.equal(await svc.searchProductsViaAtlas({ searchQuery: '', page: 1, perPage: 24 }), null);
  });

  await t.test('ATLAS_SEARCH=off coupe la voie Atlas sans redéploiement', async () => {
    /* L’interrupteur d’exploitation : quand ça brûle, on veut un levier
       actionnable depuis Render tout de suite, pas un déploiement. */
    const avant = process.env.ATLAS_SEARCH;
    process.env.ATLAS_SEARCH = 'off';
    try {
      const r = await svc.searchProductsViaAtlas({ searchQuery: 'boite', page: 1, perPage: 24, baseFilter: {} });
      assert.equal(r, null, 'aucun appel ne doit partir');
    } finally {
      if (avant === undefined) delete process.env.ATLAS_SEARCH;
      else process.env.ATLAS_SEARCH = avant;
    }
  });

  await t.test('OFF est insensible à la casse et aux espaces', async () => {
    const avant = process.env.ATLAS_SEARCH;
    process.env.ATLAS_SEARCH = '  OFF ';
    try {
      assert.equal(
        await svc.searchProductsViaAtlas({ searchQuery: 'boite', page: 1, perPage: 24, baseFilter: {} }),
        null
      );
    } finally {
      if (avant === undefined) delete process.env.ATLAS_SEARCH;
      else process.env.ATLAS_SEARCH = avant;
    }
  });
});
