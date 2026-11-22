'use strict';

/* Landing « Suspension pneumatique » (test marché nov. 2026) : source du lead
 * branchée partout où les autres landings le sont, types de pièce proposés,
 * et page servie sur la bonne URL. */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const ctrl = require('../../src/controllers/suspensionPneumatiqueController');
const { CAPTURE_SOURCE, LANDING_PATH, PART_TYPES } = ctrl._internal;

const lire = (rel) => fs.readFileSync(path.join(__dirname, '../../src', rel), 'utf8');

test('URL et source du lead', () => {
  assert.strictEqual(LANDING_PATH, '/suspension-pneumatique');
  assert.strictEqual(CAPTURE_SOURCE, 'landing_suspension');
  const routes = lire('routes/index.js');
  assert.ok(routes.includes("router.get('/suspension-pneumatique'"), 'route GET');
  assert.ok(routes.includes("router.post('/suspension-pneumatique/devis'"), 'route POST');
});

test('types de pièce : jambes avant/arrière, compresseur, bloc de valves, autre', () => {
  assert.deepStrictEqual(Object.keys(PART_TYPES), ['jambe_avant', 'jambe_arriere', 'compresseur', 'bloc_valves', 'autre']);
});

test('source déclarée dans le modèle, le back-office, les relances et la remontée Google Ads', () => {
  const fichiers = [
    'models/AbandonedCart.js',
    'controllers/abandonedCartAdminController.js',
    'jobs/sendAbandonedCartReminders.js',
    'services/leadWork.js',
    'services/leadResume.js',
    'services/ringoverContact.js',
    'services/googleAdsConversionSync.js',
    'views/admin/cart-activity.ejs',
  ];
  for (const f of fichiers) assert.ok(lire(f).includes("'landing_suspension'") || lire(f).includes('landing_suspension:'), f);
});

test('la page ne reprend pas les promesses propres aux ponts (denture, 48-72 h, banc pont)', () => {
  const view = lire('views/suspension-pneumatique/index.ejs');
  assert.ok(!/denture|48 à 72|48-72|Bench Video/i.test(view));
  assert.ok(view.includes("lead_category: '<%= copy.leadCategory %>'"));
});

test('ISO 9001 toujours attribué à l’atelier partenaire, garantie 2 ans affichée', () => {
  const view = lire('views/suspension-pneumatique/index.ejs');
  const ctrlSrc = lire('controllers/suspensionPneumatiqueController.js');
  for (const txt of [view, ctrlSrc]) {
    const isoSansPartenaire = txt.split('\n').filter((l) => /ISO 9001/.test(l) && !/partenaire|Reconditionné ISO 9001|Qualité ISO 9001/.test(l));
    assert.deepStrictEqual(isoSansPartenaire, []);
  }
  assert.strictEqual(ctrl._internal.CAPTURE_SOURCE, 'landing_suspension');
  assert.ok(ctrlSrc.includes("warrantyLabel: 'Garantie 2 ans'"));
});

test('variante camping-car : URL, kits neufs, aucune promesse de reconditionné ISO 9001 ni d’échange standard', () => {
  const { CAMPING_PATH, PART_TYPES_CAMPING, VARIANTS, getVariant } = ctrl._internal;
  assert.strictEqual(CAMPING_PATH, '/suspension-pneumatique-camping-car');
  assert.strictEqual(getVariant({ path: '/suspension-pneumatique-camping-car/devis' }), 'camping');
  assert.strictEqual(getVariant({ path: '/suspension-pneumatique/devis' }), 'suspension');
  assert.deepStrictEqual(Object.keys(PART_TYPES_CAMPING), ['kit_arriere', 'kit_complet', 'commande', 'autre']);
  const routes = lire('routes/index.js');
  assert.ok(routes.includes("router.post('/suspension-pneumatique-camping-car/devis'"));
  const view = lire('views/suspension-pneumatique/camping-car.ejs');
  const copy = JSON.stringify(VARIANTS.camping);
  for (const txt of [view, copy]) {
    assert.ok(!/ISO 9001|reconditionn|échange standard|consigne/i.test(txt), 'pas de promesse propre au reconditionné');
  }
  const html = ctrl.buildAckEmailHtml({ quoteRef: 'AUT-2026-11-ABC123', plate: 'AB123CD', partTypeLabel: 'Kit essieu arrière', brandObj: {}, texts: VARIANTS.camping.email });
  assert.ok(!/ISO 9001|Échange standard/.test(html), 'e-mail client camping-car sans ISO ni échange standard');
});
