'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { identifiantsVehicule } = require('../../src/services/vehiculeCommande');

/* Formes réellement présentes dans les commandes de production (16/09/2026). */

test('plaque SIV saisie au paiement, mise au format AA-123-AA', () => {
  assert.deepEqual(identifiantsVehicule({ vehicle: { plate: 'dp401hf' } }), { plaque: 'DP-401-HF', vin: '', saisie: '' });
  assert.deepEqual(identifiantsVehicule({ vehicle: { plate: 'GD 694-fm' } }), { plaque: 'GD-694-FM', vin: '', saisie: '' });
});

test('VIN saisi dans son champ', () => {
  assert.deepEqual(identifiantsVehicule({ vehicle: { vin: ' wauzzz8r4ga091182 ' } }), { plaque: '', vin: 'WAUZZZ8R4GA091182', saisie: '' });
});

test('VIN tapé dans le champ plaque : affiché comme VIN', () => {
  assert.deepEqual(identifiantsVehicule({ vehicle: { plate: 'WAUZZZ8R4GA091182' } }), { plaque: '', vin: 'WAUZZZ8R4GA091182', saisie: '' });
});

test('plaque et VIN collés dans le champ plaque : séparés', () => {
  assert.deepEqual(identifiantsVehicule({ vehicle: { plate: 'FG123ABWAUZZZ8R4GA091182' } }), { plaque: 'FG-123-AB', vin: 'WAUZZZ8R4GA091182', saisie: '' });
});

test('les deux champs remplis : les deux affichés', () => {
  assert.deepEqual(identifiantsVehicule({ vehicle: { plate: 'FG-123-AB', vin: 'WAUZZZ8R4GA091182', saisie: '' } }), { plaque: 'FG-123-AB', vin: 'WAUZZZ8R4GA091182', saisie: '' });
});

test('plaque et VIN séparés par « VIN » ou « IMAT » (le paiement ne garde que lettres et chiffres)', () => {
  assert.deepEqual(identifiantsVehicule({ vehicle: { plate: 'DW038XFVINWVWZZZAUZFP043058' } }), { plaque: 'DW-038-XF', vin: 'WVWZZZAUZFP043058', saisie: '' });
  assert.deepEqual(identifiantsVehicule({ vehicle: { plate: 'WVWZZZ6RZGY098888IMATDW101PT' } }), { plaque: 'DW-101-PT', vin: 'WVWZZZ6RZGY098888', saisie: '' });
});

test('saisie non reconnue : rendue telle quelle, sans l’appeler plaque', () => {
  assert.deepEqual(identifiantsVehicule({ vehicle: { plate: 'T914PH' } }), { plaque: '', vin: '', saisie: 'T914PH' });
  assert.deepEqual(identifiantsVehicule({ vehicle: { plate: '1234 ab 56' } }), { plaque: '', vin: '', saisie: '1234 AB 56' });
});

test('commande saisie à la main : plaque et VIN lus dans l’article', () => {
  assert.deepEqual(
    identifiantsVehicule({ vehicle: { plate: '', vin: '', saisie: '' }, items: [{ name: 'AUDI A5 · 3.0 V6 239', sku: 'Immat : DP401HF Code moteur : CAPA Kilométrage : 105001km' }] }),
    { plaque: 'DP-401-HF', vin: '', saisie: '' },
  );
  assert.deepEqual(
    identifiantsVehicule({ items: [{ name: 'Moteur 3.0 TDV6', sku: 'Etat : Moteur d’occasion contrôlé Garantie : 1 an VIN : SALCA2BE1FH502906' }] }),
    { plaque: '', vin: 'SALCA2BE1FH502906', saisie: '' },
  );
});

test('« programmé au VIN » dans un nom de pièce n’est pas un VIN', () => {
  assert.deepEqual(
    identifiantsVehicule({ items: [{ name: 'Calculateur de boîte EDC 6DCT250 / DC4 Continental reconditionné programmé au VIN' }] }),
    { plaque: '', vin: '', saisie: '' },
  );
});

test('le champ du paiement prime sur le texte des articles', () => {
  assert.deepEqual(
    identifiantsVehicule({ vehicle: { plate: 'AB123CD' }, items: [{ sku: 'Immat : DP401HF' }] }),
    { plaque: 'AB-123-CD', vin: '', saisie: '' },
  );
});

test('rien de connu', () => {
  assert.deepEqual(identifiantsVehicule({}), { plaque: '', vin: '', saisie: '' });
  assert.deepEqual(identifiantsVehicule(null), { plaque: '', vin: '', saisie: '' });
});
