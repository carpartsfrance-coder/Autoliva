'use strict';

/**
 * Retire des articles de blog, À L'AFFICHAGE, les restes de la chaîne de
 * production qui les a générés. Aucune écriture en base : l'article stocké ne
 * change pas, seul ce que voient le lecteur et Google change.
 *
 * ── Pourquoi (plan de reprise SEO du 14/09/2026, action A12) ────────────────
 *
 * Le 31/08/2026, Google a déclassé tout le site ; le profil en cause est celui
 * d'un contenu produit en masse. Plusieurs traces le disaient en toutes
 * lettres, sur la page même :
 *
 *   - 162 articles contenaient un bloc <script type="application/ld+json">
 *     collé dans leur texte : un second balisage BlogPosting, concurrent de
 *     celui de la page, voire du JSON affiché en clair ;
 *   - des titres de plan SEO montrés au lecteur : « Articles liés du cocon
 *     BMW E60/E61 », « Ces guides complètent ce satellite », « Cocons
 *     associés », et des liens « … — pilier complet » ;
 *   - « chez Car Parts France » sur 364 articles publiés sous autoliva.com ;
 *   - 138 liens vers car-parts-france-fr-refonte.onrender.com, un serveur de
 *     préproduction coupé (503) — alors que les 138 articles visés existent
 *     tous sur autoliva.com.
 *
 * Les motifs sont volontairement STRICTS : « porte-satellites » ou
 * « satellites et planétaires » sont des pièces de différentiel, pas du
 * jargon, et ne sont jamais touchés.
 */

const { sanitizeBrandLeak } = require('./brandSanitizer');

const TITRE_A_LIRE = { fr: 'À lire aussi', de: 'Weiterlesen' };

/* Bloc JSON-LD collé dans le texte, sous forme brute ou échappée par la
   conversion Markdown → HTML. La page porte déjà son propre balisage. */
const JSONLD_BRUT = /<script\b[^>]*application\/ld\+json[^>]*>[\s\S]*?<\/script>/gi;
const JSONLD_ECHAPPE = /&lt;script\b(?:(?!&gt;)[\s\S])*application\/ld\+json[\s\S]*?&lt;\/script&gt;/gi;

/* Un titre est du jargon de plan SEO s'il parle de cocon, de maillage, ou
   d'articles « satellites » — jamais de pièces satellites. */
const TITRE_JARGON = [
  /\bcocons?\b/i,
  /\bmaillage\b/i,
  /^\s*articles?\s+satellites?\b/i,
  /\bcompl[èe]tent\s+ce\s+satellite\b/i,
  /\bguides?\s+sp[ée]cialis[ée]s\s+du\s+cocon\b/i,
  /\bThemen-?Cluster\b/i,
  /\bSatelliten(?:artikel|beitr[äa]ge?)\b/i,
  /\bS[äa]ulen(?:artikel|seite)\b/i,
  /\bPillar(?:-?(?:Artikel|Seite|Page))?\b/i,
  /\b[KC]okon\b/i,
];

/* Marqueurs internes de la chaîne (« <!-- backlink:cocon-clonage-v2-… --> »),
   que la conversion Markdown affichait EN CLAIR sur 13 articles. */
const COMMENTAIRE_BRUT = /<!--[\s\S]*?-->/g;
const COMMENTAIRE_ECHAPPE = /&lt;!--[\s\S]*?--&gt;/g;

const PREPROD = /https?:\/\/car-parts-france-fr-refonte\.onrender\.com(?=[\/"'\s)<]|$)/gi;

/* Applique fn aux seuls nœuds texte d'un fragment HTML (hors balises). */
function surTexte(html, fn) {
  return html.split(/(<[^>]+>)/).map((part) => (part.startsWith('<') ? part : fn(part))).join('');
}

function estTitreJargon(texte) {
  const t = String(texte || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
  if (!t) return false;
  if (/satellites?\s+et\s+plan[ée]taires|porte-?satellites?/i.test(t)) return false;
  return TITRE_JARGON.some((re) => re.test(t));
}

/** À appliquer au Markdown AVANT sa conversion en HTML. */
function nettoyerMarkdown(md) {
  if (typeof md !== 'string' || !md) return md;
  return md.replace(JSONLD_BRUT, '').replace(COMMENTAIRE_BRUT, '');
}

/** À appliquer au HTML final de l'article (FR ou DE). */
function nettoyerHtml(html, { lang = 'fr' } = {}) {
  if (typeof html !== 'string' || !html) return html;
  let out = html
    .replace(JSONLD_BRUT, '').replace(JSONLD_ECHAPPE, '')
    .replace(COMMENTAIRE_BRUT, '').replace(COMMENTAIRE_ECHAPPE, '')
    .replace(/<p>\s*<\/p>/g, '');

  /* Titres de plan SEO → « À lire aussi ». */
  out = out.replace(/<(h[1-4])(\b[^>]*)>([\s\S]*?)<\/\1>/gi, (tout, balise, attrs, contenu) => (
    estTitreJargon(contenu) ? `<${balise}${attrs}>${TITRE_A_LIRE[lang] || TITRE_A_LIRE.fr}</${balise}>` : tout
  ));

  /* Jargon dans le texte visible : suffixes « — pilier complet », « cocon »,
     « pilier ». Seuls les NŒUDS TEXTE sont touchés — jamais une adresse de
     lien ni un attribut, où « cocon » ou « pilier » peuvent figurer dans un
     slug. « Pilier A/B/C » (montant de carrosserie) est épargné. */
  if (lang === 'de') {
    out = surTexte(out, (t) => t
      .replace(/\bS[äa]ulen(?:artikel|seite)\b/g, 'Hauptartikel')
      .replace(/\bPillar-?(?:Artikel|Seite|Page)\b/g, 'Hauptartikel')
      .replace(/\bSatelliten(?:artikel|beitr[äa]ge?)\b/g, 'Artikel')
      .replace(/\bThemen-?Cluster\b/g, 'Themenbereich')
      .replace(/\b[KC]okon\b/g, 'Themenbereich'));
  }
  out = surTexte(out, (t) => t
    .replace(/\s+[—–-]\s+pilier(?:\s+complet)?\s*$/i, '')
    .replace(/\s*\(pilier\)/gi, '')
    .replace(/\s+[—–-]\s+l(?:'|’|&#39;|&#x27;)article pilier/gi, '')
    .replace(/\b([Aa])rticle pilier\b/g, (m, a) => (a === 'A' ? 'Guide complet' : 'guide complet'))
    .replace(/\b([Dd])ossier pilier\b/g, '$1ossier complet')
    .replace(/\b([Gg])uide pilier\b/g, '$1uide complet')
    .replace(/\b([Pp])iliers(?=\s)/g, (m, p) => (p === 'P' ? 'Guides' : 'guides'))
    .replace(/\b([Pp])ilier(?!\s+[ABC]\b)(?=\s)/g, (m, p) => (p === 'P' ? 'Guide' : 'guide'))
    .replace(/\bdans le cocon\s+[^:*\]]{0,39}[^:*\]\s]/gi, 'sur le même sujet')
    .replace(/\bcocon\s+SEO\s+/gi, 'dossier ')
    .replace(/\b([Gg])uides?\s+cocon\b/g, '$1uides')
    .replace(/\b([Cc])ocons\b/g, (m, c) => (c === 'C' ? 'Dossiers' : 'dossiers'))
    .replace(/\b([Cc])ocon\b/g, (m, c) => (c === 'C' ? 'Dossier' : 'dossier')));

  /* Préproduction coupée → même chemin sur le site. */
  out = out.replace(PREPROD, (m, pos, tout) => (tout[pos + m.length] === '/' ? '' : '/'));

  /* Ancien nom de la marque (textes et adresses). */
  return sanitizeBrandLeak(out);
}

module.exports = { nettoyerMarkdown, nettoyerHtml, estTitreJargon };
