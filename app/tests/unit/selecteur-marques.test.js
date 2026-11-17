/**
 * Sélecteur véhicule : marques en double et fausses marques (16/11/2026).
 * Lancé par : npm test (aucune base).
 */
const test = require('node:test');
const assert = require('node:assert');
const { fusionnerMarques } = require('../../src/services/productListingService');

test('« SEAT » et « Seat » ne font qu’une marque, modèles et motorisations réunis', () => {
  const parMarque = new Map([
    ['SEAT', new Set(['Leon'])],
    ['Seat', new Set(['Ibiza', 'Leon'])],
    ['Mini', new Set(['Cooper'])],
    ['MINI', new Set(['Countryman'])],
    ['Volkswagen', new Set(['Golf'])],
    ['VW', new Set(['Polo'])],
    ['Distrimotor', new Set(['X'])],
    ['Ct', new Set([])],
  ]);
  const parMoteur = new Map([['Seat|||Ibiza', new Set(['1.4 TSI'])], ['SEAT|||Leon', new Set(['2.0 TDI'])], ['Distrimotor|||X', new Set(['Y'])]]);
  const r = fusionnerMarques(parMarque, parMoteur);
  assert.deepEqual(r.makes, ['MINI', 'SEAT', 'Volkswagen', 'VW']);
  assert.deepEqual(r.modelsByMake.SEAT, ['Ibiza', 'Leon']);
  assert.deepEqual(r.modelsByMake.MINI, ['Cooper', 'Countryman']);
  assert.deepEqual(r.enginesByMakeModel['SEAT|||Ibiza'], ['1.4 TSI']);
  assert.deepEqual(r.enginesByMakeModel['SEAT|||Leon'], ['2.0 TDI']);
  assert.ok(!Object.keys(r.enginesByMakeModel).some((k) => k.startsWith('Distrimotor')));
});

test('« Mercedes-Benz » rangée sous « Mercedes » (le filtre « Mercedes » trouve les deux)', () => {
  const r = fusionnerMarques(new Map([
    ['Mercedes', new Set(['Classe C'])],
    ['Mercedes-Benz', new Set(['Vito'])],
    ['Alfa', new Set(['159'])],
    ['Alfa Romeo', new Set(['Giulietta'])],
    ['Kia', new Set(['Sportage'])],
  ]), new Map([['Mercedes-Benz|||Vito', new Set(['2.2 CDI'])]]));
  assert.deepEqual(r.makes, ['Alfa', 'Kia', 'Mercedes']);
  assert.deepEqual(r.modelsByMake.Mercedes, ['Classe C', 'Vito']);
  assert.deepEqual(r.enginesByMakeModel['Mercedes|||Vito'], ['2.2 CDI']);
});
