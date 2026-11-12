'use strict';

/* Polices servies depuis notre domaine — côté serveur.
 *
 * Lit public/fonts/manifest.json (produit par scripts/polices-locales.js) et
 * fabrique, une fois au démarrage, ce que le gabarit met dans <head> :
 *
 *   — le CSS @font-face des fichiers locaux (avec ?v=empreinte : un fichier
 *     régénéré change d'adresse, le cache navigateur ne sert jamais un
 *     sous-ensemble d'icônes périmé) ;
 *   — les classes .material-symbols-* que Google fournissait avec sa feuille ;
 *   — la liste des fichiers à précharger (ceux du premier écran).
 *
 * Sans manifest (dépôt fraîchement cloné sans lancer le script), on renvoie
 * `disponible: false` et le gabarit retombe sur les feuilles Google : le site
 * s'affiche, seulement plus lentement.
 */

const fs = require('fs');
const path = require('path');

const MANIFEST = path.join(__dirname, '..', '..', 'public', 'fonts', 'manifest.json');

/* Repris à l'identique de la feuille que Google sert pour ces familles. */
const CLASSE_ICONES = "font-weight:normal;font-style:normal;font-size:24px;line-height:1;letter-spacing:normal;text-transform:none;display:inline-block;white-space:nowrap;word-wrap:normal;direction:ltr;-webkit-font-feature-settings:'liga';-webkit-font-smoothing:antialiased";

let charge = null;

function construire(manifest) {
  const v = encodeURIComponent(String(manifest.version || '1'));
  const polices = Array.isArray(manifest.polices) ? manifest.polices : [];
  const regles = polices.map((p) => {
    const src = `url(/fonts/${p.fichier}?v=${v}) format('woff2')`;
    const plage = p.unicodeRange ? `;unicode-range:${p.unicodeRange}` : '';
    return `@font-face{font-family:'${p.famille}';font-style:${p.style || 'normal'};font-weight:${p.poids || '400'};font-display:${p.display || 'swap'};src:${src}${plage}}`;
  });
  const classes = polices
    .filter((p) => p.icones)
    .map((p) => `.${p.famille.toLowerCase().replace(/\s+/g, '-')}{font-family:'${p.famille}';${CLASSE_ICONES}}`);
  return {
    disponible: regles.length > 0,
    version: manifest.version,
    css: regles.concat(classes).join(''),
    preloads: polices.filter((p) => p.preload).map((p) => `/fonts/${p.fichier}?v=${v}`),
    icones: new Set(Array.isArray(manifest.icones) ? manifest.icones : []),
  };
}

/** Lecture unique, mise en cache. Ne jette jamais. */
function charger() {
  if (charge) return charge;
  try {
    charge = construire(JSON.parse(fs.readFileSync(MANIFEST, 'utf8')));
  } catch (e) {
    charge = { disponible: false, version: null, css: '', preloads: [], icones: new Set() };
  }
  return charge;
}

/** Pour les tests. */
function reinitialiser() { charge = null; }

module.exports = { charger, construire, reinitialiser, MANIFEST };
