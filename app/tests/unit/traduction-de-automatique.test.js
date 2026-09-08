'use strict';

const test = require('node:test');
const assert = require('node:assert');

const {
  aTraiter, estPerime, estEnQuarantaine, blogSourceHash, MAX_ECHECS,
} = require('../../src/jobs/traduireNouveautesDe');
const { sourceHash } = require('../../src/services/productTranslator');

/* Ce qui est vérifié ici tient en une phrase : le balayage doit voir le
   contenu NEUF ou RÉÉCRIT, et RIEN d'autre. S'il se trompe dans l'autre sens,
   il retraduit le catalogue entier — 14 000 appels — sans que personne l'ait
   demandé. */

const fiche = (extra) => Object.assign({
  name: 'Moteur Volkswagen Golf CLHA',
  description: 'Moteur reconditionné, testé sur banc.',
}, extra || {});

const traduite = (p) => Object.assign({}, p, {
  localizations: { de: { translatedAt: new Date(), sourceHash: sourceHash(p) } },
});

test('une fiche jamais traduite est prise', () => {
  assert.strictEqual(aTraiter(fiche(), sourceHash), true);
  assert.strictEqual(aTraiter(Object.assign(fiche(), { localizations: { de: { translatedAt: null } } }), sourceHash), true);
});

test('une fiche traduite et inchangée est laissée tranquille', () => {
  assert.strictEqual(aTraiter(traduite(fiche()), sourceHash), false);
});

test('un changement de prix ou de stock ne redéclenche RIEN', () => {
  const p = traduite(fiche());
  p.priceCents = 149900;
  p.stockQty = 2;
  p.updatedAt = new Date();
  assert.strictEqual(aTraiter(p, sourceHash), false);
});

test('une description réécrite redéclenche la traduction', () => {
  const p = traduite(fiche());
  p.description = 'Moteur reconditionné, testé sur banc et garanti 2 ans.';
  assert.strictEqual(aTraiter(p, sourceHash), true);
});

test('une fiche traduite AVANT les empreintes est laissée tranquille', () => {
  /* Le rattrapage pose l'empreinte sur tout l'existant. Si l'un d'eux passe
     entre les mailles, on ne le retraduit pas pour autant : on ne dépense pas
     sur un doute. */
  const p = fiche();
  p.localizations = { de: { translatedAt: new Date(), sourceHash: '' } };
  assert.strictEqual(aTraiter(p, sourceHash), false);
});

test('l’empreinte d’un article suit son texte, pas ses métadonnées', () => {
  const a = { title: 'Panne DQ200', contentHtml: '<p>Texte</p>' };
  const b = Object.assign({}, a, { views: 412, updatedAt: new Date() });
  assert.strictEqual(blogSourceHash(a), blogSourceHash(b));
  assert.notStrictEqual(blogSourceHash(a), blogSourceHash(Object.assign({}, a, { title: 'Panne DQ250' })));
});

test('le balayage ne fait rien tant qu’il n’est pas armé', async () => {
  const { traduireNouveautesDe } = require('../../src/jobs/traduireNouveautesDe');
  const avant = process.env.DE_AUTO_TRANSLATE;
  delete process.env.DE_AUTO_TRANSLATE;
  assert.strictEqual(await traduireNouveautesDe(), null);
  if (avant !== undefined) process.env.DE_AUTO_TRANSLATE = avant;
});

/* ── Quarantaine ──────────────────────────────────────────────────────────
   Une fiche que le modèle n'arrive pas à traduire consommait un créneau ET un
   appel payant à chaque passage, pour toujours. */

test('une fiche qui échoue trois fois sur le même texte est mise de côté', () => {
  const p = fiche();
  p.localizations = { de: { failedHash: sourceHash(p), failedCount: MAX_ECHECS } };
  assert.strictEqual(estPerime(p, sourceHash), true, 'elle reste bien « à traduire »');
  assert.strictEqual(estEnQuarantaine(p, sourceHash), true);
  assert.strictEqual(aTraiter(p, sourceHash), false, 'mais le balayage ne la reprend plus');
});

test('deux échecs ne suffisent pas à la mettre de côté', () => {
  const p = fiche();
  p.localizations = { de: { failedHash: sourceHash(p), failedCount: MAX_ECHECS - 1 } };
  assert.strictEqual(aTraiter(p, sourceHash), true);
});

test('une fiche en quarantaine repart si son texte change', () => {
  const p = fiche();
  p.localizations = { de: { failedHash: sourceHash(p), failedCount: 9 } };
  p.description = 'Texte corrigé à la main après l’échec.';
  assert.strictEqual(estEnQuarantaine(p, sourceHash), false);
  assert.strictEqual(aTraiter(p, sourceHash), true);
});

test('les échecs d’une AUTRE version du texte ne bloquent pas', () => {
  const p = traduite(fiche());
  p.localizations.de.failedHash = 'empreinte-d-une-vieille-version';
  p.localizations.de.failedCount = 12;
  assert.strictEqual(estEnQuarantaine(p, sourceHash), false);
});
