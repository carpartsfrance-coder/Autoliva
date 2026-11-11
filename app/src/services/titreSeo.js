'use strict';

/**
 * Titres de page (<title>) sans « … » — audit SEO du 11/11/2026, problème 5.
 *
 * ── Pourquoi ─────────────────────────────────────────────────────────────────
 *
 * Chaque contrôleur avait son propre garde-fou des 60 caractères, et tous
 * faisaient la même chose : couper le texte au caractère près, poser « … »,
 * puis recoller « | Autoliva ». Résultat mesuré sur le site le 11/11 : 8 fiches
 * sur 10 testées avaient un titre coupé, et c'est presque toujours la
 * RÉFÉRENCE qui tombait — celle que le client tape dans Google :
 *   « Pont arrière reconditionné Ford Kuga II 2.0 TDCi… | Autoliva »
 *   (la référence CV6W-4000-DB a disparu)
 *   « Différentiel avant Mercedes — 2462800200 CLA rec… | Autoliva »
 * Deux fiches voisines (33107592939 et 33107592938) finissaient avec le même
 * titre visible.
 *
 * ── La règle ─────────────────────────────────────────────────────────────────
 *
 *   1. Le titre entier + « | Autoliva » tient dans 60 caractères : on le garde.
 *   2. Sinon, on coupe ENTRE deux mots, jamais au milieu d'un mot, et on
 *      n'ajoute jamais « … ».
 *   3. Les codes (une référence comme 2462800200, CV6W-4000-DB, 95B341010 ;
 *      un code boîte ou défaut comme DQ200, P17BF) ne sont jamais coupés : la
 *      place leur est réservée d'abord, quitte à perdre la fin du nom du
 *      véhicule.
 *   4. Aucun titre ne finit par un mot vide (« pour », « et », « de »…) ni par
 *      une ponctuation pendante (« — », « : », « , », parenthèse ouverte).
 *
 * Deux façons de traiter « | Autoliva » :
 *   - suffixe 'facultatif' (fiches produit) : s'il faut couper pour le garder,
 *     on le retire — 11 caractères de plus pour la référence et le véhicule ;
 *   - suffixe 'prefere' (articles, catégories, pages véhicule) : on coupe le
 *     texte pour le garder, et on ne le retire que si le texte restant serait
 *     trop maigre. Ces pages tenaient à ce que <title> ne soit pas identique
 *     au <h1> (alertes Semrush « duplicate H1 and title »).
 */

const TITRE_MAX = 60;

/* Mots qui ne finissent jamais un titre. Comparés en minuscules, apostrophe
   finale retirée (« d' », « l' »). */
const MOTS_VIDES = new Set([
  'de', 'du', 'des', 'd', 'et', 'ou', 'pour', 'avec', 'sans', 'en', 'à', 'a',
  'au', 'aux', 'sur', 'sous', 'le', 'la', 'les', 'l', 'un', 'une', 'par',
  'dans', 'chez', 'vs', 'ainsi', 'que', 'qui', 'son', 'sa', 'ses', 'leur',
  'leurs', 'votre', 'vos', 'notre', 'nos',
]);

/* Ponctuation qui ne doit jamais pendre en fin de titre (seule ou collée). */
const PONCTUATION_FINALE = /[\s—–\-|/:;,·&+(]+$/u;

function normaliserEspaces(texte) {
  return String(texte == null ? '' : texte).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

/**
 * Un « code » ne se coupe jamais : au moins un chiffre ET au moins quatre
 * lettres ou chiffres une fois la ponctuation retirée. « DQ200 », « P17BF »,
 * « 2462800200 », « CV6W-4000-DB », « 0AM/0CW », « xDrive18d » en sont ;
 * « 2.0 », « E84 », « II », « 4x4 » n'en sont pas.
 */
function estCode(mot) {
  const brut = String(mot || '').replace(/[^\p{L}\p{N}]/gu, '');
  if (brut.length < 4 || !/\d/.test(brut)) return false;
  /* Une cylindrée (1.9, 2,0) ou un nombre seul de moins de 4 chiffres n'est
     pas une référence. */
  if (/^\d{1,2}[.,]\d{1,2}$/.test(String(mot).trim())) return false;
  return true;
}

/* Code défaut OBD : P, B, C ou U, puis un chiffre de 0 à 3 et trois
   caractères hexadécimaux (P0715, P1735, P17BF, U0100). */
function estCodeDefaut(mot) {
  const brut = String(mot || '').replace(/[^\p{L}\p{N}]/gu, '');
  return /^[PBCU][0-3][0-9A-F]{3}$/i.test(brut) && (brut.match(/\d/g) || []).length >= 2;
}

/**
 * Ce qu'on réserve AVANT de couper : la référence de la pièce (au moins
 * 4 chiffres sur au moins 6 lettres ou chiffres : 2462800200, CV6W-4000-DB,
 * 95B341010, 0AM325065, 27107646889) et les codes défaut OBD (P17BF, P0715).
 * Un code boîte (DQ200), un nom de version (xDrive18d) ou « 4MATIC » ne sont
 * pas réservés : ils restent s'ils tombent avant la coupe.
 */
function estReference(mot) {
  const brut = String(mot || '').replace(/[^\p{L}\p{N}]/gu, '');
  if (estCodeDefaut(brut)) return true;
  const chiffres = (brut.match(/\d/g) || []).length;
  return brut.length >= 6 && chiffres >= 4;
}

/* Expressions répétées sur presque toutes les fiches, qu'on retire en premier
   quand il faut gagner de la place : elles ne distinguent aucune pièce. */
/* \b ne connaît pas les lettres accentuées : bornes écrites à la main. */
const REMPLISSAGE = [
  /\s*[-–—]?\s*(?<![\p{L}\p{N}])en\s+échange\s+standard(?![\p{L}\p{N}])/giu,
  /\s*[-–—]?\s*(?<![\p{L}\p{N}])échange\s+standard(?![\p{L}\p{N}])/giu,
];

function sansRemplissage(texte) {
  let s = texte;
  for (const motif of REMPLISSAGE) s = s.replace(motif, '');
  return normaliserEspaces(s).replace(/^[\s—–\-|/:;,]+/, '');
}

function nettoyerMot(mot) {
  return String(mot || '').toLowerCase().replace(/['’]$/, '').replace(/[^\p{L}\p{N}]/gu, '');
}

/** Retire en fin de liste les mots vides et la ponctuation pendante. */
function nettoyerFin(mots) {
  const out = mots.slice();
  for (;;) {
    if (!out.length) return out;
    const dernier = out[out.length - 1];
    const sansPonctuation = dernier.replace(PONCTUATION_FINALE, '');
    if (!sansPonctuation) { out.pop(); continue; }
    if (sansPonctuation !== dernier) { out[out.length - 1] = sansPonctuation; continue; }
    if (!estCode(dernier) && MOTS_VIDES.has(nettoyerMot(dernier))) { out.pop(); continue; }
    return out;
  }
}

/** Parenthèse ouverte sans sa fermante (ou l'inverse) : on retire le signe orphelin. */
function equilibrerParentheses(mots) {
  const texte = mots.join(' ');
  const ouvertes = (texte.match(/\(/g) || []).length;
  const fermees = (texte.match(/\)/g) || []).length;
  if (ouvertes === fermees) return mots;
  return mots.map((m) => m.replace(/[()]/g, '')).filter(Boolean);
}

/**
 * Le plus long début du texte qui tient dans `budget` caractères, coupé entre
 * deux mots, en réservant d'abord la place des codes (qui gardent leur ordre :
 * ceux qui tombent après la coupe sont recollés à la fin).
 */
function couper(texte, budget, { proteger = [] } = {}) {
  const mots = normaliserEspaces(texte).split(' ').filter(Boolean);
  if (!mots.length || budget <= 0) return '';

  /* Identifiants à réserver comme une référence : ceux que l'appelant nomme
     (référence fabricant, code boîte…), et le code écrit après « — » en fin
     de nom de fiche (« Boîte de vitesses … Transporter 2.5 TDI — HNE »). */
  const aProteger = new Set((Array.isArray(proteger) ? proteger : [])
    .map((v) => String(v || '').replace(/[^\p{L}\p{N}]/gu, '').toLowerCase())
    .filter((v) => v.length >= 2));
  const identifiant = (i) => {
    const brut = mots[i].replace(/[^\p{L}\p{N}]/gu, '');
    if (aProteger.has(brut.toLowerCase())) return true;
    return i > 0 && /^[—–]$/.test(mots[i - 1]) && /^[\p{Lu}\p{N}][\p{Lu}\p{N}\-/.]{1,14}$/u.test(mots[i]);
  };

  /* À réserver : la PREMIÈRE référence (une fiche en liste souvent deux,
     quasi identiques : 33107592938 / 33107592937 — la seconde ne vient que si
     elle tient) et chaque code défaut, tant que l'ensemble tient. */
  const codes = [];
  let placeCodes = 0;
  let referenceVue = false;
  for (let i = 0; i < mots.length; i += 1) {
    if (!estReference(mots[i]) && !identifiant(i)) continue;
    const estDefaut = estCodeDefaut(mots[i]);
    if (!estDefaut && referenceVue) continue;
    const cout = mots[i].length + (codes.length ? 1 : 0);
    if (placeCodes + cout > budget) break;
    codes.push(i);
    placeCodes += cout;
    if (!estDefaut) referenceVue = true;
  }

  const longueur = (liste) => liste.reduce((n, m, k) => n + m.length + (k ? 1 : 0), 0);
  /* Un code comparé sans sa ponctuation de bord (« P17BF, » = « P17BF »). */
  const cle = (m) => String(m).replace(PONCTUATION_FINALE, '').replace(/^[(\s]+/, '');

  const gardes = [];
  for (let i = 0; i < mots.length; i += 1) {
    const restants = codes.filter((k) => k > i).map((k) => mots[k]);
    if (longueur([...gardes, mots[i], ...restants]) <= budget) {
      gardes.push(mots[i]);
      continue;
    }
    /* Le mot ne tient plus : le texte s'arrête ici. Les codes réservés qui
       restent sont recollés après. */
    break;
  }

  let resultat = equilibrerParentheses(nettoyerFin(gardes));
  for (const k of codes) {
    const code = cle(mots[k]);
    if (!code || resultat.some((m) => cle(m) === code)) continue;
    resultat = nettoyerFin(resultat);
    if (longueur([...resultat, code]) <= budget) resultat.push(code);
  }
  resultat = equilibrerParentheses(nettoyerFin(resultat));

  /* Cas extrême : un seul « mot » plus long que le budget (une URL collée…).
     On coupe au caractère, toujours sans « … ». */
  let sortie = resultat.join(' ');
  if (!sortie && mots[0]) sortie = mots[0].slice(0, budget);
  if (sortie.length > budget) sortie = sortie.slice(0, budget).replace(PONCTUATION_FINALE, '');
  return sortie;
}

/**
 * Titre de page de 60 caractères au plus, sans « … ».
 *
 * @param {string} texte    le titre voulu, SANS le suffixe de marque
 * @param {object} [options]
 * @param {string} [options.suffixe]  ex. « | Autoliva » (espace initial inclus)
 * @param {'facultatif'|'prefere'} [options.modeSuffixe]
 * @param {number} [options.max]      60 par défaut
 * @param {number} [options.minimumAvecSuffixe] longueur minimale du texte
 *        coupé pour garder le suffixe en mode « prefere » (défaut : 28)
 * @param {string[]} [options.proteger] identifiants à ne jamais couper en
 *        plus des références détectées (référence fabricant, code boîte…)
 */
function ajusterTitre(texte, options = {}) {
  const max = Number.isFinite(options.max) && options.max > 0 ? options.max : TITRE_MAX;
  const suffixe = typeof options.suffixe === 'string' ? options.suffixe : '';
  const mode = options.modeSuffixe === 'prefere' ? 'prefere' : 'facultatif';
  const minimum = Number.isFinite(options.minimumAvecSuffixe) ? options.minimumAvecSuffixe : 28;
  const opts = { proteger: options.proteger };

  const complet = normaliserEspaces(texte);
  if (!complet) return normaliserEspaces(suffixe.replace(/^\s*[|\-–—]\s*/, ''));

  if (suffixe && (complet + suffixe).length <= max) return complet + suffixe;
  if (!suffixe && complet.length <= max) return complet;

  /* Il faut gagner de la place : d'abord sans les expressions qui ne
     distinguent aucune pièce (« échange standard »), puis en coupant. */
  const allege = sansRemplissage(complet) || complet;

  if (mode === 'facultatif') {
    /* « échange standard » se cherche (« pont arrière échange standard ») :
       on le garde tant que le titre complet tient sans la marque. */
    if (complet.length <= max) return complet;
    if (allege.length <= max) return allege;
    return couper(allege, max, opts);
  }

  /* « prefere » : on garde la marque si le texte coupé reste parlant. */
  if ((allege + suffixe).length <= max) return allege + suffixe;
  const coupe = couper(allege, max - suffixe.length, opts);
  if (coupe.length >= minimum) return coupe + suffixe;
  if (complet.length <= max) return complet;
  if (allege.length <= max) return allege;
  return couper(allege, max, opts);
}

/**
 * Sépare un titre déjà suffixé (« … | Autoliva », « … - Autoliva ») en
 * texte + suffixe, pour le réajuster sans perdre la marque.
 */
function separerSuffixe(titre, nomMarque) {
  const s = normaliserEspaces(titre);
  const marque = normaliserEspaces(nomMarque);
  if (!marque) return { texte: s, suffixe: '' };
  const bas = s.toLowerCase();
  for (const sep of [' | ', ' - ', ' — ', ' – ']) {
    const fin = `${sep}${marque}`.toLowerCase();
    if (bas.endsWith(fin)) {
      return { texte: s.slice(0, s.length - fin.length).trim(), suffixe: ` | ${marque}` };
    }
  }
  return { texte: s, suffixe: '' };
}

module.exports = {
  TITRE_MAX,
  ajusterTitre,
  separerSuffixe,
  couper,
  estCode,
};
