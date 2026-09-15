/**
 * L'encadré produit des articles de blog ne promet que ce que dit la fiche.
 *
 * Lancé par : npm test  (aucune base, aucun réseau)
 *
 * Avant le 14/09/2026, chaque article affichait « Pièce reconditionnée —
 * Garantie 2 ans », « Testé et garanti 24 mois » et « Paiement en 3x sans
 * frais », quelle que soit la pièce liée — y compris des pièces d'occasion
 * garanties 6 ou 12 mois, et alors que le 3x était coupé depuis le 05/08.
 */

const test = require('node:test');
const assert = require('node:assert');

const { construireCta, moisGarantie } = require('../../src/services/blogProductCta');

const OCCASION_12 = {
  name: 'Moteur Kia Picanto II G4LA — occasion',
  priceCents: 89000,
  badges: { condition: 'Occasion' },
  warranty: { months: 12 },
  shippingDelayText: 'Expédition sous 3-5 jours, sur palette',
};

test('une pièce d’occasion garantie 12 mois n’hérite plus de la promesse du reconditionné', () => {
  const html = construireCta(OCCASION_12, { lang: 'fr', url: '/product/x/', scalapayActif: false });
  assert.match(html, /Occasion — Garantie 12 mois/);
  assert.doesNotMatch(html, /reconditionn/i);
  assert.doesNotMatch(html, /2 ans|24 mois/);
  assert.match(html, /Expédition sous 3-5 jours, sur palette/);
});

test('sans garantie saisie, aucune durée n’est inventée', () => {
  const html = construireCta({ name: 'Pont arrière', priceCents: 120000, badges: {} }, { lang: 'fr', url: '/p', scalapayActif: false });
  assert.doesNotMatch(html, /Garantie \d|mois|ans/);
  assert.match(html, /cta-eyebrow">Pièce auto</);
  assert.equal(moisGarantie({ warranty: { months: 0 } }), null);
  assert.equal(moisGarantie({}), null);
});

test('le 3x suit l’interrupteur Scalapay, dans les deux langues', async (sub) => {
  await sub.test('coupé : ni sous-prix ni ligne de paiement fractionné', () => {
    for (const lang of ['fr', 'de']) {
      const html = construireCta(OCCASION_12, { lang, url: '/p', scalapayActif: false });
      assert.doesNotMatch(html, /3x|3 Raten/, lang);
      assert.match(html, lang === 'fr' ? /Paiement sécurisé</ : /Sichere Zahlung</, lang);
    }
  });

  await sub.test('actif : le 3x revient, calculé sur le vrai prix', () => {
    const html = construireCta(OCCASION_12, { lang: 'fr', url: '/p', scalapayActif: true });
    assert.match(html, /soit 3x 296,67 € sans frais/);
    assert.match(html, /Paiement sécurisé en 3x sans frais/);
  });

  await sub.test('sous 500 €, pas de 3x même actif', () => {
    const html = construireCta({ ...OCCASION_12, priceCents: 30000 }, { lang: 'fr', url: '/p', scalapayActif: true });
    assert.doesNotMatch(html, /soit 3x/);
  });
});

test('l’allemand ne reprend que les champs traduits', async (sub) => {
  await sub.test('pastille non traduite : pas de français dans l’encadré allemand', () => {
    const html = construireCta(OCCASION_12, { lang: 'de', url: '/de/produits/x', nom: 'Motor', scalapayActif: false });
    assert.doesNotMatch(html, /Occasion|Expédition/);
    assert.match(html, /12 Monate Garantie/);
    assert.match(html, /Lieferung 3-5 Werktage/);
  });

  await sub.test('pastille traduite : elle est reprise', () => {
    const traduit = {
      ...OCCASION_12,
      localizations: { de: { translatedAt: new Date(), badges: { condition: 'Gebraucht' }, shippingDelayText: 'Versand in 3-5 Tagen' } },
    };
    const html = construireCta(traduit, { lang: 'de', url: '/de/produits/x', nom: 'Motor', scalapayActif: false });
    assert.match(html, /Gebraucht — 12 Monate Garantie/);
    assert.match(html, /Versand in 3-5 Tagen/);
    assert.doesNotMatch(html, /2 Jahre|24 Monate/);
  });
});

test('le nom et l’adresse sont échappés', () => {
  const html = construireCta({ name: '<script>x</script>', priceCents: 1000 }, { lang: 'fr', url: '/p?a="b"', scalapayActif: false });
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.match(html, /href="\/p\?a=&quot;b&quot;"/);
});
