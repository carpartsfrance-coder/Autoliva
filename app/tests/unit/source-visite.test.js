/**
 * Source des visites : une visite venue de Google gratuit (ou de ChatGPT, ou
 * d'un autre site) est enregistrée et rattachée à la commande, comme un clic pub.
 *
 * Lancé par : npm test  (aucune base, aucun réseau)
 *
 * Diagnostic du 08/11/2026 : captureAttribution n'enregistrait que les URL
 * portant gclid / utm_*. Search Console : 6 450 clics gratuits sur 28 jours ;
 * l'outil de stats : 1 visite organique sur 90 jours, et les commandes de ces
 * visiteurs rangées dans « Pré-tracking ».
 */

const test = require('node:test');
const assert = require('node:assert');

const AttributionTouch = require('../../src/models/AttributionTouch');
const { classifyReferrer, isBotUserAgent } = require('../../src/services/sourceVisite');
const captureAttribution = require('../../src/middlewares/captureAttribution');
const { buildOrderAttribution } = captureAttribution;
const {
  classifyRow,
  BUCKET_ORGANIC,
  BUCKET_AI,
  BUCKET_REFERRAL,
  BUCKET_DIRECT,
  BUCKET_LEGACY,
  BUCKET_OFFLINE,
  BUCKET_GADS_NO_UTM,
} = require('../../src/services/marketingAggregations');
const { trafficBucket } = require('../../src/mcp/tools/businessOverview');

const CHROME = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1';
const GOOGLEBOT = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';

// Pas de base dans les tests : on capture les écritures AttributionTouch.
const created = [];
AttributionTouch.create = async (doc) => { created.push(doc); return doc; };

function fakeReq({ path = '/product/mecatronique-dq200/', query = {}, referer = '', ua = CHROME, session = {}, cookie = '' } = {}) {
  const qs = new URLSearchParams(query).toString();
  return {
    method: 'GET',
    path,
    originalUrl: path + (qs ? '?' + qs : ''),
    query,
    hostname: 'autoliva.com',
    ip: '203.0.113.7',
    headers: { accept: 'text/html,application/xhtml+xml', referer, 'user-agent': ua, cookie },
    session,
    sessionID: 'sid-test',
  };
}

function fakeRes() {
  const cookies = [];
  return { cookies, append: (name, value) => { if (name === 'Set-Cookie') cookies.push(value); } };
}

async function run(opts) {
  created.length = 0;
  const req = fakeReq(opts);
  const res = fakeRes();
  let nextCalled = false;
  await captureAttribution(req, res, () => { nextCalled = true; });
  assert.ok(nextCalled, 'le middleware rend toujours la main');
  return { req, res, touches: created.slice() };
}

function cookieHeader(name, value) {
  return name + '=' + encodeURIComponent(JSON.stringify(value));
}

/* ── Référents ─────────────────────────────────────────────────────────── */

test('référent : moteurs, IA, autres sites, navigation interne, paiement, direct', () => {
  const cas = [
    ['https://www.google.com/', 'organic'],
    ['https://www.google.fr/', 'organic'],
    ['android-app://com.google.android.googlequicksearchbox/', 'organic'],
    ['https://www.bing.com/search?q=dq200', 'organic'],
    ['https://duckduckgo.com/', 'organic'],
    ['https://chatgpt.com/', 'ai'],
    ['https://www.perplexity.ai/', 'ai'],
    ['https://forum-auto.caradisiac.com/topic/123', 'referral'],
    ['https://www.google.un-site-louche.com/', 'referral'],
    ['https://autoliva.com/produits', 'internal'],
    ['https://www.autoliva.com/', 'internal'],
    ['https://www.mollie.com/checkout/xyz', 'payment'],
    ['https://www.paypal.com/checkoutnow', 'payment'],
    ['', 'direct'],
  ];
  for (const [ref, attendu] of cas) {
    assert.strictEqual(classifyReferrer(ref, 'autoliva.com'), attendu, ref || '(vide)');
  }
});

test('robots : un navigateur passe, un robot déclaré ou sans user-agent non', () => {
  assert.strictEqual(isBotUserAgent(CHROME), false);
  assert.strictEqual(isBotUserAgent(GOOGLEBOT), true);
  assert.strictEqual(isBotUserAgent('curl/8.4.0'), true);
  assert.strictEqual(isBotUserAgent(''), true);
});

/* ── Middleware ────────────────────────────────────────────────────────── */

test('visite Google gratuite : enregistrée, en session et en cookie', async () => {
  const { req, res, touches } = await run({ referer: 'https://www.google.com/' });
  assert.strictEqual(touches.length, 1, 'une visite enregistrée');
  assert.strictEqual(touches[0].referrer, 'https://www.google.com/');
  assert.strictEqual(touches[0].gclid, '');
  const a = req.session.attribution;
  assert.strictEqual(a.firstTouch.referrer, 'https://www.google.com/');
  assert.strictEqual(a.lastTouch.referrer, 'https://www.google.com/');
  assert.strictEqual(a.visitTouch.referrer, 'https://www.google.com/');
  assert.ok(res.cookies.some((c) => c.startsWith('cpf_attr=')), 'cookie dernier contact posé');
});

test('navigation interne, retour de paiement, visite directe, robot : rien n\'est écrit', async () => {
  for (const opts of [
    { referer: 'https://autoliva.com/produits' },
    { referer: 'https://www.mollie.com/checkout/abc' },
    { referer: '' },
    { referer: 'https://www.google.com/', ua: GOOGLEBOT },
  ]) {
    const { req, res, touches } = await run(opts);
    assert.strictEqual(touches.length, 0, JSON.stringify(opts));
    // Rien en session : pas de « session fantôme » créée en base.
    assert.strictEqual(req.session.attribution, undefined, JSON.stringify(opts));
    assert.strictEqual(res.cookies.length, 0, JSON.stringify(opts));
  }
});

test('ancien clic pub en cookie puis retour par Google gratuit : le gclid reste pour Google Ads, la visite dit « gratuit »', async () => {
  const ancien = { gclid: 'G-123', utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'pmax_feed', landingPath: '/', referrer: '' };
  const { req, res } = await run({
    referer: 'https://www.google.com/',
    cookie: cookieHeader('cpf_attr', ancien) + '; ' + cookieHeader('cpf_attr_first', ancien),
  });
  const a = req.session.attribution;
  assert.strictEqual(a.lastTouch, undefined, 'le dernier contact pub n\'est pas écrasé');
  assert.ok(!res.cookies.some((c) => c.startsWith('cpf_attr=')), 'le cookie pub n\'est pas écrasé');
  assert.strictEqual(a.visitTouch.referrer, 'https://www.google.com/');

  const attr = buildOrderAttribution(req);
  assert.strictEqual(attr.lastTouch.gclid, 'G-123', 'import Google Ads inchangé');
  assert.strictEqual(attr.visitTouch.gclid, '');
  assert.strictEqual(attr.visitTouch.referrer, 'https://www.google.com/');
});

test('clic pub : comportement d\'avant inchangé, et la visite porte le gclid', async () => {
  const { req, touches } = await run({ query: { gclid: 'G-999', utm_source: 'google', utm_medium: 'cpc' }, referer: 'https://www.google.com/' });
  assert.strictEqual(touches.length, 1);
  assert.strictEqual(touches[0].gclid, 'G-999');
  assert.strictEqual(req.session.attribution.lastTouch.gclid, 'G-999');
  assert.strictEqual(req.session.attribution.visitTouch.gclid, 'G-999');
});

test('commande d\'une visite directe : pas de source de visite inventée', () => {
  const req = fakeReq({ session: {} });
  assert.strictEqual(buildOrderAttribution(req), undefined);
  const req2 = fakeReq({ session: { attribution: { lastTouch: { utmSource: 'newsletter', utmMedium: 'email' } } } });
  assert.strictEqual(buildOrderAttribution(req2).visitTouch, null);
});

/* ── Rangement dans le tableau marketing ──────────────────────────────── */

test('tableau marketing : chaque visite / commande tombe dans le bon canal', () => {
  const vide = { campaign: '', source: '', medium: '' };
  assert.strictEqual(classifyRow({ ...vide, hasOrganicReferrer: true, hasExternalReferrer: true }, true).bucket, BUCKET_ORGANIC);
  assert.strictEqual(classifyRow({ ...vide, hasAiReferrer: true, hasExternalReferrer: true }, true).bucket, BUCKET_AI);
  assert.strictEqual(classifyRow({ ...vide, hasExternalReferrer: true }, true).bucket, BUCKET_REFERRAL);
  assert.strictEqual(classifyRow({ ...vide }, true).bucket, BUCKET_DIRECT);
  assert.strictEqual(classifyRow({ ...vide, hasGclid: true, hasOrganicReferrer: true }, true).bucket, BUCKET_GADS_NO_UTM);
  assert.strictEqual(classifyRow({ ...vide, isOffline: true }, false).bucket, BUCKET_OFFLINE);
  assert.strictEqual(classifyRow({ ...vide, isOffline: false }, false).bucket, BUCKET_LEGACY);
  const camp = classifyRow({ campaign: 'pmax_feed', source: 'google', medium: 'cpc', hasOrganicReferrer: true }, true);
  assert.strictEqual(camp.bucket, null);
  assert.strictEqual(camp.campaign, 'pmax_feed');
});

test('vue de pilotage : mix de trafic', () => {
  assert.strictEqual(trafficBucket({ source: '', medium: '', hasOrganicReferrer: true, hasExternalReferrer: true }), 'organic');
  assert.strictEqual(trafficBucket({ source: '', medium: '', hasAiReferrer: true, hasExternalReferrer: true }), 'ai');
  assert.strictEqual(trafficBucket({ source: 'chatgpt.com', medium: '' }), 'ai');
  assert.strictEqual(trafficBucket({ source: '', medium: '', hasExternalReferrer: true }), 'referral');
  assert.strictEqual(trafficBucket({ source: '', medium: '' }), 'direct');
  assert.strictEqual(trafficBucket({ source: '', medium: '', hasGclid: true, hasOrganicReferrer: true }), 'paid_google');
  assert.strictEqual(trafficBucket({ source: 'google', medium: 'cpc' }), 'paid_google');
  assert.strictEqual(trafficBucket({ source: 'google', medium: '' }), 'organic');
  assert.strictEqual(trafficBucket({ source: 'newsletter', medium: 'email' }), 'email');
});
