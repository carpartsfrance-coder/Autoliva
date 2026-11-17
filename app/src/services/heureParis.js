'use strict';

/*
 * Jours du calendrier de PARIS, quel que soit le fuseau du serveur.
 *
 * Le tableau de bord calculait « aujourd'hui », « ce mois » et les 7 jours du
 * graphique avec l'heure du serveur (setHours(0)…). Sur un serveur en UTC,
 * la journée commençait à 1 h (2 h l'été) heure de Paris, et entre minuit et
 * 1 h les ventes du jour tombaient encore sur la veille.
 */

const FORMAT_PARTIES = new Intl.DateTimeFormat('en-US', {
  timeZone: 'Europe/Paris',
  hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit',
  weekday: 'short',
});
const JOURS_SEMAINE = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** Date et heure murales à Paris pour l'instant `date`. */
function partiesParis(date) {
  const p = {};
  for (const { type, value } of FORMAT_PARTIES.formatToParts(date)) p[type] = value;
  return {
    annee: Number(p.year), mois: Number(p.month), jour: Number(p.day),
    heure: Number(p.hour), minute: Number(p.minute), seconde: Number(p.second),
    jourSemaine: JOURS_SEMAINE[p.weekday],
  };
}

/** Décalage de Paris par rapport à UTC à l'instant `date`, en minutes (60 ou 120). */
function decalageParisMinutes(date) {
  const p = partiesParis(date);
  const murale = Date.UTC(p.annee, p.mois - 1, p.jour, p.heure, p.minute, p.seconde);
  return Math.round((murale - Math.floor(date.getTime() / 1000) * 1000) / 60000);
}

/**
 * Instant (UTC) de minuit à Paris, pour le jour parisien de `date` décalé de
 * `jours` (négatif = avant). Les débordements de mois/année sont gérés.
 */
function minuitParis(date = new Date(), jours = 0) {
  const p = partiesParis(date);
  const minuitUtc = Date.UTC(p.annee, p.mois - 1, p.jour + jours, 0, 0, 0);
  let instant = minuitUtc - decalageParisMinutes(new Date(minuitUtc)) * 60000;
  // Changement d'heure entre les deux mesures : on recale une fois.
  const verif = minuitUtc - decalageParisMinutes(new Date(instant)) * 60000;
  if (verif !== instant) instant = verif;
  return new Date(instant);
}

/** Instant de minuit à Paris le 1er du mois parisien de `date`, décalé de `mois`. */
function debutMoisParis(date = new Date(), mois = 0) {
  const p = partiesParis(date);
  const repere = new Date(Date.UTC(p.annee, p.mois - 1 + mois, 1, 12, 0, 0));
  return minuitParis(repere, 0);
}

/** Clé « AAAA-MM-JJ » du jour à Paris (même format que $dateToString Europe/Paris). */
function cleJourParis(date) {
  const p = partiesParis(date);
  return `${p.annee}-${String(p.mois).padStart(2, '0')}-${String(p.jour).padStart(2, '0')}`;
}

module.exports = { partiesParis, decalageParisMinutes, minuitParis, debutMoisParis, cleJourParis };
