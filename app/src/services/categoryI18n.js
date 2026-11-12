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
/* Map<nomFrançaisEnMinuscules, { slug, slugDe, deTraduite }> — pour construire
   le LIEN de la catégorie (fil d'Ariane de la fiche), pas seulement son nom. */
let cacheLiens = null;
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
    const liens = new Map();
    try {
      if (mongoose.connection.readyState === 1) {
        const Category = require('../models/Category');
        const cats = await Category.find({}).select('name slug localizations.de.name localizations.de.slug localizations.de.translatedAt').lean();
        for (const c of cats) {
          const loc = (c.localizations && c.localizations.de) || {};
          if (c.name && loc.name) nouvelle.get('de').set(normaliser(c.name), loc.name);
          if (c.name && c.slug) {
            liens.set(normaliser(c.name), {
              slug: c.slug,
              slugDe: loc.slug || c.slug,
              deTraduite: !!loc.translatedAt,
            });
          }
        }
      }
    } catch (err) {
      /* Une catégorie non traduite n'est pas une panne : on garde le français
         plutôt que de casser l'affichage de la fiche. */
      console.warn('[categoryI18n] chargement impossible, on reste en francais :', err && err.message);
    }
    cache = nouvelle;
    cacheLiens = liens;
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

/**
 * Chemin de la page catégorie correspondant à un nom de catégorie de fiche.
 *
 * La fiche construisait ce lien en « slugifiant » le nom français
 * (« Mécatroniques & calculateurs » → /categorie/mecatroniques-calculateurs) :
 * ce slug n'existe pas, le fil d'Ariane renvoyait une 404 — en français comme
 * en allemand. On lit donc le VRAI slug du document Category, et sous /de le
 * slug allemand (l'URL FR avec un slug allemand répondait 404 elle aussi).
 * Chaîne vide si la catégorie est inconnue : l'appelant n'affiche pas de lien.
 */
async function lienCategorie(nomFr, langue) {
  const brut = String(nomFr || '').trim();
  if (!brut) return '';
  await chargerCache();
  const table = cacheLiens;
  if (!table || !table.size) return '';

  const segments = brut.includes('>') ? brut.split('>').map((x) => x.trim()).filter(Boolean) : [brut];
  /* Nom complet d'abord, puis le segment TERMINAL : c'est lui qui porte la
     catégorie la plus précise (« Transmission > Mécatronique »). */
  const candidats = [brut, segments[segments.length - 1]];
  for (const candidat of candidats) {
    const fiche = table.get(normaliser(candidat));
    if (!fiche) continue;
    if (langue === 'de' && fiche.deTraduite) return '/de/categorie/' + encodeURIComponent(fiche.slugDe);
    return '/categorie/' + encodeURIComponent(fiche.slug);
  }
  return '';
}

/** Pour les tests : vide le cache. */
function viderCache() {
  cache = null;
  cacheLiens = null;
  cacheExpire = 0;
  chargementEnCours = null;
}

module.exports = { traduire, lienCategorie, chargerCache, viderCache };
