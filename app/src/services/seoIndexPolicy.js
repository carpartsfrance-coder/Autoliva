'use strict';

/**
 * Politique d'indexation : quelles pages sortent de Google, famille par
 * famille, derrière UN interrupteur Render.
 *
 * ── Pourquoi (plan de reprise SEO du 14/09/2026, action A5 — PR-1b) ──────────
 *
 * Google a déclassé tout le domaine le 31/08 : l'essentiel de ce qu'il pouvait
 * indexer était produit en masse (articles générés, fiches d'import, pages
 * allemandes traduites à la machine, gabarits /pieces-auto et /reference),
 * contre 2 820 pages qui portent presque toutes les visites et les ventes. Le
 * plan retire ces familles de l'index par un noindex RÉVERSIBLE, une famille à
 * la fois, et ne répond 410 qu'aux 268 articles publiés après la chute. Toutes
 * les pages restent en ligne, en vente, dans les flux Merchant et dans Ads.
 *
 * ── L'interrupteur ────────────────────────────────────────────────────────────
 *
 * Variable Render SEO_PRUNE : la liste des familles actives, séparées par des
 * virgules, parmi gone, blog, reference, pieces-auto, de, products.
 *   - ABSENTE (ou vide) : RIEN ne change, aucune page, aucun sitemap. C'est
 *     l'état au moment du merge : chaque famille s'allume ensuite à la main,
 *     une par jour, après le contrôle du lendemain.
 *   - Un mot inconnu est ignoré (et signalé dans les journaux) : une faute de
 *     frappe n'allume jamais rien par accident.
 *   - Retirer une famille la rallume dans Google au redéploiement (« Save and
 *     deploy » sur Render : process.env n'est relu qu'au démarrage).
 *
 * Familles :
 *   gone        : les 268 adresses de gone-410-blog.txt répondent 410 (le
 *                 contenu reste en base : retirer un slug de la liste le rend) ;
 *   blog        : tout article français hors des 295 gardés passe en
 *                 noindex, follow (liste BLANCHE) ;
 *   reference   : toute /reference/<réf> hors des 3 gardées, en noindex ;
 *   pieces-auto : toute /pieces-auto/* hors des 242 pages gardées, en noindex
 *                 (la racine /pieces-auto, page statique, n'est pas concernée) ;
 *   de          : toute la couche /de en noindex, pages gardées en ligne ;
 *   products    : les fiches d'import sans signal (liste d'_id) et toutes les
 *                 copies distrimotor (préfixe SKU « DM- », décision de Killian
 *                 du 14/09/2026), en noindex. N'est allumée qu'après le contrôle
 *                 Merchant Center (action A2). Le choix fait fiche par fiche
 *                 dans l'admin (seo.indexOverride) passe devant la liste.
 *
 * ── Un seul point d'application ──────────────────────────────────────────────
 *
 * La décision est posée dans res.locals.seoForceNoindex, que SEULE cette
 * politique écrit, et que partials/head.ejs fait passer devant tout metaRobots.
 * Un simple res.locals.metaRobots ne suffit pas : Express fusionne res.locals
 * PUIS les options de rendu, et les contrôleurs passent leur propre valeur
 * (productController : undefined sur une fiche publiée ; blogController : la
 * valeur en base, « index, follow » sur 1 099 articles ; blogDeController : en
 * dur). Le même texte part dans l'en-tête X-Robots-Tag : la balise et l'en-tête
 * disent toujours la même chose.
 *
 * Aucune page n'est jamais bloquée dans robots.txt : Google doit pouvoir
 * explorer une page pour y lire son noindex.
 */

const POLITIQUE = require('../data/seo/index-policy.json');
const DATES_BASCULE = require('../data/seo/dates-bascule.json');

const FAMILLES = ['gone', 'blog', 'reference', 'pieces-auto', 'de', 'products'];
const ROBOTS_NOINDEX = 'noindex, follow';

/* Les sitemaps de retrait (et les sitemaps allemands retirés) vivent huit
   semaines après la bascule : le temps que Google repasse sur chaque adresse
   et y lise le noindex ou le 410. Ensuite ils répondent 404. */
const DUREE_RETRAITS_JOURS = 56;

/* Import en lot (POST /admin/api/products/import) : au-delà de 3 fiches dans
   une même requête, les fiches CRÉÉES naissent en noindex quand « products »
   est actif. Une fiche seule et le formulaire de l'admin ne sont pas visés. */
const SEUIL_IMPORT_LOT = 3;

const OVERRIDES = new Set(['', 'index', 'noindex']);

/* ─── Listes du plan ──────────────────────────────────────────────────────── */

const BLOG_GARDER = new Set(POLITIQUE.blog.garder);
const BLOG_GARDER_LISTE = POLITIQUE.blog.garder.slice();
const BLOG_MAILLAGE = POLITIQUE.blog.maillage.slice();
const DISPARUS_FR = new Set(POLITIQUE.disparus.fr);
const DISPARUS_DE = new Set(POLITIQUE.disparus.de);
const DISPARUS_FR_LISTE = POLITIQUE.disparus.fr.slice();
const DISPARUS_DE_LISTE = POLITIQUE.disparus.de.slice();
const PIECES_AUTO_GARDER = new Set(POLITIQUE.piecesAuto.garder);
const REFERENCES_GARDER = new Set(POLITIQUE.references.garder);
const REFERENCES_GARDER_LISTE = POLITIQUE.references.garder.slice();
const PRODUITS_NOINDEX = new Set(POLITIQUE.produits.noindex);
const PREFIXES_SKU = POLITIQUE.produits.prefixesSku.map((p) => String(p).trim().toUpperCase()).filter(Boolean);

/* ─── Familles actives ─────────────────────────────────────────────────────── */

let _brut = null;
let _actives = new Set();

/**
 * Familles citées dans SEO_PRUNE. Relu à chaque appel (le coût est celui d'une
 * comparaison de chaîne : le résultat est gardé tant que la variable ne change
 * pas) — les tests peuvent ainsi basculer une famille entre deux requêtes.
 */
function famillesActives(env = process.env) {
  const brut = typeof env.SEO_PRUNE === 'string' ? env.SEO_PRUNE : '';
  if (env === process.env && brut === _brut) return _actives;

  const actives = new Set();
  const inconnus = [];
  for (const mot of brut.split(/[\s,;]+/)) {
    /* « pieces_auto » (un souligné est vite tapé dans l'écran Render) vaut
       « pieces-auto » ; tout autre mot est ignoré. */
    const m = mot.trim().toLowerCase().replace(/_/g, '-');
    if (!m) continue;
    if (FAMILLES.includes(m)) actives.add(m);
    else inconnus.push(mot);
  }

  if (env === process.env) {
    _brut = brut;
    _actives = actives;
    signalerEtat(actives, inconnus);
  }
  return actives;
}

function familleActive(nom, env) {
  return famillesActives(env).has(nom);
}

/** Clé de cache : deux états différents de l'interrupteur ne partagent rien. */
function signature(env) {
  return FAMILLES.filter((f) => famillesActives(env).has(f)).join(',');
}

/* Une ligne dans les journaux Render à chaque changement d'état : c'est ce que
   Claude lit au contrôle du lendemain pour savoir ce qui est réellement allumé. */
function signalerEtat(actives, inconnus) {
  if (inconnus.length) {
    console.warn(`[politique indexation] SEO_PRUNE : mot(s) inconnu(s) ignoré(s) : ${inconnus.join(', ')} — familles possibles : ${FAMILLES.join(', ')}`);
  }
  if (!actives.size) return;
  const details = FAMILLES.filter((f) => actives.has(f)).map((f) => {
    const jour = dateBascule(f);
    return jour ? `${f} (depuis le ${jour})` : `${f} (date de bascule absente : sitemap de retrait sans lastmod)`;
  });
  console.log(`[politique indexation] familles actives : ${details.join(', ')}`);
}

/* ─── Dates de bascule ─────────────────────────────────────────────────────── */

function cleEnv(famille) {
  return `SEO_PRUNE_SINCE_${famille.toUpperCase().replace(/-/g, '_')}`;
}

/**
 * Jour où la famille a été allumée (AAAA-MM-JJ), ou '' : la variable
 * SEO_PRUNE_SINCE_<FAMILLE> passe devant dates-bascule.json. Une date à venir
 * n'est jamais annoncée (on ne dit pas à Google qu'une page a changé avant
 * qu'elle ait changé).
 */
function dateBascule(famille, { maintenant = Date.now(), env = process.env } = {}) {
  const brut = String(env[cleEnv(famille)] || DATES_BASCULE[famille] || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(brut)) return '';
  const d = new Date(`${brut}T00:00:00Z`);
  if (Number.isNaN(d.getTime()) || d.getTime() > maintenant) return '';
  return brut;
}

/**
 * Le sitemap de retrait de la famille est-il encore servi ? Oui tant que la
 * famille est active et que ses huit semaines ne sont pas écoulées ; sans
 * date de bascule, il reste servi (sans lastmod) jusqu'à ce qu'on en pose une.
 */
function retraitsEnCours(famille, { maintenant = Date.now(), env = process.env } = {}) {
  if (!famillesActives(env).has(famille)) return false;
  const jour = dateBascule(famille, { maintenant, env });
  if (!jour) return true;
  const fin = new Date(`${jour}T00:00:00Z`).getTime() + DUREE_RETRAITS_JOURS * 24 * 3600 * 1000;
  return maintenant < fin;
}

/** Familles dont le sitemap de retrait est servi, dans l'ordre du plan. */
function famillesEnRetrait(options = {}) {
  return FAMILLES.filter((f) => retraitsEnCours(f, options));
}

/* ─── Décision par chemin (blog, /de, /reference, /pieces-auto, 410) ──────── */

function normaliserChemin(chemin) {
  let p = String(chemin || '').split('?')[0].split('#')[0];
  try { p = decodeURIComponent(p); } catch (_) { /* chemin mal encodé : tel quel */ }
  if (p.length > 1) p = p.replace(/\/+$/, '');
  return p || '/';
}

/**
 * Décision pour une adresse du site :
 *   { famille: 'gone', statut: 410, lang } — l'article n'est plus servi ;
 *   { famille, noindex: true }             — la page sort de Google ;
 *   null                                   — rien ne change.
 * Les fiches produit ne se décident pas ici (voir produitNoindex) : seul le
 * contrôleur connaît leur _id une fois le slug résolu.
 */
function decisionChemin(chemin, familles = famillesActives()) {
  if (!familles || !familles.size) return null;
  const p = normaliserChemin(chemin);
  const bas = p.toLowerCase();

  if (familles.has('gone')) {
    const fr = bas.match(/^\/blog\/([^/]+)$/);
    if (fr && DISPARUS_FR.has(fr[1])) return { famille: 'gone', statut: 410, lang: 'fr' };
    const de = bas.match(/^\/de\/blog\/([^/]+)$/);
    if (de && DISPARUS_DE.has(de[1])) return { famille: 'gone', statut: 410, lang: 'de' };
  }

  if (familles.has('de') && (bas === '/de' || bas.startsWith('/de/'))) {
    return { famille: 'de', noindex: true };
  }

  if (familles.has('blog')) {
    const m = bas.match(/^\/blog\/([^/]+)$/);
    if (m && !BLOG_GARDER.has(m[1])) return { famille: 'blog', noindex: true };
  }

  if (familles.has('reference')) {
    /* Toute écriture de la référence (0am927769g, 0AM927769G) : la page est
       la même, la décision aussi. Une référence peut contenir « / » (M48/01,
       servie sous /reference/M48%2F01) : tout ce qui suit /reference/ compte. */
    const m = p.match(/^\/reference\/(.+)$/i);
    if (m && !REFERENCES_GARDER.has(m[1].trim().toUpperCase())) return { famille: 'reference', noindex: true };
  }

  if (familles.has('pieces-auto') && bas.startsWith('/pieces-auto/') && !PIECES_AUTO_GARDER.has(bas)) {
    return { famille: 'pieces-auto', noindex: true };
  }

  return null;
}

/* ─── Fiches produit ──────────────────────────────────────────────────────── */

function normaliserOverride(valeur) {
  const v = String(valeur == null ? '' : valeur).trim().toLowerCase();
  return OVERRIDES.has(v) ? v : '';
}

/**
 * Pourquoi la politique retire (ou garde) une fiche, indépendamment de
 * l'interrupteur — l'admin l'affiche :
 *   'index' / 'noindex' : choix fait sur la fiche dans l'admin ;
 *   'liste'             : fiche d'import sans signal (liste du plan) ;
 *   'prefixe'           : copie distrimotor (SKU « DM- ») ;
 *   ''                  : la fiche reste dans Google.
 */
function motifProduit(produit) {
  if (!produit) return '';
  const override = normaliserOverride(produit.seo && produit.seo.indexOverride);
  if (override) return override;
  if (PRODUITS_NOINDEX.has(String(produit._id))) return 'liste';
  const sku = String(produit.sku || '').trim().toUpperCase();
  if (sku && PREFIXES_SKU.some((prefixe) => sku.startsWith(prefixe))) return 'prefixe';
  return '';
}

/**
 * La fiche sort-elle de Google ? Jamais tant que « products » n'est pas
 * active : couper la famille rend TOUTES les fiches à l'index d'un coup, choix
 * de l'admin compris — c'est ce que demandent les règles de retour arrière.
 */
function produitNoindex(produit, familles = famillesActives()) {
  if (!familles || !familles.has('products')) return false;
  const motif = motifProduit(produit);
  return motif === 'noindex' || motif === 'liste' || motif === 'prefixe';
}

/**
 * Ce que la politique fait de la fiche, en une phrase pour l'admin — Killian
 * voit d'où vient la décision avant de choisir « toujours indexable ».
 */
function etatProduitPourAdmin(produit) {
  const actif = familleActive('products');
  const motif = motifProduit(produit);
  const raisons = {
    noindex: 'choix fait sur cette fiche',
    liste: "fiche d'import sans visite, vente ni demande (liste du plan)",
    prefixe: 'copie mot pour mot de distrimotor.com (SKU « DM- »)',
  };
  if (motif === 'index') return { code: 'index', texte: 'Indexable : choix fait sur cette fiche, il passe devant la liste du plan.' };
  if (!raisons[motif]) return { code: 'indexable', texte: 'Indexable : la politique ne retire pas cette fiche.' };
  return actif
    ? { code: `noindex-${motif}`, texte: `Retirée de Google (noindex, follow) : ${raisons[motif]}.` }
    : { code: `attente-${motif}`, texte: `Indexable pour l'instant ; sortira de Google quand la famille « products » sera active : ${raisons[motif]}.` };
}

/* ─── Application : balise ET en-tête ─────────────────────────────────────── */

/**
 * Sort la page de Google : res.locals.seoForceNoindex (lu par head.ejs, jamais
 * écrasé par un contrôleur) et X-Robots-Tag portent le MÊME texte. Un en-tête
 * déjà plus strict (hors production, FORCE_NOINDEX : « noindex, nofollow »)
 * est conservé et recopié dans la balise — la politique ne relâche jamais rien.
 */
function marquerNoindex(res) {
  const actuel = typeof res.get === 'function' ? String(res.get('X-Robots-Tag') || '') : '';
  const valeur = /noindex/i.test(actuel) ? actuel : ROBOTS_NOINDEX;
  res.set('X-Robots-Tag', valeur);
  res.locals.seoForceNoindex = valeur;
}

/** À appeler par le contrôleur des fiches une fois le produit trouvé. */
function appliquerProduit(res, produit) {
  if (produitNoindex(produit)) marquerNoindex(res);
}

/**
 * Middleware monté avant les routes publiques. SEO_PRUNE absent : il ne fait
 * strictement rien, pas même poser une variable de vue.
 */
function middleware(req, res, next) {
  const familles = famillesActives();
  if (!familles.size) return next();

  /* hreflang : quand la couche allemande sort de Google, les pages ne la
     déclarent plus comme alternative (head.ejs). Les données hreflangTags
     restent entières : le sélecteur FR/DE de l'en-tête et la bannière de
     suggestion de langue en vivent. x-default reste le français. */
  if (familles.has('de')) res.locals.seoHreflangSansDe = true;

  if (req.method !== 'GET' && req.method !== 'HEAD') return next();
  const decision = decisionChemin(req.path, familles);
  if (!decision) return next();

  if (decision.statut === 410) return repondreDisparu(req, res, decision);
  marquerNoindex(res);
  return next();
}

/* 410 Gone : un article publié après la chute, que rien ne peut sauver. Une
   page courte, qui renvoie vers le blog (jamais une redirection : rediriger un
   article supprimé vers /blog ou l'accueil serait un soft 404).
   Pas de « Cache-Control: public » : la page passe après la session, qui
   renvoie son cookie à chaque réponse (rolling) — un cache partagé qui la
   garderait resservirait la session d'un visiteur aux suivants. Elle garde
   donc l'en-tête de cache de toutes les pages HTML du site. */
function repondreDisparu(req, res, decision) {
  const de = decision.lang === 'de';
  marquerNoindex(res);
  return res.status(410).render('errors/410', {
    title: de ? 'Artikel nicht mehr verfügbar' : 'Article retiré',
    metaRobots: ROBOTS_NOINDEX,
    lienBlog: de ? '/de/blog' : '/blog',
    lienAccueil: de ? '/de' : '/',
    articleDe: de,
  });
}

/* ─── Articles de blog : un seul filtre pour toutes les requêtes publiques ── */

/**
 * Condition Mongo sur le slug, ou null quand rien ne change.
 *   lang 'fr', liste (défaut) : « blog » actif → seuls les 295 articles
 *     gardés ; sinon « gone » actif → tout sauf les 134 articles en 410.
 *   lang 'fr', page : l'article lui-même reste servi même en noindex ; seul
 *     le 410 l'écarte.
 *   lang 'de' : seuls les 410 allemands sont écartés ; la couche allemande
 *     entière relève de la famille « de », qui la garde en ligne.
 */
function clauseSlugBlog({ lang = 'fr', page = false } = {}, familles = famillesActives()) {
  if (!familles || !familles.size) return null;
  if (lang === 'de') {
    return familles.has('gone') ? { $nin: DISPARUS_DE_LISTE } : null;
  }
  if (!page && familles.has('blog')) return { $in: BLOG_GARDER_LISTE };
  if (familles.has('gone')) return { $nin: DISPARUS_FR_LISTE };
  return null;
}

/**
 * Filtre de TOUTE requête BlogPost publique (listes, barre latérale, blocs
 * liés, accueil, fiches, landings, sitemaps) : les 410 n'apparaissent nulle
 * part, les articles en noindex quittent les listes. SEO_PRUNE absent : le
 * filtre reçu est rendu tel quel (le même objet).
 */
function publicBlogFilter(filtre = {}, options = {}) {
  const clause = clauseSlugBlog(options);
  if (!clause) return filtre;
  const base = filtre || {};
  if (!Object.prototype.hasOwnProperty.call(base, 'slug')) return { ...base, slug: clause };
  /* Le filtre porte déjà une condition sur le slug (« pas l'article courant »,
     « pas les épinglés ») : on ajoute la nôtre à côté, sans l'écraser. */
  return { ...base, $and: [...(Array.isArray(base.$and) ? base.$and : []), { slug: clause }] };
}

/** Un article (par son slug) peut-il apparaître dans une liste publique ? */
function articleListable(slug, { lang = 'fr' } = {}) {
  const clause = clauseSlugBlog({ lang });
  if (!clause) return true;
  const s = String(slug || '').toLowerCase();
  if (clause.$in) return BLOG_GARDER.has(s);
  return !(lang === 'de' ? DISPARUS_DE : DISPARUS_FR).has(s);
}

/* Lien vers un article en 410, sous ses trois formes : /blog/x,
   https://autoliva.com/blog/x et l'ancien domaine carpartsfrance.fr — plus
   /de/blog/x dans les articles allemands. */
const LIEN_ARTICLE = /^(?:(?:https?:)?\/\/(?:www\.)?(?:autoliva\.com|carpartsfrance\.fr))?(\/de)?\/blog\/([^/?#\s]+)\/?(?:[?#].*)?$/i;

function lienVersDisparu(href) {
  let h = String(href || '').trim().replace(/&amp;/g, '&');
  try { h = decodeURI(h); } catch (_) { /* tel quel */ }
  const m = h.match(LIEN_ARTICLE);
  if (!m) return false;
  const slug = m[2].toLowerCase();
  return m[1] ? DISPARUS_DE.has(slug) : DISPARUS_FR.has(slug);
}

/**
 * Dans le corps d'un article (ou d'une fiche), un lien vers un article en 410
 * perd sa balise <a> : le texte reste, le lien mort disparaît. Rien ne change
 * tant que « gone » n'est pas actif.
 */
function retirerLiensDisparus(html) {
  if (typeof html !== 'string' || !html || !familleActive('gone')) return html;
  return html.replace(/<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi, (tout, attributs, texte) => {
    /* L'attribut href lui-même, pas un data-href ni un xlink:href. */
    const m = attributs.match(/(?:^|\s)href\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (!m) return tout;
    const href = m[1] !== undefined ? m[1] : (m[2] !== undefined ? m[2] : m[3]);
    return lienVersDisparu(href) ? texte : tout;
  });
}

/* ─── Maillage des articles gardés sans lien entrant ──────────────────────── */

/* 76 articles gardés ne reçoivent plus de lien d'aucun autre article gardé
   (65 n'en recevaient que d'articles retirés, 11 d'aucun). Le bloc « articles
   similaires » de chaque article gardé en porte donc un ou deux, répartis de
   façon stable : un hôte de la même catégorie d'abord (au plus 2 par hôte,
   pour laisser la place aux voisins habituels), sinon l'hôte le moins chargé
   du site. Calculé sur la base (les catégories y vivent), gardé 30 minutes. */
const MAILLAGE_TTL_MS = 30 * 60 * 1000;
const MAILLAGE_MAX_PAR_HOTE = 2;
let _maillage = { cle: null, at: 0, parHote: null };

function repartirMaillage(articles) {
  const hotes = articles
    .filter((a) => a && a.slug && BLOG_GARDER.has(a.slug))
    .map((a) => ({ slug: a.slug, categorie: (a.category && a.category.slug) || '', charge: 0 }))
    .sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0));
  const publies = new Set(hotes.map((h) => h.slug));
  const parHote = new Map();
  const parCharge = (a, b) => (a.charge - b.charge) || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0);

  for (const cible of BLOG_MAILLAGE.slice().sort()) {
    if (!publies.has(cible)) continue;
    const categorie = (hotes.find((h) => h.slug === cible) || {}).categorie || '';
    const autres = hotes.filter((h) => h.slug !== cible);
    let choix = categorie
      ? autres.filter((h) => h.categorie === categorie && h.charge < MAILLAGE_MAX_PAR_HOTE).sort(parCharge)[0]
      : null;
    if (!choix) choix = autres.slice().sort(parCharge)[0];
    if (!choix) continue;
    choix.charge += 1;
    if (!parHote.has(choix.slug)) parHote.set(choix.slug, []);
    parHote.get(choix.slug).push(cible);
  }
  return parHote;
}

/**
 * Slugs d'articles gardés que la page de `slugHote` doit citer dans son bloc
 * « articles similaires ». Vide tant que ni « blog » ni « gone » n'est actif :
 * ce sont eux qui font perdre ses liens à l'article.
 */
async function articlesAMailler(slugHote) {
  const familles = famillesActives();
  if (!familles.has('blog') && !familles.has('gone')) return [];
  if (!BLOG_GARDER.has(String(slugHote || ''))) return [];
  const cle = signature();
  if (!_maillage.parHote || _maillage.cle !== cle || Date.now() - _maillage.at > MAILLAGE_TTL_MS) {
    const BlogPost = require('../models/BlogPost');
    const articles = await BlogPost.find({ isPublished: true, slug: { $in: BLOG_GARDER_LISTE } })
      .select('slug category.slug')
      .lean();
    _maillage = { cle, at: Date.now(), parHote: repartirMaillage(articles) };
  }
  return (_maillage.parHote.get(String(slugHote)) || []).slice();
}

/* ─── Sitemaps ───────────────────────────────────────────────────────────── */

/** /reference : la référence reste-t-elle dans sitemap-references.xml ? */
function referenceIndexable(ref, familles = famillesActives()) {
  if (!familles.has('reference')) return true;
  return REFERENCES_GARDER.has(String(ref || '').trim().toUpperCase());
}

/** /pieces-auto : la page reste-t-elle dans sitemap-vehicles.xml ? */
function pieceAutoIndexable(chemin, familles = famillesActives()) {
  return !decisionChemin(chemin, new Set(familles.has('pieces-auto') ? ['pieces-auto'] : []));
}

/** Les 268 adresses en 410, chemins relatifs (/blog/x, /de/blog/x). */
function cheminsDisparus() {
  return [
    ...DISPARUS_FR_LISTE.map((s) => `/blog/${s}`),
    ...DISPARUS_DE_LISTE.map((s) => `/de/blog/${s}`),
  ];
}

function viderCaches() {
  _maillage = { cle: null, at: 0, parHote: null };
}

module.exports = {
  FAMILLES,
  ROBOTS_NOINDEX,
  DUREE_RETRAITS_JOURS,
  SEUIL_IMPORT_LOT,
  famillesActives,
  familleActive,
  signature,
  dateBascule,
  retraitsEnCours,
  famillesEnRetrait,
  normaliserChemin,
  decisionChemin,
  normaliserOverride,
  motifProduit,
  etatProduitPourAdmin,
  produitNoindex,
  marquerNoindex,
  appliquerProduit,
  middleware,
  clauseSlugBlog,
  publicBlogFilter,
  articleListable,
  lienVersDisparu,
  retirerLiensDisparus,
  articlesAMailler,
  repartirMaillage,
  referenceIndexable,
  pieceAutoIndexable,
  cheminsDisparus,
  referencesGardees: () => REFERENCES_GARDER_LISTE.slice(),
  articlesGardes: () => BLOG_GARDER_LISTE.slice(),
  viderCaches,
};
