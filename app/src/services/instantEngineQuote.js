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

// Les codes du catalogue occasion portent souvent un suffixe (n° de série /
// châssis) collé au code moteur : « N47D20C-157055 » -> « N47D20C157055 ».
// L'API plaque renvoie le code propre « N47D20C ». On matche donc :
//   1) en exact ; 2) sinon en préfixe (clé catalogue commençant par le code API),
//      en gardant l'offre la moins chère. Préfixe réservé aux codes >= 4 car.
//      pour éviter les faux positifs sur les codes courts (AXE, AXD…).
function matchOne(index, apiCode, priceKey) {
  const nc = normalizeCode(apiCode);
  if (!nc) return null;
  if (index[nc]) return Object.assign({ codeCatalogue: nc, match: 'exact' }, index[nc]);
  if (nc.length >= 4) {
    let best = null;
    let bestKey = null;
    for (const key in index) {
      if (key.startsWith(nc)) {
        const entry = index[key];
        if (best === null || entry[priceKey] < best[priceKey]) {
          best = entry;
          bestKey = key;
        }
      }
    }
    if (best) return Object.assign({ codeCatalogue: bestKey, match: 'prefix' }, best);
  }
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
