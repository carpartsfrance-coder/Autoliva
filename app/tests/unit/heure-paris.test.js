/* Jours du calendrier de Paris, indépendants du fuseau du serveur. */
const test = require('node:test');
const assert = require('node:assert');
const { minuitParis, debutMoisParis, cleJourParis, partiesParis } = require('../../src/services/heureParis');

test('minuit à Paris, hiver / été / changements d’heure', () => {
  // 17 nov. 23 h 30 UTC = 18 nov. 0 h 30 à Paris : on est déjà le 18.
  assert.equal(cleJourParis(new Date('2026-11-17T23:30:00Z')), '2026-11-18');
  assert.equal(minuitParis(new Date('2026-11-17T23:30:00Z')).toISOString(), '2026-11-17T23:00:00.000Z');
  assert.equal(minuitParis(new Date('2026-07-01T22:30:00Z')).toISOString(), '2026-07-01T22:00:00.000Z');
  assert.equal(minuitParis(new Date('2026-03-29T12:00:00Z')).toISOString(), '2026-03-28T23:00:00.000Z');
  assert.equal(minuitParis(new Date('2026-10-25T12:00:00Z')).toISOString(), '2026-10-24T22:00:00.000Z');
  assert.equal(minuitParis(new Date('2026-10-26T12:00:00Z')).toISOString(), '2026-10-25T23:00:00.000Z');
});

test('décalage en jours et en mois', () => {
  assert.equal(minuitParis(new Date('2026-11-17T10:00:00Z'), -6).toISOString(), '2026-11-10T23:00:00.000Z');
  assert.equal(minuitParis(new Date('2026-03-01T10:00:00Z'), -1).toISOString(), '2026-02-27T23:00:00.000Z');
  assert.equal(debutMoisParis(new Date('2026-11-17T10:00:00Z')).toISOString(), '2026-10-31T23:00:00.000Z');
  assert.equal(debutMoisParis(new Date('2026-01-15T10:00:00Z'), -1).toISOString(), '2025-11-30T23:00:00.000Z');
  // 31 oct. 23 h 30 UTC = 1er nov. à Paris : le mois parisien est novembre.
  assert.equal(debutMoisParis(new Date('2026-10-31T23:30:00Z')).toISOString(), '2026-10-31T23:00:00.000Z');
  assert.equal(partiesParis(new Date('2026-11-17T10:00:00Z')).jourSemaine, 2);
});
