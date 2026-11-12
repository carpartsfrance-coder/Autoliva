'use strict';

/**
 * Mise en page des messages SAV : ce qu'on garde d'un copier-coller.
 *
 * ── Pourquoi (demande de Killian, 01/10/2026) ────────────────────────────────
 *
 * Les réponses sont souvent rédigées ailleurs (ChatGPT, un document) puis
 * collées dans l'éditeur du ticket. L'éditeur envoyait bien le HTML collé, mais
 * le serveur ne gardait que le texte brut : paragraphes, listes à puces et gras
 * disparaissaient, et le client recevait un bloc compact.
 *
 * On garde donc la mise en page — mais pas n'importe laquelle. Un copier-coller
 * depuis ChatGPT ou Word traîne ses polices, ses couleurs, ses classes et
 * parfois des commentaires conditionnels : collé tel quel, le message arrive
 * dans une autre typographie que le reste du site, en gris sur blanc ou en
 * Times New Roman. On ne retient donc que la STRUCTURE (paragraphes, sauts de
 * ligne, listes, gras, italique, titres, liens, citations) et on jette tout
 * l'habillage : le message prend l'apparence du site, comme un message tapé à
 * la main.
 *
 * Le texte brut continue d'être stocké à côté (champ `contenu`) : c'est lui que
 * lisent la recherche, les extraits de la liste et les anciens messages.
 */

const sanitizeHtml = require('sanitize-html');

/* Les balises d'un texte rédigé : rien qui mette en forme par lui-même
   (ni font, ni style, ni table), rien d'interactif. */
const BALISES = [
  'p', 'br', 'div', 'span',
  'strong', 'b', 'em', 'i', 'u', 's',
  'ul', 'ol', 'li',
  'blockquote', 'code', 'pre',
  'h3', 'h4', 'h5',
  'a', 'hr',
];

const LONGUEUR_MAX = 50000;

/** Un lien cliquable, et rien d'autre : pas de javascript:, pas de data:. */
const PROTOCOLES = ['http', 'https', 'mailto', 'tel'];

/** Le HTML est-il vide de sens (que des balises et des espaces) ? */
function vide(html) {
  return !String(html || '').replace(/<[^>]*>/g, '').replace(/&nbsp;|\s/g, '').trim();
}

/**
 * Nettoie le HTML d'un message avant de l'enregistrer.
 * Rend '' si le contenu ne porte aucun texte : l'affichage retombe alors sur
 * le texte brut, comme pour les messages d'avant.
 */
function nettoyer(html) {
  const brut = String(html || '');
  if (!brut.trim() || brut.length > LONGUEUR_MAX) return '';
  const propre = sanitizeHtml(brut, {
    allowedTags: BALISES,
    /* Aucun style, aucune classe : l'habillage de ChatGPT ou de Word ne doit
       pas s'imposer à la place de celui du site. */
    allowedAttributes: { a: ['href', 'name', 'target', 'rel'] },
    allowedSchemes: PROTOCOLES,
    allowedSchemesAppliedToAttributes: ['href'],
    /* Un lien collé s'ouvre ailleurs, sans donner la main à la page ouverte. */
    transformTags: {
      a: sanitizeHtml.simpleTransform('a', { target: '_blank', rel: 'noopener noreferrer' }),
      /* Word et Google Docs emballent tout dans des <font>/<span> stylés ;
         une fois l'attribut retiré, la balise ne sert plus à rien. */
      span: 'span',
    },
    /* « nbsp » en rafale (indentations de Word) : un espace suffit. */
    textFilter: (texte) => texte.replace(/ {2,}/g, ' '),
    exclusiveFilter: (frame) => frame.tag === 'span' && !frame.text.trim(),
  }).trim();
  return vide(propre) ? '' : propre;
}

/**
 * Texte brut de secours quand l'éditeur n'a envoyé que du HTML : les sauts de
 * ligne restent des sauts de ligne (c'est ce texte que lisent la recherche et
 * les extraits).
 */
function enTexte(html) {
  const avecSauts = String(html || '')
    .replace(/<\s*br\s*\/?>/gi, '\n')
    .replace(/<\/\s*(p|div|li|h[1-6]|blockquote|tr)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '• ');
  return sanitizeHtml(avecSauts, { allowedTags: [], allowedAttributes: {} })
    .replace(/&nbsp;/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .trim();
}

module.exports = { nettoyer, enTexte, BALISES, LONGUEUR_MAX };
