/**
 * Les SMS reçus d'un client, après le retrait de l'onglet « Le client a
 * répondu » (20/11/2026).
 *
 * L'onglet faisait remonter en tête de file tout dossier dont le client
 * avait écrit. Mais l'outil ne sait que QUI a écrit — le message est
 * rattaché au dossier par le seul numéro de téléphone (ringoverCalls.js →
 * findContext) — pas DE QUOI : un « ma boîte fait toujours du bruit » d'un
 * client en SAV, ou un « où est mon colis ? », passait pour une réponse
 * commerciale. Le patron a demandé de supprimer l'onglet entièrement.
 *
 * Ce qui reste, et ce que ces tests gardent :
 *   - le dossier suit son échéance normale, quel que soit le message reçu ;
 *   - le message reste lisible : c'est la dernière note du dossier, avec son
 *     contexte (SAV ouvert, commande en cours) que Ringover y accole ;
 *   - un panier abandonné dont le client écrit devient une vraie demande
 *     (sauf « STOP ») — c'est une question d'intention, pas d'onglet.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const ejs = require('ejs');

const { computeWork, GROUPES } = require('../../src/services/leadWork');
const { toCardModel } = require('../../src/controllers/abandonedCartAdminController');
const { filtreBase } = require('../../src/services/leadWorkQueue');

const VUES = path.join(__dirname, '..', '..', 'src', 'views', 'admin', 'partials');
const NOW = new Date('2026-11-18T13:00:00Z'); // mercredi 18/11/2026, 14 h à Paris

function rendre(fichier, c) {
  return ejs.render(`<%- include('./${fichier}', { c: c }) %>`, { c }, { filename: path.join(VUES, 'appelant.ejs') });
}

function sms(corps, at, sens = 'entrant') {
  return { canal: 'sms', sens, corps, at, par: sens === 'entrant' ? 'Client' : 'Système', auto: sens !== 'entrant' };
}

/** Client en SAV, dossier de vente mis en attente un mois, qui écrit aujourd'hui. */
function clientSavQuiEcrit() {
  const recu = new Date('2026-11-18T12:30:00Z');
  return {
    _id: '6afc7c9fd251d246e1609001',
    captureSource: 'devis',
    firstName: 'Patrick',
    phone: '0612345678',
    abandonedAt: new Date('2026-11-02T09:00:00Z'),
    createdAt: new Date('2026-11-02T09:00:00Z'),
    takenByName: 'Lucas',
    lastManualContactAt: new Date('2026-11-16T10:00:00Z'),
    nextAction: { type: 'wait_client', dueAt: new Date('2026-12-16T08:30:00Z') },
    communications: [sms('Ma boîte fait toujours du bruit au passage de la 3e', recu)],
    /* Ce que le webhook Ringover écrit à côté du message, avec son contexte. */
    notes: [{
      text: 'RÉPONSE SMS du client : « Ma boîte fait toujours du bruit au passage de la 3e » — SAV-2026-0114 ouvert (bruit)',
      addedByName: 'Ringover SMS', addedAt: recu,
    }],
  };
}

test('l’onglet « Le client a répondu » n’existe plus', () => {
  assert.ok(!GROUPES.some((g) => g.key === 'repondu'));
});

test('un SMS reçu ne fait plus remonter le dossier : il reste dans son onglet', () => {
  /* Le cas qui a fait supprimer l'onglet : un message de SAV qui sortait un
     dossier de vente de « Planifiés » pour le mettre en tête de file. */
  const w = computeWork(clientSavQuiEcrit(), NOW);
  assert.equal(w.group, 'plus_tard', 'le rendez-vous du 16/12 tient toujours');
  assert.equal(w.aRepondu, undefined, 'le calcul ne connaît plus cette notion');
});

test('la ligne n’affiche plus ni pastille « A répondu » ni vert', () => {
  const ligne = rendre('lead-ligne', toCardModel(clientSavQuiEcrit(), NOW));
  assert.ok(!ligne.includes('A répondu'));
  assert.ok(!ligne.includes('bg-green-500'), 'la barre ne vire plus au vert');
  assert.ok(!ligne.includes('format_quote'), 'plus de citation du message sur la ligne');
});

test('le message reste lisible, AVEC son contexte', () => {
  /* Depuis la refonte de la fiche (20/11/2026), il s'affiche comme un
     message, avec ce que l'outil savait du numéro à la réception — et la
     note que Ringover écrit n'est plus répétée en « Dernière note ». */
  const c = toCardModel(clientSavQuiEcrit(), NOW);
  const fiche = rendre('lead-fiche', c);
  assert.ok(!fiche.includes('Le client a répondu'), 'plus d’encadré vert');
  assert.ok(fiche.includes('Message du client'));
  assert.ok(fiche.includes('Ma boîte fait toujours du bruit au passage de la 3e'), 'le texte du client');
  assert.ok(fiche.includes('SAV-2026-0114 ouvert'), 'et on voit tout de suite que c’est du SAV');
  assert.ok(!fiche.includes('RÉPONSE SMS du client'), 'le même texte n’est pas affiché deux fois');
});

test('un panier abandonné dont le client écrit devient une vraie demande', () => {
  const panier = {
    _id: '6afc7c9fd251d246e1609002', captureSource: 'cart_activity', phone: '0612345678',
    abandonedAt: new Date('2026-11-16T10:00:00Z'), items: [{ name: 'Mécatronique DQ250' }], totalAmountCents: 89000,
  };
  assert.equal(computeWork(panier, NOW).intent, 'weak', 'un simple panier reste un simple passage');
  const ecrit = computeWork(Object.assign({}, panier, {
    communications: [sms('Elle est toujours dispo ?', new Date('2026-11-18T12:30:00Z'))],
  }), NOW);
  assert.equal(ecrit.intent, 'opportunity');
  assert.equal(ecrit.group, 'non_traites', 'personne ne lui a encore répondu : à prendre');
});

test('« STOP » ne transforme pas un panier en demande', () => {
  const panier = {
    _id: '6afc7c9fd251d246e1609003', captureSource: 'cart_activity', phone: '0612345678',
    abandonedAt: new Date('2026-11-16T10:00:00Z'),
  };
  ['STOP', 'stop sms', 'Désabonnement', 'ARRÊT', 'Ne plus me contacter svp'].forEach((texte) => {
    const w = computeWork(Object.assign({}, panier, {
      communications: [sms(texte, new Date('2026-11-18T12:30:00Z'))],
    }), NOW);
    assert.equal(w.intent, 'weak', `« ${texte} » ne doit pas faire entrer ce client dans la file`);
  });
});

test('la file va toujours chercher les dossiers dont le client a écrit', () => {
  /* Sans cette condition, le panier qui écrit n'était jamais chargé. */
  const entrants = filtreBase(NOW).$or.find((b) => b.communications);
  assert.ok(entrants, 'la requête doit ramener les leads avec un message entrant récent');
  assert.equal(entrants.communications.$elemMatch.sens, 'entrant');
});
