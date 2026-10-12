'use strict';

// Fil d'exécution séparé : décode une image et la réduit en JPEG.
// Lancé par imageResize.js — jamais chargé par le serveur web lui-même, pour
// que deux à trois secondes de décodage ne figent pas le site.

const { parentPort, workerData } = require('worker_threads');
const { Jimp } = require('jimp');

(async () => {
  const { bytes, maxWidth, maxHeight, quality } = workerData;
  const img = await Jimp.read(Buffer.from(bytes));
  if (img.width > maxWidth) img.resize({ w: maxWidth });
  if (img.height > maxHeight) img.resize({ h: maxHeight });
  // Le JPEG n'a pas de transparence : on aplatit sur fond blanc, sinon les
  // zones transparentes sortent en noir.
  let toEncode = img;
  if (typeof img.hasAlpha === 'function' && img.hasAlpha()) {
    toEncode = new Jimp({ width: img.width, height: img.height, color: 0xffffffff });
    toEncode.composite(img, 0, 0);
  }
  const out = await toEncode.getBuffer('image/jpeg', { quality });
  const copy = Uint8Array.from(out);
  parentPort.postMessage({ ok: true, bytes: copy, width: toEncode.width, height: toEncode.height }, [copy.buffer]);
})().catch((err) => {
  parentPort.postMessage({ ok: false, error: (err && err.message) || 'erreur' });
});
