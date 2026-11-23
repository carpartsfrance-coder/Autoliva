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

test('types de pièce : ressort, jambe, compresseur, bloc de valves, je ne sais pas', () => {
  assert.deepStrictEqual(Object.keys(PART_TYPES), ['ressort', 'jambe', 'compresseur', 'bloc_valves', 'autre']);
  const { normalizePartType } = ctrl._internal;
  // Anciennes valeurs (pages en cache) toujours acceptées
  assert.strictEqual(normalizePartType('jambe_avant', PART_TYPES), 'jambe');
  assert.strictEqual(normalizePartType('JAMBE_ARRIERE', PART_TYPES), 'jambe');
  assert.strictEqual(normalizePartType('<script>', PART_TYPES), '');
});

test('haut de page adapté à l’annonce : listes fermées, rien de recopié tel quel', () => {
  const { buildHero, HERO_VEHICULES } = ctrl._internal;
  assert.strictEqual(buildHero({}), null);
  const h = buildHero({ piece: 'ressort', vehicule: 'serie-5-f11' });
  assert.strictEqual(h.title, 'Ressort pneumatique pour BMW Série 5 F11');
  assert.ok(/^Neuf ou reconditionné, garantie 2 ans/.test(h.accent));
  assert.ok(/^Neuve ou reconditionnée/.test(buildHero({ piece: 'jambe' }).accent));
  assert.strictEqual(buildHero({ vehicule: '<b>pirate</b>' }), null);
  assert.strictEqual(buildHero({ piece: 'x', vehicule: 'y' }), null);
  assert.ok(Object.keys(HERO_VEHICULES).length >= 20);
});

test('page de pub : en-tête réduit, sans popup promo, sans logos constructeurs ni chiffres invérifiables', () => {
  const view = lire('views/suspension-pneumatique/index.ejs');
  assert.ok(!/placehold\.co|1 000 clients|logo-porsche|newsletter/i.test(view));
  assert.ok(view.includes('Illustration'), 'les images générées sont présentées comme des illustrations');
  const ctrlSrc = lire('controllers/suspensionPneumatiqueController.js');
  for (const flag of ['landingHeader:', 'hideMobileNav:', 'hideContactWidget:', 'hideExitIntent: true']) assert.ok(ctrlSrc.includes(flag), flag);
  assert.ok(lire('views/partials/exit-intent.ejs').includes('hideExitIntent'));
  for (const img of ['gamme-1600', 'gamme-960', 'ressort-600', 'jambe-600', 'compresseur-600', 'valves-600', 'banc-900', 'etancheite-900', 'emballage-900']) {
    assert.ok(fs.existsSync(path.join(__dirname, '../../public/images/suspension', img + '.webp')), img);
  }
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

test('page voitures : pièces neuves ET reconditionnées, un seul numéro, pas d’articles hors sujet', () => {
  const { VARIANTS } = ctrl._internal;
  assert.ok(/neuve ou reconditionnée/.test(VARIANTS.suspension.copy.h1Html));
  const view = lire('views/suspension-pneumatique/index.ejs');
  assert.ok(view.includes('Vendez-vous aussi des pièces neuves ?'));
  const ctrlSrc = lire('controllers/suspensionPneumatiqueController.js');
  assert.ok(ctrlSrc.includes('PHONE: brand.PHONE_MOTEUR, PHONE_INTL: brand.PHONE_MOTEUR_INTL'), 'numéro commercial partout');
  const articlesSrc = lire('services/landingArticles.js');
  assert.ok(articlesSrc.includes("NO_FALLBACK = new Set(['suspension'])"), 'pas de repli DSG/moteur');
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
