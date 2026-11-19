/**
 * Heure d'arrivée, temps d'attente et horloge de la file des leads
 * (services/leadHeure.js + public/js/leads-horloge.js).
 *
 * L'enjeu de la moitié de ces tests : le navigateur réécrit les libellés
 * toutes les 30 s, le serveur les écrit au rendu. S'ils ne disent pas
 * exactement la même chose, le libellé saute à chaque rechargement de page.
 */
const test = require('node:test');
const assert = require('node:assert');

const lh = require('../../src/services/leadHeure');
const ho = require('../../src/services/heuresOuvrees');
const { libelleUrgence, libelleUrgenceCourt } = require('../../src/services/leadWork');
const H = require('../../public/js/leads-horloge.js');

/* Mardi 17 novembre 2026, 10 h 00 à Paris. */
const MARDI_10H = new Date('2026-11-17T09:00:00Z');

test('heure d’arrivée : l’heure seule aujourd’hui, « hier » hier, la date avant', () => {
  assert.equal(lh.arriveeCourte(new Date('2026-11-17T08:12:00Z'), MARDI_10H), '09:12');
  assert.equal(lh.arriveeCourte(new Date('2026-11-16T15:40:00Z'), MARDI_10H), 'hier 16:40');
  assert.equal(lh.arriveeCourte(new Date('2026-11-10T08:12:00Z'), MARDI_10H), 'mar. 10/11');
  assert.equal(lh.arriveeCourte(new Date('2025-11-10T09:12:00Z'), MARDI_10H), '10/11/25');
  assert.equal(lh.arriveeCourte(null, MARDI_10H), '');
});

test('heure d’arrivée, version fiche : une phrase lisible', () => {
  assert.equal(lh.arriveeLongue(new Date('2026-11-17T08:12:00Z'), MARDI_10H), 'aujourd’hui à 09:12');
  assert.equal(lh.arriveeLongue(new Date('2026-11-16T15:40:00Z'), MARDI_10H), 'hier à 16:40');
  assert.equal(lh.arriveeLongue(new Date('2026-11-10T08:12:00Z'), MARDI_10H), 'mardi 10 nov. à 09:12');
  assert.equal(lh.arriveeExacte(new Date('2026-11-10T08:12:00Z')), '10/11/2026 à 09:12');
});

test('l’heure affichée est celle de Paris, pas celle du serveur', () => {
  /* Un dossier reçu à 23 h 30 UTC un 16 novembre est arrivé le 17 à 0 h 30
     à Paris : la liste doit le dire comme le client l'a vécu. */
  assert.equal(lh.arriveeCourte(new Date('2026-11-16T23:30:00Z'), MARDI_10H), '00:30');
});

test('temps d’attente : en heures OUVRÉES, et seulement si personne n’a répondu', () => {
  const recu = new Date('2026-11-17T07:30:00Z'); // mardi 8 h 30, avant l'ouverture
  const jamaisPris = lh.infosHeure({ intent: 'opportunity', receivedAt: recu, firstHumanAt: null }, MARDI_10H);
  /* Ouverture à 9 h : il attend une heure, pas une heure et demie. */
  assert.equal(jamaisPris.attenteMin, 60);
  assert.equal(jamaisPris.attenteCourte, '1 h');

  const dejaPris = lh.infosHeure({ intent: 'opportunity', receivedAt: recu, firstHumanAt: new Date('2026-11-17T08:40:00Z') }, MARDI_10H);
  assert.equal(dejaPris.attenteMin, -1, 'un dossier déjà appelé n’« attend » plus');
  assert.equal(dejaPris.attenteCourte, '');

  const simplePassage = lh.infosHeure({ intent: 'weak', receivedAt: recu, firstHumanAt: null }, MARDI_10H);
  assert.equal(simplePassage.attenteMin, -1, 'un panier abandonné n’est pas une demande en attente');
});

test('temps d’attente : le week-end ne compte pas', () => {
  const vendrediSoir = new Date('2026-11-20T16:50:00Z'); // vendredi 17 h 50
  const lundiMatin = new Date('2026-11-23T08:10:00Z');   // lundi 9 h 10
  const i = lh.infosHeure({ intent: 'opportunity', receivedAt: vendrediSoir, firstHumanAt: null }, lundiMatin);
  assert.equal(i.attenteMin, 20, '10 min vendredi soir + 10 min lundi matin');
});

test('durées : « 25 min », « 2 h 10 », « 2 h » pile, « 3 j ouvrés »', () => {
  assert.equal(lh.dureeOuvree(25), '25 min');
  assert.equal(lh.dureeOuvree(130), '2 h 10');
  assert.equal(lh.dureeOuvree(120), '2 h');
  assert.equal(lh.dureeOuvree(65), '1 h 05');
  assert.equal(lh.dureeOuvree(0), '1 min', 'une attente qui vient de naître n’affiche pas « 0 min »');
  assert.equal(lh.dureeOuvree(7 * 60), '1 j ouvré');
  assert.equal(lh.dureeOuvree(21 * 60), '3 j ouvrés');
});

test('le navigateur écrit EXACTEMENT les mêmes durées que le serveur', () => {
  const SANS = 840; /* 2 jours ouvrés de silence avant l'échéance déduite. */
  for (let m = 0; m <= 3000; m += 1) {
    assert.equal(H.dureeOuvree(m), lh.dureeOuvree(m), `durée divergente à ${m} min`);
    /* Une heure PROMISE : « Retard 2 h ». */
    const promis = { dueAt: MARDI_10H, overdue: true, overdueMinutes: m, promesse: true };
    assert.equal(H.retardCourt(m), libelleUrgenceCourt(promis, MARDI_10H), `libellé de retard divergent à ${m} min`);
    assert.equal(H.retardLong(m), libelleUrgence(promis, MARDI_10H), `libellé long divergent à ${m} min`);

    /* Une heure DEVINÉE par la file : « Relancer · 4 j », jamais « en retard ».
       Le navigateur réécrit ces libellés toutes les 30 s : s'il disait « en
       retard » là où le serveur dit « à relancer », la distinction qui vide
       le rouge disparaîtrait au bout d'une demi-minute. */
    [false, true].forEach((devis) => {
      const stage = devis ? 'devis_a_faire' : 'en_cours';
      const suppose = { dueAt: MARDI_10H, overdue: true, overdueMinutes: m, promesse: false, stage, sansNouvellesMin: m + SANS };
      assert.equal(H.relanceCourt(m + SANS, devis), libelleUrgenceCourt(suppose, MARDI_10H), `relance courte divergente à ${m} min (devis ${devis})`);
      assert.equal(H.relanceLong(m + SANS, devis, false), libelleUrgence(suppose, MARDI_10H), `relance longue divergente à ${m} min (devis ${devis})`);
      /* Dossier sans dernier contact daté : les deux retombent sur l'échéance. */
      const sansRepere = Object.assign({}, suppose, { sansNouvellesMin: -1 });
      assert.equal(H.relanceCourt(m, devis), libelleUrgenceCourt(sansRepere, MARDI_10H), `repli court divergent à ${m} min (devis ${devis})`);
      assert.equal(H.relanceLong(m, devis, true), libelleUrgence(sansRepere, MARDI_10H), `repli long divergent à ${m} min (devis ${devis})`);
    });
  }
});

test('le navigateur compte les minutes ouvrées comme le serveur', () => {
  /* Vendredi 17 h 30 : la fenêtre envoyée au navigateur s'arrête à 18 h puis
     reprend lundi. On vérifie sur 4 jours, de quart d'heure en quart d'heure. */
  const rendu = new Date('2026-11-20T16:30:00Z');
  const fenetre = lh.fenetreOuvree(rendu, 4);
  const plages = H.preparer(fenetre.plages);
  assert.ok(plages.length >= 5, 'la fenêtre couvre le vendredi soir et les jours ouvrés suivants');
  for (let q = 0; q <= 4 * 96; q += 1) {
    const t = new Date(rendu.getTime() + q * 15 * 60000);
    assert.equal(
      H.minutesOuvrees(plages, rendu, t),
      ho.minutesOuvreesEntre(rendu, t),
      `écart à ${t.toISOString()}`,
    );
  }
});

test('la fenêtre envoyée au navigateur ne contient jamais de temps déjà passé', () => {
  const rendu = new Date('2026-11-17T09:20:00Z');
  const fenetre = lh.fenetreOuvree(rendu, 4);
  assert.equal(fenetre.nowIso, rendu.toISOString());
  fenetre.plages.forEach(([a, b]) => {
    assert.ok(Date.parse(a) >= rendu.getTime(), 'aucune plage ne commence avant le rendu');
    assert.ok(Date.parse(b) > Date.parse(a));
  });
});
