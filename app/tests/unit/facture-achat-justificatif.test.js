/**
 * Tests unitaires — facture d'achat jointe à une commande (justificatif marge).
 *
 * Lancé par : npm test  (aucune base de données, aucun appel réseau)
 *
 * Deux choses à verrouiller :
 *
 *  1. Le fichier ne doit JAMAIS pouvoir partir chez le client. Il porte le
 *     prix d'achat, donc la marge. La route client sert n'importe quelle
 *     entrée de `documents[]` sans regarder son type : le justificatif est
 *     donc rangé ailleurs, et ce test vérifie qu'il y reste.
 *  2. Le nommage des fichiers, parce que c'est ce que le comptable lit pour
 *     rapprocher une facture de vente de sa facture d'achat.
 */

const test = require('node:test');
const assert = require('node:assert');

const purchaseInvoice = require('../../src/services/purchaseInvoice');
const Order = require('../../src/models/Order');

test('le justificatif est hors de portée du client, par construction', async (t) => {
  await t.test('il vit dans purchase.invoiceFile, pas dans documents[]', () => {
    /* La route client (`GET /compte/commandes/:orderId/documents/:docId`)
       projette `{ documents: 1 }` et cherche dans ce tableau. Un fichier
       stocké hors de `documents[]` lui est inatteignable — ce n'est pas un
       filtre qu'on pourrait oublier, c'est la structure. */
    const chemins = Object.keys(Order.schema.paths);
    assert.ok(chemins.includes('purchase.invoiceFile.data'),
      'le champ doit exister sous purchase');
    assert.ok(!chemins.some((p) => p.startsWith('documents') && p.includes('invoiceFile')),
      'aucun sous-champ invoiceFile ne doit apparaître dans documents[]');
  });

  await t.test('et il n’est pas chargé par défaut', () => {
    /* `select: false` : une liste de commandes ne doit pas traîner plusieurs
       mégaoctets de PDF derrière elle. */
    const champ = Order.schema.path('purchase.invoiceFile.data');
    assert.equal(champ.options.select, false);
  });

  await t.test('le type de document « facture d’achat » n’existe pas dans documents[]', () => {
    /* Garde-fou contre la tentation de « simplifier » un jour en rangeant le
       justificatif avec les autres documents : il redeviendrait alors
       téléchargeable par l'acheteur. */
    const docType = Order.schema.path('documents').schema.path('docType');
    assert.ok(!docType.enumValues.some((v) => /achat/i.test(v)),
      'documents[].docType ne doit pas accueillir de facture d’achat');
  });
});

test('nom de fichier pour la comptabilité', async (t) => {
  await t.test('le numéro de commande d’abord — comme les factures de vente', () => {
    assert.equal(
      purchaseInvoice.nomFichier('CP2026-000199', { originalName: 'scan.pdf' }),
      'Facture-achat_CP2026-000199.pdf'
    );
  });

  await t.test('l’extension d’origine est conservée', () => {
    assert.equal(
      purchaseInvoice.nomFichier('CP2026-000199', { originalName: 'facture.PDF' }),
      'Facture-achat_CP2026-000199.PDF'
    );
  });

  await t.test('sans nom d’origine exploitable, on retombe sur .pdf', () => {
    assert.equal(purchaseInvoice.nomFichier('CP1', {}), 'Facture-achat_CP1.pdf');
    assert.equal(purchaseInvoice.nomFichier('CP1', { originalName: 'sans-extension' }), 'Facture-achat_CP1.pdf');
    assert.equal(purchaseInvoice.nomFichier('CP1', null), 'Facture-achat_CP1.pdf');
  });

  await t.test('sans numéro de commande, le nom reste utilisable', () => {
    assert.equal(purchaseInvoice.nomFichier('', { originalName: 'x.pdf' }), 'Facture-achat.pdf');
    assert.equal(purchaseInvoice.nomFichier(null, null), 'Facture-achat.pdf');
  });

  await t.test('une extension aberrante ne passe pas pour une extension', () => {
    /* `.jesuisuneextensiontreslongue` n'est pas capturé : on retombe sur .pdf
       plutôt que de forger un nom de fichier à partir d'une chaîne arbitraire. */
    assert.equal(
      purchaseInvoice.nomFichier('CP1', { originalName: 'x.jesuistreslongue' }),
      'Facture-achat_CP1.pdf'
    );
  });
});

test('charger() ne renvoie rien plutôt que de planter', async (t) => {
  await t.test('sur un identifiant invalide, avant toute requête', async () => {
    /* Retour immédiat : pas de connexion Mongo requise, donc ce test tourne
       hors base comme le reste de la suite. */
    assert.equal(await purchaseInvoice.charger('pas-un-objectid'), null);
    assert.equal(await purchaseInvoice.charger(''), null);
    assert.equal(await purchaseInvoice.charger(null), null);
    assert.equal(await purchaseInvoice.charger(undefined), null);
  });
});
