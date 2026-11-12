'use strict';

/**
 * Slug d'une NOUVELLE fiche produit — audit SEO du 11/11/2026, problème 13.
 *
 * Des fiches importées ont des adresses aux lettres cassées :
 * /product/diff-rentiel-avant-mercedes-…, « arri-re », « bo-te »,
 * « r-ducteur ». Le slug arrivait tout fait dans le fichier d'import, écrit
 * par un outil qui remplace chaque lettre accentuée par un tiret au lieu de
 * la lettre sans accent. L'application le gardait tel quel : il était déjà
 * fait de [a-z0-9-].
 *
 * slugNouvelleFiche(slugFourni, nom) :
 *   - sans slug fourni : le slug du nom, accents retirés (é → e) ;
 *   - avec un slug fourni : nettoyé de la même façon, puis chaque mot
 *     accentué du nom qui s'y trouve sous sa forme cassée (« diff-rentiel »)
 *     reprend sa forme juste (« differentiel »). Le reste du slug fourni ne
 *     change pas.
 *
 * Fiches NEUVES seulement (création dans l'admin, import JSON en création) :
 * changer le slug d'une fiche existante changerait son adresse, et une fiche
 * n'a pas de redirection depuis un ancien slug.
 */

/** Même règle que le slug de l'admin : accents retirés, le reste en tirets. */
function slugify(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

/* Ce que produisait l'outil fautif : minuscules, puis tout ce qui n'est pas
   [a-z0-9] devient un tiret, lettres accentuées comprises. */
function slugCasse(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

const NON_ASCII = /[^\x00-\x7f]/;
const echapper = (texte) => texte.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Rend leur forme juste aux mots accentués du nom écrits cassés dans le slug. */
function reparerAccents(slug, nom) {
  let resultat = String(slug || '');
  if (!resultat) return '';
  const mots = String(nom || '').split(/[\s/_,;:()'’"«»+.!?]+/u).filter((m) => NON_ASCII.test(m));
  for (const mot of mots) {
    const casse = slugCasse(mot);
    const juste = slugify(mot);
    if (!casse || !juste || casse === juste) continue;
    const motif = new RegExp(`(^|-)${echapper(casse)}(?=-|$)`, 'g');
    resultat = resultat.replace(motif, `$1${juste}`);
  }
  return resultat;
}

function slugNouvelleFiche(slugFourni, nom) {
  const fourni = slugify(typeof slugFourni === 'string' ? slugFourni : '');
  if (!fourni) return slugify(typeof nom === 'string' ? nom : '') || 'produit';
  return reparerAccents(fourni, nom) || 'produit';
}

module.exports = { slugNouvelleFiche, reparerAccents, slugify };
