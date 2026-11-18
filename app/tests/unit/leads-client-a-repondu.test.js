/**
 * « Le client a répondu » — le signal le plus chaud de la file des leads.
 *
 * Un client qui nous écrit a déjà dit ce qu'il veut et attend une réponse.
 * Jusqu'ici son message n'apparaissait que dans l'onglet « Suivi & notes »,
 * chargé après coup : le dossier restait à sa place habituelle dans la file,
 * parfois dans un groupe replié, et personne ne voyait qu'il avait écrit.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const ejs = require('ejs');

const { computeWork, comparer, GROUPES } = require('../../src/services/leadWork');
const { toCardModel } = require('../../src/controllers/abandonedCartAdminController');

const VUES = path.join(__dirname, '..', '..', 'src', 'views', 'admin', 'partials');
const NOW = new Date('2026-11-18T13:00:00Z'); // mercredi 18/11/2026, 14 h à Paris

function rendre(fichier, c) {
  return ejs.render(`<%- include('./${fichier}', { c: c }) %>`, { c }, { filename: path.join(VUES, 'appelant.ejs') });
}

function sms(corps, at, sens = 'entrant') {
  return { canal: 'sms', sens, corps, at, par: sens === 'entrant' ? 'Client' : 'Système', auto: sens !== 'entrant' };
}

/** Appel manqué : accusé de réception automatique, puis le client dit ce qu'il veut. */
function aRepondu(extra = {}) {
  return Object.assign({
    _id: '6afc7c9fd251d246e1609001',
    captureSource: 'appel_manque',
    phone: '0612345678',
    abandonedAt: new Date('2026-11-18T07:00:00Z'),
    createdAt: new Date('2026-11-18T07:00:00Z'),
    communications: [
      sms('Bonjour, nous avons bien reçu votre appel.', new Date('2026-11-18T07:02:00Z'), 'sortant'),
      sms('Bonjour, je cherche une mécatronique DQ250 pour une Golf 6 de 2011, vous avez ?', new Date('2026-11-18T12:30:00Z')),
    ],
  }, extra);
}

test('un client qui écrit passe en tête de file', () => {
  const w = computeWork(aRepondu(), NOW);
  assert.equal(w.aRepondu, true);
  assert.equal(w.group, 'repondu');
  assert.equal(w.nextActionLabel, 'Répondre au client');
  assert.equal(GROUPES[0].key, 'repondu', 'le groupe est le premier de la liste');
});

test('un message automatique ne compte pas : seule la réponse du client compte', () => {
  const sansReponse = computeWork(Object.assign(aRepondu(), {
    communications: [sms('Bonjour, nous avons bien reçu votre appel.', new Date('2026-11-18T07:02:00Z'), 'sortant')],
  }), NOW);
  assert.equal(sansReponse.aRepondu, false);
  assert.notEqual(sansReponse.group, 'repondu');
});

test('une fois qu’un commercial a répondu, le dossier quitte le groupe', () => {
  const repondu = computeWork(aRepondu({
    lastManualContactAt: new Date('2026-11-18T12:45:00Z'),
  }), NOW);
  assert.equal(repondu.aRepondu, false, 'la balle n’est plus dans notre camp');
  assert.notEqual(repondu.group, 'repondu');

  /* …et si le client réécrit APRÈS notre réponse, il y revient. */
  const reecrit = computeWork(aRepondu({
    lastManualContactAt: new Date('2026-11-18T12:45:00Z'),
    communications: aRepondu().communications.concat([sms('Et en combien de temps ?', new Date('2026-11-18T12:50:00Z'))]),
  }), NOW);
  assert.equal(reecrit.aRepondu, true);
});

test('« STOP » n’est pas une réponse commerciale : on ne remonte pas ce client', () => {
  ['STOP', 'stop sms', 'Désabonnement', 'ARRÊT', 'Ne plus me contacter svp'].forEach((texte) => {
    const w = computeWork(aRepondu({
      communications: [sms(texte, new Date('2026-11-18T12:30:00Z'))],
    }), NOW);
    assert.equal(w.aRepondu, false, `« ${texte} » ne doit pas remonter le dossier`);
  });
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
  assert.equal(ecrit.group, 'repondu');
});

test('dans le groupe, celui qui attend sa réponse depuis le plus longtemps est en haut', () => {
  const vieux = { id: 'v', work: computeWork(aRepondu({
    communications: [sms('Alors ?', new Date('2026-11-18T08:00:00Z'))] }), NOW) };
  const recent = { id: 'r', work: computeWork(aRepondu({
    communications: [sms('Bonjour', new Date('2026-11-18T12:55:00Z'))] }), NOW) };
  assert.ok(comparer(vieux, recent) < 0);
  assert.ok(comparer(recent, vieux) > 0);
});

test('un retard reste compté comme un retard, même sorti de son groupe', () => {
  /* Le bandeau du patron lisait les retards par GROUPE : un dossier passé
     dans « Le client a répondu » aurait disparu du compteur. */
  const w = computeWork(aRepondu({
    nextAction: { type: 'callback', dueAt: new Date('2026-11-18T09:00:00Z') },
  }), NOW);
  assert.equal(w.group, 'repondu');
  assert.equal(w.overdue, true, 'l’échéance est bien passée');
  assert.equal(w.ancien, false);
});

test('la ligne montre la pastille et les mots du client', () => {
  const c = toCardModel(aRepondu(), NOW);
  assert.equal(c.reponse.canal, 'SMS');
  const html = rendre('lead-ligne', c);
  assert.ok(html.includes('A répondu'), 'la pastille se voit sans ouvrir la fiche');
  assert.ok(html.includes('mécatronique DQ250'), 'ses mots sont sur la ligne');
  assert.ok(html.includes('bg-green-500'), 'la ligne passe au vert');
});

test('la fiche met son message avant la prochaine action', () => {
  const c = toCardModel(aRepondu(), NOW);
  const html = rendre('lead-fiche', c);
  assert.ok(html.includes('Le client a répondu par SMS'));
  assert.ok(html.includes('Golf 6'), 'son message en entier');
  assert.ok(html.indexOf('Le client a répondu par SMS') < html.indexOf('La prochaine action'),
    'son message se lit AVANT ce qu’il faut faire');
  assert.ok(html.includes('Répondre au client'));
});

test('sans le texte du message, on renvoie vers le suivi plutôt que d’afficher du vide', () => {
  /* Certaines pages chargent le journal sans le corps des messages. */
  const c = toCardModel(aRepondu({
    communications: [{ canal: 'sms', sens: 'entrant', at: new Date('2026-11-18T12:30:00Z') }],
  }), NOW);
  assert.equal(c.aRepondu, true);
  assert.equal(c.reponse.texte, '');
  assert.ok(rendre('lead-fiche', c).includes('Suivi &amp; notes'));
});

test('la file va CHERCHER les dossiers dont le client a écrit, même un vieux panier', () => {
  /* Sans cette condition, un panier abandonné qui répond à un SMS de relance
     n'était jamais chargé : le groupe « Le client a répondu » restait vide
     pour tout ce qui n'était pas une demande de devis. */
  const { filtreBase } = require('../../src/services/leadWorkQueue');
  const branches = filtreBase(NOW).$or;
  const entrants = branches.find((b) => b.communications);
  assert.ok(entrants, 'la requête doit ramener les leads avec un message entrant récent');
  assert.equal(entrants.communications.$elemMatch.sens, 'entrant');
  assert.ok(entrants.communications.$elemMatch.at.$gte instanceof Date);
});
