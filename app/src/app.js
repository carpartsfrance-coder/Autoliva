const express = require('express');
const session = require('express-session');
const path = require('path');
const mongoose = require('mongoose');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const wpRedirects = require('./middlewares/wpRedirects');
const wwwCanonical = require('./middlewares/wwwCanonical');
const i18nMiddleware = require('./middlewares/i18n');
const brand = require('./config/brand');

const app = express();

app.disable('x-powered-by');

const isProd = process.env.NODE_ENV === 'production';
const oneDayMs = 24 * 60 * 60 * 1000;

const sessionSecret = typeof process.env.SESSION_SECRET === 'string' ? process.env.SESSION_SECRET.trim() : '';
if (isProd && (!sessionSecret || sessionSecret === 'dev_secret_change_me')) {
  throw new Error('SESSION_SECRET manquant en production');
}

app.use((req, res, next) => {
  if (isProd) {
    res.set('Strict-Transport-Security', 'max-age=15552000; includeSubDomains');
  }

  res.set('X-Content-Type-Options', 'nosniff');
  res.set('X-Frame-Options', 'DENY');
  res.set('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.set('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');

  next();
});

// trust proxy AVANT les middlewares qui dépendent de req.hostname / X-Forwarded-*
if (isProd) {
  app.set('trust proxy', 1);
}

// Canonical www redirect (301) — must be before all other routes
app.use(wwwCanonical);

function isSameOrigin(req) {
  const host = typeof req.headers.host === 'string' ? req.headers.host : '';
  if (!host) return true;

  // En développement, localhost est toujours accepté
  if (!isProd && /^localhost(:\d+)?$/.test(host)) return true;

  // Construire la liste de domaines de confiance
  const trustedHosts = new Set();

  // 1. Host header (peut déjà être le bon domaine selon le proxy)
  trustedHosts.add(host);

  // 2. X-Forwarded-Host (envoyé par certains reverse proxies)
  const fwdHost = req.headers['x-forwarded-host'];
  if (typeof fwdHost === 'string' && fwdHost) {
    fwdHost.split(',').forEach(h => trustedHosts.add(h.trim()));
  }

  // 3. SITE_URL (.env)
  const siteUrl = process.env.SITE_URL || '';
  if (siteUrl) {
    try { trustedHosts.add(new URL(siteUrl).host); } catch (_) {}
  }

  // 4. req.hostname (Express, tient compte de trust proxy)
  if (req.hostname) {
    trustedHosts.add(req.hostname);
    // Ajouter aussi hostname:port si le port est non-standard
    const port = req.headers.host && req.headers.host.includes(':')
      ? req.headers.host.split(':')[1] : '';
    if (port && port !== '443' && port !== '80') {
      trustedHosts.add(req.hostname + ':' + port);
    }
  }

  const origin = typeof req.headers.origin === 'string' ? req.headers.origin : '';
  // "null" est envoyé par certains navigateurs (Chrome derrière reverse proxy, privacy redirect, sandboxed iframe)
  // On le traite comme absent et on tombe sur le check Referer ou le fallback
  if (origin && origin !== 'null') {
    try {
      const originHost = new URL(origin).host;
      if (trustedHosts.has(originHost)) return true;
      // Comparer aussi sans le port (:443 est souvent omis par le navigateur)
      const originHostname = new URL(origin).hostname;
      for (const th of trustedHosts) {
        if (th === originHostname || th.split(':')[0] === originHostname) return true;
      }
      if (!isProd && /^localhost(:\d+)?$/.test(originHost)) return true;
      return false;
    } catch (e) {
      return false;
    }
  }

  const referer = typeof req.headers.referer === 'string' ? req.headers.referer : '';
  if (referer) {
    try {
      const refHost = new URL(referer).host;
      if (trustedHosts.has(refHost)) return true;
      const refHostname = new URL(referer).hostname;
      for (const th of trustedHosts) {
        if (th === refHostname || th.split(':')[0] === refHostname) return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  }

  // Pas d'Origin ni Referer → navigateur légitime (form submit dans certains cas)
  return true;
}

app.use((req, res, next) => {
  const method = req.method;
  const isWrite = method === 'POST' || method === 'PUT' || method === 'PATCH' || method === 'DELETE';
  if (!isWrite) return next();

  const p = typeof req.path === 'string' ? req.path : '';
  // Exclure les endpoints qui n'ont pas besoin de protection CSRF
  if (p === '/commande/paiement/webhook') return next();
  if (p === '/admin/connexion' || p === '/admin/reinitialiser' || p === '/admin/deconnexion') return next();

  const shouldProtect = /^(\/admin|\/compte|\/contact|\/devis|\/commande|\/newsletter)(\/|$)/.test(p);
  if (!shouldProtect) return next();

  if (!isSameOrigin(req)) {
    console.warn('[CSRF] Blocked:', method, p, '| Host:', req.headers.host, '| Origin:', req.headers.origin, '| Referer:', req.headers.referer, '| X-Fwd-Host:', req.headers['x-forwarded-host']);
    return res.status(403).send('Requête refusée.');
  }

  return next();
});

// En dev, on désactive upgrade-insecure-requests et HSTS : Safari les applique
// strictement même sur http://localhost, ce qui casse le chargement des CSS/JS
// (Chrome est plus permissif sur localhost mais on ne peut pas s'y fier).
app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: [
        "'self'",
        "'unsafe-inline'",
        "https://cdn.jsdelivr.net",
        "https://www.googletagmanager.com",
        "https://googletagmanager.com",
        "https://*.google-analytics.com",
        "https://www.googleadservices.com",
        "https://*.googleadservices.com",
        "https://googleads.g.doubleclick.net",
        "https://*.g.doubleclick.net",
        "https://www.google.com",
        "https://js.mollie.com",
        "https://js.scalapay.com",
      ],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      imgSrc: [
        "'self'",
        "data:",
        "https:",
      ],
      connectSrc: [
        "'self'",
        "https://*.google-analytics.com",
        "https://*.analytics.google.com",
        "https://www.googletagmanager.com",
        "https://*.g.doubleclick.net",
        "https://*.googleadservices.com",
        "https://www.google.com",
        "https://www.google.fr",
        "https://*.mollie.com",
        "https://*.scalapay.com",
      ],
      frameSrc: [
        "'self'",
        "https://www.youtube-nocookie.com",
        "https://js.mollie.com",
        "https://www.googletagmanager.com",
        "https://td.doubleclick.net",
        "https://www.google.com",
      ],
      formAction: ["'self'", "https://*.mollie.com", "https://*.scalapay.com"],
      // null = ne pas émettre la directive (important en dev sur http://localhost)
      upgradeInsecureRequests: isProd ? [] : null,
    },
  },
  // HSTS uniquement en prod derrière HTTPS. En dev, Safari mémoriserait le host
  // et refuserait le HTTP pendant 1 an.
  strictTransportSecurity: isProd ? { maxAge: 31536000, includeSubDomains: true } : false,
  crossOriginEmbedderPolicy: false,
  crossOriginResourcePolicy: { policy: 'cross-origin' },
}));

const adminLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5,
  message: 'Trop de tentatives de connexion. Réessayez dans 15 minutes.',
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/admin/connexion', adminLoginLimiter);

// Headers de sécurité sur toutes les routes /admin
app.use('/admin', (req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  // CSP basique : pas d'iframe, scripts/styles uniquement self + inline (Tailwind/EJS),
  // images self/data/https (pour les uploads et thumbnails).
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      // blob: nécessaire pour les previews d'upload via URL.createObjectURL
      // (drag & drop d'images et vidéos sur la page produit admin).
      "img-src 'self' data: blob: https:",
      "media-src 'self' blob: https:",
      "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
      "font-src 'self' https://fonts.gstatic.com data:",
      "script-src 'self' 'unsafe-inline'",
      "connect-src 'self'",
      "frame-ancestors 'none'",
      "base-uri 'self'",
      "form-action 'self'",
    ].join('; ')
  );
  next();
});

const secureCookieFromEnv =
  process.env.SESSION_COOKIE_SECURE === 'true'
    ? true
    : process.env.SESSION_COOKIE_SECURE === 'false'
      ? false
      : null;

const shouldUseSecureCookie = secureCookieFromEnv === null ? isProd : secureCookieFromEnv;

const indexRouter = require('./routes');
const productsRouter = require('./routes/products');
const categoriesRouter = require('./routes/categories');
const searchRouter = require('./routes/search');
const cartRouter = require('./routes/cart');
const accountRouter = require('./routes/account');
const newsletterRouter = require('./routes/newsletter');
const checkoutRouter = require('./routes/checkout');
const legalRouter = require('./routes/legal');
const blogRouter = require('./routes/blog');
const adminRouter = require('./routes/admin');
const mediaRouter = require('./routes/media');
const savApi = require('./routes/api/sav');
const seoController = require('./controllers/seoController');
const analyticsController = require('./controllers/analyticsController');
const siteSettings = require('./services/siteSettings');

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

app.use(express.json());
app.use(express.urlencoded({ extended: false }));

let compression = null;
try {
  compression = require('compression');
} catch (err) {
  compression = null;
}

let MongoStore = null;
try {
  MongoStore = require('connect-mongo');
} catch (err) {
  MongoStore = null;
}

if (compression) {
  app.use(compression());
}

app.get('/favicon.ico', (req, res) => {
  res.status(204).end();
});

app.use(
  session((() => {
    const sessionOptions = {
      name: 'carpartsfrance.sid',
      secret: sessionSecret || 'dev_secret_change_me',
      proxy: isProd,
      resave: false,
      saveUninitialized: false,
      rolling: true,
      cookie: {
        httpOnly: true,
        sameSite: 'lax',
        secure: shouldUseSecureCookie,
        maxAge: 30 * oneDayMs,
      },
    };

    const mongoUrl = typeof process.env.MONGODB_URI === 'string' ? process.env.MONGODB_URI.trim() : '';
    if (MongoStore && mongoUrl) {
      sessionOptions.store = MongoStore.create({
        mongoUrl,
        ttl: 30 * 24 * 60 * 60,
      });
    }

    return sessionOptions;
  })())
);

app.use((req, res, next) => {
  const originalRender = res.render;
  res.render = function patchedRender(view, options, callback) {
    let locals = options;
    let cb = callback;

    if (typeof locals === 'function') {
      cb = locals;
      locals = undefined;
    }

    if (locals && typeof locals === 'object' && Object.prototype.hasOwnProperty.call(locals, 'include')) {
      delete locals.include;
    }

    if (this && this.locals && typeof this.locals === 'object' && Object.prototype.hasOwnProperty.call(this.locals, 'include')) {
      delete this.locals.include;
    }

    return originalRender.call(this, view, locals, cb);
  };

  next();
});

app.use((req, res, next) => {
  res.locals.brand = brand;
  next();
});

app.use((req, res, next) => {
  const cart = req.session.cart || { items: {} };

  const currentUser = req.session.user && typeof req.session.user === 'object'
    ? req.session.user
    : null;

  const currentAdmin = req.session.admin && typeof req.session.admin === 'object'
    ? req.session.admin
    : null;

  const accountTypeFromUser = currentUser && currentUser.accountType === 'pro'
    ? 'pro'
    : currentUser && currentUser.accountType === 'particulier'
      ? 'particulier'
      : null;

  const accountTypeFromSession = req.session.accountType === 'pro' ? 'pro' : 'particulier';
  const accountType = accountTypeFromUser || accountTypeFromSession;

  req.session.accountType = accountType;

  const cartItemCount = Object.values(cart.items).reduce(
    (sum, item) => sum + (Number(item && item.quantity) || 0),
    0
  );

  res.locals.cartItemCount = cartItemCount;
  res.locals.searchQuery = '';
  res.locals.accountType = accountType;
  res.locals.currentPath = req.originalUrl;
  res.locals.currentUser = currentUser;
  res.locals.currentAdmin = currentAdmin;
  res.locals.newsletterSuccess = req.session && req.session.newsletterSuccess ? String(req.session.newsletterSuccess) : null;
  res.locals.newsletterError = req.session && req.session.newsletterError ? String(req.session.newsletterError) : null;
  res.locals.cartFeedback = req.session && req.session.cartFeedback && typeof req.session.cartFeedback === 'object'
    ? req.session.cartFeedback
    : null;

  if (req.session) {
    delete req.session.newsletterSuccess;
    delete req.session.newsletterError;
    delete req.session.cartFeedback;
  }

  const pathOnly = typeof req.path === 'string' ? req.path : '';
  const noIndex = /^\/(admin|panier|commande|compte)(\/|$)/.test(pathOnly);
  const siteUrl = (process.env.SITE_URL || '').toLowerCase();
  const isProduction = process.env.NODE_ENV === 'production' && siteUrl.includes('carpartsfrance.fr');
  res.locals.metaRobots = noIndex ? 'noindex, nofollow' : (isProduction ? 'index, follow' : 'noindex, nofollow');

  if (process.env.FORCE_NOINDEX === 'true') {
    res.locals.metaRobots = 'noindex, nofollow';
    res.set('X-Robots-Tag', 'noindex, nofollow');
  }

  if (!isProduction) {
    res.set('X-Robots-Tag', 'noindex, nofollow');
  }

  if (Object.prototype.hasOwnProperty.call(res.locals, 'include')) {
    delete res.locals.include;
  }

  next();
});

app.use(async (req, res, next) => {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    res.locals.siteSettings = dbConnected
      ? await siteSettings.getSiteSettingsMergedWithFallback()
      : siteSettings.buildEnvFallback();
  } catch (err) {
    res.locals.siteSettings = siteSettings.buildEnvFallback();
  }

  next();
});

app.get('/sitemap.xml', seoController.getSitemapXml);
app.get('/robots.txt', seoController.getRobotsTxt);

app.use('/media', mediaRouter);

const staticOptions = isProd
  ? { maxAge: '7d', etag: true }
  : undefined;

app.use(express.static(path.join(__dirname, '..', 'public'), staticOptions));

// SAV : exposition statique des PDF de rapports et docs uploadés
app.use('/uploads/sav-reports', express.static(path.join(__dirname, '..', '..', 'uploads', 'sav-reports')));
app.use('/uploads/sav', express.static(path.join(__dirname, '..', '..', 'uploads', 'sav')));

// WordPress -> Node.js 301 redirects (SEO migration)
app.use(wpRedirects);

// i18n: language detection from URL prefix (/en/)
app.use(i18nMiddleware);

// Analytics tracking endpoint (public, no auth)
app.post('/api/analytics/track', analyticsController.postTrackEvent);

// SAV API (REST JSON)
app.use('/api/sav', savApi.publicRouter);
app.use('/admin/api/sav', savApi.adminRouter);

// SAV — fichiers stockés en MongoDB (GridFS), avec auth contextuelle
app.use('/sav-files', require('./routes/savFiles'));

// i18n SAV : injecte tSav() et savLocale dans toutes les vues
const i18nSav = require('./services/i18nSav');
app.use(i18nSav.middleware());

// French routes (default)
app.use('/', indexRouter);
app.use('/blog', blogRouter);
app.use('/categorie', categoriesRouter);
app.use('/rechercher', searchRouter);
app.use('/produits', productsRouter);
app.use('/panier', cartRouter);
app.use('/newsletter', newsletterRouter);
app.use('/commande', checkoutRouter);
app.use('/legal', legalRouter);
app.use('/compte', accountRouter);
app.use('/admin', adminRouter);

// English routes (same routers, /en/ prefix — Express strips the mount path)
app.use('/en', indexRouter);
app.use('/en/blog', blogRouter);
app.use('/en/categorie', categoriesRouter);
app.use('/en/rechercher', searchRouter);
app.use('/en/produits', productsRouter);
app.use('/en/panier', cartRouter);
app.use('/en/newsletter', newsletterRouter);
app.use('/en/commande', checkoutRouter);
app.use('/en/legal', legalRouter);
app.use('/en/compte', accountRouter);

app.use((req, res) => {
  res.status(404).render('errors/404', {
    title: `Page introuvable - ${brand.NAME}`,
  });
});

app.use((err, req, res, next) => {
  console.error(err);

  res.status(500).render('errors/500', {
    title: `Erreur - ${brand.NAME}`,
  });
});

module.exports = app;
