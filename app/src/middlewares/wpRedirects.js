'use strict';

/**
 * WordPress -> Node.js 301 redirect middleware.
 *
 * Handles the URL migration from the old WordPress/WooCommerce site
 * (carpartsfrance.fr) to the new Express application.
 *
 * Patterns handled:
 *   1. Exact static redirects (page-to-page)
 *   2. /product-category/[slug]  ->  /categorie/[slug]
 *   3. /wp-content/*, /feed/*, /xmlrpc.php, /wp-admin, etc. -> 410 Gone
 *
 * NOTE: /en/ URLs are now handled by the i18n middleware (not redirected).
 */

// ── 1. Exact static redirects ────────────────────────────────────────────────
const EXACT_REDIRECTS = {
  '/shop':                '/produits',
  '/shop/':               '/produits',
  '/boutique':            '/produits',
  '/boutique/':           '/produits',
  '/cart':                '/panier',
  '/cart/':               '/panier',
  '/panier/':             '/panier',
  '/checkout':            '/commande',
  '/checkout/':           '/commande',
  '/my-account':          '/compte',
  '/my-account/':         '/compte',
  '/mon-compte':          '/compte',
  '/mon-compte/':         '/compte',
  '/about':               '/',
  '/about/':              '/',
  '/a-propos':            '/',
  '/a-propos/':           '/',
  '/mentions-legales':    '/legal/mentions-legales',
  '/mentions-legales/':   '/legal/mentions-legales',
  '/privacy-policy':      '/legal/confidentialite',
  '/privacy-policy/':     '/legal/confidentialite',
  '/politique-de-confidentialite':  '/legal/confidentialite',
  '/politique-de-confidentialite/': '/legal/confidentialite',
  // Le footer + plusieurs templates pointaient vers /legal/politique-de-confidentialite
  // qui n'existe pas (vrai slug = /legal/confidentialite). Tant que les vues ne sont
  // pas toutes corrigées, on garde un 301 ici pour absorber les liens externes
  // existants (newsletter, emails, anciens partages sociaux).
  '/legal/politique-de-confidentialite':  '/legal/confidentialite',
  '/legal/politique-de-confidentialite/': '/legal/confidentialite',
  '/cgv':                 '/legal/cgv',
  '/cgv/':                '/legal/cgv',
  '/conditions-generales-de-vente':  '/legal/cgv',
  '/conditions-generales-de-vente/': '/legal/cgv',

  // Redirections migration SEO depuis carpartsfrance.fr
  '/probleme-mecatronique-dsg-7-0am-guide-complet':   '/blog/mecatronique-dsg7-dq200-diagnostic-prix-remplacement',
  '/probleme-mecatronique-dsg-7-0am-guide-complet/':  '/blog/mecatronique-dsg7-dq200-diagnostic-prix-remplacement',
  '/remplacement-mecatronique-dsg-7':                  '/blog/mecatronique-dsg7-dq200-diagnostic-prix-remplacement',
  '/remplacement-mecatronique-dsg-7/':                 '/blog/mecatronique-dsg7-dq200-diagnostic-prix-remplacement',
  '/boite-dsg-7-bloquee-en-neutre-causes-et-solutions':  '/blog/mecatronique-dsg7-dq200-diagnostic-prix-remplacement',
  '/boite-dsg-7-bloquee-en-neutre-causes-et-solutions/': '/blog/mecatronique-dsg7-dq200-diagnostic-prix-remplacement',
  '/reparation-mecatronique-dsg-7':                    '/blog/mecatronique-dsg7-dq200-diagnostic-prix-remplacement',
  '/reparation-mecatronique-dsg-7/':                   '/blog/mecatronique-dsg7-dq200-diagnostic-prix-remplacement',
  '/mecatronique-dsg-6':                               '/blog/mecatronique-dsg6-dq250-diagnostic-prix-remplacement',
  '/mecatronique-dsg-6/':                              '/blog/mecatronique-dsg6-dq250-diagnostic-prix-remplacement',
  '/product/mecatronique-dsg-7-dq200-pour-volskwagen-audi-seat-et-skoda':   '/product/mecatronique-dsg-7-dq200-pour-volkswagen-audi-seat-et-skoda/',
  '/product/mecatronique-dsg-7-dq200-pour-volskwagen-audi-seat-et-skoda/':  '/product/mecatronique-dsg-7-dq200-pour-volkswagen-audi-seat-et-skoda/',

  // ─────────────────────────────────────────────────────────────────────
  // Récupération trafic SEO carpartsfrance.fr — ajouté le 2026-04-30
  // suite audit GSC (top URLs en 404 après migration).
  //
  // Audit BDD effectué le 2026-04-30 contre /sitemap-blog.xml (304 articles
  // publiés). Statut des cibles ci-dessous :
  //
  //   ✅ Existe déjà :
  //     - mecatronique-dsg7-dq200-diagnostic-prix-remplacement
  //     - actionneur-boite-transfert-bmw-x3-e83-pignon-reparation     (remap)
  //     - pont-arriere-audi-a3-quattro-reconditionnement-haldex       (remap)
  //     - boite-de-transfert-bmw-x3-e83-prix-budget-comparatif        (remap x2)
  //
  //   ❌ À recréer en /admin/blog/nouveau (12 articles) — la redirection
  //   est active mais mène à un 404 jusqu'à la recréation. C'est volontaire :
  //   un 404 sur la nouvelle cible n'est pas pire qu'un 404 sur l'URL legacy
  //   WordPress, et dès que l'article est créé avec le bon slug, la
  //   redirection fonctionne sans redéploiement :
  //     - embrayage-dsg-7-double-fonctionnement-et-problemes-courants
  //     - demonter-phare-audi-a3-8v
  //     - moteur-porsche-cayenne-4-8-v8
  //     - haldex-audi-guide-symptomes-et-prix
  //     - problemes-cylindre-moteurs-porsche
  //     - moteur-porsche-cayenne-3-0-diesel
  //     - calibrage-boite-de-transfert-bmw-x3
  //     - boite-de-transfert-porsche-macan
  //     - boite-de-transfert-range-rover
  //     - boite-de-transfert-chevrolet-captiva
  //     - bruit-pont-avant-bmw-x1
  //     - calculateur-boite-automatique-310320749r
  // ─────────────────────────────────────────────────────────────────────
  '/embrayage-dsg-7-double-fonctionnement-et-problemes-courants':
    '/blog/embrayage-dsg-7-double-fonctionnement-et-problemes-courants',
  '/embrayage-dsg-7-double-fonctionnement-et-problemes-courants/':
    '/blog/embrayage-dsg-7-double-fonctionnement-et-problemes-courants',

  '/demonter-phare-audi-a3-8v':  '/blog/demonter-phare-audi-a3-8v',
  '/demonter-phare-audi-a3-8v/': '/blog/demonter-phare-audi-a3-8v',

  '/moteur-porsche-cayenne-4-8-v8':  '/blog/moteur-porsche-cayenne-4-8-v8',
  '/moteur-porsche-cayenne-4-8-v8/': '/blog/moteur-porsche-cayenne-4-8-v8',

  '/haldex-audi-guide-symptomes-et-prix':  '/blog/haldex-audi-guide-symptomes-et-prix',
  '/haldex-audi-guide-symptomes-et-prix/': '/blog/haldex-audi-guide-symptomes-et-prix',

  '/les-problemes-de-cylindre-sur-les-moteurs-porsche-causes-symptomes-et-solutions':
    '/blog/problemes-cylindre-moteurs-porsche',
  '/les-problemes-de-cylindre-sur-les-moteurs-porsche-causes-symptomes-et-solutions/':
    '/blog/problemes-cylindre-moteurs-porsche',

  '/moteur-porsche-cayenne-3-0-diesel':  '/blog/moteur-porsche-cayenne-3-0-diesel',
  '/moteur-porsche-cayenne-3-0-diesel/': '/blog/moteur-porsche-cayenne-3-0-diesel',

  '/calibrage-boite-de-transfert-bmw-x3':  '/blog/calibrage-boite-de-transfert-bmw-x3',
  '/calibrage-boite-de-transfert-bmw-x3/': '/blog/calibrage-boite-de-transfert-bmw-x3',

  // Remap → article existant le plus proche en attendant un article générique BMW
  '/boite-de-transfert-bmw-2':  '/blog/boite-de-transfert-bmw-x3-e83-prix-budget-comparatif',
  '/boite-de-transfert-bmw-2/': '/blog/boite-de-transfert-bmw-x3-e83-prix-budget-comparatif',

  '/boite-de-transfert-porsche-macan':  '/blog/boite-de-transfert-porsche-macan',
  '/boite-de-transfert-porsche-macan/': '/blog/boite-de-transfert-porsche-macan',

  // Remap → article existant (slug proche : "actionneur-boite-transfert-..." sans le "de")
  '/actionneur-boite-de-transfert-bmw-x3-e83':  '/blog/actionneur-boite-transfert-bmw-x3-e83-pignon-reparation',
  '/actionneur-boite-de-transfert-bmw-x3-e83/': '/blog/actionneur-boite-transfert-bmw-x3-e83-pignon-reparation',

  '/remplacer-mecatronique-dsg-7':  '/blog/mecatronique-dsg7-dq200-diagnostic-prix-remplacement',
  '/remplacer-mecatronique-dsg-7/': '/blog/mecatronique-dsg7-dq200-diagnostic-prix-remplacement',

  '/boite-de-transfert-range-rover':  '/blog/boite-de-transfert-range-rover',
  '/boite-de-transfert-range-rover/': '/blog/boite-de-transfert-range-rover',

  // Remap → article existant (préfixe identique, suffixe "-reconditionnement-haldex")
  '/pont-arriere-aud-i-a3-quattro':  '/blog/pont-arriere-audi-a3-quattro-reconditionnement-haldex',
  '/pont-arriere-aud-i-a3-quattro/': '/blog/pont-arriere-audi-a3-quattro-reconditionnement-haldex',

  // Remap → article existant le plus proche (même véhicule, même thème)
  '/boite-de-transfert-bmw-x3-e83-symptomes-et-remplacement':
    '/blog/boite-de-transfert-bmw-x3-e83-prix-budget-comparatif',
  '/boite-de-transfert-bmw-x3-e83-symptomes-et-remplacement/':
    '/blog/boite-de-transfert-bmw-x3-e83-prix-budget-comparatif',

  '/boite-de-transfert-chevrolet-captiva':  '/blog/boite-de-transfert-chevrolet-captiva',
  '/boite-de-transfert-chevrolet-captiva/': '/blog/boite-de-transfert-chevrolet-captiva',

  '/bruit-pont-avant-bmw-x1':  '/blog/bruit-pont-avant-bmw-x1',
  '/bruit-pont-avant-bmw-x1/': '/blog/bruit-pont-avant-bmw-x1',

  '/calculateur-boite-automatique-compatible-310320749r-edc-dc4':
    '/blog/calculateur-boite-automatique-310320749r',
  '/calculateur-boite-automatique-compatible-310320749r-edc-dc4/':
    '/blog/calculateur-boite-automatique-310320749r',

  // PDF technique WordPress supprimé → article blog équivalent
  '/wp-content/uploads/2025/12/Revue-technique-Mecatronique-dsg-7-DQ200-0AM.pdf':
    '/blog/mecatronique-dsg7-dq200-diagnostic-prix-remplacement',

  // Duplicate content L538 vs L538-AWD : les 2 modèles partagent les mêmes
  // produits en DB et ont des titres quasi-identiques. On consolide vers
  // la version "parent" L538 pour résoudre les 2 alertes Semrush
  // "duplicate content" + "duplicate title tags".
  '/pieces-auto/land-rover/range-rover-evoque-l538-awd':
    '/pieces-auto/land-rover/range-rover-evoque-l538',
  '/pieces-auto/land-rover/range-rover-evoque-l538-awd/':
    '/pieces-auto/land-rover/range-rover-evoque-l538',
};

// ── 2. WordPress artifact patterns -> 410 Gone ──────────────────────────────
const GONE_PATTERNS = [
  /^\/wp-content\//i,
  /^\/wp-includes\//i,
  /^\/wp-admin/i,
  /^\/wp-login/i,
  /^\/wp-json\//i,
  /^\/wp-cron\.php/i,
  /^\/xmlrpc\.php/i,
  /^\/feed\/?$/i,
  /^\/feed\//i,
  /^\/comments\/feed/i,
  /^\/author\//i,
  /^\/tag\//i,
  /^\/\?p=\d+/i,
  /^\/\?page_id=\d+/i,
  /^\/\?attachment_id=\d+/i,
  /^\/trackback\//i,
];

// ── 3. Dynamic pattern redirects (non-/en/ only) ────────────────────────────
const DYNAMIC_REDIRECTS = [
  // /product-category/[slug]  ->  /categorie/[slug]
  {
    pattern: /^\/product-category\/([^/?#]+)\/?$/i,
    target: (match) => `/categorie/${match[1].toLowerCase()}`,
  },
  // /categorie/[slug]/  (trailing slash normalisation)
  {
    pattern: /^\/categorie\/([^/?#]+)\/$/i,
    target: (match) => `/categorie/${match[1].toLowerCase()}`,
  },
  // /product/[slug] (without trailing slash) -> /product/[slug]/
  {
    pattern: /^\/product\/([^/?#]+)$/i,
    target: (match) => `/product/${match[1].toLowerCase()}/`,
  },
  // FR singulier WooCommerce: /produit/[slug]  ->  /product/[slug]/
  {
    pattern: /^\/produit\/([^/?#]+)\/?$/i,
    target: (match) => `/product/${match[1].toLowerCase()}/`,
  },
  // FR pluriel d'un slug produit qui devrait pointer vers la fiche.
  // /produits/[slug]  ->  /product/[slug]/  (note : /produits sans slug = listing,
  // déjà géré par le router donc on capture seulement avec slug derrière).
  {
    pattern: /^\/produits\/([^/?#]+)\/?$/i,
    target: (match) => `/product/${match[1].toLowerCase()}/`,
  },
  // Catégories WP fréquentes : /categorie-produit/[slug]
  {
    pattern: /^\/categorie-produit\/([^/?#]+)\/?$/i,
    target: (match) => `/categorie/${match[1].toLowerCase()}`,
  },
  // /shop/[slug] WC legacy
  {
    pattern: /^\/shop\/([^/?#]+)\/?$/i,
    target: (match) => `/product/${match[1].toLowerCase()}/`,
  },
  // /boutique/[slug] (FR shop)
  {
    pattern: /^\/boutique\/([^/?#]+)\/?$/i,
    target: (match) => `/product/${match[1].toLowerCase()}/`,
  },
  // Tags WP: /tag-produit/[slug]  ->  recherche /produits?q=[slug]
  {
    pattern: /^\/(?:tag|tag-produit|product_tag)\/([^/?#]+)\/?$/i,
    target: (match) => `/produits?q=${encodeURIComponent(match[1])}`,
  },
  // Marques véhicule WC sur autoliva : /marque/audi  ->  /pieces-auto/audi
  {
    pattern: /^\/(?:marque|marque-voiture)\/([^/?#]+)\/?$/i,
    target: (match) => `/pieces-auto/${match[1].toLowerCase()}`,
  },
  // Pages auteur WP (cas non-couvert par GONE_PATTERNS si une URL custom existe)
  {
    pattern: /^\/author\/([^/?#]+)\/?$/i,
    target: () => '/blog',
  },
  // /blog/category/[slug]  ->  /blog?category=[slug]
  {
    pattern: /^\/blog\/category\/([^/?#]+)\/?$/i,
    target: (match) => `/blog?category=${encodeURIComponent(match[1])}`,
  },
];

// ── 4. Query-string patterns: add-to-cart, p=ID, etc. ──────────────────────
//
// Ces URLs WC ne devraient jamais arriver sur le nouveau site, mais quand
// elles le font (vieux backlinks, partages…), on les neutralise proprement
// au lieu de renvoyer 200 avec page vide ou 404.
function tryQueryRedirect(req) {
  const q = req.query || {};
  // ?add-to-cart=ID → panier
  if (q['add-to-cart']) return '/panier';
  // ?remove_item=, ?undo_item=, ?empty-cart= → panier
  if (q.remove_item || q.undo_item || q['empty-cart']) return '/panier';
  // ?p=ID, ?page_id=, ?attachment_id= → home (gone géré par GONE_PATTERNS mais
  // certains crawleurs envoient ces params sur le path racine).
  if (q.p || q.page_id || q.attachment_id) return '/';
  // ?orderby=, ?per_page=, ?paged= seuls (sans path) → /produits
  if (req.path === '/' && (q.orderby || q.per_page || q.paged)) return '/produits';
  return null;
}

// ── Middleware ────────────────────────────────────────────────────────────────

function wpRedirectsMiddleware(req, res, next) {
  // Only handle GET/HEAD — POST etc. should fall through
  if (req.method !== 'GET' && req.method !== 'HEAD') return next();

  const url = req.path;

  // Skip /en/ URLs entirely — they are handled by the i18n system
  if (/^\/en(\/|$)/i.test(url)) return next();

  // 1. Exact static redirects
  const exactTarget = EXACT_REDIRECTS[url] || EXACT_REDIRECTS[url.toLowerCase()];
  if (exactTarget) {
    console.log(`[301] ${url} -> ${exactTarget}`);
    return res.redirect(301, exactTarget);
  }

  // 2. WordPress artifacts -> 410 Gone
  for (const pattern of GONE_PATTERNS) {
    if (pattern.test(url)) {
      console.log(`[410] ${url} (WordPress artifact)`);
      return res.status(410).send('410 Gone — Cette ressource WordPress n\'existe plus.');
    }
  }

  // 3. Dynamic pattern redirects
  for (const rule of DYNAMIC_REDIRECTS) {
    const match = url.match(rule.pattern);
    if (match) {
      const target = rule.target(match);
      if (target !== url) {
        console.log(`[301] ${url} -> ${target}`);
        return res.redirect(301, target);
      }
    }
  }

  // 4. Query-string-based legacy redirects (WooCommerce ?add-to-cart=, ?p=…)
  const qTarget = tryQueryRedirect(req);
  if (qTarget && qTarget !== req.originalUrl) {
    console.log(`[301-q] ${req.originalUrl} -> ${qTarget}`);
    return res.redirect(301, qTarget);
  }

  return next();
}

module.exports = wpRedirectsMiddleware;
