/**
 * Le corps des articles ne promet plus le paiement en plusieurs fois, ni un
 * délai par défaut.
 *
 * Lancé par : npm test  (aucune base, aucun réseau)
 *
 * Mesuré le 15/09/2026 : 303 articles publiés promettaient encore « payable
 * en 3 x 263 EUR sans frais », « le paiement en 3 fois est proposé »…, alors
 * que Scalapay est coupé depuis le 05/08. Et 6 329 fiches sans délai saisi
 * affichaient « 24/48h » par défaut.
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const cf = require('../../src/services/claimFilter');

const coupe = () => cf.contexteArticle({ scalapayActif: false });

test('les tournures relevées dans les articles sont retirées tant que Scalapay est coupé', () => {
  for (const phrase of [
    'Le pont est à 1 490 € TTC, payable en 3 x 496,67 EUR sans frais.',
    'Utiliser le paiement en 3 fois : 3 × 496 € sans frais chez Autoliva.',
    'Oui, le paiement en 4 fois est proposé sans frais supplémentaires.',
    'Zahlung in 3 Raten ohne Aufpreis möglich.',
    'Ratenzahlung ist verfügbar.',
  ]) {
    const out = cf.filtrer(`<p>${phrase}</p><p>Garde ce texte.</p>`, coupe());
    assert.doesNotMatch(out, /[34]\s?[x×]\s*\d|en [34] fois|Raten/i, phrase);
    assert.match(out, /Garde ce texte\./, 'le texte voisin doit rester');
  }
});

test('rien n’est retiré à tort', () => {
  for (const vrai of [
    '<p>Un coût 3-4x supérieur au reconditionné.</p>',
    '<p>Serrer les vis en 3 fois, en croix.</p>',
    '<p>Le 4x4 Audi Q7 et la BMW X4 utilisent une boîte de transfert.</p>',
    '<p>Le pont reconditionné est garanti 24 mois.</p>',
  ]) assert.equal(cf.filtrer(vrai, coupe()), vrai, vrai);
});

test('Scalapay rallumé : la promesse redevient vraie et reste', () => {
  const phrase = '<p>Payable en 3 x 263 EUR sans frais.</p>';
  assert.equal(cf.filtrer(phrase, cf.contexteArticle({ scalapayActif: true })), phrase);
});

test('les articles ne perdent pas leurs durées de garantie (relecture humaine)', () => {
  assert.ok(!coupe().regles.has('dureeGarantie'));
});

test('plus de délai « 24/48h » promis par défaut', () => {
  const fiche = fs.readFileSync(path.join(__dirname, '../../src/views/products/show.ejs'), 'utf8');
  assert.doesNotMatch(fiche, /shippingDelayText\s*\|\|\s*'24\/48h'/);
  const brochure = fs.readFileSync(path.join(__dirname, '../../src/services/companyBrochurePdf.js'), 'utf8');
  assert.match(brochure, /scalapay'\)\.estActif\(\)/, 'le 3/4 fois de la brochure doit dépendre de Scalapay');
});

test('le point d’une abréviation ne coupe pas la phrase : pas de « 1.390 € inkl. » laissé seul', () => {
  /* 85 articles /de gardaient « Für 1.390 € inkl. » : la phrase était coupée
     après « inkl. » (le nom allemand qui suit prend la majuscule). */
  const de = cf.filtrer('<p>Für 1.390 € inkl. MwSt – in 3 Raten ohne Zinsen zahlbar – wird sie fahrfertig geliefert. Der Austausch ist ohne Kaution.</p>', coupe());
  assert.equal(de, '<p>Der Austausch ist ohne Kaution.</p>');
  const balise = cf.filtrer('<p>Ab 1.290 € <strong>inkl.</strong> MwSt., zahlbar in 4 Raten. Versand in 48 h.</p>', coupe());
  assert.equal(balise, '<p>Versand in 48 h.</p>');
  const fr = cf.filtrer('<p>La mécatronique réf. DQ200 est payable en 3 x 430 € sans frais. Garde ce texte.</p>', coupe());
  assert.equal(fr, '<p>Garde ce texte.</p>');
  /* Une vraie fin de phrase reste une frontière. */
  assert.equal(cf.filtrer('<p>Livraison offerte. Paiement en 3 fois disponible. Garde.</p>', coupe()), '<p>Livraison offerte. Garde.</p>');
});
