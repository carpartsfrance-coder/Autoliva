'use strict';

/**
 * Chaîne de requête des redirections 301.
 *
 * Une règle de redirection ne réécrit que le CHEMIN : la chaîne de requête du
 * visiteur doit suivre, sinon elle est perdue au passage. C'est ce qui arrivait
 * à /product/<slug> sans slash final — la forme la plus courante dans les
 * annonces : le 301 vers /product/<slug>/ jetait le ?gclid=, le clic Google Ads
 * arrivait sur la fiche sans son identifiant de clic, et la conversion n'était
 * plus rattachée à l'annonce. Même effet sur un utm_* ou un identifiant de
 * campagne : plus rien à rattacher, donc un canal qui paraît ne rien rapporter.
 *
 * À ne PAS utiliser pour une redirection qui CONSOMME la requête (étape 4 de
 * wpRedirects : ?add-to-cart=, ?p=…), où la recopier n'aurait pas de sens.
 */

/**
 * Recolle la chaîne de requête de `req` sur la cible d'une redirection.
 *
 * Les paramètres déjà posés par la cible gagnent : /tag/boite redirige vers
 * /produits?q=boite et garde SON q même si l'URL d'origine en portait un autre.
 * Sans ce filtre on obtenait deux q=, et le listing — qui n'accepte qu'une
 * chaîne — ne cherchait plus rien du tout.
 *
 * La chaîne est recopiée telle quelle, sans ré-encodage : un gclid est une
 * valeur opaque, on n'y touche pas.
 *
 * @param {import('express').Request} req
 * @param {string} cible chemin (ou URL) de destination, éventuellement déjà
 *   porteur de ses propres paramètres
 * @returns {string} la cible, suivie des paramètres du visiteur
 */
function avecRequete(req, cible) {
  const chemin = cible == null ? '' : String(cible);
  const brut = req && typeof req.originalUrl === 'string' ? req.originalUrl : '';
  const debut = brut.indexOf('?');
  if (debut < 0) return chemin;

  const dejaPoses = new Set(
    (chemin.split('?')[1] || '')
      .split('&')
      .map((paire) => paire.split('=')[0])
      .filter(Boolean)
  );
  const aSuivre = brut
    .slice(debut + 1)
    .split('&')
    .filter((paire) => paire && !dejaPoses.has(paire.split('=')[0]));

  if (!aSuivre.length) return chemin;
  return chemin + (chemin.includes('?') ? '&' : '?') + aSuivre.join('&');
}

module.exports = { avecRequete };
