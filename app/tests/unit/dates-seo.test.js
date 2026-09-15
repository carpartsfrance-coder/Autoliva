'use strict';

/**
 * Dates annoncées aux moteurs — plan de reprise SEO du 14/09/2026, action A4.5.
 * Aucune ne vient d'updatedAt ; une date n'est annoncée que si le contenu
 * principal a vraiment changé ce jour-là. Aucune base, aucun réseau.
 */

const test = require('node:test');
const assert = require('node:assert');

const datesSeo = require('../../src/services/datesSeo');
const FICHES_A3 = require('../../src/data/seo/fiches-description-a3.json');

const APRES_A3 = Date.parse('2026-10-01T00:00:00Z');
const REDATE = new Date('2026-09-08T18:16:30Z');

test('la liste A3 : 6 771 fiches, identifiants valides et uniques, date au format AAAA-MM-JJ', () => {
  assert.equal(FICHES_A3.ids.length, 6771, 'le nombre annoncé par la PR #372 (6 787 du plan − 16 fiches DM-)');
  assert.equal(new Set(FICHES_A3.ids).size, FICHES_A3.ids.length);
  for (const id of FICHES_A3.ids) assert.match(id, /^[a-f0-9]{24}$/);
  assert.match(FICHES_A3.dateMiseEnLigne, /^\d{4}-\d{2}-\d{2}$/);
});

test('fiche française : la date A3 si elle a regagné sa description, rien sinon', () => {
  const listee = FICHES_A3.ids[0];
  const opts = { maintenant: APRES_A3 };
  const date = FICHES_A3.dateMiseEnLigne;
  assert.equal(datesSeo.lastmodFicheFr({ _id: listee, sku: 'ASY-0100214793', updatedAt: REDATE }, opts), date);
  assert.equal(datesSeo.lastmodFicheFr({ _id: '0123456789abcdef01234567', sku: 'ASY-1', updatedAt: REDATE }, opts), '',
    'hors liste : pas de lastmod, quel que soit updatedAt');
  /* La liste ne suffit pas : si la description n'est pas servie, rien n'a changé. */
  assert.equal(datesSeo.lastmodFicheFr({ _id: listee, sku: 'DM-81318' }, opts), '', 'copie distrimotor');
  assert.equal(datesSeo.lastmodFicheFr({ _id: listee, sku: 'ALV-PT-2462800200' }, opts), '', 'Alibaba, décision 4');
  assert.equal(datesSeo.lastmodFicheFr(null, opts), '');
});

test('fiche française : interrupteur SHOW_PRODUCT_DESCRIPTION coupé → aucun lastmod', (t) => {
  const avant = process.env.SHOW_PRODUCT_DESCRIPTION;
  t.after(() => { if (avant === undefined) delete process.env.SHOW_PRODUCT_DESCRIPTION; else process.env.SHOW_PRODUCT_DESCRIPTION = avant; });
  process.env.SHOW_PRODUCT_DESCRIPTION = 'off';
  assert.equal(datesSeo.lastmodFicheFr({ _id: FICHES_A3.ids[0], sku: 'ASY-1' }, { maintenant: APRES_A3 }), '');
});

test('la date A3 n’est jamais annoncée avant d’être arrivée', () => {
  const veille = Date.parse(`${FICHES_A3.dateMiseEnLigne}T00:00:00Z`) - 1;
  assert.equal(datesSeo.dateDescriptionsFiches({ maintenant: veille }), '');
  assert.equal(datesSeo.dateDescriptionsFiches({ maintenant: APRES_A3 }), FICHES_A3.dateMiseEnLigne);
});

test('article français : sa publication, jamais updatedAt', () => {
  const post = { publishedAt: new Date('2026-04-02T09:00:00Z'), createdAt: new Date('2026-04-02T08:55:00Z'), updatedAt: REDATE };
  assert.equal(datesSeo.dateModificationArticle(post).toISOString(), '2026-04-02T09:00:00.000Z');
  assert.equal(datesSeo.dateModificationArticle({ createdAt: new Date('2026-03-01T00:00:00Z'), updatedAt: REDATE }).toISOString(),
    '2026-03-01T00:00:00.000Z', 'sans date de publication : sa création');
  assert.equal(datesSeo.dateModificationArticle({ updatedAt: REDATE }), null, 'updatedAt seul ne donne rien');
});

test('article allemand : sa traduction, sinon sa publication', () => {
  const post = {
    publishedAt: new Date('2026-05-10T08:00:00Z'),
    updatedAt: REDATE,
    localizations: { de: { translatedAt: new Date('2026-09-07T09:30:00Z') } },
  };
  assert.equal(datesSeo.dateModificationArticleDe(post).toISOString(), '2026-09-07T09:30:00.000Z');
  assert.equal(datesSeo.dateModificationArticleDe({ ...post, localizations: {} }).toISOString(), '2026-05-10T08:00:00.000Z');
  assert.equal(datesSeo.dateTraductionDe({ updatedAt: REDATE }), null);
});

test('isoPasse : jamais une date future, jamais une date invalide', () => {
  assert.equal(datesSeo.isoPasse('2026-04-02T09:00:00Z'), '2026-04-02T09:00:00.000Z');
  assert.equal(datesSeo.isoPasse(new Date(Date.now() + 86400000)), '');
  assert.equal(datesSeo.isoPasse('pas une date'), '');
  assert.equal(datesSeo.isoPasse(null), '');
});
