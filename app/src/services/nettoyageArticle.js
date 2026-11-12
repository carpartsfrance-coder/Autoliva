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
 *
 * ── Audit du 25/09/2026, sur les 168 articles gardés ─────────────────────────
 *
 *   - un en-tête YAML (« title: … slug: … metaTitle: … primaryKeyword: … »)
 *     affiché en tête d'article : l'en-tête de son fichier source ;
 *   - « CPF », l'ancien sigle de la marque (« Reconditionné CPF »), dans 50
 *     articles : remplacé par le nom de la marque, dans le texte seulement —
 *     jamais dans une adresse, un attribut ou du code.
 */

const { sanitizeBrandLeak } = require('./brandSanitizer');
const brand = require('../config/brand');

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

/* ─── En-tête YAML (« front matter ») du fichier source ─────────────────────
   Soit un bloc « --- » … « --- » en tout début d'article, soit des lignes
   « clé: valeur » nues en tête. Il n'est retiré que s'il n'est fait QUE de
   lignes YAML et porte des clés d'en-tête connues (title, slug, metaTitle,
   primaryKeyword, tags…), écrites comme en YAML : « metaTitle: », sans
   espace avant les deux-points, là où le français écrit « Description : ».
   Un article qui commence par du texte n'est jamais touché. */
const CLES_ENTETE = new Set([
  'title', 'slug', 'excerpt', 'description', 'summary', 'metatitle', 'metadescription', 'seotitle', 'seodescription',
  'primarykeyword', 'secondarykeywords', 'keywords', 'keyword', 'tags', 'category', 'categories', 'cover',
  'coverimage', 'coverimageurl', 'image', 'ogimage', 'publishedat', 'date', 'updatedat', 'author', 'lang',
  'canonical', 'canonicalpath', 'draft', 'readingtime', 'readingtimeminutes', 'relatedproducts', 'relatedproductids',
]);
const LIGNE_CLE = /^([A-Za-z][A-Za-z0-9_-]*):(?:\s|$)/;
const FILET_YAML = /^(?:---|\.\.\.)\s*$/;

function cleEntete(ligne) {
  const m = LIGNE_CLE.exec(String(ligne || '').trim());
  return m ? m[1].toLowerCase().replace(/[-_]/g, '') : '';
}

/* Ligne qui prolonge une valeur YAML : élément de liste (« - DSG ») ou
   ligne indentée. */
function suiteYaml(ligne) {
  return /^\s*-\s+\S/.test(ligne) || /^\s+\S/.test(ligne);
}

/** Retire l'en-tête YAML placé en tête d'un Markdown ; le reste est intact. */
function retirerEnteteYaml(md) {
  if (typeof md !== 'string' || !md) return md;
  const lignes = md.replace(/\r\n?/g, '\n').split('\n');
  let debut = 0;
  while (debut < lignes.length && !lignes[debut].trim()) debut += 1;
  if (debut >= lignes.length) return md;

  /* Bloc « --- » … « --- » : TOUTES ses lignes sont du YAML, et au moins une
     clé d'en-tête connue (un filet suivi de texte n'est pas un en-tête). */
  if (lignes[debut].trim() === '---') {
    for (let fin = debut + 1; fin < Math.min(lignes.length, debut + 80); fin += 1) {
      if (!FILET_YAML.test(lignes[fin].trim())) continue;
      const bloc = lignes.slice(debut + 1, fin);
      const toutYaml = bloc.every((l) => !l.trim() || cleEntete(l) || suiteYaml(l));
      if (toutYaml && bloc.some((l) => CLES_ENTETE.has(cleEntete(l)))) {
        return lignes.slice(fin + 1).join('\n').replace(/^\s*\n/, '');
      }
      return md;
    }
    return md;
  }

  /* Lignes nues : le 1er paragraphe n'est fait QUE de lignes YAML, commence
     par une clé d'en-tête connue et en compte au moins deux ; il peut être
     suivi d'un filet « --- ». */
  if (!CLES_ENTETE.has(cleEntete(lignes[debut]))) return md;
  let fin = debut;
  const cles = new Set();
  while (fin < lignes.length && lignes[fin].trim() && !FILET_YAML.test(lignes[fin].trim())) {
    const cle = cleEntete(lignes[fin]);
    if (!cle && !suiteYaml(lignes[fin])) return md;
    if (CLES_ENTETE.has(cle)) cles.add(cle);
    fin += 1;
  }
  if (cles.size < 2) return md;
  if (fin < lignes.length && FILET_YAML.test(lignes[fin].trim())) fin += 1;
  return lignes.slice(fin).join('\n').replace(/^\s*\n/, '');
}

/* Le même en-tête, déjà converti en HTML (article saisi en HTML, ou rendu
   Markdown d'un bloc sans filet d'ouverture) : « <p>title: "…" slug: "…"
   metaTitle: "…"</p> » suivi d'un « <hr/> », en tout début de corps. Un
   paragraphe (ou titre) dont le texte commence par une clé d'en-tête et en
   compte au moins deux. */
const ENTETE_HTML = /^(\s*(?:<hr\s*\/?>\s*)*)<(p|h[1-6])\b[^>]*>([\s\S]*?)<\/\2>(\s*<hr\s*\/?>)?/i;

function texteBrut(html) {
  return String(html || '').replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, '&').trim();
}

function retirerEnteteYamlHtml(html) {
  if (typeof html !== 'string' || !html) return html;
  const m = ENTETE_HTML.exec(html);
  if (!m) return html;
  const t = texteBrut(m[3]).replace(/^-{3,}\s*/, '');
  if (!CLES_ENTETE.has(cleEntete(t))) return html;
  const cles = new Set();
  for (const c of t.matchAll(/(?:^|\s)([A-Za-z][A-Za-z0-9_-]*):(?=\s)/g)) {
    const cle = c[1].toLowerCase().replace(/[-_]/g, '');
    if (CLES_ENTETE.has(cle)) cles.add(cle);
  }
  if (cles.size < 2) return html;
  return html.slice(m[0].length).replace(/^\s+/, '');
}

/* ─── « CPF », l'ancien sigle de la marque ─────────────────────────────────
   Un mot entier en capitales (« Reconditionné CPF », « CPF-Ratgeber »),
   jamais accolé à une lettre, un chiffre, une barre ou un point suivi d'une
   lettre : « CPF2 », « /CPF/ » ou « CPF.fr » ne sont pas le sigle, ni une
   référence « CPF-1234 ». Sans effet quand la marque courante EST Car Parts
   France (même règle que sanitizeBrandLeak). */
const ANCIEN_SIGLE = /(?<![\p{L}\p{N}_\/.@])CPF(?![\p{L}\p{N}_\/@]|\.[\p{L}\p{N}]|-\p{N})/gu;

function remplacerAncienSigle(texte) {
  if (typeof texte !== 'string' || !texte || brand.KEY === 'carpartsfrance') return texte;
  return texte.replace(ANCIEN_SIGLE, brand.NAME);
}

/* Nœuds texte seulement, hors <code>, <pre>, <script>, <style> et <textarea>. */
function surTexteHorsCode(html, fn) {
  let profondeur = 0;
  return html.split(/(<[^>]+>)/).map((part) => {
    if (part.startsWith('<')) {
      const m = /^<(\/?)(code|pre|script|style|textarea)\b/i.exec(part);
      if (m) profondeur = Math.max(0, profondeur + (m[1] ? -1 : 1));
      return part;
    }
    return profondeur ? part : fn(part);
  }).join('');
}

/**
 * Titre, résumé, description Google d'un article (texte, pas de HTML) :
 * ancien sigle et ancien nom de la marque.
 */
function nettoyerTexte(texte) {
  if (typeof texte !== 'string' || !texte) return texte;
  return sanitizeBrandLeak(remplacerAncienSigle(texte));
}

/** À appliquer au Markdown AVANT sa conversion en HTML. */
function nettoyerMarkdown(md) {
  if (typeof md !== 'string' || !md) return md;
  return retirerEnteteYaml(md.replace(JSONLD_BRUT, '').replace(COMMENTAIRE_BRUT, ''));
}

/** À appliquer au HTML final de l'article (FR ou DE). */
function nettoyerHtml(html, { lang = 'fr' } = {}) {
  if (typeof html !== 'string' || !html) return html;
  let out = retirerEnteteYamlHtml(html
    .replace(JSONLD_BRUT, '').replace(JSONLD_ECHAPPE, '')
    .replace(COMMENTAIRE_BRUT, '').replace(COMMENTAIRE_ECHAPPE, '')
    .replace(/<p>\s*<\/p>/g, ''));

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
  /* « … pilier complet » : le « complet » d'origine est absorbé, sinon
     « guide pilier complet » donnait « guide complet complet » (7 articles).
     « l'article pilier » → « le guide complet », jamais « l'guide ».
     « un pilier du marché », « les piliers de… » sont du vrai français : seul
     le pilier SANS ces déterminants est du jargon de plan. */
  out = surTexte(out, (t) => t
    .replace(/\s+[—–-]\s+pilier(?:\s+complet)?\s*$/i, '')
    .replace(/\s*\(pilier\)/gi, '')
    .replace(/\s+[—–-]\s+l(?:'|’|&#39;|&#x27;)article pilier(?:\s+complet)?/gi, '')
    .replace(/\b([Dd])e l(?:'|’|&#39;|&#x27;)article pilier(?:\s+complet)?\b/g, '$1u guide complet')
    .replace(/(^|[^\p{L}])([Àà]) l(?:'|’|&#39;|&#x27;)article pilier(?:\s+complet)?\b/gu, (m, avant, a) => `${avant}${a === 'À' ? 'Au' : 'au'} guide complet`)
    .replace(/\b([Ll])(?:'|’|&#39;|&#x27;)article pilier(?:\s+complet)?\b/g, (m, l) => (l === 'L' ? 'Le guide complet' : 'le guide complet'))
    .replace(/\b([Cc])et article pilier(?:\s+complet)?\b/g, '$1e guide complet')
    .replace(/\b([Aa])rticle pilier(?:\s+complet)?\b/g, (m, a) => (a === 'A' ? 'Guide complet' : 'guide complet'))
    .replace(/\b([Dd])ossier pilier(?:\s+complet)?\b/g, '$1ossier complet')
    .replace(/\b([Gg])uide pilier(?:\s+complet)?\b/g, '$1uide complet')
    .replace(/(?<!\b(?:[Dd]es|[Ll]es)\s)\b([Pp])iliers(?=\s)/g, (m, p) => (p === 'P' ? 'Guides' : 'guides'))
    .replace(/(?<!\b[Uu]n\s)\b([Pp])ilier(?!\s+[ABC]\b)(?=\s)/g, (m, p) => (p === 'P' ? 'Guide' : 'guide'))
    .replace(/\bdans le cocon\s+[^:*\]]{0,39}[^:*\]\s]/gi, 'sur le même sujet')
    .replace(/\bcocon\s+SEO\s+/gi, 'dossier ')
    .replace(/\b([Gg])uides?\s+cocon\b/g, '$1uides')
    .replace(/\b([Cc])ocons\b/g, (m, c) => (c === 'C' ? 'Dossiers' : 'dossiers'))
    .replace(/\b([Cc])ocon\b/g, (m, c) => (c === 'C' ? 'Dossier' : 'dossier')));

  /* Préproduction coupée → même chemin sur le site. */
  out = out.replace(PREPROD, (m, pos, tout) => (tout[pos + m.length] === '/' ? '' : '/'));

  /* Ancien sigle « CPF » : texte visible seulement. */
  out = surTexteHorsCode(out, remplacerAncienSigle);

  /* Ancien nom de la marque (textes et adresses). */
  return sanitizeBrandLeak(out);
}

module.exports = {
  nettoyerMarkdown,
  nettoyerHtml,
  nettoyerTexte,
  estTitreJargon,
  retirerEnteteYaml,
  retirerEnteteYamlHtml,
  remplacerAncienSigle,
};
