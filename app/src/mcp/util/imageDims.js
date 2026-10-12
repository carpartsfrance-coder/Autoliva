'use strict';

// Type et dimensions d'une image lus dans son EN-TÊTE, sans la décoder.
//
// Pourquoi : les pièces jointes SAV viennent des clients. Un PNG de 140 Ko
// peut déclarer 12 000 × 12 000 px et demander près d'un gigaoctet une fois
// décodé. On regarde donc les dimensions annoncées AVANT de confier l'image à
// un décodeur, et le type réel plutôt que l'extension ou le type déclaré.

function png(b) {
  if (b.length < 24 || b.readUInt32BE(0) !== 0x89504e47 || b.readUInt32BE(4) !== 0x0d0a1a0a) return null;
  if (b.toString('latin1', 12, 16) !== 'IHDR') return null;
  return { mime: 'image/png', width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function gif(b) {
  if (b.length < 10) return null;
  const sig = b.toString('latin1', 0, 6);
  if (sig !== 'GIF87a' && sig !== 'GIF89a') return null;
  return { mime: 'image/gif', width: b.readUInt16LE(6), height: b.readUInt16LE(8) };
}

function jpeg(b) {
  if (b.length < 4 || b[0] !== 0xff || b[1] !== 0xd8) return null;
  let i = 2;
  while (i + 9 < b.length) {
    if (b[i] !== 0xff) { i += 1; continue; }
    const marker = b[i + 1];
    if (marker === 0xff) { i += 1; continue; }                                   // remplissage
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd9)) { i += 2; continue; } // marqueurs sans longueur
    const len = b.readUInt16BE(i + 2);
    // SOF0…SOF15, sauf DHT (C4), JPG (C8) et DAC (CC) : c'est là que sont les dimensions.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      return { mime: 'image/jpeg', width: b.readUInt16BE(i + 7), height: b.readUInt16BE(i + 5) };
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function webp(b) {
  if (b.length < 30 || b.toString('latin1', 0, 4) !== 'RIFF' || b.toString('latin1', 8, 12) !== 'WEBP') return null;
  const chunk = b.toString('latin1', 12, 16);
  if (chunk === 'VP8X') {
    return { mime: 'image/webp', width: 1 + b.readUIntLE(24, 3), height: 1 + b.readUIntLE(27, 3) };
  }
  if (chunk === 'VP8 ') {
    if (b[23] !== 0x9d || b[24] !== 0x01 || b[25] !== 0x2a) return null;
    return { mime: 'image/webp', width: b.readUInt16LE(26) & 0x3fff, height: b.readUInt16LE(28) & 0x3fff };
  }
  if (chunk === 'VP8L') {
    if (b[20] !== 0x2f) return null;
    const bits = b.readUInt32LE(21);
    return { mime: 'image/webp', width: 1 + (bits & 0x3fff), height: 1 + ((bits >>> 14) & 0x3fff) };
  }
  return null;
}

/**
 * @param {Buffer} buffer
 * @returns {{ mime: string, width: number, height: number } | null}
 *   null : ni JPEG, ni PNG, ni GIF, ni WebP, ou en-tête illisible.
 */
function imageInfo(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  try {
    const info = png(buffer) || jpeg(buffer) || gif(buffer) || webp(buffer);
    if (!info || !(info.width > 0) || !(info.height > 0)) return null;
    return info;
  } catch (_) {
    return null;
  }
}

module.exports = { imageInfo };
