/**
 * Polices locales : chaque icône utilisée par une vue doit être dans le
 * sous-ensemble embarqué (public/fonts/manifest.json). Sinon elle s'affiche
 * en toutes lettres — « shopping_cart » à la place du panier. Le remède :
 *
 *   node scripts/polices-locales.js
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');

const { extraireIcones, MANIFEST } = require('../../scripts/polices-locales');

test('toutes les icônes des vues sont dans le sous-ensemble de police embarqué', () => {
  assert.ok(fs.existsSync(MANIFEST), 'public/fonts/manifest.json manquant : lancer node scripts/polices-locales.js');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const embarquees = new Set(manifest.icones);
  const { strictes } = extraireIcones();
  const manquantes = [...strictes].filter((n) => !embarquees.has(n)).sort();
  assert.deepEqual(manquantes, [], 'icône(s) absente(s) du sous-ensemble — relancer node scripts/polices-locales.js');
  assert.ok(strictes.size > 100, 'l’extraction doit voir les icônes des vues (' + strictes.size + ' trouvées)');
});

test('les six fichiers de police annoncés existent et sont bien du woff2', () => {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  assert.equal(manifest.polices.length, 6);
  for (const p of manifest.polices) {
    const chemin = require('path').join(require('path').dirname(MANIFEST), p.fichier);
    assert.ok(fs.existsSync(chemin), p.fichier + ' manquant');
    assert.equal(fs.readFileSync(chemin).slice(0, 4).toString('latin1'), 'wOF2', p.fichier + ' n’est pas un woff2');
    assert.ok(fs.statSync(chemin).size < 200 * 1024, p.fichier + ' dépasse 200 Ko : le sous-ensemble a grossi');
  }
});
