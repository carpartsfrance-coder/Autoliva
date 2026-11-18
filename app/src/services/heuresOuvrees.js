'use strict';

/**
 * Heures ouvrées d'Autoliva, à l'heure de Paris : lundi–vendredi, 9 h–12 h et
 * 14 h–18 h, hors jours fériés français.
 *
 * Sert à la file de travail des leads (services/leadWork.js) : une demande
 * reçue vendredi à 17 h 45 doit être rappelée lundi matin, pas « en retard »
 * dès samedi. Toutes les dates en entrée/sortie sont des instants (UTC).
 *
 * ── Calcul direct, sans Intl ────────────────────────────────────────────────
 * Première version (18/11/2026) : chaque jour parcouru passait par
 * Intl.DateTimeFormat (heureParis.js). Sur la vraie base, la file calculait
 * l'âge de 3 000 dossiers vieux de plusieurs mois : 28 s par affichage de la
 * page. Ici, l'heure d'été européenne est calculée par sa règle (du dernier
 * dimanche de mars au dernier dimanche d'octobre, à 1 h UTC) et les jours sont
 * des entiers : même résultat, plusieurs centaines de fois plus rapide.
 */

const MIN = 60000;
const JOUR = 86400000;

/** Plages ouvrées d'une journée, en minutes depuis minuit (heure de Paris). */
const PLAGES = [[9 * 60, 12 * 60], [14 * 60, 18 * 60]];

/* ── Heure d'été (règle européenne) ─────────────────────────────────────── */

/** Instant UTC du passage d'heure : dernier dimanche du mois `mois0`, 1 h UTC. */
function dernierDimanche1hUtc(annee, mois0) {
  const finMois = Date.UTC(annee, mois0 + 1, 0); // dernier jour du mois, 0 h UTC
  const jourSemaine = new Date(finMois).getUTCDay(); // 0 = dimanche
  return finMois - jourSemaine * JOUR + 3600000;
}
const DST_CACHE = new Map();
function bornesEte(annee) {
  let b = DST_CACHE.get(annee);
  if (!b) { b = [dernierDimanche1hUtc(annee, 2), dernierDimanche1hUtc(annee, 9)]; DST_CACHE.set(annee, b); }
  return b;
}

/** Décalage de Paris (minutes) à l'instant `t` (ms). */
function decalage(t) {
  const annee = new Date(t).getUTCFullYear();
  const [debut, fin] = bornesEte(annee);
  return t >= debut && t < fin ? 120 : 60;
}

/** Numéro du jour parisien (jours depuis le 1/1/1970, calendrier de Paris). */
function jourParis(t) {
  return Math.floor((t + decalage(t) * MIN) / JOUR);
}

/** Instant UTC de minuit à Paris pour le jour parisien `n`. */
function minuitJour(n) {
  /* Le décalage d'une journée ouvrée ne change jamais en cours de journée (le
     passage d'heure a lieu un dimanche). On le lit à midi UTC du même jour. */
  return n * JOUR - decalage(n * JOUR + 12 * 3600000) * MIN;
}

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
    const d = new Date(base + jours * JOUR);
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

const OUVRE_CACHE = new Map();
/** Le jour parisien n° `n` est-il ouvré ? */
function jourOuvreN(n) {
  let v = OUVRE_CACHE.get(n);
  if (v !== undefined) return v;
  const d = new Date(n * JOUR); // minuit UTC du même jour civil
  const js = d.getUTCDay();
  if (js === 0 || js === 6) v = false;
  else {
    const cle = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    v = !feriesAnnee(d.getUTCFullYear()).has(cle);
  }
  if (OUVRE_CACHE.size > 20000) OUVRE_CACHE.clear();
  OUVRE_CACHE.set(n, v);
  return v;
}

/** Le jour parisien de `date` est-il ouvré ? */
function jourOuvre(date) {
  return jourOuvreN(jourParis(new Date(date).getTime()));
}

/** Plages ouvrées [début, fin] (ms) du jour parisien n° `n`. */
function plagesN(n) {
  if (!jourOuvreN(n)) return [];
  const m = minuitJour(n);
  return PLAGES.map(([a, b]) => [m + a * MIN, m + b * MIN]);
}

/**
 * Plages ouvrées [début, fin] (Date) du jour parisien de `date` — vide un
 * week-end ou un jour férié. Sert à envoyer au navigateur la fenêtre
 * d'ouverture des prochains jours (services/leadHeure.js) : l'horloge de la
 * file des leads reste juste sans refaire ici le calcul des fériés.
 */
function plagesJour(date) {
  return plagesN(jourParis(new Date(date).getTime())).map(([a, b]) => [new Date(a), new Date(b)]);
}

/** `date` tombe-t-elle pendant les heures d'ouverture ? */
function estOuvert(date) {
  const t = new Date(date).getTime();
  return plagesN(jourParis(t)).some(([a, b]) => t >= a && t < b);
}

/**
 * Ajoute `minutes` minutes OUVRÉES à `date`. Une demande reçue en dehors des
 * heures d'ouverture démarre à la prochaine ouverture.
 * Ex. : lundi 11 h 40 + 60 min → lundi 14 h 40 ; vendredi 17 h 45 + 60 → lundi 9 h 45.
 */
function ajouterMinutesOuvrees(date, minutes) {
  let reste = Math.max(0, Math.round(minutes));
  const t0 = new Date(date).getTime();
  const n0 = jourParis(t0);
  for (let j = 0; j < 400; j += 1) {
    for (const [a, b] of plagesN(n0 + j)) {
      const debut = Math.max(a, t0);
      if (debut >= b) continue;
      const dispo = (b - debut) / MIN;
      if (reste <= dispo) return new Date(debut + reste * MIN);
      reste -= dispo;
    }
  }
  return new Date(t0 + minutes * MIN);
}

/** Ajoute `jours` jours ouvrés : même heure murale, en sautant week-ends et fériés. */
function ajouterJoursOuvres(date, jours) {
  let restants = Math.max(0, Math.round(jours));
  const t0 = new Date(date).getTime();
  const n0 = jourParis(t0);
  let j = 0;
  while (restants > 0 && j < 400) {
    j += 1;
    if (jourOuvreN(n0 + j)) restants -= 1;
  }
  return new Date(t0 + (minuitJour(n0 + j) - minuitJour(n0)));
}

/** Minutes ouvrées dans une journée ouvrée complète (9-12 + 14-18). */
const MIN_PAR_JOUR = PLAGES.reduce((s, [a, b]) => s + (b - a), 0);

/** Minutes ouvrées écoulées entre `debut` et `fin` (0 si fin <= debut). */
function minutesOuvreesEntre(debut, fin) {
  const a = new Date(debut).getTime();
  const b = new Date(fin).getTime();
  if (!(b > a)) return 0;
  const na = jourParis(a);
  const nb = jourParis(b);
  const partiel = (n) => plagesN(n).reduce((s, [p, q]) => {
    const x = Math.max(a, p);
    const y = Math.min(b, q);
    return y > x ? s + (y - x) / MIN : s;
  }, 0);
  if (na === nb) return Math.round(partiel(na));
  let total = partiel(na) + partiel(nb);
  /* Jours pleins entre les deux : une simple boucle d'entiers (cache des jours ouvrés). */
  for (let n = na + 1; n < nb; n += 1) if (jourOuvreN(n)) total += MIN_PAR_JOUR;
  return Math.round(total);
}

/** Prochain instant ouvert à partir de `date` (lui-même s'il est ouvert). */
function prochaineOuverture(date) {
  return ajouterMinutesOuvrees(date, 0);
}

module.exports = {
  estOuvert,
  jourOuvre,
  plagesJour,
  ajouterMinutesOuvrees,
  ajouterJoursOuvres,
  minutesOuvreesEntre,
  prochaineOuverture,
  feriesAnnee,
};
