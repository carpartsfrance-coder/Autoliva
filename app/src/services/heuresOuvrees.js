'use strict';

/**
 * Heures ouvrées d'Autoliva, à l'heure de Paris : lundi–vendredi, 9 h–12 h et
 * 14 h–18 h, hors jours fériés français.
 *
 * Sert à la file de travail des leads (services/leadWork.js) : une demande
 * reçue vendredi à 17 h 45 doit être rappelée lundi matin, pas « en retard »
 * dès samedi. Toutes les dates en entrée/sortie sont des instants (UTC) ; les
 * calculs se font en heure murale de Paris via heureParis.js.
 */

const { partiesParis, minuitParis, cleJourParis } = require('./heureParis');

/** Plages ouvrées d'une journée, en minutes depuis minuit (heure de Paris). */
const PLAGES = [[9 * 60, 12 * 60], [14 * 60, 18 * 60]];

/* ── Jours fériés (France métropolitaine) ─────────────────────────────── */

/** Dimanche de Pâques (algorithme de Meeus/Butcher), en {mois, jour}. */
function paques(annee) {
  const a = annee % 19;
  const b = Math.floor(annee / 100);
  const c = annee % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const mois = Math.floor((h + l - 7 * m + 114) / 31);
  const jour = ((h + l - 7 * m + 114) % 31) + 1;
  return { mois, jour };
}

const FERIES_CACHE = new Map();
/** Ensemble des clés « AAAA-MM-JJ » fériées de l'année. */
function feriesAnnee(annee) {
  if (FERIES_CACHE.has(annee)) return FERIES_CACHE.get(annee);
  const cle = (m, j) => `${annee}-${String(m).padStart(2, '0')}-${String(j).padStart(2, '0')}`;
  const p = paques(annee);
  const base = Date.UTC(annee, p.mois - 1, p.jour);
  const decale = (jours) => {
    const d = new Date(base + jours * 86400000);
    return cle(d.getUTCMonth() + 1, d.getUTCDate());
  };
  const set = new Set([
    cle(1, 1), cle(5, 1), cle(5, 8), cle(7, 14), cle(8, 15), cle(11, 1), cle(11, 11), cle(12, 25),
    decale(1),   // lundi de Pâques
    decale(39),  // Ascension
    decale(50),  // lundi de Pentecôte
  ]);
  FERIES_CACHE.set(annee, set);
  return set;
}

/** Le jour parisien de `date` est-il ouvré ? */
function jourOuvre(date) {
  const p = partiesParis(date);
  if (p.jourSemaine === 0 || p.jourSemaine === 6) return false;
  return !feriesAnnee(p.annee).has(cleJourParis(date));
}

/** Plages ouvrées [début, fin] (instants) du jour parisien de `date`, décalé de `jours`. */
function plagesDuJour(date, jours = 0) {
  const minuit = minuitParis(date, jours);
  const repere = new Date(minuit.getTime() + 12 * 3600000);
  if (!jourOuvre(repere)) return [];
  return PLAGES.map(([a, b]) => [new Date(minuit.getTime() + a * 60000), new Date(minuit.getTime() + b * 60000)]);
}

/** `date` tombe-t-elle pendant les heures d'ouverture ? */
function estOuvert(date) {
  const t = date.getTime();
  return plagesDuJour(date).some(([a, b]) => t >= a.getTime() && t < b.getTime());
}

/**
 * Ajoute `minutes` minutes OUVRÉES à `date`. Une demande reçue en dehors des
 * heures d'ouverture démarre à la prochaine ouverture.
 * Ex. : lundi 11 h 40 + 60 min → lundi 14 h 40 ; vendredi 17 h 45 + 60 → lundi 9 h 45.
 */
function ajouterMinutesOuvrees(date, minutes) {
  let reste = Math.max(0, Math.round(minutes));
  const depart = new Date(date);
  for (let j = 0; j < 400; j += 1) {
    for (const [a, b] of plagesDuJour(depart, j)) {
      const debut = Math.max(a.getTime(), j === 0 ? depart.getTime() : 0);
      if (debut >= b.getTime()) continue;
      const dispo = (b.getTime() - debut) / 60000;
      if (reste <= dispo) return new Date(debut + reste * 60000);
      reste -= dispo;
    }
  }
  return new Date(depart.getTime() + minutes * 60000);
}

/** Ajoute `jours` jours ouvrés : même heure murale, en sautant week-ends et fériés. */
function ajouterJoursOuvres(date, jours) {
  let restants = Math.max(0, Math.round(jours));
  const depart = new Date(date);
  let j = 0;
  while (restants > 0 && j < 400) {
    j += 1;
    const repere = new Date(minuitParis(depart, j).getTime() + 12 * 3600000);
    if (jourOuvre(repere)) restants -= 1;
  }
  const delta = minuitParis(depart, j).getTime() - minuitParis(depart, 0).getTime();
  return new Date(depart.getTime() + delta);
}

/** Minutes ouvrées écoulées entre `debut` et `fin` (0 si fin <= debut). */
function minutesOuvreesEntre(debut, fin) {
  const a = new Date(debut).getTime();
  const b = new Date(fin).getTime();
  if (!(b > a)) return 0;
  let total = 0;
  for (let j = 0; j < 400; j += 1) {
    const plages = plagesDuJour(new Date(a), j);
    const finJour = minuitParis(new Date(a), j + 1).getTime();
    for (const [p, q] of plages) {
      const x = Math.max(a, p.getTime());
      const y = Math.min(b, q.getTime());
      if (y > x) total += (y - x) / 60000;
    }
    if (finJour >= b) break;
  }
  return Math.round(total);
}

/** Prochain instant ouvert à partir de `date` (lui-même s'il est ouvert). */
function prochaineOuverture(date) {
  return ajouterMinutesOuvrees(date, 0);
}

module.exports = {
  estOuvert,
  jourOuvre,
  ajouterMinutesOuvrees,
  ajouterJoursOuvres,
  minutesOuvreesEntre,
  prochaineOuverture,
  feriesAnnee,
};
