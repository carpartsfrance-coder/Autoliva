'use strict';

/**
 * Traduit le NOM DE CATÉGORIE affiché sur une fiche produit.
 *
 * ── Pourquoi ce module (09/2026) ────────────────────────────────────────────
 *
 * Sur une fiche allemande, le tableau « Eigenschaften » affichait encore
 * « Typ : Boîtes de transfert », et le fil d'Ariane « Boîtes de transfert »,
 * juste sous un titre parfaitement traduit.
 *
 * La cause n'était pas une traduction manquante : 63 des 67 catégories sont
 * DÉJÀ traduites dans `Category.localizations.de`. Simplement, la fiche
 * n'affiche pas la catégorie du document Category — elle affiche la CHAÎNE
 * `Product.category`, recopiée sur le produit, que rien ne traduisait.
 *
 * On rapproche donc les deux par le nom. Une catégorie hiérarchique
 * (« Transmission > Mécatronique ») est traduite segment par segment : si un
 * segment manque, on garde le français POUR CE SEGMENT — jamais de libellé à
 * moitié inventé.
 *
 * Le cache évite une lecture par fiche affichée ; 67 catégories changent
 * rarement, une heure suffit largement.
 */

const CACHE_TTL_MS = 60 * 60 * 1000;

/* Map<langue, Map<nomFrançaisEnMinuscules, nomTraduit>> */
let cache = null;
let cacheExpire = 0;
let chargementEnCours = null;

function normaliser(nom) {
  return String(nom || '').trim().toLowerCase();
}

async function chargerCache() {
  if (cache && cacheExpire > Date.now()) return cache;
  /* Verrou : plusieurs fiches affichées en même temps ne déclenchent qu'une
     seule lecture, pas une par requête. */
  if (chargementEnCours) return chargementEnCours;

  chargementEnCours = (async () => {
    const mongoose = require('mongoose');
    const nouvelle = new Map([['de', new Map()]]);
    try {
      if (mongoose.connection.readyState === 1) {
        const Category = require('../models/Category');
        const cats = await Category.find({}).select('name localizations.de.name').lean();
        for (const c of cats) {
          const de = c.localizations && c.localizations.de && c.localizations.de.name;
          if (c.name && de) nouvelle.get('de').set(normaliser(c.name), de);
        }
      }
    } catch (err) {
      /* Une catégorie non traduite n'est pas une panne : on garde le français
         plutôt que de casser l'affichage de la fiche. */
      console.warn('[categoryI18n] chargement impossible, on reste en francais :', err && err.message);
    }
    cache = nouvelle;
    cacheExpire = Date.now() + CACHE_TTL_MS;
    return cache;
  })();

  try {
    return await chargementEnCours;
  } finally {
    chargementEnCours = null;
  }
}

/**
 * Traduit un libellé de catégorie, y compris hiérarchique.
 * Retourne le français inchangé si la langue n'est pas gérée ou si rien ne
 * correspond.
 */
async function traduire(nomFr, langue) {
  const brut = String(nomFr || '').trim();
  if (!brut || langue !== 'de') return brut;

  const table = (await chargerCache()).get(langue);
  if (!table || !table.size) return brut;

  const direct = table.get(normaliser(brut));
  if (direct) return direct;

  if (brut.includes('>')) {
    const segments = brut.split('>').map((s) => s.trim());
    const traduits = segments.map((s) => table.get(normaliser(s)) || s);
    /* Si AUCUN segment n'a bougé, on renvoie l'original tel quel — inutile de
       reconstruire une chaîne identique avec d'autres espaces. */
    if (traduits.some((t, i) => t !== segments[i])) return traduits.join(' > ');
  }
  return brut;
}

/** Pour les tests : vide le cache. */
function viderCache() {
  cache = null;
  cacheExpire = 0;
  chargementEnCours = null;
}

module.exports = { traduire, chargerCache, viderCache };
