/**
 * Vitesse du site — les garde-fous des correctifs de septembre 2026.
 *
 * Lighthouse mobile mesurait un LCP de 15 à 63 s : 6,4 Mo de polices
 * d'icônes, un logo de 726 Ko, des photos PNG de 2 Mo servies telles quelles,
 * six agrégations sans index à chaque page de listing, et un traceur
 * d'audience qui comptait Googlebot. Chaque test verrouille l'un de ces
 * points.
 */

const test = require('node:test');
const assert = require('node:assert');
const { Jimp } = require('jimp');

const { estRobot } = require('../../src/services/robots');
const { optimiserImageCatalogue, CATALOGUE } = require('../../src/services/imageCompress');
const { construire } = require('../../src/services/policesLocales');
const { _memo } = require('../../src/services/productListingService');

test('les robots qui exécutent le JavaScript ne comptent pas comme des visiteurs', () => {
  assert.equal(estRobot('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), true);
  assert.equal(estRobot('Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)'), true);
  assert.equal(estRobot('Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)'), true);
  assert.equal(estRobot('Chrome-Lighthouse'), true);
  assert.equal(estRobot('curl/8.4.0'), true);
  assert.equal(estRobot(''), true, 'pas de User-Agent = pas un navigateur');
  assert.equal(estRobot('Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1'), false);
  assert.equal(estRobot('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36'), false);
  assert.equal(estRobot('Mozilla/5.0 (Linux; Android 13; CUBOT_KINGKONG_9) AppleWebKit/537.36 Chrome/120 Mobile Safari/537.36'), false, 'un téléphone Cubot n’est pas un robot');
});

/* Une image bruitée : incompressible, donc lourde à coup sûr. */
async function imageBruitee(largeur, hauteur, alpha) {
  const img = new Jimp({ width: largeur, height: hauteur });
  const d = img.bitmap.data;
  for (let i = 0; i < d.length; i += 4) {
    d[i] = (i * 7919) % 256; d[i + 1] = (i * 104729) % 256; d[i + 2] = (i * 15485863) % 256;
    d[i + 3] = alpha ? (i % 3 ? 255 : 0) : 255;
  }
  return img;
}

test('une photo PNG lourde devient un JPEG de 1600 px au plus', async () => {
  const img = await imageBruitee(2000, 1500, false);
  const png = await img.getBuffer('image/png');
  assert.ok(png.length > CATALOGUE.seuilOctets, 'le PNG bruité doit dépasser le seuil');
  const r = await optimiserImageCatalogue(png, 'image/png');
  assert.equal(r.modifie, true);
  assert.equal(r.mime, 'image/jpeg');
  assert.equal(r.largeur, 1600);
  assert.equal(r.hauteur, 1200);
  assert.ok(r.buffer.length < png.length);
});

test('un PNG transparent reste un PNG (pas de fond noir), seulement réduit', async () => {
  const img = await imageBruitee(2000, 400, true);
  const png = await img.getBuffer('image/png');
  const r = await optimiserImageCatalogue(png, 'image/png', { seuilOctets: 0 });
  assert.equal(r.mime, 'image/png');
  if (r.modifie) assert.equal(r.largeur, 1600);
});

test('une petite image et un fichier qui n’est pas une image ressortent intacts', async () => {
  const petit = Buffer.from('pas une image');
  const r1 = await optimiserImageCatalogue(petit, 'image/jpeg');
  assert.equal(r1.modifie, false);
  assert.strictEqual(r1.buffer, petit);
  const r2 = await optimiserImageCatalogue(Buffer.alloc(500 * 1024, 1), 'application/pdf');
  assert.equal(r2.modifie, false);
});

test('le CSS des polices locales porte la version et les préchargements du premier écran', () => {
  const p = construire({
    version: 'abc123',
    icones: ['search', 'close'],
    polices: [
      { famille: 'Inter', fichier: 'inter-latin.woff2', poids: '400 800', display: 'swap', unicodeRange: 'U+0000-00FF', preload: true },
      { famille: 'Material Symbols Outlined', fichier: 'material-symbols-outlined.woff2', poids: '100 700', display: 'block', icones: true, preload: false },
    ],
  });
  assert.equal(p.disponible, true);
  assert.match(p.css, /@font-face\{font-family:'Inter';[^}]*src:url\(\/fonts\/inter-latin\.woff2\?v=abc123\)/);
  assert.match(p.css, /unicode-range:U\+0000-00FF/);
  assert.match(p.css, /\.material-symbols-outlined\{font-family:'Material Symbols Outlined';/);
  assert.deepEqual(p.preloads, ['/fonts/inter-latin.woff2?v=abc123']);
  assert.ok(p.icones.has('search'));
  assert.equal(construire({ polices: [] }).disponible, false);
});

test('deux catégories ne partagent jamais le même compteur de facettes', async () => {
  const { cleMemo, memoriser, viderMemo } = _memo;
  viderMemo();
  const a = cleMemo('facettes', { isPublished: { $in: [true, null] }, category: { $regex: /^Boîtes/i } });
  const b = cleMemo('facettes', { isPublished: { $in: [true, null] }, category: { $regex: /^Moteurs/i } });
  assert.notEqual(a, b, 'JSON.stringify seul rend les RegExp en {} : les clés seraient identiques');

  let calculs = 0;
  const calcul = async () => { calculs++; return { n: calculs }; };
  const r1 = await memoriser(a, calcul);
  const r2 = await memoriser(a, calcul);
  const r3 = await memoriser(b, calcul);
  assert.deepEqual(r1, r2, 'même clé dans les dix minutes : même résultat, sans recalcul');
  assert.equal(calculs, 2, 'une agrégation par combinaison de filtres, pas par requête');
  assert.notDeepEqual(r1, r3);
  viderMemo();
});
