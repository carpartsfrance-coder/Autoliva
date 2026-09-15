'use strict';

/**
 * Robots vérifiés et adresse du visiteur — plan de reprise SEO du 14/09/2026,
 * action A4.3. Aucun appel réseau : les résolveurs DNS sont des doublures.
 *
 * Ce qui doit tenir :
 *   - un vrai Googlebot / Storebot / AdsBot / Bingbot est reconnu (inverse PUIS
 *     direct), un faux ne l'est jamais, quelle que soit la ruse sur le nom ;
 *   - le verdict est mis en cache, et deux demandes simultanées ne font
 *     qu'une résolution ;
 *   - un DNS lent ne retient pas la requête plus que le délai prévu ;
 *   - la clé du limiteur est l'adresse du visiteur Cloudflare, pas le nœud.
 */

const test = require('node:test');
const assert = require('node:assert');

const {
  robotDeclare, normaliserIp, ipDuVisiteur, cleLimiteur, creerVerificateur, FAMILLES,
} = require('../../src/services/robotsVerifies');

const UA = {
  googlebot: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  googlebotMobile: 'Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)',
  storebot: 'Mozilla/5.0 (X11; Linux x86_64; Storebot-Google/1.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.88 Safari/537.36',
  adsbot: 'AdsBot-Google (+http://www.google.com/adsbot.html)',
  bingbot: 'Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)',
  chrome: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36',
};

const GOOGLE = FAMILLES.find((f) => f.nom === 'Googlebot');
const BING = FAMILLES.find((f) => f.nom === 'Bingbot');

const erreurDns = (code) => Object.assign(new Error(code), { code });

/* Un DNS de test : table inverse (ip → noms) et directe (nom → adresses). */
function faux({ inverse = {}, direct4 = {}, direct6 = {}, compte = { reverse: 0, resolve: 0 }, lenteurMs = 0 } = {}) {
  const pause = () => new Promise((r) => setTimeout(r, lenteurMs));
  return {
    compte,
    reverse: async (ip) => {
      compte.reverse++;
      if (lenteurMs) await pause();
      if (!(ip in inverse)) throw erreurDns('ENOTFOUND');
      const v = inverse[ip];
      if (v instanceof Error) throw v;
      return v;
    },
    resolve4: async (nom) => { compte.resolve++; if (!(nom in direct4)) throw erreurDns('ENODATA'); return direct4[nom]; },
    resolve6: async (nom) => { if (!(nom in direct6)) throw erreurDns('ENODATA'); return direct6[nom]; },
  };
}

test('le User-Agent désigne une famille, rien de plus', () => {
  assert.equal(robotDeclare(UA.googlebot).nom, 'Googlebot');
  assert.equal(robotDeclare(UA.googlebotMobile).nom, 'Googlebot');
  assert.equal(robotDeclare('Googlebot-Image/1.0').nom, 'Googlebot');
  assert.equal(robotDeclare(UA.storebot).nom, 'Storebot-Google', 'Storebot ne contient pas « Googlebot »');
  assert.equal(robotDeclare(UA.adsbot).nom, 'AdsBot-Google', 'AdsBot non plus');
  assert.equal(robotDeclare(UA.bingbot).nom, 'Bingbot');
  assert.equal(robotDeclare(UA.chrome), null);
  assert.equal(robotDeclare(''), null);
  assert.equal(robotDeclare(undefined), null);
});

test('un vrai Googlebot est vérifié : inverse en googlebot.com, puis direct vers la même IP', async () => {
  const dns = faux({
    inverse: { '66.249.66.1': ['crawl-66-249-66-1.googlebot.com'] },
    direct4: { 'crawl-66-249-66-1.googlebot.com': ['66.249.66.1'] },
  });
  const v = creerVerificateur(dns);
  assert.equal(await v.estVerifie('66.249.66.1', GOOGLE), true);
});

test('AdsBot (rate-limited-proxy…google.com) et Bingbot (search.msn.com) aussi', async () => {
  const dns = faux({
    inverse: {
      '66.249.90.77': ['rate-limited-proxy-66-249-90-77.google.com.'],
      '157.55.39.1': ['msnbot-157-55-39-1.search.msn.com'],
    },
    direct4: {
      'rate-limited-proxy-66-249-90-77.google.com': ['66.249.90.77'],
      'msnbot-157-55-39-1.search.msn.com': ['157.55.39.1'],
    },
  });
  const v = creerVerificateur(dns);
  assert.equal(await v.estVerifie('66.249.90.77', FAMILLES.find((f) => f.nom === 'AdsBot-Google')), true, 'le point final du nom inverse est toléré');
  assert.equal(await v.estVerifie('157.55.39.1', BING), true);
  assert.equal(await v.estVerifie('157.55.39.1', GOOGLE), false, 'un nom Bing ne vérifie pas un Googlebot');
});

test('un faux Googlebot n’est jamais vérifié, quelle que soit la ruse', async () => {
  const dns = faux({
    inverse: {
      '203.0.113.5': ['serveur.pirate.example'],
      '203.0.113.6': ['crawl-203-0-113-6.googlebot.com.pirate.example'],
      '203.0.113.7': ['evilgooglebot.com'],
      '203.0.113.8': ['crawl-66-249-66-1.googlebot.com'], // nom volé : le direct ne redonne pas cette IP
      '34.120.0.9': ['9.0.120.34.bc.googleusercontent.com'], // VM Google Cloud louée
    },
    direct4: {
      'crawl-66-249-66-1.googlebot.com': ['66.249.66.1'],
      '9.0.120.34.bc.googleusercontent.com': ['34.120.0.9'],
      'evilgooglebot.com': ['203.0.113.7'],
    },
  });
  const v = creerVerificateur(dns);
  for (const ip of ['203.0.113.5', '203.0.113.6', '203.0.113.7', '203.0.113.8', '34.120.0.9', '198.51.100.1']) {
    assert.equal(await v.estVerifie(ip, GOOGLE), false, `${ip} ne doit pas passer pour Googlebot`);
  }
});

test('IPv6 : formes différentes de la même adresse reconnues', async () => {
  const dns = faux({
    inverse: { '2001:4860:4801:10::1': ['crawl-2001-4860-4801-10--1.googlebot.com'] },
    direct6: { 'crawl-2001-4860-4801-10--1.googlebot.com': ['2001:4860:4801:0010:0000:0000:0000:0001'] },
  });
  const v = creerVerificateur(dns);
  assert.equal(await v.estVerifie('2001:4860:4801:10:0:0:0:1', GOOGLE), true);
  assert.equal(normaliserIp('::ffff:66.249.66.1'), '66.249.66.1');
  assert.equal(normaliserIp('2001:4860:4801:0010::0001'), '2001:4860:4801:10::1');
  assert.equal(normaliserIp('pas une ip'), '');
});

test('le verdict est en cache, et deux demandes simultanées ne font qu’une résolution', async () => {
  const compte = { reverse: 0, resolve: 0 };
  const dns = faux({
    compte,
    lenteurMs: 20,
    inverse: { '66.249.66.2': ['crawl-66-249-66-2.googlebot.com'], '203.0.113.9': ['x.pirate.example'] },
    direct4: { 'crawl-66-249-66-2.googlebot.com': ['66.249.66.2'] },
  });
  const v = creerVerificateur(dns);
  const [a, b] = await Promise.all([v.estVerifie('66.249.66.2', GOOGLE), v.estVerifie('66.249.66.2', GOOGLE)]);
  assert.equal(a && b, true);
  assert.equal(compte.reverse, 1, 'une seule résolution inverse pour deux demandes');
  for (let i = 0; i < 20; i++) assert.equal(await v.estVerifie('66.249.66.2', GOOGLE), true);
  assert.equal(await v.estVerifie('203.0.113.9', GOOGLE), false);
  assert.equal(await v.estVerifie('203.0.113.9', GOOGLE), false);
  assert.equal(compte.reverse, 2, 'le refus est aussi en cache');
});

test('le cache expire : un verdict vieux d’un jour est revérifié', async () => {
  let t = 1_000_000;
  const compte = { reverse: 0, resolve: 0 };
  const dns = faux({
    compte,
    inverse: { '66.249.66.3': ['crawl-66-249-66-3.googlebot.com'] },
    direct4: { 'crawl-66-249-66-3.googlebot.com': ['66.249.66.3'] },
  });
  const v = creerVerificateur({ ...dns, maintenant: () => t });
  await v.estVerifie('66.249.66.3', GOOGLE);
  t += 23 * 3600 * 1000;
  await v.estVerifie('66.249.66.3', GOOGLE);
  assert.equal(compte.reverse, 1);
  t += 2 * 3600 * 1000;
  await v.estVerifie('66.249.66.3', GOOGLE);
  assert.equal(compte.reverse, 2);
});

test('un DNS lent ne retient pas la requête : délai dépassé → limite normale, puis le cache prend le relais', async () => {
  const dns = faux({
    lenteurMs: 80,
    inverse: { '66.249.66.4': ['crawl-66-249-66-4.googlebot.com'] },
    direct4: { 'crawl-66-249-66-4.googlebot.com': ['66.249.66.4'] },
  });
  const v = creerVerificateur({ ...dns, delaiMaxMs: 10 });
  const debut = Date.now();
  assert.equal(await v.estVerifie('66.249.66.4', GOOGLE), false, 'trop lent : on ne l’exempte pas cette fois');
  assert.ok(Date.now() - debut < 60, 'la réponse n’a pas attendu le DNS');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(await v.estVerifie('66.249.66.4', GOOGLE), true, 'la résolution finie en arrière-plan a rempli le cache');
});

test('une panne DNS n’exempte personne et n’est retenue que brièvement', async () => {
  let t = 5_000_000;
  const compte = { reverse: 0, resolve: 0 };
  const dns = faux({ compte, inverse: { '66.249.66.5': erreurDns('ESERVFAIL') } });
  const v = creerVerificateur({ ...dns, maintenant: () => t });
  assert.equal(await v.estVerifie('66.249.66.5', GOOGLE), false);
  t += 6 * 60 * 1000;
  await v.estVerifie('66.249.66.5', GOOGLE);
  assert.equal(compte.reverse, 2, 'après 5 min, on réessaie');
});

test('le cache est borné', async () => {
  const dns = faux();
  const v = creerVerificateur({ ...dns, maxEntrees: 3 });
  for (let i = 1; i <= 10; i++) await v.estVerifie(`203.0.113.${i}`, GOOGLE);
  assert.equal(v.tailleCache(), 3);
});

test('adresse du visiteur : CF-Connecting-IP, puis True-Client-IP, puis req.ip', () => {
  assert.equal(ipDuVisiteur({ headers: { 'cf-connecting-ip': '66.249.66.1', 'true-client-ip': '1.1.1.1' }, ip: '172.70.1.1' }), '66.249.66.1');
  assert.equal(ipDuVisiteur({ headers: { 'true-client-ip': '157.55.39.1' }, ip: '172.70.1.1' }), '157.55.39.1');
  assert.equal(ipDuVisiteur({ headers: {}, ip: '::ffff:127.0.0.1' }), '127.0.0.1');
  assert.equal(ipDuVisiteur({ headers: { 'cf-connecting-ip': 'n’importe quoi' }, ip: '172.70.1.1' }), '172.70.1.1', 'une valeur illisible est ignorée');
});

test('clé du limiteur : un visiteur par clé, le nœud Cloudflare ne mélange plus personne', () => {
  const noeud = '172.70.1.1';
  const a = cleLimiteur({ headers: { 'cf-connecting-ip': '203.0.113.10' }, ip: noeud });
  const b = cleLimiteur({ headers: { 'cf-connecting-ip': '66.249.66.1' }, ip: noeud });
  assert.notEqual(a, b, 'deux visiteurs derrière le même nœud ont deux compteurs');
  /* IPv6 : un abonné a tout un bloc, regroupé en /56. */
  const v6a = cleLimiteur({ headers: { 'cf-connecting-ip': '2a01:e0a:1:2::1' } });
  const v6b = cleLimiteur({ headers: { 'cf-connecting-ip': '2a01:e0a:1:2:ffff::9' } });
  assert.equal(v6a, v6b);
});

test('les journaux disent d’où vient l’adresse du visiteur, une fois par source, sans jamais l’écrire', (t) => {
  /* Module neuf : le « déjà signalé » des autres tests ne compte pas. */
  const chemin = require.resolve('../../src/services/robotsVerifies');
  const sauvegarde = require.cache[chemin];
  delete require.cache[chemin];
  const lignes = [];
  const log = console.log;
  console.log = (...args) => { lignes.push(args.join(' ')); };
  t.after(() => { console.log = log; require.cache[chemin] = sauvegarde; });

  const neuf = require('../../src/services/robotsVerifies');
  for (let i = 0; i < 5; i++) neuf.cleLimiteur({ headers: { 'cf-connecting-ip': `203.0.113.${i + 1}` }, ip: '172.70.1.1' });
  neuf.cleLimiteur({ headers: {}, ip: '172.70.1.1' });
  neuf.cleLimiteur({ headers: {}, ip: '172.70.1.2' });
  console.log = log;

  const signalements = lignes.filter((l) => l.startsWith('[limiteur crawl]'));
  assert.deepEqual(signalements, [
    '[limiteur crawl] adresse du visiteur lue dans CF-Connecting-IP',
    '[limiteur crawl] adresse du visiteur lue dans req.ip',
  ]);
  assert.ok(!lignes.some((l) => /203\.0\.113\.|172\.70\./.test(l)), 'aucune adresse dans les journaux');
});
