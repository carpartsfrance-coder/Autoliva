/**
 * Tests unitaires — À QUEL MOMENT la facture part chez le client.
 *
 * Lancé par : npm test  (aucune base de données, aucun e-mail réellement envoyé)
 *
 * L'ENJEU. Les pièces sont sourcées APRÈS la vente : au paiement, on ignore chez
 * quel fournisseur on achètera, donc sous quel régime de TVA (normal 20 % ou
 * marge, art. 297 A du CGI). Joindre la facture au mail de confirmation, c'est
 * graver un régime qu'on ne connaît pas encore — et le corriger ensuite
 * imposerait un avoir, le client ayant déjà le PDF dans sa boîte mail.
 *
 * D'où la règle vérifiée ici :
 *   particulier → facture au mail d'EXPÉDITION (après l'achat fournisseur)
 *   professionnel → facture immédiate (obligatoire, art. 289 I-1-a, et il en a
 *                   besoin pour déduire sa TVA)
 *
 * Aucun envoi réel : `fetch` est remplacé le temps du test, et restauré ensuite.
 */

const test = require('node:test');
const assert = require('node:assert');

/* Variables lues au chargement du module : à poser AVANT le require(). */
process.env.MAILERSEND_API_KEY = 'cle-de-test-hors-ligne';
process.env.MAIL_FROM_EMAIL = 'test@example.com';
process.env.BREVO_API_KEY = '';
/* Les CGV sont cherchées en base quand ce chemin est vide. Sans connexion
   Mongoose, chaque appel attendrait son délai d'expiration de 10 secondes —
   pour une pièce jointe qui n'est pas le sujet ici. Un chemin bidon suffit à
   court-circuiter la requête : le fichier est simplement absent. */
process.env.CGV_PDF_PATH = 'tests/unit/_cgv-absentes-volontairement.pdf';

/* Sans connexion, Mongoose met en attente chaque requête pendant 10 secondes
   avant d'abandonner. La génération du PDF en déclenche quelques-unes (réglages
   de la société) : sans ce réglage, le fichier de test durerait une minute pour
   vérifier une décision qui, elle, ne touche pas la base. */
require('mongoose').set('bufferTimeoutMS', 10);

const emailService = require('../../src/services/emailService');

const CLIENT = { email: 'client@example.com', firstName: 'Jean', lastName: 'Dupont' };
const ADRESSE = {
  fullName: 'Jean Dupont', line1: '1 rue de la Paix',
  postalCode: '75001', city: 'Paris', country: 'France',
};

/* `_id` absent : les fonctions d'hydratation retournent l'objet tel quel
   (emailService.js, `if (!order || !order._id) return order`), donc aucun
   accès à la base n'est déclenché. */
const commande = (accountType) => ({
  number: 'CP-TEST-001', accountType, status: 'paid', paymentStatus: 'paid',
  createdAt: new Date(), totalCents: 99000, currency: 'EUR',
  items: [{ name: 'Mécatronique DSG7 DQ200', quantity: 1, unitPriceCents: 99000 }],
  shippingAddress: ADRESSE, billingAddress: ADRESSE,
  invoice: { number: 'FA-2026-0001', issuedAt: new Date() },
});

/** Exécute un envoi en interceptant l'appel réseau, et rend les pièces jointes. */
async function piecesJointes(envoyer) {
  const fetchInitial = global.fetch;
  let corps = null;
  global.fetch = async (url, opts) => {
    corps = JSON.parse(opts.body);
    return { ok: true, status: 202, json: async () => ({}), text: async () => '' };
  };
  try {
    await envoyer();
  } finally {
    global.fetch = fetchInitial;
  }
  return ((corps && corps.attachments) || []).map((a) => a.filename);
}

const contientFacture = (noms) => noms.some((n) => /^Facture-/.test(n));

test('moment d’envoi de la facture au client', async (t) => {
  await t.test('le PARTICULIER ne reçoit pas sa facture à la confirmation', async () => {
    /* Le régime de TVA n'est pas encore connu : la pièce n'est pas achetée. */
    const noms = await piecesJointes(() =>
      emailService.sendOrderConfirmationEmail({ order: commande('particulier'), user: CLIENT }));
    assert.equal(contientFacture(noms), false,
      'facture jointe trop tôt : ' + noms.join(', '));
  });

  await t.test('il la reçoit au mail d’EXPÉDITION, après l’achat fournisseur', async () => {
    const noms = await piecesJointes(() =>
      emailService.sendShipmentTrackingEmail({
        order: commande('particulier'), user: CLIENT,
        shipment: { carrier: 'UPS', trackingNumber: '1Z999', label: 'Envoi' },
      }));
    assert.ok(contientFacture(noms), 'facture absente du mail d’expédition : ' + noms.join(', '));
  });

  await t.test('le PROFESSIONNEL la reçoit immédiatement', async () => {
    /* Facture obligatoire (art. 289 I-1-a CGI), et il en a besoin pour déduire
       sa TVA. Un pro est de toute façon toujours facturé au régime normal. */
    const noms = await piecesJointes(() =>
      emailService.sendOrderConfirmationEmail({ order: commande('pro'), user: CLIENT }));
    assert.ok(contientFacture(noms), 'le pro doit recevoir sa facture : ' + noms.join(', '));
  });

  await t.test('un type de compte inattendu est traité comme un particulier', async () => {
    /* Prudence : en cas de valeur absente ou inconnue, on retient le
       comportement le plus sûr — ne pas graver un régime qu'on ignore. */
    for (const type of [undefined, '', 'PARTICULIER', 'inconnu']) {
      const noms = await piecesJointes(() =>
        emailService.sendOrderConfirmationEmail({ order: commande(type), user: CLIENT }));
      assert.equal(contientFacture(noms), false, 'accountType = ' + JSON.stringify(type));
    }
  });

  await t.test('« pro » est reconnu quelle que soit la casse', async () => {
    for (const type of ['pro', 'Pro', 'PRO']) {
      const noms = await piecesJointes(() =>
        emailService.sendOrderConfirmationEmail({ order: commande(type), user: CLIENT }));
      assert.ok(contientFacture(noms), 'accountType = ' + JSON.stringify(type));
    }
  });
});
