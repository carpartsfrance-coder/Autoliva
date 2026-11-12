/**
 * La description d'une fiche produit doit être DANS la page.
 *
 * Lancé par : npm test  (aucune base, aucun réseau)
 *
 * ── L'incident (05/07 → 14/09/2026) ─────────────────────────────────────────
 *
 * La refonte « Autoparts v3 » du 05/07/2026 a réécrit le gabarit de la fiche
 * sans le bloc description. Rien n'a cassé : le contrôleur continuait de
 * calculer `descriptionHtmlSafe`, la page s'affichait, les tests passaient.
 * Simplement, plus aucune des 13 362 fiches ne montrait son texte propre.
 *
 * Pour Google, deux mois de pages identiques à 95 % — même gabarit, seul le
 * titre changeait. Le 31/08, le site entier a été déclassé.
 *
 * Ce test ne vérifie pas le style : il vérifie que le texte est rendu, et
 * qu'il l'est dans une section repérable.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const GABARIT = fs.readFileSync(path.join(__dirname, '../../src/views/products/show.ejs'), 'utf8');

test('le gabarit de la fiche rend la description', async (sub) => {
  await sub.test('le HTML nettoyé de la description est bien écrit dans la page', () => {
    assert.match(GABARIT, /<%-\s*_descHtml\s*%>/,
      'plus aucune sortie de la description : une refonte a-t-elle retiré le bloc ?');
    assert.match(GABARIT, /product\.descriptionHtmlSafe/,
      'le gabarit ne lit plus descriptionHtmlSafe');
  });

  await sub.test('à défaut de HTML, le texte brut prend le relais', () => {
    /* Une fiche importée sans HTML ne doit pas retomber dans le vide. */
    assert.match(GABARIT, /product\.descriptionText\s*\|\|\s*product\.description/);
  });

  await sub.test('la section est ancrée et titrée', () => {
    assert.match(GABARIT, /<section id="description"/);
    assert.match(GABARIT, /t\('product\.description'\)/);
  });

  await sub.test('le titre reste neutre', () => {
    /* L'ancien gabarit titrait « Reconstruite à zéro kilomètre, pas une pièce
       d'occasion » — faux pour une pièce neuve ou d'occasion. Ne pas le
       réintroduire au-dessus d'une description qui peut dire le contraire. */
    const bloc = GABARIT.slice(GABARIT.indexOf('<section id="description"'), GABARIT.indexOf('</section>', GABARIT.indexOf('<section id="description"')));
    assert.doesNotMatch(bloc, /descHeadline/);
  });
});

test('le bouton « lire la suite » parle la langue de la page', () => {
  /* Le script écrivait « Lire la suite » en dur : sur /de, le bouton
     repassait en français au premier redimensionnement. */
  assert.match(GABARIT, /data-label-more="<%= t\('product\.readMore'\) %>"/);
  assert.doesNotMatch(GABARIT, /toggleLabel\.textContent = 'Lire la suite'/);
  for (const langue of ['fr', 'de', 'en']) {
    const table = JSON.parse(fs.readFileSync(path.join(__dirname, '../../src/locales/' + langue + '.json'), 'utf8'));
    assert.ok(table['product.readLess'], 'product.readLess manque en ' + langue);
  }
});
