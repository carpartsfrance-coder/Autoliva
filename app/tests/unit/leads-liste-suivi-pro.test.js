/**
 * La liste de gauche et l'onglet « Suivi et notes », refaits le 20/11/2026
 * dans le style de la fiche (maquette validée par le patron).
 *
 * La ligne : un point de couleur au lieu de la barre, l'heure d'arrivée en
 * haut à droite, le début du SMS entre guillemets plutôt que présenté comme
 * une pièce, « non attribuée » écrit en clair.
 *
 * L'onglet : le champ de note EN HAUT, l'historique groupé par jour, le plus
 * récent d'abord, les messages du client mis en avant. Ce code tourne dans
 * le navigateur (cart-activity.ejs) : on l'extrait de la page et on l'exécute
 * ici, faute de quoi rien ne le vérifiait.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const vm = require('node:vm');
const ejs = require('ejs');

const { toCardModel } = require('../../src/controllers/abandonedCartAdminController');

const VUES = path.join(__dirname, '..', '..', 'src', 'views', 'admin');
const PAGE = fs.readFileSync(path.join(VUES, 'cart-activity.ejs'), 'utf8');
const NOW = new Date(Date.UTC(2026, 10, 19, 10, 15)); // jeudi 19/11/2026, 11 h 15 à Paris

function ligne(c) {
  return ejs.render("<%- include('./lead-ligne', { c: c }) %>", { c }, { filename: path.join(VUES, 'partials', 'appelant.ejs') });
}

/* ── L'onglet, extrait de la page et exécuté tel quel ───────────────────── */

function morceau(debut, fin) {
  const i = PAGE.indexOf(debut);
  const j = PAGE.indexOf(fin, i);
  assert.ok(i > -1 && j > i, `morceau introuvable : ${debut}`);
  return PAGE.slice(i, j);
}
const code = [
  morceau('  function escapeHtml(s) {', '\n  }\n') + '\n  }\n',
  morceau('  var ICONES_CANAL', '\n'),
  morceau('  /* ══ Onglet « Suivi et notes » ══', '\n\n  function ligneInfo('),
  'this.htmlSuivi = htmlSuivi;',
].join('\n');
const bac = {};
vm.runInNewContext(code, bac);
const { htmlSuivi } = bac;

const maintenant = Date.now();
const iso = (decalageMin) => new Date(maintenant - decalageMin * 60000).toISOString();
const IL_Y_A_3_JOURS = 3 * 24 * 60;

/* ── La ligne ────────────────────────────────────────────────────────────── */

test('la ligne : un point de couleur, l’heure d’arrivée en haut à droite', () => {
  const html = ligne(toCardModel({
    _id: '6afc7c9fd251d246e1609201', captureSource: 'landing_ponts', firstName: 'Marc', lastName: 'Dubois',
    phone: '0612345678', abandonedAt: new Date(Date.UTC(2026, 10, 19, 9, 37)), createdAt: new Date(Date.UTC(2026, 10, 19, 9, 37)),
    requested: { plate: 'BE251FQ', vehicle: 'Boîte de transfert reconditionné(e)' }, totalAmountCents: 145000,
  }, NOW));
  assert.ok(/class="h-2 w-2 [^"]*rounded-full bg-blue-500" data-role="barre"/.test(html), 'le point, recoloré par l’horloge');
  assert.ok(!html.includes('absolute left-0 top-2 bottom-2'), 'plus de barre sur le bord');
  assert.ok(html.includes('>10:37<'), 'l’heure d’arrivée');
  assert.ok(html.includes('non attribuée'));
  assert.ok(!html.includes('attend '), 'plus de compte à rebours');
});

test('la ligne d’un appel manqué cite le SMS au lieu d’en faire une pièce', () => {
  const sms = new Date(Date.UTC(2026, 10, 19, 9, 21));
  const texte = 'Bonjour, je viens d’effectuer une commande qui doit être livrée dans un garage autre que l’adresse indiquée';
  const html = ligne(toCardModel({
    _id: '6afc7c9fd251d246e1609202', captureSource: 'appel_manque', phone: '+33634237651',
    abandonedAt: new Date(Date.UTC(2026, 10, 19, 9, 19)), createdAt: new Date(Date.UTC(2026, 10, 19, 9, 19)),
    notes: [{ text: `RÉPONSE SMS du client : « ${texte} »`, addedByName: 'Ringover SMS', addedAt: sms }],
  }, NOW));
  assert.ok(html.includes('>06 34 23 76 51<'), 'le numéro lisible en titre');
  assert.ok(/« Bonjour, je viens d’effectuer une commande[^»]*… »/.test(html), 'le début du SMS, entre guillemets');
});

test('dans « Planifiés », le coin garde la date du rendez-vous', () => {
  const html = ligne(toCardModel({
    _id: '6afc7c9fd251d246e1609203', captureSource: 'devis', firstName: 'Patrick', phone: '0690123456',
    abandonedAt: new Date(Date.UTC(2026, 10, 10, 9)), createdAt: new Date(Date.UTC(2026, 10, 10, 9)),
    takenByName: 'Lucas', lastManualContactAt: new Date(Date.UTC(2026, 10, 18, 9)),
    nextAction: { type: 'wait_client', dueAt: new Date(Date.UTC(2026, 11, 10, 8, 30)) },
  }, NOW));
  assert.ok(/title="Rendez-vous prévu">jeu\. 10\/12</.test(html));
  assert.ok(html.includes('Lucas'));
});

test('la ligne sélectionnée passe en gris clair, le nom ne vire plus au rouge', () => {
  assert.ok(PAGE.includes('.lead-ligne[aria-selected="true"] { background: #f1f5f9; }'));
  assert.ok(!PAGE.includes('.lead-ligne-nom { color: #b91c1c; }'));
});

test('l’en-tête de chaque file tient en une ligne, l’explication en infobulle', () => {
  assert.ok(PAGE.includes('<%= g.court || g.hint %>'));
  assert.ok(PAGE.includes('title="<%= g.hint %>."'));
});

/* ── L'onglet « Suivi et notes » ─────────────────────────────────────────── */

const DOSSIER = {
  commResume: {},
  communications: [
    { canal: 'appel', entrant: true, atIso: iso(IL_Y_A_3_JOURS), at: 'lun.', corps: '' },
    { canal: 'sms', entrant: false, auto: true, atIso: iso(62), at: '10:20', corps: 'Bonjour, nous avons bien reçu votre appel.' },
    { canal: 'sms', entrant: true, atIso: iso(60), at: '10:21', corps: 'Est-ce que la livraison en garage est possible ? <b>merci</b>' },
  ],
  notes: [
    { text: 'RÉPONSE SMS du client : « Est-ce que la livraison en garage est possible ? »', addedByName: 'Ringover SMS', addedAtIso: iso(60), addedAt: '10:21' },
    { text: '📞 Appel — Client joint → Rappeler jeu. 26 nov.', addedByName: 'Lucas', addedAtIso: iso(30), addedAt: '10:50' },
  ],
};

test('le champ de note est en haut, avec tous ses branchements', () => {
  const html = htmlSuivi(DOSSIER);
  assert.ok(html.indexOf('data-role="note-form"') < html.indexOf('<section'), 'la note avant l’historique');
  ['data-role="note-form"', '<textarea name="text"', 'data-role="note-res"', 'type="submit"'].forEach((crochet) => {
    assert.ok(html.includes(crochet), `branchement perdu : ${crochet}`);
  });
  assert.ok(!html.includes('uppercase'), 'plus de « NOTE INTERNE » en majuscules');
});

test('l’historique est groupé par jour, le plus récent en haut', () => {
  const html = htmlSuivi(DOSSIER);
  const auj = html.indexOf('>Aujourd’hui<');
  const avant = html.indexOf('Appel du client');
  assert.ok(auj > -1, 'le jour d’aujourd’hui');
  assert.ok(html.indexOf('Lucas') < html.indexOf('SMS reçu du client'), 'la note de 10 h 50 avant le SMS de 10 h 21');
  assert.ok(html.indexOf('SMS reçu du client') < html.indexOf('SMS envoyé'), 'puis l’accusé automatique');
  assert.ok(avant > auj, 'l’appel d’il y a 3 jours dans un groupe plus bas');
  assert.equal((html.match(/<section/g) || []).length, 2, 'deux jours, deux groupes');
});

test('le message du client ressort, les envois automatiques restent discrets', () => {
  const html = htmlSuivi(DOSSIER);
  assert.ok(/bg-blue-50 text-blue-600[^]*?SMS reçu du client/.test(html), 'le SMS du client en bleu');
  assert.ok(html.includes('SMS envoyé <span class="font-normal text-slate-400">· automatique</span>'));
  assert.ok(html.includes('Lucas <span class="font-normal text-slate-400">· appel noté</span>'));
  assert.ok(html.includes('Appel — Client joint'), 'le texte de la note, sans le pictogramme');
  assert.ok(!html.includes('📞'));
});

test('la note automatique de Ringover n’est pas affichée en double', () => {
  assert.ok(!htmlSuivi(DOSSIER).includes('RÉPONSE SMS du client'));
  /* Vieux dossier sans message journalisé : c'est la seule trace, on la garde. */
  const vieux = htmlSuivi({ communications: [], notes: [DOSSIER.notes[0]] });
  assert.ok(vieux.includes('RÉPONSE SMS du client'));
});

test('un message non délivré reste signalé en rouge', () => {
  const html = htmlSuivi({
    commResume: { echecs: 1 },
    communications: [{ canal: 'sms', entrant: false, echec: true, motif: 'numéro injoignable', atIso: iso(5), at: '11:10', corps: 'Votre devis est prêt.' }],
    notes: [],
  });
  assert.ok(html.includes('1 message non délivré : le client ne les a jamais reçus.'));
  assert.ok(html.includes('Non délivré') && html.includes('bg-red-50 text-red-600'));
  assert.ok(html.includes('Motif : numéro injoignable'));
});

test('le texte d’un client est échappé, jamais interprété', () => {
  const html = htmlSuivi(DOSSIER);
  assert.ok(html.includes('&lt;b&gt;merci&lt;/b&gt;'));
  assert.ok(!html.includes('<b>merci</b>'));
});

test('dossier vide : on le dit, et on peut quand même écrire une note', () => {
  const html = htmlSuivi({ communications: [], notes: [] });
  assert.ok(html.includes('Rien pour l’instant : aucun message, aucune note.'));
  assert.ok(html.includes('data-role="note-form"'));
});
