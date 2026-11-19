/**
 * « Mais on peut pas trier hier, aujourd'hui, le 28 novembre etc ? »
 * (19/11/2026)
 *
 * Triée par date, la liste n'était qu'une suite d'heures : il fallait lire
 * chaque ligne pour voir où commençait la veille. Elle est maintenant coupée
 * par jour — « Aujourd’hui · 3 », « Hier · 2 », « Samedi 28 novembre · 1 » —
 * dès qu'elle suit une date :
 *  - « Non traités » (toujours rangé par date de la demande) ;
 *  - tout onglet trié par « plus récentes » ou « plus anciennes » ;
 *  - « Planifiés », par jour du rendez-vous.
 * Rangée par urgence, une liste n'a pas d'ordre de jours : pas d'intertitre.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const ejs = require('ejs');

const { jourDe, heureSeule } = require('../../src/services/leadHeure');
const { parJourDe, compterJours } = require('../../src/services/leadWorkQueue');

const VUES = path.join(__dirname, '..', '..', 'src', 'views', 'admin');
const FICHIER_PAGE = path.join(VUES, 'cart-activity.ejs');
const PAGE = fs.readFileSync(FICHIER_PAGE, 'utf8');

/** Jeudi 19/11/2026 à 15 h, heure de Paris (UTC+1). */
const paris = (mois, jour, heure, min = 0, annee = 2026) => new Date(Date.UTC(annee, mois - 1, jour, heure - 1, min));
const MAINTENANT = paris(11, 19, 15);

/* ── Les libellés ────────────────────────────────────────────────────────── */

test('aujourd’hui, hier, demain, puis la date en toutes lettres', () => {
  assert.equal(jourDe(paris(11, 19, 9), MAINTENANT).libelle, 'Aujourd’hui');
  assert.equal(jourDe(paris(11, 18, 17), MAINTENANT).libelle, 'Hier');
  assert.equal(jourDe(paris(11, 20, 9, 30), MAINTENANT).libelle, 'Demain');
  assert.equal(jourDe(paris(11, 28, 10), MAINTENANT).libelle, 'Samedi 28 novembre');
  assert.equal(jourDe(paris(11, 16, 10), MAINTENANT).libelle, 'Lundi 16 novembre');
});

test('une autre année se lit avec son année', () => {
  assert.equal(jourDe(paris(11, 18, 10, 0, 2025), MAINTENANT).libelle, 'Mardi 18 novembre 2025');
});

test('le jour est celui de Paris, pas celui du serveur', () => {
  /* 23 h 30 UTC le 18 = 0 h 30 à Paris le 19 : c'est aujourd'hui. */
  const nuit = new Date(Date.UTC(2026, 10, 18, 23, 30));
  assert.deepEqual(jourDe(nuit, MAINTENANT), { cle: '2026-11-19', libelle: 'Aujourd’hui' });
  assert.equal(heureSeule(nuit), '00:30');
});

test('sans date, pas de jour', () => {
  assert.equal(jourDe(null, MAINTENANT), null);
  assert.equal(heureSeule(undefined), '');
});

/* ── Quand couper par jour ───────────────────────────────────────────────── */

test('la liste se coupe par jour seulement quand elle suit une date', () => {
  assert.equal(parJourDe('non_traites', ''), 'demande', '« Non traités » est toujours rangé par date');
  assert.equal(parJourDe('non_traites', 'ancien'), 'demande');
  assert.equal(parJourDe('relances', ''), '', 'rangée par urgence : pas d’intertitre');
  assert.equal(parJourDe('retard', ''), '');
  assert.equal(parJourDe('relances', 'ancien'), 'demande');
  assert.equal(parJourDe('devis', 'recent'), 'demande');
  assert.equal(parJourDe('plus_tard', ''), 'rdv', '« Planifiés » : le jour du rendez-vous');
  assert.equal(parJourDe('plus_tard', 'recent'), 'demande', 'trié par date de la demande, c’est elle qui compte');
});

test('le compte du jour porte sur tout l’onglet, pas sur la page affichée', () => {
  const items = [];
  for (let i = 0; i < 20; i += 1) items.push({ work: { receivedAt: paris(11, 18, 9, i), dueAt: paris(11, 28, 10) } });
  items.push({ work: { receivedAt: paris(11, 19, 9), dueAt: null } });
  items.push({ work: { receivedAt: null } });
  assert.deepEqual(compterJours(items, 'demande'), { '2026-11-18': 20, '2026-11-19': 1, '': 1 });
  assert.deepEqual(compterJours(items, 'rdv'), { '2026-11-28': 20, '': 2 });
  assert.deepEqual(compterJours(items, ''), {});
});

/* ── La page ─────────────────────────────────────────────────────────────── */

/** Le bloc <ul> d'un onglet, tel qu'il est dans la page, rendu pour de vrai. */
function rendreListe(g) {
  const debut = PAGE.indexOf('<% var jourPrecedent = null; %>');
  const fin = PAGE.indexOf('</ul>', debut);
  assert.ok(debut > 0 && fin > debut, 'le bloc de la liste doit être trouvé');
  return ejs.render(PAGE.slice(debut, fin), { g }, { filename: FICHIER_PAGE });
}

function carte(id, recu, rdv) {
  return {
    id, fullName: id, demande: {}, work: { group: rdv ? 'plus_tard' : 'non_traites', stage: 'nouveau', intent: 'opportunity' },
    recuCourt: 'x', recuExact: 'x', recuJour: jourDe(recu, MAINTENANT), recuHeure: heureSeule(recu),
    urgenceCourte: rdv ? 'sam. 28/11' : '', prevu: rdv ? 'samedi 28 nov. à 10:00' : '',
    prevuJour: rdv ? jourDe(rdv, MAINTENANT) : null, prevuHeure: rdv ? heureSeule(rdv) : '',
  };
}

test('« Non traités » : un intertitre par jour, avec le nombre de demandes', () => {
  const html = rendreListe({
    key: 'non_traites', tri: '', parJour: 'demande', jours: { '2026-11-19': 2, '2026-11-18': 7 },
    items: [carte('a', paris(11, 19, 14, 5)), carte('b', paris(11, 19, 9)), carte('c', paris(11, 18, 17, 40))],
  });
  const titres = [...html.matchAll(/class="lead-jour[^"]*" data-jour="([^"]*)">\s*([^<]+)<span[^>]*>· (\d+)/g)]
    .map((m) => [m[1], m[2].trim(), m[3]]);
  assert.deepEqual(titres, [['2026-11-19', 'Aujourd’hui', '2'], ['2026-11-18', 'Hier', '7']]);
  /* Sous l'intertitre, la ligne ne garde que l'heure. */
  assert.ok(html.includes('>14:05<') && html.includes('>17:40<'), 'l’heure seule dans le coin');
});

test('« Planifiés » : coupé par jour du rendez-vous, l’heure du rendez-vous au coin', () => {
  const html = rendreListe({
    key: 'plus_tard', tri: '', parJour: 'rdv', jours: { '2026-11-28': 1 },
    items: [carte('d', paris(11, 10, 9), paris(11, 28, 10))],
  });
  assert.ok(/data-jour="2026-11-28">\s*Samedi 28 novembre/.test(html), 'le jour du rendez-vous');
  assert.ok(html.includes('title="Rendez-vous prévu samedi 28 nov. à 10:00">10:00<'));
});

test('rangée par urgence, la liste n’a pas d’intertitre', () => {
  const html = rendreListe({ key: 'relances', tri: '', parJour: '', jours: {}, items: [carte('e', paris(11, 16, 9))] });
  assert.ok(!html.includes('lead-jour'));
  assert.ok(html.includes('>x<'), 'le coin garde la date courte');
});
