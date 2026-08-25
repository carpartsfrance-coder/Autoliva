/**
 * Tests unitaires — promesses d'argent sur la fiche produit (consigne).
 *
 * Lancé par : npm test  (aucune base de données, aucun appel réseau)
 *
 * LE BUG VÉCU : la fiche affichait « Une consigne de 500,00 € est encaissée à
 * la commande, puis remboursée au retour » sur des produits dont l'option
 * « Encaisser la consigne à la commande » n'était PAS cochée. Rien n'était
 * prélevé — le back-end exige `enabled && chargeUpfront` — donc rien ne
 * pouvait être remboursé. 5 908 fiches publiées promettaient de 300 à 700 €
 * qui n'existaient pas. Et le bandeau se contredisait : titre « SANS CAUTION »
 * au-dessus du montant encaissé.
 *
 * LA CONFUSION D'ORIGINE : deux notions distinctes.
 *   hasConsigne     → la pièce est en échange standard (ancienne pièce à rendre)
 *   consigneUpfront → la caution est réellement encaissée
 * Elles sont indépendantes : « sans caution » = échange standard SANS argent
 * avancé. Toute phrase parlant d'argent doit se baser sur la seconde.
 *
 * Ce test lit la vue et refuse qu'une promesse d'argent retombe sur la
 * première. C'est un contrôle statique : il attrape la rechute sans base ni
 * navigateur.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const VUE = path.join(__dirname, '..', '..', 'src', 'views', 'products', 'show.ejs');
const source = fs.readFileSync(VUE, 'utf8');

/* Clés de traduction qui annoncent un encaissement ou un remboursement. */
const CLES_ARGENT = [
  'product.exchangeHowSubConsigne',
  'product.exStep1TextConsigne',
  'product.depositNote',
  'product.trustExchangeConsigne',
];

test('aucune promesse d’argent ne dépend de hasConsigne', async (t) => {
  for (const cle of CLES_ARGENT) {
    await t.test(cle + ' est conditionnée par consigneUpfront', () => {
      const lignes = source.split('\n').filter((l) => l.includes(cle));
      assert.ok(lignes.length > 0, cle + ' introuvable dans la vue — clé renommée ?');
      for (const ligne of lignes) {
        assert.ok(
          ligne.includes('consigneUpfront'),
          'Cette ligne promet de l’argent sans vérifier qu’il est encaissé :\n      ' + ligne.trim()
        );
        assert.ok(
          !/hasConsigne\s*\?[^:]*\b/.test(ligne.replace(/consigneUpfront/g, '')),
          'hasConsigne ne doit pas arbitrer une promesse d’argent :\n      ' + ligne.trim()
        );
      }
    });
  }
});

test('le libellé du bandeau suit le régime réel', async (t) => {
  await t.test('« Sans caution » n’est plus codé en dur', () => {
    /* Le bandeau titrait « SANS CAUTION » même quand la caution ÉTAIT
       encaissée : la contradiction jouait dans les deux sens. */
    const lignes = source.split('\n').filter((l) => l.includes('product.noDepositWord'));
    assert.ok(lignes.length > 0, 'libellé introuvable');
    for (const ligne of lignes) {
      assert.ok(ligne.includes('consigneUpfront'),
        'le libellé doit dépendre du régime :\n      ' + ligne.trim());
    }
  });
});

test('les deux notions restent bien distinctes', async (t) => {
  await t.test('consigneUpfront exige explicitement chargeUpfront', () => {
    /* Si un jour consigneUpfront devenait un alias de hasConsigne, tous les
       tests ci-dessus passeraient tout en réintroduisant le bug. */
    const decl = source.split('\n').find((l) => l.includes('const consigneUpfront'));
    assert.ok(decl, 'déclaration introuvable');
    assert.match(decl, /chargeUpfront\s*===\s*true/,
      'consigneUpfront doit vérifier chargeUpfront === true');
  });

  await t.test('hasConsigne reste le marqueur « échange standard »', () => {
    const decl = source.split('\n').find((l) => l.includes('const hasConsigne'));
    assert.ok(decl, 'déclaration introuvable');
    assert.match(decl, /consigne\.enabled/);
    assert.ok(!decl.includes('chargeUpfront'),
      'hasConsigne ne doit PAS dépendre de chargeUpfront : une pièce en échange '
      + 'standard sans caution reste un échange standard');
  });
});
