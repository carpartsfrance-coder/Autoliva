/**
 * Ce que montre une ligne de la liste des leads et l'en-tête de sa fiche
 * (views/admin/partials/lead-ligne.ejs et lead-fiche.ejs), rendues pour de
 * vrai à partir du modèle de carte du contrôleur.
 *
 * Ces vues se lisent en une seconde entre deux appels : un oubli d'affichage
 * ne se voit pas dans un test de données, seulement dans le HTML produit.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const ejs = require('ejs');

const { toCardModel } = require('../../src/controllers/abandonedCartAdminController');

const VUES = path.join(__dirname, '..', '..', 'src', 'views', 'admin', 'partials');
const MARDI_10H = new Date('2026-11-17T09:00:00Z'); // mardi 17/11/2026, 10 h à Paris

function rendre(fichier, c) {
  return ejs.render(
    `<%- include('./${fichier}', { c: c }) %>`,
    { c },
    { filename: path.join(VUES, 'appelant.ejs') },
  );
}

/** Demande reçue ce matin à 9 h 12, jamais rappelée. */
function demandeDuMatin(extra = {}) {
  return Object.assign({
    _id: '6afc7c9fd251d246e160832c',
    captureSource: 'landing_ponts',
    firstName: 'Marc',
    lastName: 'Dubois',
    phone: '0612345678',
    email: 'marc@example.com',
    abandonedAt: new Date('2026-11-17T08:12:00Z'),
    createdAt: new Date('2026-11-17T08:12:00Z'),
    requested: { plate: 'BE251FQ', vehicle: 'Boîte de transfert reconditionné(e)', message: 'Pièce demandée : Boîte de transfert' },
    totalAmountCents: 145000,
  }, extra);
}

test('la ligne dit à quelle heure la demande est arrivée', () => {
  const c = toCardModel(demandeDuMatin(), MARDI_10H);
  assert.equal(c.recuCourt, '09:12');
  const html = rendre('lead-ligne', c);
  assert.ok(html.includes('09:12'), 'l’heure d’arrivée doit être sur la ligne');
  assert.ok(html.includes('Demande reçue le 17/11/2026 à 09:12'), 'l’infobulle donne la date complète');
});

test('la ligne dit depuis combien de temps la demande attend, heures fermées exclues', () => {
  /* Reçue à 9 h 12, il est 10 h : 48 minutes d'attente. */
  const c = toCardModel(demandeDuMatin(), MARDI_10H);
  assert.equal(c.attenteMin, 48);
  assert.ok(rendre('lead-ligne', c).includes('attend 48 min'));

  /* Reçue hier à 17 h 50, il est 9 h 10 ce matin : 10 min hier soir + 10 min
     ce matin, pas quinze heures. */
  const nuit = toCardModel(demandeDuMatin({
    abandonedAt: new Date('2026-11-16T16:50:00Z'), createdAt: new Date('2026-11-16T16:50:00Z'),
  }), new Date('2026-11-17T08:10:00Z'));
  assert.equal(nuit.attenteMin, 20);
  assert.ok(rendre('lead-ligne', nuit).includes('attend 20 min'));
});

test('attente : sous l’heure c’est gris, au-delà ça passe en rouge', () => {
  const tot = toCardModel(demandeDuMatin(), new Date('2026-11-17T08:50:00Z'));
  assert.equal(tot.attenteMin, 38);
  assert.ok(!rendre('lead-ligne', tot).includes('text-red-600'), 'sous l’heure, l’attente n’est pas alarmante');

  const tard = toCardModel(demandeDuMatin(), new Date('2026-11-17T10:30:00Z'));
  assert.ok(tard.attenteMin > 60);
  assert.ok(rendre('lead-ligne', tard).includes('text-red-600'), 'passé l’heure promise, l’attente est rouge');
});

test('la ligne montre le montant en jeu', () => {
  const c = toCardModel(demandeDuMatin(), MARDI_10H);
  assert.equal(c.prixAffiche.origine, 'panier');
  assert.ok(rendre('lead-ligne', c).includes(c.prixAffiche.montant), 'le montant doit être lisible sur la ligne');
});

test('la ligne signale un client qui a cliqué sur « payer »', () => {
  const c = toCardModel(demandeDuMatin({
    engineQuote: {
      status: 'quote_sent',
      pricing: { sellPrice: 2300 },
      sentQuotes: [{ sentAt: new Date('2026-11-16T10:00:00Z'), openedAt: new Date('2026-11-16T11:00:00Z'), payClickedAt: new Date('2026-11-17T07:00:00Z') }],
    },
  }), MARDI_10H);
  const html = rendre('lead-ligne', c);
  assert.ok(html.includes('A cliqué payer'), 'le signal d’achat le plus fort doit être visible sans ouvrir la fiche');
  assert.equal(c.prixAffiche.origine, 'devis', 'le prix montré est celui du devis, pas celui du panier');
  assert.ok(html.includes(c.prixAffiche.montant));
});

test('la ligne signale un ancien client et un SAV en cours', () => {
  const c = toCardModel(demandeDuMatin(), MARDI_10H);
  c.clientHistory = { count: 3, lastRel: 'il y a 2 j', lastUrl: '/admin/commandes/x', title: 'n°1042' };
  c.savHistory = { count: 1, openCount: 1, lastStatut: 'en cours', url: '/admin/sav/tickets/T1', title: 'T1' };
  const html = rendre('lead-ligne', c);
  assert.ok(html.includes('Déjà client · 3'));
  assert.ok(html.includes('SAV en cours'));
});

test('la ligne montre qu’une note existe, sans annoncer un nombre faux', () => {
  const c = toCardModel(demandeDuMatin({
    notes: [{ text: 'Veut la pièce avant vendredi, a déjà appelé un concurrent', addedByName: 'Killian', addedAt: new Date('2026-11-17T08:30:00Z') }],
  }), MARDI_10H);
  const html = rendre('lead-ligne', c);
  assert.ok(html.includes('Veut la pièce avant vendredi'), 'la note se lit au survol');
  assert.ok(!/sticky_note_2<\/span>\s*\d/.test(html), 'pas de compteur : la file ne charge que les 6 dernières notes');
});

test('les repères de l’horloge sont posés sur la ligne et sur la fiche', () => {
  const c = toCardModel(demandeDuMatin(), MARDI_10H);
  const ligne = rendre('lead-ligne', c);
  assert.ok(ligne.includes('data-attente="' + c.attenteMin + '"'));
  assert.ok(/data-due="20\d\d-/.test(ligne), 'l’échéance est transmise au navigateur');
  assert.ok(ligne.includes('data-role="urgence"') && ligne.includes('data-role="barre"'));

  const fiche = rendre('lead-fiche', c);
  assert.ok(fiche.includes('data-role="urgence-longue"'));
  assert.ok(fiche.includes('data-role="attente-longue"'));
});

test('la fiche donne l’heure exacte de la demande, pas seulement « il y a 3 h »', () => {
  const c = toCardModel(demandeDuMatin(), MARDI_10H);
  const html = rendre('lead-fiche', c);
  assert.ok(html.includes('aujourd’hui à 09:12'), 'la fiche dit l’heure en clair');
  assert.ok(html.includes('Demande reçue le 17/11/2026 à 09:12'), 'l’infobulle donne la date de la DEMANDE');
  assert.ok(html.includes('attend depuis'), 'et depuis combien de temps personne n’a répondu');
});

test('la fiche montre la dernière note sans attendre l’onglet « Suivi »', () => {
  const c = toCardModel(demandeDuMatin({
    notes: [{ text: 'Client rappelé, veut un devis écrit', addedByName: 'Sarah', addedAt: new Date('2026-11-17T08:40:00Z') }],
  }), MARDI_10H);
  const html = rendre('lead-fiche', c);
  assert.ok(html.includes('Dernière note'));
  assert.ok(html.includes('Client rappelé, veut un devis écrit'));
  assert.ok(html.includes('Sarah'));
});

test('un simple panier abandonné n’affiche ni attente ni échéance', () => {
  const c = toCardModel({
    _id: '6afc7c9fd251d246e1608000',
    captureSource: 'cart_activity',
    email: 'passant@example.com',
    abandonedAt: new Date('2026-11-16T14:00:00Z'),
    items: [{ name: 'Mécatronique DQ250' }],
    totalAmountCents: 89000,
  }, MARDI_10H);
  assert.equal(c.attenteMin, -1, 'personne ne doit « attendre » sur un panier : ce n’est pas une demande');
  const html = rendre('lead-ligne', c);
  assert.ok(!html.includes('attend '), 'pas de compte à rebours sur un simple passage');
  assert.ok(html.includes('hier 15:00'), 'mais on voit quand il est passé');
});
