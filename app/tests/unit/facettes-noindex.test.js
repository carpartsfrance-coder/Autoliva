/**
 * Facettes des pages catégorie et des hubs /pieces-auto : une adresse filtrée
 * sort de Google, la page nue y reste.
 *
 * Lancé par : npm test  (aucune base, aucun réseau)
 *
 * Audit du 25/09/2026 : « mainCategory » (autre catégorie que celle de la
 * page), « condition », « vehicleMake » / « vehicleModel » / « vehicleClear »
 * produisaient ~4 200 pages en « index, follow ». Le rendu réel est vérifié
 * dans tests/integration/pages-confiance.test.js ; l'indexabilité des pages
 * nues gardées l'est, exhaustivement, par tests/unit/politique-indexation.
 */

const test = require('node:test');
const assert = require('node:assert');

const { filtreAuDelaDuPreset } = require('../../src/services/facettesListing');

const CATEGORIE = { categorie: 'Boîtes de vitesses' };
const HUB_MODELE = { marque: 'Audi', modele: 'A4' };
const HUB_MODELE_CATEGORIE = { categorie: 'Turbos', marque: 'Audi', modele: 'A4' };

test('page nue, ou paramètres qui redisent ce que fixe le chemin : indexable', () => {
  for (const [query, preset] of [
    [{}, CATEGORIE],
    [undefined, HUB_MODELE],
    [{ mainCategory: 'Boîtes de vitesses' }, CATEGORIE],
    [{ mainCategory: '  boites  DE vitesses ' }, CATEGORIE],
    [{ category: 'Turbos' }, HUB_MODELE_CATEGORIE],
    [{ vehicleMake: 'audi', vehicleModel: 'A4' }, HUB_MODELE],
    [{ mainCategory: '', condition: '', vehicleClear: '' }, CATEGORIE],
    /* Paramètres de suivi : la canonique suffit, ce n'est pas un filtre. */
    [{ utm_source: 'google', gclid: 'abc' }, CATEGORIE],
  ]) {
    assert.equal(filtreAuDelaDuPreset(query, preset), false, JSON.stringify(query));
  }
});

test('autre catégorie, état, véhicule, remise à zéro : noindex', () => {
  for (const [query, preset] of [
    [{ mainCategory: 'Moteurs' }, CATEGORIE],
    [{ mainCategory: 'Moteurs' }, HUB_MODELE],
    [{ category: 'Moteurs > Blocs' }, HUB_MODELE],
    [{ condition: 'occasion' }, CATEGORIE],
    [{ condition: ['occasion', 'neuf'] }, HUB_MODELE],
    [{ condition: 'inconnu' }, CATEGORIE],
    [{ vehicleMake: 'Audi' }, CATEGORIE],
    [{ vehicleMake: 'BMW' }, HUB_MODELE],
    [{ vehicleModel: 'A6' }, HUB_MODELE],
    [{ vehicleModel: 'A4' }, { marque: 'Audi' }],
    [{ vehicleEngine: '2.0 TDI' }, HUB_MODELE],
    [{ vehicleClear: '1' }, CATEGORIE],
    [{ vehicleClear: '1' }, HUB_MODELE_CATEGORIE],
  ]) {
    assert.equal(filtreAuDelaDuPreset(query, preset), true, `${JSON.stringify(query)} sur ${JSON.stringify(preset)}`);
  }
});
