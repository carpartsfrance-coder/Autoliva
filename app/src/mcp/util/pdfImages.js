'use strict';

// Extraction des pages SCANNÉES d'un PDF.
//
// Beaucoup de pièces jointes SAV sont des scans ou des photos enregistrées en
// PDF (relevés de valise, factures de garage) : chaque page est alors une image
// JPEG rangée telle quelle dans le fichier. On retrouve ces JPEG en lisant le
// fichier octet par octet.
//
// Pourquoi ne pas ouvrir le PDF avec une bibliothèque : ces fichiers viennent
// des clients. Une bibliothèque décompresse tout le document avant de rendre
// la main, et un PDF de 1 Mo fabriqué exprès peut alors demander un gigaoctet
// de mémoire — de quoi faire tomber le site. Ici, RIEN n'est décompressé : on
// repère les objets « image », on copie leurs octets. Le coût est celui d'une
// lecture du fichier.
//
// Limites assumées, dites clairement à l'appelant :
//   - un PDF « texte » (facture générée par un logiciel) n'a pas d'image de page ;
//   - les scans non JPEG (noir et blanc CCITT/JBIG2, Flate, JPEG 2000) sont
//     comptés mais pas rendus ;
//   - un logo ou un tampon n'est pas une page : il faut au moins
//     1000 × 600 px pour compter.

const MIN_LONG_SIDE = 1000;
const MIN_SHORT_SIDE = 600;
const DICT_WINDOW = 8192; // un dictionnaire d'objet image tient largement dans 8 Ko
const MAX_PAGES_COUNTED = 5000;

const { imageInfo } = require('./imageDims');

function isPageSized(width, height) {
  return Math.max(width, height) >= MIN_LONG_SIDE && Math.min(width, height) >= MIN_SHORT_SIDE;
}

function dictNumber(dict, key) {
  // « /Width 2480 » — pas « /Width 12 0 R » (référence vers un autre objet).
  const m = new RegExp(`/${key}\\s+(\\d{1,7})(?!\\s+\\d+\\s+R)`).exec(dict);
  return m ? Number(m[1]) : 0;
}

/**
 * @param {Buffer} buffer  contenu du PDF
 * @returns {{ pageCount: number|null, images: Array<{ width: number, height: number, bytes: Buffer }>, skipped: number, compressedObjects: boolean, encrypted: boolean, hasFonts: boolean }}
 *   `images` : pages scannées JPEG, dans l'ordre du fichier.
 *   `skipped` : images de la taille d'une page mais dans un format non rendu.
 *   `pageCount` : null quand le fichier range ses pages dans des objets compressés.
 *   `hasFonts` : le fichier contient du texte (ou une couche OCR) que cet outil ne lit pas.
 */
function extractScannedPages(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.toString('latin1', 0, 1024).indexOf('%PDF-') === -1) {
    throw new Error('pas un PDF');
  }
  // latin1 : un caractère par octet, les positions dans la chaîne sont celles du fichier.
  const s = buffer.toString('latin1');
  const images = [];
  let skipped = 0;

  // Chaque octet du fichier est lu un nombre borné de fois : la recherche du
  // dictionnaire ne remonte jamais avant la fin du flux précédent (`floor`).
  // Sans cette borne, un fichier fait de milliers de « stream/endstream »
  // coûterait un temps quadratique et figerait le site.
  let pos = 0;
  let floor = 0;
  for (;;) {
    const k = s.indexOf('stream', pos);
    if (k < 0) break;
    if (s.startsWith('end', k - 3)) { pos = k + 6; continue; }
    let dataStart;
    if (s[k + 6] === '\n') dataStart = k + 7;
    else if (s[k + 6] === '\r' && s[k + 7] === '\n') dataStart = k + 8;
    else { pos = k + 6; continue; }

    const from = Math.max(floor, k - DICT_WINDOW);
    const rel = s.slice(from, k).lastIndexOf('obj');
    const dict = rel >= 0 ? s.slice(from + rel + 3, k) : '';

    // Fin du flux : la longueur annoncée si elle tombe juste, sinon le mot-clé.
    let end = -1;
    const len = dictNumber(dict, 'Length');
    if (len > 0 && dataStart + len <= s.length && /^\s{0,2}endstream/.test(s.slice(dataStart + len, dataStart + len + 11))) {
      end = dataStart + len;
    }
    let after;
    if (end < 0) {
      const e = s.indexOf('endstream', dataStart);
      if (e < 0) break;
      end = e;
      if (s[end - 1] === '\n') end -= 1;
      if (s[end - 1] === '\r') end -= 1;
      after = e + 9;
    } else {
      after = s.indexOf('endstream', end) + 9;
    }

    if (/\/Subtype\s*\/Image\b/.test(dict)) {
      const bytes = buffer.subarray(dataStart, end);
      const isDct = /\/Filter\s*\/DCTDecode\b/.test(dict) || /\/Filter\s*\[\s*\/DCTDecode\s*\]/.test(dict);
      const head = isDct ? imageInfo(bytes) : null;
      if (head && head.mime === 'image/jpeg') {
        if (isPageSized(head.width, head.height)) images.push({ width: head.width, height: head.height, bytes: Buffer.from(bytes) });
      } else if (isPageSized(dictNumber(dict, 'Width'), dictNumber(dict, 'Height'))) {
        skipped += 1;
      }
    }
    pos = after;
    floor = after;
  }

  // Compte les pages sans construire la liste des occurrences (plafonné).
  let pageCount = 0;
  const rePage = /\/Type\s*\/Page(?![A-Za-z])/g;
  while (pageCount < MAX_PAGES_COUNTED && rePage.exec(s)) pageCount += 1;

  return {
    pageCount: pageCount || null,
    images,
    skipped,
    // Objets compressés : des pages ou du texte peuvent exister sans être visibles ici.
    compressedObjects: s.indexOf('/ObjStm') !== -1,
    encrypted: /\/Encrypt\s/.test(s.slice(-4096)) || /\/Encrypt\s+\d+\s+\d+\s+R/.test(s),
    // Un objet police (« /Type /Font ») : il y a du texte, ou une couche OCR.
    // Un simple « /Font << >> » vide dans les ressources d'une page n'en est pas un.
    hasFonts: /\/Type\s*\/Font(?![A-Za-z])/.test(s),
  };
}

module.exports = { extractScannedPages, MIN_LONG_SIDE, MIN_SHORT_SIDE };
