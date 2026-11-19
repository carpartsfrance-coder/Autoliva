/**
 * « Je ne veux plus que tu écrives "en retard de 9 minutes", "avant
 *  2h00", etc. : ça pollue. »
 *
 * Ces libellés s'affichaient en haut à droite de CHAQUE ligne de la liste et
 * à côté du titre de la fiche, et l'horloge du navigateur les réécrivait
 * toutes les 30 secondes. La couleur de la barre (et de l'encadré de la
 * fiche) dit déjà l'urgence ; l'onglet dit déjà de quelle pile il s'agit.
 *
 * Une seule indication horaire reste : l'heure d'un rendez-vous que
 * quelqu'un a FIXÉ et qui n'est pas encore passé. C'est un fait, pas une
 * alarme — et dans « Planifiés », c'est précisément ce qu'on vient chercher.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const ejs = require('ejs');

const { toCardModel } = require('../../src/controllers/abandonedCartAdminController');
const { prevuLe } = require('../../src/services/leadHeure');

const VUES = path.join(__dirname, '..', '..', 'src', 'views', 'admin', 'partials');
const PAGE = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'views', 'admin', 'cart-activity.ejs'), 'utf8');
const HORLOGE = fs.readFileSync(path.join(__dirname, '..', '..', 'public', 'js', 'leads-horloge.js'), 'utf8');

/** Jeudi 19/11/2026, 10 h à Paris (UTC+1). */
const h = (heure, min = 0, jour = 19) => new Date(Date.UTC(2026, 10, jour, heure - 1, min));
const MAINTENANT = h(10);

function rendre(fichier, c) {
  return ejs.render(`<%- include('./${fichier}', { c: c }) %>`, { c },
    { filename: path.join(VUES, 'appelant.ejs') });
}

function dossier(extra = {}) {
  return Object.assign({
    _id: '6afc7c9fd251d246e160832c', captureSource: 'devis', firstName: 'Karim', lastName: 'Belkacem',
    phone: '0612345678', abandonedAt: h(9, 5), createdAt: h(9, 5),
  }, extra);
}

/* Tous les cas qui portaient un compte à rebours, groupe par groupe. */
const CAS = {
  'demande fraîche (« Avant 10:05 »)': dossier({ abandonedAt: h(9, 40), createdAt: h(9, 40) }),
  'demande hors délai (« Retard 1 h »)': dossier({ abandonedAt: h(17, 30, 18), createdAt: h(17, 30, 18) }),
  'rendez-vous promis et raté (« En retard de 1 h »)': dossier({
    takenByName: 'Lucas', lastManualContactAt: h(15, 0, 18),
    nextAction: { type: 'callback', dueAt: h(9) },
  }),
  'relance proposée (« Relancer · 3 j »)': dossier({
    takenByName: 'Lucas', abandonedAt: h(9, 0, 12), createdAt: h(9, 0, 12),
    communications: [{ canal: 'appel', sens: 'sortant', at: h(10, 0, 13) }],
  }),
  'devis en retard (« Devis · 2 j »)': dossier({
    takenByName: 'Sarah', lastManualContactAt: h(10, 0, 16), nextAction: { type: 'quote' },
  }),
  'rappel prévu cet après-midi (« 14:00 »)': dossier({
    takenByName: 'Lucas', lastManualContactAt: h(9, 30),
    nextAction: { type: 'callback', dueAt: h(14) },
  }),
};

/* Les formes que prenaient ces libellés. */
const COURTS = [/Retard \d/, /Avant \d\d:\d\d/, /Relancer · \d/, /Devis · \d/];
const LONGS = [/En retard de \d/, /À rappeler avant \d/, /À relancer — /, /Devis à préparer — /, /échéance dépassée/];

Object.keys(CAS).forEach((nom) => {
  test(`ligne et fiche sans compte à rebours : ${nom}`, () => {
    const c = toCardModel(CAS[nom], MAINTENANT);
    assert.ok(c.work.group, 'le dossier est bien dans la file');
    const ligne = rendre('lead-ligne', c);
    COURTS.forEach((re) => assert.ok(!re.test(ligne), `la ligne affiche encore ${re} (groupe ${c.work.group})`));
    const fiche = rendre('lead-fiche', c);
    LONGS.forEach((re) => assert.ok(!re.test(fiche), `la fiche affiche encore ${re} (groupe ${c.work.group})`));
  });
});

test('l’urgence reste lisible : c’est la barre qui porte la couleur', () => {
  const rouge = rendre('lead-ligne', toCardModel(CAS['rendez-vous promis et raté (« En retard de 1 h »)'], MAINTENANT));
  const ambre = rendre('lead-ligne', toCardModel(CAS['relance proposée (« Relancer · 3 j »)'], MAINTENANT));
  const bleu = rendre('lead-ligne', toCardModel(CAS['demande fraîche (« Avant 10:05 »)'], MAINTENANT));
  assert.ok(rouge.includes('bg-red-500'), 'rendez-vous promis et raté : rouge');
  assert.ok(ambre.includes('bg-amber-400'), 'relance proposée : ambre');
  assert.ok(bleu.includes('bg-blue-500'), 'demande encore dans l’heure : bleu');
});

/* ── Ce qui reste : l'heure d'un rendez-vous fixé ─────────────────────────── */

test('la fiche dit quand est le rendez-vous fixé, sans « avant »', () => {
  const c = toCardModel(CAS['rappel prévu cet après-midi (« 14:00 »)'], MAINTENANT);
  assert.equal(c.prevu, 'aujourd’hui à 14:00');
  assert.ok(rendre('lead-fiche', c).includes('Prévu aujourd’hui à 14:00'));
});

test('un rendez-vous posé sur une demande jamais appelée ne dit pas « avant » non plus', () => {
  /* Le piège : l'ancien libellé disait « À rappeler avant 14:00 » pour une
     demande neuve, même quand c'est un humain qui avait posé l'heure. */
  const c = toCardModel(dossier({ nextAction: { type: 'callback', dueAt: h(14) } }), MAINTENANT);
  assert.equal(c.work.stage, 'nouveau');
  const fiche = rendre('lead-fiche', c);
  assert.ok(fiche.includes('Prévu aujourd’hui à 14:00'));
  assert.ok(!/avant 14:00/i.test(fiche));
});

test('une heure passée ne s’affiche plus : la couleur suffit', () => {
  const c = toCardModel(CAS['rendez-vous promis et raté (« En retard de 1 h »)'], MAINTENANT);
  assert.equal(c.prevu, '');
  assert.ok(!rendre('lead-fiche', c).includes('Prévu '));
});

test('une échéance que personne n’a fixée ne s’affiche pas', () => {
  /* Relance déduite par la file : pas un rendez-vous, donc pas d'heure. */
  const c = toCardModel(CAS['relance proposée (« Relancer · 3 j »)'], MAINTENANT);
  assert.equal(c.prevu, '');
});

test('dans « Planifiés », la ligne garde la date du rendez-vous', () => {
  const c = toCardModel(dossier({
    takenByName: 'Lucas', lastManualContactAt: h(9, 30),
    nextAction: { type: 'wait_client', dueAt: h(9, 30, 26) },
  }), MAINTENANT);
  assert.equal(c.work.group, 'plus_tard');
  const ligne = rendre('lead-ligne', c);
  assert.ok(/jeu\. 26\/11/.test(ligne), `la date manque : ${c.urgenceCourte}`);
  assert.ok(rendre('lead-fiche', c).includes('Prévu jeudi 26 nov. à 09:30'));
});

test('« prévu le » dit une date, jamais un délai', () => {
  assert.equal(prevuLe(h(14), MAINTENANT), 'aujourd’hui à 14:00');
  assert.equal(prevuLe(h(9, 30, 20), MAINTENANT), 'demain à 09:30');
  assert.equal(prevuLe(h(9, 30, 26), MAINTENANT), 'jeudi 26 nov. à 09:30');
  assert.equal(prevuLe(new Date(Date.UTC(2027, 0, 6, 8, 30)), MAINTENANT), '06/01/2027 à 09:30');
});

/* ── L'horloge du navigateur ne les remet pas ─────────────────────────────── */

test('l’horloge ne réécrit plus aucun libellé de retard', () => {
  /* Sans ça, retirés du rendu, ils réapparaissaient au bout de 30 secondes. */
  ['retardCourt', 'retardLong', 'relanceCourt', 'relanceLong'].forEach((f) => {
    assert.ok(!HORLOGE.includes(`function ${f}`), `${f} est encore dans leads-horloge.js`);
    assert.ok(!PAGE.includes(`H.${f}(`), `la page appelle encore H.${f}`);
  });
  assert.ok(!PAGE.includes('[data-role="urgence"]'), 'la page cherche encore le libellé à réécrire');
});
