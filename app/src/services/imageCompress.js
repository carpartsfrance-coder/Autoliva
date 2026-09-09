'use strict';

/**
 * Compression d'images pour les pièces jointes email + intégration PDF.
 * Les photos uploadées (PNG iPhone, photos HD) peuvent peser 10+ MB chacune,
 * ce qui fait dépasser la limite MailerSend de 25 MB. On les redimensionne
 * (max 1400px de large) et recompresse en JPEG qualité ~78.
 *
 * Utilise jimp (pur JS, pas de binaire natif).
 */

const { Jimp } = require('jimp');

const MAX_WIDTH = 1400;
const JPEG_QUALITY = 78;

/**
 * Compresse un buffer image. Renvoie { buffer, mime } en JPEG.
 * En cas d'échec (format non supporté, buffer corrompu), renvoie le buffer
 * d'origine inchangé (best-effort, ne bloque jamais l'envoi).
 *
 * @param {Buffer} buffer
 * @param {string} [mime]
 * @returns {Promise<{ buffer: Buffer, mime: string }>}
 */
async function compressImage(buffer, mime) {
  if (!Buffer.isBuffer(buffer) || !buffer.length) {
    return { buffer, mime: mime || 'application/octet-stream' };
  }
  try {
    const img = await Jimp.read(buffer);
    if (img.width > MAX_WIDTH) {
      img.resize({ w: MAX_WIDTH });
    }
    // Le JPEG ne gère pas la transparence : jimp remplit alors les zones
    // transparentes en NOIR par défaut. Les images à fond transparent (ex:
    // visuels marketing PNG) ressortaient donc sur fond noir chez le client.
    // → on aplatit sur un fond BLANC avant l'export JPEG.
    let toEncode = img;
    let hadAlpha = false;
    if (typeof img.hasAlpha === 'function' && img.hasAlpha()) {
      hadAlpha = true;
      const bg = new Jimp({ width: img.width, height: img.height, color: 0xffffffff });
      bg.composite(img, 0, 0);
      toEncode = bg;
    }
    const out = await toEncode.getBuffer('image/jpeg', { quality: JPEG_QUALITY });
    // Si la "compression" a paradoxalement grossi (petite image déjà optimisée),
    // on garde l'original — SAUF si l'image avait de la transparence, car
    // renvoyer le PNG transparent ramènerait le fond noir côté client.
    if (out.length >= buffer.length && !hadAlpha) {
      return { buffer, mime: mime || 'image/jpeg' };
    }
    return { buffer: out, mime: 'image/jpeg' };
  } catch (err) {
    console.warn('[imageCompress] échec, buffer original conservé:', err && err.message);
    return { buffer, mime: mime || 'application/octet-stream' };
  }
}

/* ── Images du catalogue (fiches, blog, bandeaux) ──────────────────────────
 *
 * Les photos arrivaient en base telles quelles : des PNG de 2 à 2,5 Mo
 * sortis d'un générateur d'images, servis tels quels sur l'accueil et sur
 * les fiches. Une page produit n'a besoin d'aucune image de plus de 1600 px
 * de large ni de plus de 200 Ko.
 *
 * Règles : on ne touche qu'aux JPEG et PNG au-dessus d'un seuil ; on réduit à
 * 1600 px ; un PNG SANS transparence devient un JPEG (une photo en PNG pèse
 * dix fois trop), un PNG avec transparence reste un PNG. Si le résultat n'est
 * pas plus petit, on garde l'original. Jamais d'exception : au pire, l'image
 * est enregistrée comme avant.
 */
const CATALOGUE = { largeurMax: 1600, qualite: 82, seuilOctets: 300 * 1024 };

async function optimiserImageCatalogue(buffer, mime, options = {}) {
  const o = { ...CATALOGUE, ...options };
  const type = String(mime || '').toLowerCase().trim();
  const intact = { buffer, mime: type, modifie: false };
  if (!Buffer.isBuffer(buffer) || !buffer.length) return intact;
  if (type !== 'image/jpeg' && type !== 'image/png') return intact;
  if (buffer.length <= o.seuilOctets) return intact;
  try {
    const img = await Jimp.read(buffer);
    if (img.width > o.largeurMax) img.resize({ w: o.largeurMax });
    const alpha = type === 'image/png' && typeof img.hasAlpha === 'function' && img.hasAlpha();
    const sortie = alpha
      ? await img.getBuffer('image/png')
      : await img.getBuffer('image/jpeg', { quality: o.qualite });
    if (sortie.length >= buffer.length) return intact;
    return { buffer: sortie, mime: alpha ? 'image/png' : 'image/jpeg', modifie: true, largeur: img.width, hauteur: img.height };
  } catch (err) {
    console.warn('[imageCompress] optimisation catalogue impossible, original conservé:', err && err.message);
    return intact;
  }
}

module.exports = { compressImage, optimiserImageCatalogue, CATALOGUE };
