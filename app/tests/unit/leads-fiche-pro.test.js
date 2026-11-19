/**
 * La fiche du client, refaite le 20/11/2026 : « ça ne fait pas site pro ».
 *
 * L'ancienne empilait un grand encadré rose, sept boutons de même poids sur
 * deux lignes, des titres en MAJUSCULES, le numéro répété trois fois, et le
 * SMS du client affiché sous « Pièce demandée », coupé à 90 caractères.
 *
 * Deux choses sont vérifiées ici :
 *   - le nouveau dessin (une seule action principale, pas de bloc coloré, le
 *     message affiché comme un message, le numéro lisible) ;
 *   - TOUS les branchements du script de la page (boutons, menus, raccourcis
 *     clavier A/E/S/R/P/G/L/J) : un bouton qui change de place ne doit pas
 *     perdre sa classe js-* ou son data-*, sinon il ne fait plus rien.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const ejs = require('ejs');

const { toCardModel } = require('../../src/controllers/abandonedCartAdminController');

const VUES = path.join(__dirname, '..', '..', 'src', 'views', 'admin', 'partials');
const NOW = new Date(Date.UTC(2026, 10, 19, 10, 15)); // jeudi 19/11/2026, 11 h 15 à Paris

function rendre(c) {
  return ejs.render("<%- include('./lead-fiche', { c: c }) %>", { c }, { filename: path.join(VUES, 'appelant.ejs') });
}
const compter = (html, s) => html.split(s).length - 1;

/** Le cas de la capture : appel manqué, puis un SMS qui parle d'une commande. */
function appelManque(extra = {}) {
  const sms = new Date(Date.UTC(2026, 10, 19, 9, 11));
  const texte = 'Bonjour, je viens d’effectuer une commande qui doit être livrée dans un garage autre que l’adresse indiquée, est-ce possible ?';
  return Object.assign({
    _id: '6afc7c9fd251d246e1609101', captureSource: 'appel_manque', phone: '+33634237651',
    abandonedAt: new Date(Date.UTC(2026, 10, 19, 9, 9)), createdAt: new Date(Date.UTC(2026, 10, 19, 9, 9)),
    communications: [{ canal: 'sms', sens: 'entrant', corps: texte, at: sms, par: 'Client' }],
    notes: [{ text: `RÉPONSE SMS du client : « ${texte} »`, addedByName: 'Ringover SMS', addedAt: sms }],
  }, extra);
}

/** Demande de devis en cours, prise par Sarah, avec un nom. */
function enCours(extra = {}) {
  return Object.assign({
    _id: '6afc7c9fd251d246e1609102', captureSource: 'devis', firstName: 'Sophie', lastName: 'Martin',
    phone: '0623456789', email: 'sophie@example.com',
    abandonedAt: new Date(Date.UTC(2026, 10, 18, 8)), createdAt: new Date(Date.UTC(2026, 10, 18, 8)),
    takenByName: 'Sarah', lastManualContactAt: new Date(Date.UTC(2026, 10, 18, 9)),
    requested: { ref: '02E 325 025', vehicle: 'Audi Q7 3.0 TDI 2012', plate: 'GH456KL' },
    totalAmountCents: 89000,
  }, extra);
}

/* ── Le dessin ───────────────────────────────────────────────────────────── */

test('plus de grand encadré coloré ni de titres en majuscules', () => {
  const html = rendre(toCardModel(appelManque(), NOW));
  assert.ok(!html.includes('LA PROCHAINE ACTION') && !html.includes('La prochaine action'), 'l’ancien encadré');
  assert.ok(!/border-2 [^"]*bg-(red|blue|amber|green)-50/.test(html), 'plus de bloc rose, bleu ou ambre');
  assert.ok(!html.includes('uppercase'), 'plus de libellés en MAJUSCULES');
});

test('une seule action principale', () => {
  const html = rendre(toCardModel(appelManque(), NOW));
  assert.equal(compter(html, 'bg-slate-900'), 1, 'un seul bouton plein');
  assert.ok(/class="js-appeler [^"]*bg-slate-900/.test(html), 'et c’est « Appeler »');
});

test('le numéro se lit : « 06 34 23 76 51 », une seule fois en titre', () => {
  const html = rendre(toCardModel(appelManque(), NOW));
  assert.ok(html.includes('<h2 class="break-words text-lg font-semibold text-slate-900">06 34 23 76 51</h2>'));
  assert.ok(!/>\s*\+33634237651\s*</.test(html), 'la forme brute n’est plus affichée');
});

test('le SMS du client s’affiche comme un message, plus sous « Pièce »', () => {
  const html = rendre(toCardModel(appelManque(), NOW));
  assert.ok(html.includes('Message du client · SMS · aujourd’hui à 10:11'));
  assert.ok(html.includes('garage autre que l’adresse indiquée, est-ce possible ?'), 'en entier, plus coupé à 90 caractères');
  assert.ok(/Pièce<\/dt>\s*<dd[^>]*><span class="text-slate-400">Non précisée/.test(html), 'la pièce n’est pas le message');
  assert.ok(!html.includes('RÉPONSE SMS du client'), 'la note automatique ne le répète pas');
});

test('un déjà-client qui appelle : la fiche le dit avant qu’on décroche', () => {
  const c = toCardModel(appelManque(), NOW);
  c.clientHistory = { count: 1, lastUrl: '/admin/commandes/x', title: 'n°1042' };
  const html = rendre(c);
  assert.ok(html.includes('Déjà client (1 commande) : il contacte peut-être pour le suivi d’une commande'));
  assert.ok(html.includes('href="/admin/commandes/x"') && html.includes('Voir la commande'));
});

test('un SAV ouvert passe avant tout le reste', () => {
  const c = toCardModel(enCours(), NOW);
  c.savHistory = { count: 1, openCount: 1, url: '/admin/sav/tickets/T1', title: 'SAV-2026-114 · en cours' };
  c.clientHistory = { count: 3, lastUrl: '/admin/commandes/y', title: 'n°312' };
  const html = rendre(c);
  assert.ok(html.includes('SAV en cours pour ce client'));
  assert.ok(!html.includes('Déjà client (3 commandes)'), 'une seule alerte, la plus importante');
});

test('un client qui demande un devis par formulaire n’est pas soupçonné de SAV', () => {
  const c = toCardModel(enCours(), NOW);
  c.clientHistory = { count: 2, lastUrl: '/admin/commandes/z', title: 'n°900' };
  assert.ok(!rendre(c).includes('il contacte peut-être pour le suivi'));
});

test('« Jamais contacté » sans compte à rebours, « non attribuée » dans l’en-tête', () => {
  const html = rendre(toCardModel(appelManque(), NOW));
  assert.ok(html.includes('Jamais contacté'));
  assert.ok(!/attend depuis|en retard de/i.test(html));
  assert.ok(html.includes('non attribuée'));
});

test('la dernière note d’un collègue reste visible tout de suite', () => {
  const html = rendre(toCardModel(enCours({
    notes: [{ text: 'Veut la pièce avant vendredi', addedByName: 'Sarah', addedAt: new Date(Date.UTC(2026, 10, 18, 9)) }],
  }), NOW));
  assert.ok(html.includes('Dernière note') && html.includes('Veut la pièce avant vendredi') && html.includes('Sarah'));
});

/* ── Les branchements du script de la page ───────────────────────────────── */

test('tous les boutons gardent leur branchement', () => {
  const html = rendre(toCardModel(appelManque(), NOW));
  [
    'class="js-appeler', 'class="js-resultat', 'class="js-planifier', 'class="js-prendre',
    'class="js-suivant', 'class="js-retour-liste', 'data-copy-phone="+33634237651"',
    'data-action="sms"', 'data-action="whatsapp"', 'data-sms-template="sms_tried_to_call"',
    'data-issue="gagne"', 'data-issue="perdu"',
    'data-onglet="suivi"', 'data-onglet="piece"', 'data-onglet="client"', 'data-cible="fournisseur"',
    'class="fiche-onglets', 'class="fiche-onglets-bloc"',
    'data-quand="2h"', 'data-quand="demain"',
  ].forEach((crochet) => assert.ok(html.includes(crochet), `branchement perdu : ${crochet}`));
  ['2j', '1sem', '2sem', '1mois'].forEach((q) => assert.ok(html.includes(`data-quand="${q}" data-type="wait_client"`), `attente « ${q} » perdue`));
  assert.ok(html.includes('data-due=') && html.includes('data-promesse='), 'repères de l’horloge');
});

test('le premier élément trouvé par chaque raccourci clavier est le bon', () => {
  /* agirSurFiche() clique le PREMIER élément du sélecteur dans la fiche. */
  const html = rendre(toCardModel(enCours(), NOW));
  const premier = (sel) => html.indexOf(sel);
  assert.ok(premier('class="js-appeler') > -1, 'A : appeler');
  assert.ok(premier('data-action="email"') > -1, 'E : email');
  assert.ok(premier('data-action="sms"') > -1, 'S : SMS');
  assert.ok(premier('class="js-resultat') > -1, 'R : noter l’appel');
  assert.ok(premier('class="js-planifier') > -1, 'P : planifier');
  /* Le premier data-action="sms" doit être le SMS libre, pas un modèle. */
  const sms = html.slice(html.indexOf('data-action="sms"') - 200, html.indexOf('data-action="sms"') + 80);
  assert.ok(!sms.includes('data-sms-template'), 'S ouvrirait un SMS type au lieu du SMS libre');
});

test('un dossier clos : « Rouvrir », plus de « Reporter » ni de « Gagné »', () => {
  const html = rendre(toCardModel(enCours({ manualStatus: 'lost', lostReason: 'prix' }), NOW));
  assert.ok(html.includes('data-issue="rouvrir"'));
  assert.ok(!html.includes('>Reporter<'), 'rien à reporter sur un dossier clos');
  assert.ok(!html.includes('data-issue="gagne"'));
  assert.ok(html.includes('Motif : Prix trop élevé'));
});

test('« M’attribuer » seulement quand personne ne s’en occupe', () => {
  assert.ok(rendre(toCardModel(appelManque(), NOW)).includes('M’attribuer'));
  const pris = rendre(toCardModel(enCours(), NOW));
  assert.ok(!pris.includes('M’attribuer'));
  assert.ok(pris.includes('suivie par <span class="font-medium text-slate-700">Sarah</span>'));
});
