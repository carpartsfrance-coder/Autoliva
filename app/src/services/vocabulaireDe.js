'use strict';

/* Vocabulaire allemand APPRIS, en base — complément de `optionsDe.json`.
 *
 * Le fichier couvre les 916 libellés d'options du catalogue au moment où on
 * l'a construit. Une option ajoutée demain avec un libellé inédit restait en
 * français : la table ne peut pas connaître un texte qui n'existe pas encore,
 * et une instance en production ne peut pas écrire dans le dépôt.
 *
 * D'où deux tables qui se complètent :
 *   — le FICHIER : relu, versionné, il fait autorité ;
 *   — la BASE : remplie par le balayage horaire pour tout ce que le fichier
 *     ignore. Consultable immédiatement par toutes les instances.
 *
 * La lecture doit rester SYNCHRONE : `localizeProduct` est appelé au rendu de
 * chaque fiche, on ne va pas interroger Mongo à chaque libellé. On garde donc
 * une copie en mémoire, rafraîchie périodiquement — un libellé traduit à
 * 14 h 42 s'affiche au plus tard cinq minutes après.
 */

const mongoose = require('mongoose');

const RAFRAICHISSEMENT_MS = 5 * 60 * 1000;

let cache = new Map();
let dernierChargement = 0;
let enCours = null;

function collection() {
  return mongoose.connection.collection('vocabulairede');
}

/** Copie mémoire, rafraîchie au plus toutes les 5 minutes. Ne jette jamais. */
function rafraichirSiBesoin() {
  if (mongoose.connection.readyState !== 1) return;
  if (Date.now() - dernierChargement < RAFRAICHISSEMENT_MS || enCours) return;
  dernierChargement = Date.now();
  enCours = collection().find({}).toArray()
    .then((docs) => {
      const m = new Map();
      for (const d of docs) if (d && d._id && d.de) m.set(String(d._id), String(d.de));
      cache = m;
    })
    .catch(() => { /* la table fichier suffit à rendre la page */ })
    .finally(() => { enCours = null; });
}

/** Traduction apprise d'un libellé, ou '' si inconnue. Synchrone. */
function traduire(fr) {
  rafraichirSiBesoin();
  return cache.get(String(fr || '').trim()) || '';
}

/** Enregistre des couples appris et met la copie mémoire à jour. */
async function enregistrer(couples, domaine) {
  const entrees = Object.entries(couples || {}).filter(([fr, de]) => fr && de);
  if (!entrees.length) return 0;
  await collection().bulkWrite(entrees.map(([fr, de]) => ({
    updateOne: {
      filter: { _id: fr },
      update: { $set: { de, domaine: domaine || 'divers', translatedAt: new Date() } },
      upsert: true,
    },
  })), { ordered: false });
  for (const [fr, de] of entrees) cache.set(fr, de);
  return entrees.length;
}

/** Pour les tests : vide la copie mémoire. */
function reinitialiser() { cache = new Map(); dernierChargement = 0; }

module.exports = { traduire, enregistrer, reinitialiser };
