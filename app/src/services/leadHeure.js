'use strict';

/**
 * « Quand est-ce arrivé, et depuis combien de temps ça attend ? »
 *
 * ── Le problème (constaté le 18/11/2026) ───────────────────────────────────
 *
 * La liste de /admin/activite-panier n'affichait que l'ÉCHÉANCE du dossier
 * (« Retard 2 h », « Avant 10:15 ») : rien ne disait QUAND la demande était
 * arrivée. Impossible de distinguer un client qui vient d'écrire d'un dossier
 * qui traîne depuis trois jours, ni de dire au client « vous nous avez écrit
 * ce matin à 9 h 12 ».
 *
 * Ce module fabrique :
 *  - l'heure d'arrivée, courte pour la liste et longue pour la fiche ;
 *  - le temps d'attente d'une demande que PERSONNE n'a encore prise, en
 *    minutes ouvrées (une demande reçue vendredi 17 h 50 n'attend pas 60 h
 *    le lundi matin, elle attend 10 minutes) ;
 *  - la fenêtre d'heures ouvrées que le navigateur utilise pour garder ces
 *    libellés à jour sans recharger la page (public/js/leads-horloge.js).
 *    Les plages viennent d'ici : le navigateur ne refait jamais le calcul des
 *    week-ends, des jours fériés ni des changements d'heure.
 */

const ho = require('./heuresOuvrees');
const { minuitParis, cleJourParis } = require('./heureParis');

/** Une journée ouvrée = 7 h (9-12 + 14-18) — même constante que leadWork. */
const MIN_JOUR_OUVRE = 7 * 60;

const PARIS = 'Europe/Paris';
/* Formats construits une fois : la file calcule jusqu'à 300 lignes par page. */
const FMT_HEURE = new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, hour: '2-digit', minute: '2-digit' });
const FMT_JOUR_COURT = new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, weekday: 'short', day: '2-digit', month: '2-digit' });
const FMT_JOUR_ANNEE = new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, day: '2-digit', month: '2-digit', year: '2-digit' });
const FMT_JOUR_LONG = new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, weekday: 'long', day: 'numeric', month: 'short' });
const FMT_DATE_EXACTE = new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, day: '2-digit', month: '2-digit', year: 'numeric' });
const FMT_ANNEE = new Intl.DateTimeFormat('fr-FR', { timeZone: PARIS, year: 'numeric' });

function versDate(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 'aujourdhui' | 'hier' | 'avant' — le jour de `date` vu depuis `now`, à Paris. */
function quelJour(date, now) {
  const cle = cleJourParis(date);
  if (cle === cleJourParis(now)) return 'aujourdhui';
  if (cle === cleJourParis(minuitParis(now, -1))) return 'hier';
  return 'avant';
}

/**
 * Heure d'arrivée pour la liste de gauche, où il n'y a la place que pour
 * quelques caractères : « 09:12 » (aujourd'hui), « hier 16:40 »,
 * « mar. 17/11 » (cette année), « 17/11/25 » (plus vieux).
 */
function arriveeCourte(date, now = new Date()) {
  const d = versDate(date);
  if (!d) return '';
  const jour = quelJour(d, now);
  if (jour === 'aujourdhui') return FMT_HEURE.format(d);
  if (jour === 'hier') return `hier ${FMT_HEURE.format(d)}`;
  if (FMT_ANNEE.format(d) === FMT_ANNEE.format(now)) return FMT_JOUR_COURT.format(d);
  return FMT_JOUR_ANNEE.format(d);
}

/**
 * Heure d'arrivée pour la fiche, où on peut lire une phrase :
 * « aujourd'hui à 09:12 », « hier à 16:40 », « mardi 17 nov. à 09:12 ».
 */
function arriveeLongue(date, now = new Date()) {
  const d = versDate(date);
  if (!d) return '';
  const jour = quelJour(d, now);
  const heure = FMT_HEURE.format(d);
  if (jour === 'aujourdhui') return `aujourd’hui à ${heure}`;
  if (jour === 'hier') return `hier à ${heure}`;
  if (FMT_ANNEE.format(d) === FMT_ANNEE.format(now)) return `${FMT_JOUR_LONG.format(d)} à ${heure}`;
  return `${FMT_DATE_EXACTE.format(d)} à ${heure}`;
}

/**
 * L'heure d'un rendez-vous POSÉ par quelqu'un, dite comme une date et non
 * comme un compte à rebours : « aujourd'hui à 14:00 », « demain à 09:30 »,
 * « jeudi 26 nov. à 09:30 ».
 *
 * Le patron ne voulait plus lire « en retard de 9 min » ni « avant 14:00 »
 * partout (20/11/2026) : ces libellés changeaient chaque minute et
 * polluaient la liste. Seule reste l'heure d'un rendez-vous que quelqu'un a
 * fixé — c'est un fait, pas une alarme.
 */
function prevuLe(date, now = new Date()) {
  const d = versDate(date);
  if (!d) return '';
  const heure = FMT_HEURE.format(d);
  const cle = cleJourParis(d);
  if (cle === cleJourParis(now)) return `aujourd’hui à ${heure}`;
  if (cle === cleJourParis(minuitParis(now, 1))) return `demain à ${heure}`;
  if (FMT_ANNEE.format(d) === FMT_ANNEE.format(now)) return `${FMT_JOUR_LONG.format(d)} à ${heure}`;
  return `${FMT_DATE_EXACTE.format(d)} à ${heure}`;
}

/** Date complète pour l'infobulle : « 17/11/2026 à 09:12 » (heure de Paris). */
function arriveeExacte(date) {
  const d = versDate(date);
  if (!d) return '';
  return `${FMT_DATE_EXACTE.format(d)} à ${FMT_HEURE.format(d)}`;
}

/**
 * Durée en minutes OUVRÉES → « 25 min », « 2 h 10 », « 3 j ouvrés ».
 * Mirroir côté navigateur : public/js/leads-horloge.js (dureeOuvree).
 */
function dureeOuvree(minutes) {
  const m = Math.max(0, Math.round(Number(minutes) || 0));
  if (m < 60) return `${Math.max(1, m)} min`;
  if (m < MIN_JOUR_OUVRE) {
    const h = Math.floor(m / 60);
    const reste = m % 60;
    return reste ? `${h} h ${String(reste).padStart(2, '0')}` : `${h} h`;
  }
  const j = Math.round(m / MIN_JOUR_OUVRE);
  return `${j} j ouvré${j > 1 ? 's' : ''}`;
}

/**
 * Libellés d'heure d'un dossier, à partir de son `work` (services/leadWork.js).
 *
 * `attenteMin` ne vaut quelque chose que sur une demande ouverte que personne
 * n'a encore prise : c'est le délai de première réponse en train de courir,
 * le seul chiffre qui dise si on est en train de perdre le client. Sur un
 * dossier déjà suivi, répondu ou clos, il vaut -1 (rien à afficher).
 */
function infosHeure(work, now = new Date()) {
  const w = work || {};
  const recu = versDate(w.receivedAt);
  const jamaisPris = w.intent === 'opportunity' && !w.firstHumanAt;
  const attenteMin = (jamaisPris && recu) ? ho.minutesOuvreesEntre(recu, now) : -1;
  return {
    recuCourt: arriveeCourte(recu, now),
    recuLong: arriveeLongue(recu, now),
    recuExact: arriveeExacte(recu),
    recuIso: recu ? recu.toISOString() : '',
    attenteMin,
    attenteCourte: attenteMin >= 0 ? dureeOuvree(attenteMin) : '',
  };
}

/**
 * Fenêtre d'heures ouvrées à partir de `now`, pour l'horloge du navigateur :
 * la liste des plages d'ouverture (ISO) des `jours` prochains jours, déjà
 * amputées de ce qui est passé. Quatre jours couvrent un vendredi soir qui
 * reprend le lundi matin ; au-delà, la page a été rechargée depuis longtemps.
 */
function fenetreOuvree(now = new Date(), jours = 4) {
  const t0 = versDate(now) || new Date();
  const plages = [];
  for (let j = 0; j <= jours; j += 1) {
    ho.plagesJour(minuitParis(t0, j)).forEach(([a, b]) => {
      const debut = Math.max(a.getTime(), t0.getTime());
      if (debut < b.getTime()) plages.push([new Date(debut).toISOString(), b.toISOString()]);
    });
  }
  return { nowIso: t0.toISOString(), plages };
}

module.exports = {
  prevuLe,
  arriveeCourte,
  arriveeLongue,
  arriveeExacte,
  dureeOuvree,
  infosHeure,
  fenetreOuvree,
  MIN_JOUR_OUVRE,
};
