/**
 * Le garde-fou qui autorise, ou non, une écriture en production.
 *
 * Lancé par : npm test
 *
 * Il a déjà refusé une réparation légitime le 04/10/2026 : mesurée sur le seul
 * blog, la proportion d'images absentes valait 8,2 % et ressemblait à une
 * panne, alors que les 7 777 médias des fiches répondaient tous. Ces cas
 * figent la distinction : UNE CASSE RÉELLE concentrée sur un corpus se répare ;
 * UN STOCKAGE QUI RÉPOND MAL ne se répare pas, il se regarde.
 */

const test = require('node:test');
const assert = require('node:assert');

const { verdictEcriture, SEUIL_SITE, SEUIL_CORPUS } = require('../../src/services/gardeFousMedias');

test('stockage vide : on n’écrit rien (base incomplète, ou mauvaise base)', () => {
  const v = verdictEcriture({ mediasStockes: 0, totalSite: 8000, absentsSite: 8000, totalCorpus: 700, absentsCorpus: 700 });
  assert.equal(v.ecrire, false);
  assert.match(v.raison, /AUCUN média/);
});

test('le cas réel du 04/10/2026 : 8,2 % sur le blog, 0 % sur les fiches → on répare', () => {
  const v = verdictEcriture({
    mediasStockes: 17555,
    totalSite: 7837, absentsSite: 58,
    totalCorpus: 707, absentsCorpus: 58,
  });
  assert.equal(v.ecrire, true, `refus inattendu : ${v.raison}`);
});

test('le cas réel des fiches (02/10/2026) : 10 absents sur 7 787 → on répare', () => {
  const v = verdictEcriture({
    mediasStockes: 17555,
    totalSite: 7787, absentsSite: 10,
    totalCorpus: 7787, absentsCorpus: 10,
  });
  assert.equal(v.ecrire, true, `refus inattendu : ${v.raison}`);
});

test('tout le site plonge : c’est le stockage, on n’écrit pas', () => {
  const v = verdictEcriture({
    mediasStockes: 12,
    totalSite: 7837, absentsSite: 7000,
    totalCorpus: 707, absentsCorpus: 600,
  });
  assert.equal(v.ecrire, false);
  assert.match(v.raison, /TOUT le site/);
});

test('juste au-dessus du seuil du site : refus', () => {
  const total = 10000;
  const v = verdictEcriture({
    mediasStockes: 17555,
    totalSite: total, absentsSite: Math.floor(total * SEUIL_SITE) + 1,
    totalCorpus: 700, absentsCorpus: 1,
  });
  assert.equal(v.ecrire, false);
});

test('juste au-dessous du seuil du site : écriture autorisée', () => {
  const total = 10000;
  const v = verdictEcriture({
    mediasStockes: 17555,
    totalSite: total, absentsSite: Math.floor(total * SEUIL_SITE),
    totalCorpus: 700, absentsCorpus: 1,
  });
  assert.equal(v.ecrire, true, `refus inattendu : ${v.raison}`);
});

test('un corpus à moitié effacé ne se nettoie pas tout seul, même si le site va bien', () => {
  /* 400 absents sur 700 pour le blog, mais le site compte 80 000 médias :
     la proportion globale reste sous le seuil. Le second garde-fou prend
     le relais. */
  const v = verdictEcriture({
    mediasStockes: 17555,
    totalSite: 80000, absentsSite: 400,
    totalCorpus: 700, absentsCorpus: 400,
  });
  assert.equal(v.ecrire, false);
  assert.match(v.raison, /trop pour un nettoyage automatique/);
  assert.ok(400 / 700 > SEUIL_CORPUS);
});

test('rien à réparer : écriture autorisée (le script n’aura simplement rien à faire)', () => {
  const v = verdictEcriture({ mediasStockes: 17555, totalSite: 7837, absentsSite: 0, totalCorpus: 707, absentsCorpus: 0 });
  assert.equal(v.ecrire, true);
});

test('mesures absentes : on ne prétend pas que tout va bien', () => {
  /* Sans stockage annoncé, le premier refus s'applique : c'est le bon réflexe
     pour un appel mal formé. */
  assert.equal(verdictEcriture().ecrire, false);
});
