/**
 * Horloge de la file des leads (/admin/activite-panier).
 *
 * « attend 2 h 10 » est calculé par le serveur à l'affichage de la page. Un
 * commercial laisse cette page ouverte toute la matinée : au bout d'une
 * heure le chiffre était faux, et une ligne dont l'heure venait de passer
 * gardait sa couleur. Ce fichier remet l'attente à l'heure et recolore la
 * barre toutes les 30 secondes.
 *
 * Les comptes à rebours (« Retard 9 min », « avant 14:00 ») ont été retirés
 * le 20/11/2026 : le patron les trouvait polluants. Leurs miroirs navigateur
 * sont partis avec eux.
 *
 * Il ne refait PAS le calendrier : les week-ends, les jours fériés et les
 * changements d'heure restent l'affaire du serveur, qui envoie la fenêtre
 * d'ouverture des prochains jours (services/leadHeure.js → fenetreOuvree).
 * Ici on ne fait que découper du temps dans ces plages, et écrire les mêmes
 * libellés que le serveur (tests/unit/leads-horloge.test.js vérifie que les
 * deux disent exactement la même chose).
 */
(function (racine, usine) {
  if (typeof module === 'object' && module.exports) module.exports = usine();
  else racine.LeadsHorloge = usine();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  /** Une journée ouvrée = 7 h (9-12 + 14-18) — même constante que leadWork.js. */
  var MIN_JOUR_OUVRE = 7 * 60;

  /** Plages ISO du serveur → bornes en millisecondes, une fois pour toutes. */
  function preparer(plages) {
    var out = [];
    for (var i = 0; i < (plages || []).length; i += 1) {
      var a = Date.parse(plages[i][0]);
      var b = Date.parse(plages[i][1]);
      if (a < b) out.push([a, b]);
    }
    return out;
  }

  /** Minutes OUVRÉES entre `debut` et `fin`, dans les plages données. */
  function minutesOuvrees(plages, debut, fin) {
    var a = +debut;
    var b = +fin;
    if (!(b > a)) return 0;
    var total = 0;
    for (var i = 0; i < plages.length; i += 1) {
      var x = Math.max(a, plages[i][0]);
      var y = Math.min(b, plages[i][1]);
      if (y > x) total += (y - x) / 60000;
    }
    return Math.round(total);
  }

  /** « 25 min », « 2 h 10 », « 3 j ouvrés » — miroir de leadHeure.dureeOuvree. */
  function dureeOuvree(minutes) {
    var m = Math.max(0, Math.round(Number(minutes) || 0));
    if (m < 60) return Math.max(1, m) + ' min';
    if (m < MIN_JOUR_OUVRE) {
      var h = Math.floor(m / 60);
      var reste = m % 60;
      return reste ? h + ' h ' + String(reste < 10 ? '0' + reste : reste) : h + ' h';
    }
    var j = Math.round(m / MIN_JOUR_OUVRE);
    return j + ' j ouvré' + (j > 1 ? 's' : '');
  }

  return {
    preparer: preparer,
    minutesOuvrees: minutesOuvrees,
    dureeOuvree: dureeOuvree,
    MIN_JOUR_OUVRE: MIN_JOUR_OUVRE,
  };
}));
