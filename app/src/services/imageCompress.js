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
    const out = await img.getBuffer('image/jpeg', { quality: JPEG_QUALITY });
    // Si la "compression" a paradoxalement grossi (petite image déjà optimisée),
    // on garde l'original.
    if (out.length >= buffer.length) {
      return { buffer, mime: mime || 'image/jpeg' };
    }
    return { buffer: out, mime: 'image/jpeg' };
  } catch (err) {
    console.warn('[imageCompress] échec, buffer original conservé:', err && err.message);
    return { buffer, mime: mime || 'application/octet-stream' };
  }
}

module.exports = { compressImage };
