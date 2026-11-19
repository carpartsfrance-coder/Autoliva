/**
 * « Je voudrais pouvoir trier les leads par date. » (19/11/2026)
 *
 * Seul « Non traités » avait une bascule récentes / anciennes. Chaque onglet
 * a maintenant un menu de tri : son ordre de travail (par défaut), ou la date
 * de la demande, des plus récentes ou des plus anciennes.
 *
 * Le choix vaut pour UN onglet : « plus anciennes d'abord » pris dans
 * « À relancer » ne doit pas retourner « Non traités », où le patron veut les
 * demandes fraîches en haut. Il voyage dans l'adresse
 * (« tri=relances-ancien.devis-recent »), et l'ancienne adresse « tri=ancien »
 * continue d'ouvrir « Non traités » par les plus anciennes.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');
const ejs = require('ejs');

const { computeWork } = require('../../src/services/leadWork');
const { ordonner, lireTri, ecrireTri } = require('../../src/services/leadWorkQueue');

const VUES = path.join(__dirname, '..', '..', 'src', 'views', 'admin');
const PAGE = fs.readFileSync(path.join(VUES, 'cart-activity.ejs'), 'utf8');
const CONTROLEUR = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'controllers', 'abandonedCartAdminController.js'), 'utf8');

/** Jeudi 19/11/2026, heures de Paris (UTC+1). */
const jour = (j, heure, min = 0) => new Date(Date.UTC(2026, 10, j, heure - 1, min));
const MAINTENANT = jour(19, 15);

/**
 * Dossier déjà appelé, avec un rappel planifié : la demande est reçue le
 * jour `recu`, le rappel tombe à `due`. Les deux dates ne vont volontairement
 * pas dans le même ordre, pour qu'on voie lequel des deux trie.
 */
function rappel(id, recu, due) {
  const lead = {
    captureSource: 'devis', phone: '0612345678', abandonedAt: recu, createdAt: recu,
    lastManualContactAt: recu, nextAction: { type: 'callback', dueAt: due },
  };
  return { id, work: computeWork(lead, MAINTENANT) };
}

function pile() {
  return [
    rappel('recue-lundi', jour(16, 10), jour(19, 16)),
    rappel('recue-mercredi', jour(18, 10), jour(19, 15, 30)),
    rappel('recue-mardi', jour(17, 10), jour(19, 17)),
  ];
}

/* ── L'ordre ─────────────────────────────────────────────────────────────── */

test('par défaut, un onglet garde son ordre de travail (l’échéance)', () => {
  const ids = ordonner(pile(), 'rappels', '').map((x) => x.id);
  assert.deepEqual(ids, ['recue-mercredi', 'recue-lundi', 'recue-mardi']);
});

test('« Plus récentes » range par date de la demande, la dernière en haut', () => {
  const ids = ordonner(pile(), 'rappels', 'recent').map((x) => x.id);
  assert.deepEqual(ids, ['recue-mercredi', 'recue-mardi', 'recue-lundi']);
});

test('« Plus anciennes » repart de la première demande', () => {
  const ids = ordonner(pile(), 'rappels', 'ancien').map((x) => x.id);
  assert.deepEqual(ids, ['recue-lundi', 'recue-mardi', 'recue-mercredi']);
});

test('une demande sans date de réception passe en bas, dans les deux sens', () => {
  const sansDate = { id: 'sans-date', work: Object.assign({}, pile()[0].work, { receivedAt: null }) };
  const items = pile().concat(sansDate);
  assert.equal(ordonner(items, 'relances', 'recent').slice(-1)[0].id, 'sans-date');
  assert.equal(ordonner(items, 'relances', 'ancien').slice(-1)[0].id, 'sans-date');
});

test('un ordre inconnu retombe sur l’ordre de travail', () => {
  assert.deepEqual(ordonner(pile(), 'rappels', 'n_importe_quoi').map((x) => x.id),
    ordonner(pile(), 'rappels', '').map((x) => x.id));
});

/* ── L'adresse ───────────────────────────────────────────────────────────── */

test('chaque onglet garde son propre tri dans l’adresse', () => {
  assert.deepEqual(lireTri('relances-ancien.devis-recent'), { relances: 'ancien', devis: 'recent' });
  /* Écrit dans l'ordre des onglets : une même page, une même adresse. */
  assert.equal(ecrireTri({ devis: 'recent', relances: 'ancien' }), 'devis-recent.relances-ancien');
  assert.equal(ecrireTri(lireTri('plus_tard-ancien')), 'plus_tard-ancien', 'les clés avec un tiret bas');
});

test('l’ancienne adresse « tri=ancien » ouvre toujours « Non traités » par les plus anciennes', () => {
  assert.deepEqual(lireTri('ancien'), { non_traites: 'ancien' });
});

test('l’adresse ne garde ni l’ordre par défaut ni les valeurs inconnues', () => {
  /* « Non traités » est déjà rangé des plus récentes aux plus anciennes. */
  assert.deepEqual(lireTri('non_traites-recent'), {});
  assert.deepEqual(lireTri('pirate-ancien.relances-hier.-ancien.relances'), {});
  assert.deepEqual(lireTri(['relances-ancien']), {}, 'un paramètre répété n’est pas une chaîne');
  assert.equal(ecrireTri({}), '');
  assert.equal(ecrireTri({ non_traites: 'recent', relances: 'demain' }), '');
});

test('le contrôleur lit et remet au propre le tri de l’adresse', () => {
  assert.ok(CONTROLEUR.includes('const triParOnglet = lireTri(req.query.tri);'));
  assert.ok(CONTROLEUR.includes('const tri = ecrireTri(triParOnglet);'));
  assert.ok(CONTROLEUR.includes('tri: triParOnglet,'), 'la file reçoit le tri de chaque onglet');
});

/* ── La page ─────────────────────────────────────────────────────────────── */

test('chaque onglet porte un menu de tri, pas seulement « Non traités »', () => {
  const debut = PAGE.indexOf('<details class="lead-menu relative shrink-0">');
  assert.ok(debut > 0, 'le menu de tri est dans l’en-tête du groupe');
  const enTete = PAGE.slice(PAGE.lastIndexOf('groupe-entete', debut), debut);
  assert.ok(!/if \(g\.key === 'non_traites'\) \{ %>\s*$/.test(enTete), 'le menu ne doit plus dépendre de l’onglet');
  ['Le plus urgent d’abord', 'Demandes les plus récentes', 'Demandes les plus anciennes'].forEach((t) => {
    assert.ok(PAGE.includes(t), `le choix « ${t} »`);
  });
  assert.ok(PAGE.includes("#groupe-<%= g.key %>"), 'trier rouvre le même onglet');
  assert.ok(!PAGE.includes('Plus anciennes ↑'), 'l’ancienne bascule est partie');
});

test('la ligne montre la date qui fait l’ordre', () => {
  /* Dans « Planifiés », le coin montre le rendez-vous ; trié par date de la
     demande, il montre la date de la demande. */
  const c = {
    id: 'x', fullName: 'Jean Martin', work: { group: 'plus_tard', stage: 'contacte', intent: 'opportunity' },
    urgenceCourte: 'lun. 23/11', recuCourt: '16/11', recuExact: 'lundi 16 novembre à 10:00', demande: {},
  };
  const rendre = (locals) => ejs.render(
    fs.readFileSync(path.join(VUES, 'partials', 'lead-ligne.ejs'), 'utf8'), locals, { filename: path.join(VUES, 'partials', 'lead-ligne.ejs') });
  assert.ok(rendre({ c }).includes('title="Rendez-vous prévu">lun. 23/11<'), 'par défaut : le rendez-vous');
  assert.ok(rendre({ c, triDate: true }).includes('title="Demande reçue le lundi 16 novembre à 10:00">16/11<'), 'trié par date : la demande');
});
