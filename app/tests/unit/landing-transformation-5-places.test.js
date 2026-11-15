'use strict';

/* Landing « Transformation 2 → 5 places » : tarifs affichés, nettoyage du
 * formulaire, et aucune trace de téléphone (contact WhatsApp uniquement). */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ctrl = require('../../src/controllers/transformation5PlacesController');
const { PRICING, readForm, CAPTURE_SOURCE, buildAckEmailHtml } = ctrl._internal;

test('tarifs de lancement : 1 500 € TTC = 1 250 € HT, grille pro dégressive à TVA 20 %', () => {
  assert.strictEqual(PRICING.unitTtc, 1500);
  assert.strictEqual(PRICING.unitHt, 1250);
  for (const tier of PRICING.tiers) {
    assert.strictEqual(Math.round(tier.ht * 1.2), tier.ttc, tier.label);
  }
  assert.deepStrictEqual(PRICING.tiers.map((t) => t.ht), [1250, 1190, 1090]);
});

test('formulaire : valeurs hors liste rejetées, champs nettoyés', () => {
  const f = readForm({
    profile: 'pirate', fleetSize: '99', make: 'Ferrari', model: '  Clio 5  ',
    year: '20a21', regType: 'xxx', plate: 'ab-123 cd', postcode: '13 340x', phone: '06 12',
  });
  assert.strictEqual(f.profile, 'particulier');
  assert.strictEqual(f.fleetSize, '');
  assert.strictEqual(f.make, '');
  assert.strictEqual(f.model, 'Clio 5');
  assert.strictEqual(f.year, '2021');
  assert.strictEqual(f.regType, '');
  assert.strictEqual(f.plate, 'AB123CD');
  assert.strictEqual(f.postcode, '13340');
});

test('source du lead déclarée dans le modèle et le back-office', () => {
  assert.strictEqual(CAPTURE_SOURCE, 'landing_5places');
  const model = fs.readFileSync(path.join(__dirname, '../../src/models/AbandonedCart.js'), 'utf8');
  assert.ok(model.includes("'landing_5places'"), 'enum captureSource');
  const cron = fs.readFileSync(path.join(__dirname, '../../src/jobs/sendAbandonedCartReminders.js'), 'utf8');
  assert.ok(cron.includes("'landing_5places'"), 'pas de relance « panier » pour ces demandes');
});

test('aucun numéro de téléphone dans la page ni dans l’e-mail client', () => {
  const view = fs.readFileSync(path.join(__dirname, '../../src/views/transformation-5-places/index.ejs'), 'utf8');
  assert.ok(!/tel:/.test(view), 'pas de lien tel: dans la vue');
  const html = buildAckEmailHtml({ firstName: 'Jean', quoteRef: 'T5P-2026-11-ABC123', vehicle: 'Renault Clio 5' });
  assert.ok(!/tel:/.test(html), 'pas de lien tel: dans l’accusé de réception');
  assert.ok(html.includes('/go/whatsapp'), 'lien WhatsApp présent');
});

test('formulaire : champ unique « téléphone ou e-mail » rangé au bon endroit', () => {
  const a = readForm({ plate: 'AB-123-CD', contact: ' client@exemple.fr ' });
  assert.strictEqual(a.email, 'client@exemple.fr');
  assert.strictEqual(a.phone, '');
  const b = readForm({ plate: 'AB-123-CD', contact: '06 12 34 56 78' });
  assert.strictEqual(b.phone, '06 12 34 56 78');
  assert.strictEqual(b.email, '');
});
