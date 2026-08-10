/**
 * Tests unitaires — conformité du payload Skeepers au Swagger officiel.
 *
 * Référence : https://apidocs.skeepers.io/purchase-events.html
 *             opération « Submit Purchase Event »
 *
 * Lancé par : npm test  (aucune base, aucun réseau)
 */

const test = require('node:test');
const assert = require('node:assert');

const sk = require('../../src/services/skeepersReviews');

const CLIENT = { email: 'client@example.com', firstName: 'Jean', lastName: 'Dupont' };
const commande = (items) => ({
  number: 'CP2026-000199',
  createdAt: new Date(Date.now() - 10 * 86400000),
  totalCents: 99000,
  items,
  shippingAddress: { fullName: 'Jean Dupont' },
});

test('purchase_event_type respecte l’énumération documentée', async (t) => {
  /* Le Swagger n'accepte que BRAND_AND_PRODUCT | PURCHASE_ONLY | PRODUCT_ONLY.
     On envoyait « BRAND », qui n'existe pas. */
  const VALIDES = new Set(['BRAND_AND_PRODUCT', 'PURCHASE_ONLY', 'PRODUCT_ONLY']);

  await t.test('avec des produits liés : BRAND_AND_PRODUCT', () => {
    const ev = sk.buildPurchaseEvent(commande([{ name: 'Mécatronique', productId: 'abc123' }]), CLIENT);
    assert.equal(ev.solicitation_parameters.purchase_event_type, 'BRAND_AND_PRODUCT');
    assert.equal(ev.products.length, 1);
  });

  await t.test('sans produit lié : PURCHASE_ONLY, jamais « BRAND »', () => {
    /* Cas d'une vente issue d'un devis moteur : l'article n'a pas de productId. */
    const ev = sk.buildPurchaseEvent(commande([{ name: 'Moteur d\'occasion' }]), CLIENT);
    assert.equal(ev.solicitation_parameters.purchase_event_type, 'PURCHASE_ONLY');
    assert.notEqual(ev.solicitation_parameters.purchase_event_type, 'BRAND');
    assert.equal(ev.products.length, 0);
  });

  await t.test('la valeur envoyée est toujours dans l’énumération', () => {
    [[], [{ name: 'X' }], [{ name: 'X', productId: 'a' }]].forEach((items) => {
      const ev = sk.buildPurchaseEvent(commande(items), CLIENT);
      assert.ok(VALIDES.has(ev.solicitation_parameters.purchase_event_type),
        JSON.stringify(ev.solicitation_parameters.purchase_event_type));
    });
  });
});

test('champs obligatoires du Swagger', async (t) => {
  await t.test('purchase_reference, purchase_date et sales_channel sont présents', () => {
    const ev = sk.buildPurchaseEvent(commande([{ name: 'X', productId: 'a' }]), CLIENT);
    assert.equal(ev.purchase_reference, 'CP2026-000199');
    assert.match(ev.purchase_date, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/, 'format date-time attendu');
    assert.equal(ev.sales_channel.channel, 'online');
    assert.ok(ev.consumer.email);
  });

  await t.test('la date d’achat reste celle de la commande, jamais falsifiée', () => {
    /* Antidater contournerait la fenêtre de Skeepers — et ruinerait la
       certification « avis vérifiés » qu'on cherche justement à obtenir. */
    const c = commande([{ name: 'X', productId: 'a' }]);
    const ev = sk.buildPurchaseEvent(c, CLIENT);
    assert.equal(ev.purchase_date.slice(0, 10), c.createdAt.toISOString().slice(0, 10));
  });

  await t.test('sans e-mail client, aucun événement n’est construit', () => {
    assert.equal(sk.buildPurchaseEvent(commande([{ name: 'X' }]), {}), null);
    assert.equal(sk.buildPurchaseEvent(commande([{ name: 'X' }]), null), null);
  });
});
