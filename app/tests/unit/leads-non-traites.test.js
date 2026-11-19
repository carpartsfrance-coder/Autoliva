/**
 * « Au lieu de différencier "Nouvelles demandes" et "En retard", j'aimerais
 *  qu'on mette uniquement "Non traités", classé du plus récent au plus
 *  ancien, avec une petite option pour trier par ancien et nouveau. »
 *
 * Les deux groupes séparaient deux piles que le commercial traite du même
 * geste : décrocher le téléphone. Une demande de 9 h 05 et une de 8 h 40 ne
 * demandent pas un travail différent — la seconde a juste passé l'heure.
 *
 * Une précision que le nom impose : « En retard » contenait AUSSI des
 * dossiers déjà appelés, dont le rappel promis était passé. Ceux-là ne
 * peuvent pas vivre dans un onglet qui s'appelle « Non traités » ; ils
 * restent dans « En retard », qui redevient ce que son nom dit.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const { computeWork, GROUPES } = require('../../src/services/leadWork');
const { ordonner } = require('../../src/services/leadWorkQueue');

const PAGE = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'views', 'admin', 'cart-activity.ejs'), 'utf8');

/** Jeudi 19/11/2026, heures de Paris (UTC+1). */
const h = (heure, min = 0) => new Date(Date.UTC(2026, 10, 19, heure - 1, min));
const MAINTENANT = h(15);

/** Demande jamais appelée ni écrite, reçue à l'heure dite. */
function jamaisPrise(recu, extra = {}) {
  return Object.assign({
    captureSource: 'devis', phone: '0612345678', abandonedAt: recu, createdAt: recu,
  }, extra);
}

test('tout ce que personne n’a touché tient dans une seule pile', () => {
  /* Dans l'heure, hors de l'heure, ou vieille de trois jours : même geste. */
  const fraiche = computeWork(jamaisPrise(h(14, 40)), MAINTENANT);
  const passeeDeLHeure = computeWork(jamaisPrise(h(9)), MAINTENANT);
  const avantHier = computeWork(jamaisPrise(new Date(Date.UTC(2026, 10, 17, 8))), MAINTENANT);

  [fraiche, passeeDeLHeure, avantHier].forEach((w) => {
    assert.equal(w.group, 'non_traites', `groupe ${w.group}`);
    assert.equal(w.firstHumanAt, null);
  });
  /* La promesse de l'heure n'est pas abandonnée pour autant : elle se lit
     sur la LIGNE (rouge dès que l'heure est passée), plus dans l'onglet. */
  assert.equal(fraiche.overdue, false);
  assert.equal(passeeDeLHeure.overdue, true);
  assert.equal(passeeDeLHeure.promesse, true);
});

test('un dossier DÉJÀ appelé ne tombe jamais dans « Non traités »', () => {
  /* Le rappel de 13 h n'a pas été passé : c'est un rendez-vous raté, pas une
     demande qui attend. Un onglet « Non traités » ne peut pas le contenir. */
  const w = computeWork(jamaisPrise(h(9), {
    lastManualContactAt: h(10), takenByName: 'Lucas',
    nextAction: { type: 'callback', dueAt: h(13) },
  }), MAINTENANT);
  assert.equal(w.group, 'retard');
  assert.ok(w.firstHumanAt, 'quelqu’un s’en est bien occupé');
  assert.equal(w.promesse, true);
});

test('les vieux dossiers gardent leur garde-fou', () => {
  /* Sans lui, 45 jours d'arriéré noieraient la file du jour. */
  const w = computeWork(jamaisPrise(new Date(Date.UTC(2026, 9, 20, 8))), MAINTENANT);
  assert.equal(w.ancien, true);
  assert.equal(w.group, 'anciens');
});

test('« Nouvelles demandes » n’existe plus, « Non traités » ouvre la file', () => {
  const cles = GROUPES.map((g) => g.key);
  assert.ok(!cles.includes('nouveaux'), 'l’ancien groupe doit avoir disparu');
  assert.deepEqual(cles.slice(0, 2), ['non_traites', 'retard'], 'la pile à appeler d’abord');
});

/* ── L'ordre ─────────────────────────────────────────────────────────────── */

function pile() {
  /* Volontairement dans le désordre : c'est le tri qu'on vérifie. */
  return [
    { id: 'b', work: computeWork(jamaisPrise(h(10)), MAINTENANT) },
    { id: 'c', work: computeWork(jamaisPrise(h(14, 30)), MAINTENANT) },
    { id: 'a', work: computeWork(jamaisPrise(h(9)), MAINTENANT) },
  ];
}

test('la plus récente en haut, par défaut', () => {
  assert.deepEqual(ordonner(pile(), 'non_traites', '').map((x) => x.id), ['c', 'b', 'a']);
});

test('la bascule repart des plus anciennes', () => {
  assert.deepEqual(ordonner(pile(), 'non_traites', 'ancien').map((x) => x.id), ['a', 'b', 'c']);
});

test('l’ordre porte sur TOUTE la pile, pas sur la page affichée', () => {
  /* Inversée après le découpage, la bascule n'aurait retourné que les quinze
     lignes déjà à l'écran — et la plus vieille demande serait restée cachée. */
  const beaucoup = [];
  for (let i = 0; i < 40; i += 1) {
    beaucoup.push({ id: String(i).padStart(2, '0'), work: computeWork(jamaisPrise(h(9, i)), MAINTENANT) });
  }
  const anciennes = ordonner(beaucoup, 'non_traites', 'ancien');
  assert.equal(anciennes.length, 40);
  assert.equal(anciennes[0].id, '00', 'la toute première demande doit être en tête');
  assert.equal(ordonner(beaucoup, 'non_traites', '')[0].id, '39');
});

test('par défaut, les autres onglets gardent leur tri par échéance', () => {
  /* Le tri par date se choisit onglet par onglet (leads-tri-date.test.js). */
  const tard = (due, id) => ({ id, work: computeWork(jamaisPrise(h(9), {
    lastManualContactAt: h(10), nextAction: { type: 'callback', dueAt: due },
  }), MAINTENANT) });
  const ordre = ordonner([tard(h(14), 'tard'), tard(h(11), 'tot')], 'retard', '');
  assert.deepEqual(ordre.map((x) => x.id), ['tot', 'tard'], 'l’échéance la plus ancienne d’abord');
});

test('le bandeau et les onglets racontent la même histoire', () => {
  /* Sinon le patron lit « 12 en retard » au-dessus d'un onglet « En retard »
     qui en montre 3, et il ne sait plus lequel croire. */
  const file = fs.readFileSync(
    path.join(__dirname, '..', '..', 'src', 'services', 'leadWorkQueue.js'), 'utf8');
  assert.ok(file.includes("else if (w.group === 'retard') enRetard += 1;"),
    'le compteur rouge doit se lire sur le groupe, pas sur une règle parallèle');
  assert.ok(!file.includes('else if (w.overdue) enRetard += 1;'), 'ancienne règle, remplacée');
});

/* ── La page ─────────────────────────────────────────────────────────────── */

test('l’onglet s’appelle « Non traités » et porte la bascule de tri', () => {
  assert.ok(PAGE.includes("non_traites: 'Non traités'"), 'le nom de l’onglet');
  assert.ok(!PAGE.includes("nouveaux: 'Nouvelles demandes'"), 'l’ancien nom doit être parti');
  /* La bascule est devenue un menu de tri, présent dans chaque onglet. */
  assert.ok(PAGE.includes('Plus anciennes d’abord'), 'le choix des plus anciennes');
  assert.ok(PAGE.includes('Plus récentes d’abord'), 'et le retour aux plus récentes');
  assert.ok(PAGE.includes("g.key === 'non_traites'"), 'un menu à deux choix pour cet onglet');
});

test('trier ne perd pas les filtres en cours', () => {
  /* Chaque lien de la page repart des mêmes filtres : sans ça, trier
     effaçait « Mes dossiers » ou la pièce choisie sans le dire. */
  assert.ok(PAGE.includes('var filtresEnCours'), 'les filtres doivent être réunis une fois');
  ['qui', 'piece', 'source', 'suivi', 'tri'].forEach((f) => {
    assert.ok(PAGE.includes(`todoFilters.${f} ? { ${f}: todoFilters.${f} } : {}`),
      `le filtre « ${f} » doit être reporté dans les liens`);
  });
});
