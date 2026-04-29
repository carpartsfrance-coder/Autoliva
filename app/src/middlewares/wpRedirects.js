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
  '/privacy-policy':      '/legal/politique-de-confidentialite',
  '/privacy-policy/':     '/legal/politique-de-confidentialite',
  '/politique-de-confidentialite':  '/legal/politique-de-confidentialite',
  '/politique-de-confidentialite/': '/legal/politique-de-confidentialite',
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
];

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

  return next();
}

module.exports = wpRedirectsMiddleware;
