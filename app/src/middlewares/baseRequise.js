'use strict';

/**
 * Base de données indisponible → 503 + Retry-After sur les pages qui en vivent.
 *
 * ── Pourquoi (plan de reprise SEO du 14/09/2026, action A4.4) ────────────────
 *
 * Quand MongoDB décroche (redémarrage, panne du 21/08, lenteur Atlas), chaque
 * famille de pages répondait à sa façon, et presque toujours mal :
 *   - /reference/<réf> : 404 — Google retire une URL indexée sur un 404 ;
 *   - /pieces-auto/<marque>/<modèle> : 301 de CHAQUE page vers /pieces-auto,
 *     la marque et le modèle n'étant plus résolus ;
 *   - /product/<slug> : une fiche de DÉMONSTRATION, ou 404 ;
 *   - /categorie/<slug> : des catégories de démonstration, ou 404 ;
 *   - /blog/<slug> : 503, mais sans Retry-After.
 * Un 503 accompagné de Retry-After est la seule réponse que Google comprend
 * comme « revenez plus tard » : il garde la page telle qu'il la connaît.
 *
 * Les pages allemandes équivalentes (/de/produits, /de/blog, /de/categorie)
 * passent par les mêmes contrôleurs et ont les mêmes défauts : même règle.
 *
 * Le reste du site n'est pas concerné : accueil, landings, robots.txt (un 5xx
 * sur robots.txt ferait suspendre TOUTE l'exploration) et sitemaps, qui ont
 * leurs propres replis.
 */

const mongoose = require('mongoose');
const { t } = require('../services/i18n');

/* Délai conseillé à Google et aux navigateurs. Le serveur retente la connexion
   toutes les 5 à 60 s (server.js) : deux minutes couvrent un décrochage. */
const RETRY_AFTER_S = 120;

/* Le listing /produits n'en fait pas partie (hors du périmètre de A4), et
   /produits/<x> non plus : wpRedirects le renvoie vers /product/<x>/ sans
   toucher à la base, et c'est là que la règle s'applique. */
const CHEMINS = /^\/(?:product|blog|pieces-auto|reference|categorie)(?:\/|$)|^\/de\/(?:produits|blog|categorie)(?:\/|$)/i;

function cheminConcerne(chemin) {
  return CHEMINS.test(String(chemin || ''));
}

function baseRequise(req, res, next) {
  if (mongoose.connection.readyState === 1) return next();
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  if (!cheminConcerne(req.path)) return next();

  res.set('Retry-After', String(RETRY_AFTER_S));
  res.set('Cache-Control', 'no-store');
  return res.status(503).render('errors/500', {
    title: t(req.lang || 'fr', 'error.500.title'),
    metaRobots: 'noindex, nofollow',
  });
}

module.exports = baseRequise;
module.exports.cheminConcerne = cheminConcerne;
module.exports.RETRY_AFTER_S = RETRY_AFTER_S;
