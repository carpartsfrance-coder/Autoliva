'use strict';

const test = require('node:test');
const assert = require('node:assert');

const { buildDeliveryEstimateEmail } = require('../../src/services/emailTemplates');
const { traduireEmail } = require('../../src/services/emailI18n');

/* E-mail « date de livraison » (liste des commandes, 16/09/2026) : le client
   doit lire la date dans SA langue, et aucune phrase ne doit rester en
   français dans la version allemande. */

const order = {
  _id: '66e8a0f0c0ffee0000000001',
  number: 'CP2026-000999',
  items: [{ name: 'Mécatronique DQ200', quantity: 1 }],
};

function texteVisible(html) {
  return html.replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
}

test('première date : objet, date longue, lien vers la commande', () => {
  const e = buildDeliveryEstimateEmail({ order, user: { firstName: 'Julien' }, date: '2026-09-23', baseUrl: 'https://autoliva.com' });
  assert.strictEqual(e.subject, 'Livraison prévue — commande #CP2026-000999');
  const corps = texteVisible(e.html);
  assert.match(corps, /Nous avons une date de livraison pour votre commande\./);
  assert.match(corps, /mercredi 23 septembre 2026/);
  assert.match(e.html, /href="https:\/\/autoliva\.com\/compte\/commandes\/66e8a0f0c0ffee0000000001"/);
  assert.match(e.text, /mercredi 23 septembre 2026/);
});

test('date modifiée : l’objet et la phrase le disent', () => {
  const e = buildDeliveryEstimateEmail({ order, user: {}, date: '2026-09-30', changement: true, baseUrl: 'https://autoliva.com' });
  assert.strictEqual(e.subject, 'Nouvelle date de livraison — commande #CP2026-000999');
  assert.match(texteVisible(e.html), /La date de livraison de votre commande a changé\./);
});

test('client allemand : date en allemand et aucune phrase restée en français', () => {
  const brut = buildDeliveryEstimateEmail({ order, user: {}, date: '2026-09-23', changement: true, baseUrl: 'https://autoliva.com', lang: 'de' });
  const de = traduireEmail(brut, 'de');
  assert.strictEqual(de.subject, 'Neuer Liefertermin — Bestellung #CP2026-000999');
  const corps = texteVisible(de.html);
  assert.match(corps, /Mittwoch, 23\. September 2026/);
  for (const francais of ['Bonjour', 'Livraison prévue', 'La date de livraison', 'Cette date est une estimation', 'Voir ma commande', 'Si vous avez une question']) {
    assert.ok(!corps.includes(francais), `resté en français : ${francais}`);
    assert.ok(!de.text.includes(francais), `resté en français (texte) : ${francais}`);
  }
});
