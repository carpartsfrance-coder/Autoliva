'use strict';

/**
 * Middleware: redirect non-www → www with 301 (permanent).
 * Only active in production when SITE_URL contains "www.".
 * Fixes Semrush "No self-referencing hreflang" and "temporary redirect" issues.
 */
function wwwCanonical(req, res, next) {
  if (process.env.NODE_ENV !== 'production') return next();

  const siteUrl = (process.env.SITE_URL || '').trim();
  if (!siteUrl) return next();

  let canonicalHost;
  try {
    canonicalHost = new URL(siteUrl).host;
  } catch (_) {
    return next();
  }

  // Only act if SITE_URL explicitly includes "www."
  if (!canonicalHost.startsWith('www.')) return next();

  const host = (typeof req.get === 'function' ? req.get('host') : (req.headers && req.headers.host)) || '';
  if (!host) return next();

  // If request host is non-www but canonical is www → 301 redirect
  if (!host.startsWith('www.') && `www.${host}` === canonicalHost) {
    const proto = req.protocol || 'https';
    const target = `${proto}://${canonicalHost}${req.originalUrl}`;
    return res.redirect(301, target);
  }

  return next();
}

module.exports = wwwCanonical;
