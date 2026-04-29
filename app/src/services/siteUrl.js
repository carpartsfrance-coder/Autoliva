function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : value ? String(value).trim() : '';
}

function normalizeSiteUrl(value) {
  const input = getTrimmedString(value);
  if (!input) return '';
  return input.replace(/\/+$/, '');
}

function getSiteUrlFromEnv() {
  return normalizeSiteUrl(process.env.SITE_URL)
    || normalizeSiteUrl(process.env.PUBLIC_BASE_URL)
    || normalizeSiteUrl(process.env.COMPANY_WEBSITE_URL);
}

function getRequestOrigin(req) {
  if (!req) return '';

  const protoHeader = getTrimmedString(req.headers && req.headers['x-forwarded-proto']);
  const proto = protoHeader ? protoHeader.split(',')[0].trim() : (req.protocol || 'http');
  const host = typeof req.get === 'function'
    ? getTrimmedString(req.get('host'))
    : getTrimmedString(req.headers && req.headers.host);

  if (!host) return '';
  return `${proto}://${host}`;
}

function getSiteUrlFromReq(req) {
  const envUrl = getSiteUrlFromEnv();
  if (!envUrl) return getRequestOrigin(req);

  // If request is available, check for www mismatch and prefer request origin
  // so that hreflang / canonical URLs always match the domain the visitor sees.
  if (req) {
    const reqOrigin = getRequestOrigin(req);
    if (reqOrigin) {
      try {
        const envHost = new URL(envUrl).hostname;
        const reqHost = new URL(reqOrigin).hostname;
        // Same domain except one has www and the other doesn't → use request origin
        if (envHost !== reqHost) {
          const envBase = envHost.replace(/^www\./, '');
          const reqBase = reqHost.replace(/^www\./, '');
          if (envBase === reqBase) return reqOrigin;
        }
      } catch (_) {
        /* ignore parse errors */
      }
    }
  }

  return envUrl;
}

function resolveSiteUrl(value, { req, baseUrl } = {}) {
  const input = getTrimmedString(value);
  if (!input) return '';
  if (/^https?:\/\//i.test(input)) return input;

  const origin = normalizeSiteUrl(baseUrl) || getSiteUrlFromReq(req);
  if (!origin) return input;
  if (input.startsWith('/')) return `${origin}${input}`;
  return `${origin}/${input}`;
}

module.exports = {
  normalizeSiteUrl,
  getSiteUrlFromEnv,
  getSiteUrlFromReq,
  resolveSiteUrl,
};
