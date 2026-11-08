/**
 * Marge d'une commande — la valeur envoyée à Google Ads à la place du prix TTC.
 *
 * Lancé par : npm test (aucune base, aucun réseau).
 *
 * Diagnostic du 08/11/2026 : Google recevait le total TTC (TVA, port et
 * consigne compris) et gardait les ventes remboursées ; ses enchères
 * cherchaient le chiffre d'affaires, pas le bénéfice.
 */

const test = require('node:test');
const assert = require('node:assert');

const { margeCommande, tauxMargeParDefaut } = require('../../src/services/margeCommande');

const P1 = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const P2 = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const couts = new Map([[P1, 50000], [P2, null]]);

// Boîte de transfert Macan : 890 € la pièce, 89 € de port, 100 € de consigne.
const macan = (over = {}) => ({
  status: 'processing',
  totalCents: 107900,
  shippingCostCents: 8900,
  consigne: { chargedTotalCents: 10000 },
  vatScheme: 'normal',
  items: [{ productId: P1, quantity: 1 }],
  refunds: [],
  ...over,
});

test('TVA normale, prix d\'achat de la fiche produit : 890 € TTC − 500 € HT = 241,67 €', () => {
  const m = margeCommande(macan(), { couts });
  assert.strictEqual(m.source, 'catalogue');
  assert.strictEqual(m.estimee, false);
  assert.strictEqual(m.revenuPiecesCents, 74167, 'la pièce hors TVA : 890 / 1,2 (sans port ni consigne)');
  assert.strictEqual(m.margeCents, 24167);
});

test('prix d\'achat saisi sur la commande (TTC, TVA déductible) : même marge', () => {
  const m = margeCommande(macan({ items: [{ productId: P2, quantity: 1 }], purchase: { priceCents: 60000, supplierRegime: 'tva_deductible' } }), { couts });
  assert.strictEqual(m.source, 'achat_commande');
  assert.strictEqual(m.margeCents, 24167);
});

test('prix d\'achat saisi sans TVA déductible (étranger, intracom, particulier) : pris tel quel', () => {
  const m = margeCommande(macan({ purchase: { priceCents: 50000, supplierRegime: 'intracom_autoliquidation' } }), { couts });
  assert.strictEqual(m.margeCents, 24167);
  const sansRegime = margeCommande(macan({ purchase: { priceCents: 50000 } }), { couts });
  assert.strictEqual(sansRegime.margeCents, 24167);
});

test('TVA sur marge (297 A) : la TVA ne porte que sur (vente − achat)', () => {
  const m = margeCommande({
    status: 'delivered', totalCents: 100000, shippingCostCents: 0, vatScheme: 'margin',
    purchase: { priceCents: 50000, supplierRegime: 'marge' }, items: [{ productId: P2, quantity: 1 }],
  }, { couts });
  // (1000 − 500) − TVA de 83,33 = 416,67
  assert.strictEqual(m.margeCents, 41667);
});

test('vente autoliquidée (pro UE) : aucune TVA à retirer', () => {
  const m = margeCommande({
    status: 'shipped', totalCents: 100000, shippingCostCents: 5000, vat: { reverseCharge: true },
    items: [{ productId: P1, quantity: 1 }],
  }, { couts: new Map([[P1, 60000]]) });
  assert.strictEqual(m.margeCents, 35000);
});

test('prix d\'achat inconnu : marge estimée (taux par défaut), signalée', () => {
  const m = margeCommande(macan({ items: [{ productId: P2, quantity: 1 }] }), { couts });
  assert.strictEqual(m.estimee, true);
  assert.strictEqual(m.source, 'estimation');
  assert.strictEqual(m.margeCents, Math.round(74167 * 0.5));
  // Une seule ligne sans prix d'achat suffit : pas de marge à moitié inventée.
  const mixte = margeCommande(macan({ items: [{ productId: P1, quantity: 1 }, { productId: P2, quantity: 1 }] }), { couts });
  assert.strictEqual(mixte.estimee, true);
  // Ligne libre d'une commande téléphone (pas de fiche produit).
  const libre = margeCommande(macan({ items: [{ productId: null, quantity: 1 }] }), { couts });
  assert.strictEqual(libre.estimee, true);
});

test('remboursement partiel : la marge baisse du montant rendu, hors TVA', () => {
  const m = margeCommande({
    status: 'partially_refunded', totalCents: 120000, shippingCostCents: 0, vatScheme: 'normal',
    items: [{ productId: P1, quantity: 1 }],
    refunds: [{ amountCents: 12000, kind: 'standard' }],
  }, { couts });
  // 1000 € HT − 100 € rendus (120 TTC) − 500 € d'achat
  assert.strictEqual(m.margeCents, 40000);
});

test('consigne rendue au retour de l\'ancienne pièce : la marge ne bouge pas', () => {
  const avant = margeCommande(macan(), { couts });
  const apres = margeCommande(macan({ refunds: [{ amountCents: 10000, kind: 'consigne' }] }), { couts });
  assert.strictEqual(apres.margeCents, avant.margeCents);
});

test('remboursée, annulée, supprimée, impayée : 0', () => {
  for (const over of [
    { status: 'refunded' },
    { status: 'cancelled' },
    { status: 'pending_payment' },
    { deletedAt: new Date() },
    { refunds: [{ amountCents: 107900, kind: 'standard' }] }, // tout rendu, statut pas encore à jour
  ]) {
    assert.strictEqual(margeCommande(macan(over), { couts }).margeCents, 0, JSON.stringify(over));
  }
});

test('vendue à perte : 0, jamais négatif (Google refuse les valeurs négatives)', () => {
  const m = margeCommande(macan(), { couts: new Map([[P1, 90000]]) });
  assert.strictEqual(m.margeCents, 0);
});

test('taux par défaut réglable, borné', () => {
  const avant = process.env.GOOGLE_ADS_TAUX_MARGE_DEFAUT;
  try {
    process.env.GOOGLE_ADS_TAUX_MARGE_DEFAUT = '0,4';
    assert.strictEqual(tauxMargeParDefaut(), 0.4);
    process.env.GOOGLE_ADS_TAUX_MARGE_DEFAUT = '3';
    assert.strictEqual(tauxMargeParDefaut(), 0.5, 'valeur absurde ignorée');
    delete process.env.GOOGLE_ADS_TAUX_MARGE_DEFAUT;
    assert.strictEqual(tauxMargeParDefaut(), 0.5);
  } finally {
    if (avant === undefined) delete process.env.GOOGLE_ADS_TAUX_MARGE_DEFAUT;
    else process.env.GOOGLE_ADS_TAUX_MARGE_DEFAUT = avant;
  }
});
