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
 *
 * Puis, une heure après la correction : 101 visites « Google gratuit » en une
 * heure (Search Console : ~10). Des robots déguisés en Chrome et les
 * préchargements de Google, qui ne gardent pas les cookies. Une visite
 * gratuite ne compte donc plus qu'une fois que le navigateur revient avec le
 * cookie d'attente (cpf_arr).
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
// Visite gratuite confirmée : écriture idempotente (upsert sur arrivalId).
AttributionTouch.updateOne = (filtre, maj) => {
  if (!created.some((d) => d.arrivalId && d.arrivalId === filtre.arrivalId)) created.push({ ...maj.$setOnInsert });
  return Promise.resolve({ upsertedCount: 1 });
};

function fakeReq({ path = '/product/mecatronique-dq200/', query = {}, referer = '', ua = CHROME, session = {}, cookie = '', method = 'GET', accept = 'text/html,application/xhtml+xml', extra = {} } = {}) {
  const qs = new URLSearchParams(query).toString();
  return {
    method,
    path,
    originalUrl: path + (qs ? '?' + qs : ''),
    query,
    hostname: 'autoliva.com',
    ip: '203.0.113.7',
    headers: { accept, referer, 'user-agent': ua, cookie, ...extra },
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

// Le cookie d'attente posé par la réponse, renvoyé tel quel par le navigateur.
function cookieAttente(res) {
  const c = res.cookies.find((x) => x.startsWith('cpf_arr=') && !x.startsWith('cpf_arr=;'));
  return c ? c.split(';')[0] : '';
}

test('visite Google gratuite d\'un inconnu : rien en base ni en session tant que le navigateur ne revient pas', async () => {
  const premiere = await run({ path: '/produits/mecatronique-dq200', referer: 'https://www.google.com/' });
  assert.strictEqual(premiere.touches.length, 0, 'pas encore de visite');
  assert.strictEqual(premiere.req.session.attribution, undefined, 'pas de session créée');
  const attente = premiere.res.cookies.find((c) => c.startsWith('cpf_arr='));
  assert.ok(attente, 'cookie d\'attente posé');
  assert.match(attente, /HttpOnly/);
  assert.match(attente, /Max-Age=1800/);
  assert.ok(!premiere.res.cookies.some((c) => c.startsWith('cpf_attr')), 'pas encore de cookie 90 jours');

  // Le traceur de la page (POST, quelques secondes après) rapporte le cookie : la visite compte.
  const retour = await run({ method: 'POST', path: '/api/analytics/track', accept: '*/*', referer: 'https://autoliva.com/produits/mecatronique-dq200', cookie: cookieAttente(premiere.res) });
  assert.strictEqual(retour.touches.length, 1, 'une visite enregistrée');
  const t = retour.touches[0];
  assert.strictEqual(t.referrer, 'https://www.google.com/', 'le référent de l\'arrivée, pas celui du traceur');
  assert.strictEqual(t.landingPath, '/produits/mecatronique-dq200');
  assert.strictEqual(t.confirmedArrival, true);
  assert.ok(t.arrivalId);
  assert.strictEqual(t.gclid, '');
  const a = retour.req.session.attribution;
  assert.strictEqual(a.firstTouch.referrer, 'https://www.google.com/');
  assert.strictEqual(a.lastTouch.referrer, 'https://www.google.com/');
  assert.strictEqual(a.visitTouch.referrer, 'https://www.google.com/');
  assert.ok(retour.res.cookies.some((c) => c.startsWith('cpf_attr=')), 'cookie dernier contact posé');
  assert.ok(retour.res.cookies.some((c) => c.startsWith('cpf_arr=;') && /Max-Age=0/.test(c)), 'cookie d\'attente effacé');
});

test('même arrivée confirmée deux fois (traceur + page suivante) : une seule visite', async () => {
  const premiere = await run({ referer: 'https://chatgpt.com/' });
  const cookie = cookieAttente(premiere.res);
  created.length = 0;
  const req1 = fakeReq({ method: 'POST', path: '/api/analytics/track', accept: '*/*', cookie });
  const req2 = fakeReq({ path: '/panier', referer: 'https://autoliva.com/produits/x', cookie });
  await captureAttribution(req1, fakeRes(), () => {});
  await captureAttribution(req2, fakeRes(), () => {});
  assert.strictEqual(created.length, 1);
  assert.strictEqual(created[0].referrer, 'https://chatgpt.com/');
});

test('robot déguisé en Chrome avec un faux référent Google : jamais compté', async () => {
  for (let i = 0; i < 5; i++) {
    const { req, touches } = await run({ path: `/produits/piece-${i}`, referer: 'https://www.google.com/' });
    assert.strictEqual(touches.length, 0);
    assert.strictEqual(req.session.attribution, undefined, 'aucune session fantôme');
  }
});

test('préchargement par Google (Chrome) : pas de visite, même avec le cookie d\'attente', async () => {
  const pre = await run({ referer: 'https://www.google.com/', extra: { 'sec-purpose': 'prefetch;anonymous-client-ip' } });
  assert.strictEqual(pre.touches.length, 0);
  assert.ok(cookieAttente(pre.res), 'cookie d\'attente : servira si l\'internaute clique');
  const encore = await run({ referer: 'https://www.google.com/', cookie: cookieAttente(pre.res), extra: { 'sec-purpose': 'prefetch' } });
  assert.strictEqual(encore.touches.length, 0, 'un préchargement ne confirme rien');
  // L'internaute clique : la page préchargée s'affiche, le traceur rapporte le cookie.
  const clic = await run({ method: 'POST', path: '/api/analytics/track', accept: '*/*', cookie: cookieAttente(pre.res) });
  assert.strictEqual(clic.touches.length, 1);
});

test('navigateur déjà connu (il nous a rendu un cookie) : enregistré tout de suite', async () => {
  const { req, touches } = await run({ referer: 'https://www.google.com/', cookie: 'carpartsfrance.sid=s%3Aabc.def' });
  assert.strictEqual(touches.length, 1);
  assert.strictEqual(touches[0].confirmedArrival, true);
  assert.strictEqual(req.session.attribution.visitTouch.referrer, 'https://www.google.com/');
});

test('navigateur connu qui revient de Google plusieurs fois en quelques minutes : une seule visite', async () => {
  const session = {};
  const cookie = 'carpartsfrance.sid=s%3Aabc.def';
  const a = await run({ referer: 'https://www.google.com/', cookie, session });
  const b = await run({ path: '/produits/autre', referer: 'https://www.google.com/', cookie, session });
  assert.strictEqual(a.touches.length + b.touches.length, 1, 'même visite');
  const c = await run({ referer: 'https://chatgpt.com/', cookie, session });
  assert.strictEqual(c.touches.length, 1, 'autre origine : nouvelle visite');
  session.attribution.visitTouch.capturedAt = new Date(Date.now() - 31 * 60 * 1000);
  const d = await run({ referer: 'https://chatgpt.com/', cookie, session });
  assert.strictEqual(d.touches.length, 1, 'plus de 30 minutes après : nouvelle visite');
});

test('arrivée en attente confirmée par un clic pub : le cookie « premier contact » garde l\'arrivée gratuite', async () => {
  const premiere = await run({ referer: 'https://www.google.com/' });
  const { res, touches, req } = await run({ query: { gclid: 'G-1', utm_source: 'google', utm_medium: 'cpc' }, referer: 'https://www.google.com/', cookie: cookieAttente(premiere.res) });
  assert.strictEqual(touches.length, 2);
  const premiers = res.cookies.filter((c) => c.startsWith('cpf_attr_first='));
  assert.strictEqual(premiers.length, 1);
  assert.ok(!decodeURIComponent(premiers[0]).includes('G-1'), 'premier contact = la visite gratuite');
  assert.strictEqual(req.session.attribution.firstTouch.gclid, '');
  assert.strictEqual(req.session.attribution.lastTouch.gclid, 'G-1');
});

test('page chargée dans un cadre d\'un autre site : pas une arrivée', async () => {
  const { touches, res } = await run({ referer: 'https://forum.example.org/', extra: { 'sec-fetch-dest': 'iframe' } });
  assert.strictEqual(touches.length, 0);
  assert.strictEqual(res.cookies.length, 0);
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
