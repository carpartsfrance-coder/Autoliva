'use strict';

/**
 * Traduction des e-mails transactionnels.
 *
 * ── Pourquoi ne pas avoir mis des clés dans les gabarits ────────────────────
 *
 * Les e-mails représentent ~420 chaînes réparties sur trois modules JS de
 * 2 600 lignes et treize gabarits EJS, avec le texte mêlé au HTML inline
 * qu'imposent les clients de messagerie. Y injecter 420 appels `t()` produit
 * un diff illisible et une occasion de casser la version française — celle que
 * reçoivent tous les clients aujourd'hui.
 *
 * On traduit donc l'e-mail RENDU, et uniquement ses NŒUDS DE TEXTE : tout ce
 * qui se trouve entre deux balises. L'intérieur des balises — attributs,
 * styles, URLs, `<style>`, `<script>` — n'est jamais touché, ce qui rend une
 * corruption du HTML impossible par construction. Le français reste la source
 * et sert de clé ; l'allemand est une table relue.
 *
 * Une chaîne absente de la table reste en français : jamais de trou, jamais de
 * texte inventé.
 */

const DICO = require('../locales/emails-de.json');

/* `&nbsp;`, retours ligne et indentation varient au rendu ; la clé est la
   forme normalisée, pour qu'un simple reformatage du gabarit ne fasse pas
   perdre la traduction. */
function normaliser(s) {
  return String(s || '')
    .replace(/&nbsp;| /g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function traduireSegment(segment, table) {
  const cle = normaliser(segment);
  if (!cle) return null;
  const trad = table[cle];
  if (!trad) return null;
  /* On restitue l'espacement d'origine : un segment comme « Quantité : »
     porte souvent une espace significative avant la valeur qui suit. */
  const avant = segment.match(/^\s*/)[0];
  const apres = segment.match(/\s*$/)[0];
  return avant + trad + apres;
}

/** Traduit les nœuds de texte d'un HTML, sans jamais entrer dans une balise. */
function traduireHtml(html, table) {
  if (typeof html !== 'string' || !html) return html;
  let horsTexte = 0; // profondeur dans <style>/<script>
  return html.replace(/(<[^>]*>)|([^<]+)/g, (m, balise, texte) => {
    if (balise) {
      if (/^<\s*(style|script)\b/i.test(balise)) horsTexte++;
      else if (/^<\s*\/\s*(style|script)\s*>/i.test(balise)) horsTexte = Math.max(0, horsTexte - 1);
      return balise;
    }
    if (horsTexte > 0) return texte;
    const t = traduireSegment(texte, table);
    if (t) return t;
    const pfx = traduireAutourDesVariables(texte, table)
      || traduirePrefixe(texte, table) || traduireSuffixe(texte, table);
    if (pfx) return texte.match(/^\s*/)[0] + pfx + texte.match(/\s*$/)[0];
    return texte;
  });
}

/* Index des clés par longueur décroissante, pour la correspondance par
   préfixe. Construit une seule fois. */
let _clesTriees = null;
function clesTriees(table) {
  if (!_clesTriees) _clesTriees = Object.keys(table).sort((a, b) => b.length - a.length);
  return _clesTriees;
}

/* Un objet de message se termine presque toujours par une variable :
   « Confirmation de commande #CP2026-000999 ». La table contient la partie
   fixe (« Confirmation de commande # ») ; on traduit le plus long préfixe
   connu et on garde la suite telle quelle. */
function traduirePrefixe(ligne, table, profondeur) {
  const norm = normaliser(ligne);
  if (!norm) return null;
  const d = profondeur || 0;
  for (const cle of clesTriees(table)) {
    if (cle.length >= 8 && norm.startsWith(cle)) {
      const reste = norm.slice(cle.length);
      /* La suite peut être traduisible elle aussi : « Mode de livraison :
         Livraison (standard) » est un SEUL nœud de texte, deux expressions.
         Sans cette récursion la moitié restait en français. */
      const resteTraduit = (d < 4 && reste.trim())
        ? (traduireSegment(reste, table) || traduirePrefixe(reste, table, d + 1) || reste)
        : reste;
      return table[cle] + resteTraduit;
    }
  }
  return null;
}

/* Symétrique du préfixe : « Hans, votre commande est expédiée » place la
   variable AU DÉBUT. La table porte alors la partie fixe finale. */
function traduireSuffixe(ligne, table) {
  const norm = normaliser(ligne);
  if (!norm) return null;
  for (const cle of clesTriees(table)) {
    if (cle.length >= 10 && norm.endsWith(cle)) {
      return norm.slice(0, norm.length - cle.length) + table[cle];
    }
  }
  return null;
}

/* Cas général, dont préfixe et suffixe sont des cas particuliers : la
   variable est AU MILIEU — « Commande #CP2026-000999 confirmée ». On isole
   les jetons variables (numéros, montants, e-mails, URLs) et on traduit
   chaque morceau fixe qui les entoure. */
const JETON_VARIABLE = /(#[\w-]+|\b\d[\d\s.,]*(?:€|%)?|\b[\w.+-]+@[\w.-]+\b|https?:\/\/\S+)/g;

function traduireAutourDesVariables(ligne, table) {
  const norm = normaliser(ligne);
  if (!norm || !JETON_VARIABLE.test(norm)) { JETON_VARIABLE.lastIndex = 0; return null; }
  JETON_VARIABLE.lastIndex = 0;
  const parts = norm.split(JETON_VARIABLE);
  let touche = false;
  const out = parts.map((part, i) => {
    if (i % 2 === 1) return part;            // jeton variable : intact
    const cle = part.trim();
    if (!cle) return part;
    const trad = table[cle];
    if (!trad) return part;
    touche = true;
    return part.replace(cle, trad);
  });
  return touche ? out.join('') : null;
}

/** Traduit un texte simple (objet du message, version texte brut). */
function traduireTexte(texte, table) {
  if (typeof texte !== 'string' || !texte) return texte;
  const direct = table[normaliser(texte)];
  if (direct) return direct;
  return texte
    .split('\n')
    .map((ligne) => traduireSegment(ligne, table) || traduireAutourDesVariables(ligne, table)
      || traduirePrefixe(ligne, table) || traduireSuffixe(ligne, table) || ligne)
    .join('\n');
}

/**
 * Traduit un e-mail complet. `lang` différent de 'de' renvoie l'original.
 */
function traduireEmail({ subject, html, text } = {}, lang) {
  if (lang !== 'de') return { subject, html, text };
  const table = DICO && typeof DICO === 'object' ? DICO : {};
  return {
    subject: traduireTexte(subject, table),
    html: traduireHtml(html, table),
    text: traduireTexte(text, table),
  };
}

/** Langue à retenir pour un envoi : la commande prime, puis le compte. */
function langueDe({ order, user, lead } = {}) {
  const c = order && order.lang;
  if (c === 'de' || c === 'fr') return c;
  const l = lead && lead.lang;
  if (l === 'de' || l === 'fr') return l;
  const u = user && user.lang;
  if (u === 'de' || u === 'fr') return u;
  return 'fr';
}

module.exports = { traduireEmail, traduireHtml, traduireTexte, langueDe, normaliser };
