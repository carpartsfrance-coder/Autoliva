/**
 * Alias d'articles : un slug cité à tort renvoie en 301 vers le vrai article.
 *
 * Lancé par : npm test  (aucune base, aucun réseau)
 *
 * Audit du 25/09/2026 : l'article le plus cliqué du blog
 * (/blog/mecatronique-dsg7-dq200-diagnostic-prix-remplacement) lie
 * /blog/calculateur-edc-dc4-renault-diagnostic-prix-remplacement, une 404 :
 * l'article s'appelle calculateur-boite-edc-dc4-…
 */

const test = require('node:test');
const assert = require('node:assert');

const wpRedirects = require('../../src/middlewares/wpRedirects');
const politique = require('../../src/services/seoIndexPolicy');

const CIBLE = 'calculateur-boite-edc-dc4-renault-diagnostic-prix-remplacement';

function passer(chemin, method = 'GET') {
  const sortie = { redirection: null, suite: false };
  const res = { redirect: (code, cible) => { sortie.redirection = [code, cible]; } };
  wpRedirects({ method, path: chemin, originalUrl: chemin, query: {} }, res, () => { sortie.suite = true; });
  return sortie;
}

test('le slug cité par l’article DQ200 renvoie en 301 vers l’article EDC DC4', () => {
  for (const chemin of [
    '/blog/calculateur-edc-dc4-renault-diagnostic-prix-remplacement',
    '/blog/calculateur-edc-dc4-renault-diagnostic-prix-remplacement/',
    '/blog/Calculateur-EDC-DC4-Renault-Diagnostic-Prix-Remplacement',
  ]) {
    assert.deepEqual(passer(chemin).redirection, [301, `/blog/${CIBLE}`], chemin);
  }
  /* La cible est un article gardé : la redirection ne mène pas à un noindex. */
  assert.ok(politique.articlesGardes().includes(CIBLE), `${CIBLE} doit être dans keep-blog-fr.txt`);
  /* Le vrai article, lui, n'est pas redirigé ; un POST non plus. */
  assert.equal(passer(`/blog/${CIBLE}`).suite, true);
  assert.equal(passer('/blog/calculateur-edc-dc4-renault-diagnostic-prix-remplacement', 'POST').suite, true);
});
