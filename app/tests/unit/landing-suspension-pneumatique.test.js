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
