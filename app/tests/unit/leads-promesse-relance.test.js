/**
 * « Il y a des leads qui remontent alors que je les ai déjà contactés. »
 *
 * Un dossier appelé repassait en ROUGE « En retard » deux jours ouvrés plus
 * tard, sans que personne ait choisi cette date : c'est la file qui la
 * déduisait du dernier contact. Le commercial lisait un reproche sur un
 * dossier qu'il avait fait, et comme ça arrivait des centaines de fois (168
 * « en retard » un mardi matin), il a cessé de lire le rouge.
 *
 * D'où la règle vérifiée ici : une ÉCHÉANCE N'EST PAS UNE PROMESSE.
 *   - rouge  : une heure qu'un humain a posée, ou la première réponse due
 *              dans l'heure (la promesse commerciale de la maison) ;
 *   - ambre  : l'échéance déduite du dernier contact — une suggestion.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const ejs = require('ejs');

const { computeWork, libelleUrgence, libelleUrgenceCourt } = require('../../src/services/leadWork');
const { toCardModel } = require('../../src/controllers/abandonedCartAdminController');
const { echeance } = require('../../src/controllers/leadWorkController');

const VUES = path.join(__dirname, '..', '..', 'src', 'views', 'admin', 'partials');
const PAGE = require('node:fs').readFileSync(
  path.join(__dirname, '..', '..', 'src', 'views', 'admin', 'cart-activity.ejs'), 'utf8');

const MARDI_10H = new Date('2026-11-17T09:00:00Z'); // mardi 17/11/2026, 10 h à Paris
const H = 3600000;

function rendre(fichier, c) {
  return ejs.render(`<%- include('./${fichier}', { c: c }) %>`, { c },
    { filename: path.join(VUES, 'appelant.ejs') });
}

/** Demande de devis reçue il y a une semaine, appelée vendredi dernier. */
function dejaAppele(extra = {}) {
  return Object.assign({
    _id: '6afc7c9fd251d246e160832c',
    captureSource: 'devis',
    firstName: 'Marc',
    lastName: 'Dubois',
    phone: '0612345678',
    abandonedAt: new Date('2026-11-10T08:00:00Z'),
    createdAt: new Date('2026-11-10T08:00:00Z'),
    takenByName: 'Lucas',
    requested: { plate: 'DJ767LC', vehicle: 'Mécatronique DSG7 DQ381' },
    totalAmountCents: 139000,
    /* Appelé jeudi 12/11 à 10 h : l'échéance déduite (+2 jours ouvrés)
       tombait lundi 16/11, elle est donc passée ce mardi matin. */
    communications: [{ canal: 'appel', sens: 'sortant', at: new Date('2026-11-12T09:00:00Z') }],
  }, extra);
}

/* ── La règle ────────────────────────────────────────────────────────────── */

test('un dossier appelé il y a 2 jours ouvrés n’est PAS « en retard »', () => {
  const w = computeWork(dejaAppele(), MARDI_10H);
  assert.equal(w.dueSource, 'suivi', 'l’échéance est déduite du dernier contact');
  assert.equal(w.overdue, true);
  assert.equal(w.promesse, false, 'personne n’a choisi cette heure');
  assert.equal(w.group, 'relances');
  assert.match(libelleUrgenceCourt(w, MARDI_10H), /^Relancer · \d+ j$/);
  assert.match(libelleUrgence(w, MARDI_10H), /^À relancer — sans nouvelles depuis \d+ jours ouvrés$/);
});

test('un rappel que le commercial a planifié, lui, est « en retard »', () => {
  const w = computeWork(dejaAppele({
    nextAction: { type: 'callback', dueAt: new Date(MARDI_10H.getTime() - 2 * H) },
  }), MARDI_10H);
  assert.equal(w.dueSource, 'planifiee');
  assert.equal(w.promesse, true);
  assert.equal(w.group, 'retard');
  /* 8 h → 10 h, mais l'agence ouvre à 9 h : une heure OUVRÉE de retard. */
  assert.equal(libelleUrgenceCourt(w, MARDI_10H), 'Retard 1 h');
});

test('une première réponse non tenue reste rouge : c’est la promesse de la maison', () => {
  /* Arrivée hier 17 h 50 : 10 min hier soir + 50 min ce matin → due 9 h 50. */
  const hier = new Date('2026-11-16T16:50:00Z');
  const w = computeWork({
    captureSource: 'devis', phone: '0612345678', abandonedAt: hier, createdAt: hier,
  }, MARDI_10H);
  assert.equal(w.dueSource, 'premiere_reponse');
  assert.equal(w.promesse, true);
  assert.equal(libelleUrgenceCourt(w, MARDI_10H), 'Retard 10 min');
});

test('un devis dû reste dans « Devis à préparer », en retard ou non', () => {
  /* Noyé dans « En retard », le travail à faire ne se distinguait plus d'une
     relance à passer : ce ne sont pas les mêmes gestes. */
  const w = computeWork(dejaAppele({ nextAction: { type: 'quote' } }), MARDI_10H);
  assert.equal(w.stage, 'devis_a_faire');
  assert.equal(w.overdue, true);
  assert.equal(w.group, 'devis');
  assert.match(libelleUrgenceCourt(w, MARDI_10H), /^Devis · \d+ j$/);
});

test('un vieux retard part toujours dans « Anciens dossiers », promesse ou pas', () => {
  const w = computeWork(dejaAppele({
    communications: [{ canal: 'appel', sens: 'sortant', at: new Date('2026-09-20T09:00:00Z') }],
  }), MARDI_10H);
  assert.equal(w.promesse, false);
  assert.equal(w.ancien, true);
  assert.equal(w.group, 'anciens');
});

test('le client qui a répondu passe devant, échéance ou pas', () => {
  const w = computeWork(dejaAppele({
    communications: [
      { canal: 'appel', sens: 'sortant', at: new Date('2026-11-13T09:00:00Z') },
      { canal: 'sms', sens: 'entrant', at: new Date('2026-11-17T08:30:00Z'), corps: 'Toujours dispo ?' },
    ],
  }), MARDI_10H);
  assert.equal(w.group, 'repondu');
});

/* ── Ce que la ligne en dit ──────────────────────────────────────────────── */

test('la ligne d’une relance est ambre, pas rouge', () => {
  const c = toCardModel(dejaAppele(), MARDI_10H);
  const html = rendre('lead-ligne', c);
  /* C'est la barre qui porte la couleur : les libellés de compte à rebours
     ont été retirés le 20/11/2026. */
  assert.ok(html.includes('bg-amber-400'), 'la barre d’une relance est ambre');
  assert.ok(!html.includes('bg-red-500'), 'aucun rouge sur une relance que personne n’a promise');
  assert.ok(html.includes('data-promesse="0"'), 'l’horloge du navigateur doit savoir que ce n’est pas une promesse');

  const promis = toCardModel(dejaAppele({
    nextAction: { type: 'callback', dueAt: new Date(MARDI_10H.getTime() - 2 * H) },
  }), MARDI_10H);
  const rouge = rendre('lead-ligne', promis);
  assert.ok(rouge.includes('bg-red-500'), 'une heure promise et passée, elle, reste rouge');
  assert.ok(rouge.includes('data-promesse="1"'));
});

test('la ligne dit qu’on a DÉJÀ contacté ce client, et depuis quand il attend', () => {
  /* Sans ça, un dossier appelé trois fois ressemblait mot pour mot à une
     demande fraîche — d'où « il remonte alors que je l'ai fait ». */
  const c = toCardModel(dejaAppele({
    communications: [
      { canal: 'appel', sens: 'sortant', at: new Date('2026-11-11T09:00:00Z') },
      { canal: 'sms', sens: 'sortant', at: new Date('2026-11-13T09:00:00Z') },
    ],
  }), MARDI_10H);
  assert.equal(c.suivi.nombre, 2);
  const html = rendre('lead-ligne', c);
  assert.ok(html.includes('contacté 2×'), `« contacté 2× » absent de : ${html}`);
  assert.ok(!html.includes('attend '), '« attend » ne concerne que les demandes que personne n’a prises');
});

test('une demande que personne n’a prise dit « attend », pas « contacté »', () => {
  const c = toCardModel({
    _id: '6afc7c9fd251d246e160832c', captureSource: 'devis', phone: '0612345678',
    abandonedAt: new Date('2026-11-17T08:12:00Z'), createdAt: new Date('2026-11-17T08:12:00Z'),
  }, MARDI_10H);
  assert.equal(c.suivi, null);
  const html = rendre('lead-ligne', c);
  assert.ok(html.includes('attend 48 min'));
  assert.ok(!html.includes('contacté'));
});

test('un même geste inscrit deux fois ne compte qu’une fois', () => {
  /* `lastManualContactAt` et `manualStatusAt` portent la même minute : deux
     appels s'affichaient « contacté 4× ». */
  const w = computeWork(dejaAppele({
    communications: [],
    manualStatus: 'contacted',
    manualStatusAt: new Date('2026-11-13T09:00:00Z'),
    lastManualContactAt: new Date('2026-11-13T09:00:00Z'),
  }), MARDI_10H);
  assert.equal(w.nombreHumain, 1);
});

/* ── « En attente du client » ────────────────────────────────────────────── */

test('la fiche propose de mettre le dossier en attente du client', () => {
  const html = rendre('lead-fiche', toCardModel(dejaAppele(), MARDI_10H));
  assert.ok(html.includes('En attente du client'));
  assert.ok(html.includes('data-quand="1mois"'), 'il faut pouvoir dire « pas avant un mois »');
  assert.ok(html.includes('data-type="wait_client"'));
});

test('les longues attentes existent vraiment côté serveur', () => {
  /* Sans elles, le dossier d'un client qui dit « rappelez-moi en janvier »
     repassait dans la file tous les deux jours ouvrés jusqu'à la clôture. */
  ['2j', '1sem', '2sem', '1mois'].forEach((cle) => {
    const d = echeance(cle, MARDI_10H);
    assert.ok(d instanceof Date, `« ${cle} » doit donner une date`);
    assert.ok(d > MARDI_10H, `« ${cle} » doit être dans le futur`);
    assert.equal(d.toLocaleTimeString('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' }),
      '09:30', `« ${cle} » doit tomber à 9 h 30, à l'ouverture`);
  });
  assert.ok(echeance('1mois', MARDI_10H) > echeance('2sem', MARDI_10H));
  assert.ok(echeance('2sem', MARDI_10H) > echeance('1sem', MARDI_10H));
  assert.ok(echeance('1sem', MARDI_10H) > echeance('2j', MARDI_10H));
  /* « Un mois » doit vraiment être un mois : 21 jours OUVRÉS, donc une
     trentaine de jours calendaires, week-ends et fériés compris. */
  const mois = (echeance('1mois', MARDI_10H) - MARDI_10H) / 86400000;
  assert.ok(mois > 25 && mois < 40, `un mois vaut ${Math.round(mois)} jours calendaires`);
  assert.equal(echeance('jamais', MARDI_10H), null);
});

/* ── La page : des onglets, plus une pile de huit sections ───────────────── */

test('les files sont des onglets horizontaux, pas des sections empilées', () => {
  /* Empilés, huit groupes faisaient une colonne interminable où « Nouvelles
     demandes » se retrouvait sous 168 lignes rouges. */
  assert.ok(PAGE.includes('id="leads-onglets"'), 'la barre d’onglets a disparu');
  assert.ok(PAGE.includes('class="lead-panneau hidden"'), 'un panneau par file, un seul visible');
  assert.ok(!PAGE.includes('class="lead-groupe"'), 'les anciennes sections repliables doivent être parties');
  assert.ok(PAGE.includes('.lead-panneau:not(.hidden) .lead-ligne'),
    '« J » et « Tout cocher » ne doivent agir que sur l’onglet affiché');
});

test('le bandeau compte les promesses et les relances séparément', () => {
  assert.ok(PAGE.includes('b.aRelancer'), 'le bandeau doit montrer les relances à part');
  assert.ok(PAGE.includes('b.enRetard %></strong> en retard'), 'le compteur rouge ne compte plus que les promesses');
  assert.ok(!PAGE.includes('enRetardRecents'), 'ancien compteur, remplacé');
});

test('le filtre « Jamais contactés » existe, sans sortir personne de la file', () => {
  assert.ok(PAGE.includes('name="suivi"'));
  assert.ok(PAGE.includes('>Jamais contactés</option>'));
  assert.ok(PAGE.includes('>Déjà contactés</option>'));
});
