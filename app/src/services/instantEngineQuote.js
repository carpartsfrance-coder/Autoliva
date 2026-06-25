'use strict';

// Devis instantané : à partir d'un code moteur (renvoyé par l'API plaque),
// retourne les offres disponibles — occasion (stock Ovoko, prix marge-cible)
// et reconditionné (Asysum, échange standard). Voir scripts/gen-engine-quote-index.py
// pour la génération des index. Le runtime ne lit que ces JSON.

const path = require('path');

const occasionIndex = require(path.join(__dirname, '..', 'data', 'engineQuote', 'occasion.json'));
const remanIndex = require(path.join(__dirname, '..', 'data', 'engineQuote', 'reman.json'));

function normalizeCode(code) {
  return String(code == null ? '' : code).toUpperCase().replace(/[^A-Z0-9]/g, '');
}

// Règle de matching (devis FERME → on exige les mêmes LETTRES exactement).
// On normalise (tirets/espaces/underscores retirés), puis :
//   - match exact, OU
//   - un suffixe purement NUMÉRIQUE est toléré (c'est l'id d'annonce / n° de
//     série collé au code moteur côté catalogue Ovoko : « N47D20C-157055 »
//     == « N47D20C »).
// Une LETTRE différente = moteur différent : « N47D20A » ≠ « N47D20C ».
function codesMatch(a, b) {
  if (a === b) return true;
  if (a.length >= 3 && b.startsWith(a) && /^\d+$/.test(b.slice(a.length))) return true;
  if (b.length >= 3 && a.startsWith(b) && /^\d+$/.test(a.slice(b.length))) return true;
  return false;
}

function matchOne(index, apiCode, priceKey) {
  const nc = normalizeCode(apiCode);
  if (!nc) return null;
  if (index[nc]) return Object.assign({ codeCatalogue: nc, match: 'exact' }, index[nc]);
  let best = null;
  let bestKey = null;
  for (const key in index) {
    if (codesMatch(nc, key)) {
      const entry = index[key];
      if (best === null || entry[priceKey] < best[priceKey]) {
        best = entry;
        bestKey = key;
      }
    }
  }
  if (best) return Object.assign({ codeCatalogue: bestKey, match: 'suffix' }, best);
  return null;
}

// Renvoie les offres pour un code moteur donné. On essaie le code principal
// puis, le cas échéant, les codes candidats supplémentaires (AWN_codes_moteur).
function matchOffers(engineCode, extraCodes) {
  const codes = [engineCode].concat(Array.isArray(extraCodes) ? extraCodes : []);
  let occasion = null;
  let reman = null;
  for (const c of codes) {
    if (!occasion) occasion = matchOne(occasionIndex, c, 'prix');
    if (!reman) reman = matchOne(remanIndex, c, 'pvp');
    if (occasion && reman) break;
  }
  return {
    engineCode: normalizeCode(engineCode),
    occasion, // { prix, km, marque, modele, count, codeCatalogue, match } | null
    reman, // { pvp, consigne, dispo, label, marque, type, count, codeCatalogue, match } | null
    hasOffer: Boolean(occasion || reman),
  };
}

module.exports = { matchOffers, normalizeCode };
