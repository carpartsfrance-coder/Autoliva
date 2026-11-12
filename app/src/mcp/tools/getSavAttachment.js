'use strict';

const storage = require('../../services/savFileStorage');
const { extractScannedPages } = require('../util/pdfImages');
const { imageInfo } = require('../util/imageDims');
const { resizeToJpeg } = require('../util/imageResize');
const { normalizeTicketId } = require('../util/sav');

/* Les pièces jointes viennent des clients : chaque limite ci-dessous borne ce
 * qu'un fichier, même fabriqué exprès, peut coûter au serveur. */
const MAX_FILE_BYTES = 25 * 1024 * 1024;     // au-delà : le fichier n'est pas chargé en mémoire
const PASS_THROUGH_BYTES = 2 * 1024 * 1024;  // une image plus légère part telle quelle, sans décodage
const PASS_THROUGH_SIDE = 8000;              // …si aucun côté ne dépasse 8000 px
const MAX_DECODE_PIXELS = 13 * 1000 * 1000;  // 13 mégapixels (photo de téléphone 4160 × 3120) : au-delà, on ne décode pas.
                                             // Décoder 12 Mpx demande déjà environ 200 Mo de mémoire au processus.
const MAX_WIDTH = 1400;
const MAX_HEIGHT = 2400;
const JPEG_QUALITY = 80;
const MAX_TEXT_CHARS = 40000;
const PAGES_PER_CALL = 3;
const MAX_RESULT_IMAGE_BYTES = 4 * 1024 * 1024; // total d'images par réponse

const definition = {
  name: 'getSavAttachment',
  description:
    "Ouvre une pièce jointe d'un ticket SAV (lecture seule) pour la LIRE : photo de valise de diagnostic, photo du compteur ou de la pièce, capture d'écran, facture de garage, relevé de défauts. Une photo lourde est rendue réduite (1400 × 2400 px au plus). Un PDF scanné est rendu page par page, 3 pages par appel au plus (paramètre `page` pour la suite). Cet outil ne lit PAS le texte d'un PDF : un PDF généré par un logiciel est annoncé illisible, et pour un PDF mixte seules les pages scannées sont montrées (le champ `warning` le signale). Dans ces cas, ne rien conclure sur le contenu non vu. Le `fileId` vient de getSavTicket (messages[].attachments[].file_id ou client_documents[].file_id). Le libellé d'un document (« Facture montage », « Photo OBD ») est attribué par ordre de dépôt, pas par contenu : toujours regarder le fichier.",
  inputSchema: {
    type: 'object',
    properties: {
      ticketId: { type: 'string', description: 'Numéro du ticket auquel le fichier est rattaché, ex. « SAV-2026-0134 ».' },
      fileId: { type: 'string', description: 'Identifiant du fichier (24 caractères hexadécimaux).' },
      page: { type: 'integer', minimum: 1, description: 'PDF scanné : rang de la première page scannée à rendre (défaut : 1). Reprendre la valeur `next_page` de l\'appel précédent.' },
    },
    required: ['ticketId', 'fileId'],
    additionalProperties: false,
  },
};

function guessMime(file) {
  const meta = file.metadata || {};
  const declared = String(file.contentType || meta.contentType || '').toLowerCase().split(';')[0].trim();
  if (declared && declared !== 'application/octet-stream') return declared;
  const name = String(file.filename || meta.originalName || '').toLowerCase();
  if (/\.pdf$/.test(name)) return 'application/pdf';
  if (/\.jpe?g$/.test(name)) return 'image/jpeg';
  if (/\.png$/.test(name)) return 'image/png';
  if (/\.gif$/.test(name)) return 'image/gif';
  if (/\.webp$/.test(name)) return 'image/webp';
  if (/\.(txt|csv|log)$/.test(name)) return 'text/plain';
  return declared || 'application/octet-stream';
}

function text(payload) {
  return { type: 'text', text: JSON.stringify(payload, null, 2) };
}

/* Prépare une image pour la lecture.
 * Rend { block } (bloc image MCP) ou { reason } (pourquoi elle n'est pas rendue).
 * Le type et les dimensions viennent de l'en-tête du fichier, jamais de son nom. */
async function prepareImage(buffer) {
  const head = imageInfo(buffer);
  if (!head) return { reason: "Format d'image non lisible ici (HEIC, TIFF, BMP…)." };

  const fitsAsIs = buffer.length <= PASS_THROUGH_BYTES
    && head.width <= PASS_THROUGH_SIDE && head.height <= PASS_THROUGH_SIDE;
  if (fitsAsIs) {
    return { block: { type: 'image', data: buffer.toString('base64'), mimeType: head.mime }, width: head.width, height: head.height };
  }
  if (head.mime !== 'image/jpeg' && head.mime !== 'image/png') {
    return { reason: 'Image trop lourde pour être rendue telle quelle, et ce format ne peut pas être réduit ici.' };
  }
  if (head.width * head.height > MAX_DECODE_PIXELS) {
    return { reason: `Image trop grande pour être réduite ici (${head.width} × ${head.height} px).` };
  }
  try {
    const out = await resizeToJpeg(buffer, { maxWidth: MAX_WIDTH, maxHeight: MAX_HEIGHT, quality: JPEG_QUALITY });
    if (out.buffer.length > PASS_THROUGH_BYTES * 2) return { reason: 'Image encore trop lourde après réduction.' };
    return { block: { type: 'image', data: out.buffer.toString('base64'), mimeType: 'image/jpeg' }, width: out.width, height: out.height };
  } catch (err) {
    return { reason: `Réduction de l'image impossible (${(err && err.message) || 'erreur'}).` };
  }
}

const BACK_OFFICE = ' À ouvrir dans le back-office.';

async function handler(args = {}) {
  const numero = normalizeTicketId(args.ticketId);
  if (!numero) throw new Error('ticketId manquant ou invalide (attendu : SAV-2026-0134)');
  const fileId = String(args.fileId || '').trim().toLowerCase();
  if (!/^[a-f0-9]{24}$/.test(fileId)) throw new Error('fileId invalide (24 caractères hexadécimaux attendus)');

  const file = await storage.findOne(fileId);
  const meta = (file && file.metadata && typeof file.metadata === 'object') ? file.metadata : {};
  // Même réponse que le fichier existe ailleurs ou n'existe pas : l'outil ne
  // sert que les fichiers du ticket nommé, jamais les autres fichiers du bucket
  // (procédures internes, devis moteur, fichiers d'un autre client).
  if (!file || typeof meta.ticketNumero !== 'string' || meta.ticketNumero !== numero) {
    throw new Error(`Aucun fichier ${fileId} rattaché au ticket ${numero}`);
  }

  const mime = guessMime(file);
  const info = {
    ticket: numero,
    file_id: fileId,
    name: meta.originalName || file.filename || '',
    mime,
    size_bytes: file.length,
    kind: meta.kind || '',
    uploaded_by: meta.uploadedBy || '',
    uploaded_at: file.uploadDate ? new Date(file.uploadDate).toISOString() : null,
  };

  if (file.length > MAX_FILE_BYTES) {
    return { content: [text({ ...info, readable: false, reason: 'Fichier trop volumineux pour être ouvert ici (plus de 25 Mo).' + BACK_OFFICE })] };
  }

  if (mime.startsWith('image/')) {
    const buffer = await storage.readBuffer(fileId);
    const img = await prepareImage(buffer);
    if (!img.block) return { content: [text({ ...info, readable: false, reason: img.reason + BACK_OFFICE })] };
    return { content: [text({ ...info, readable: true, shown_width: img.width, shown_height: img.height }), img.block] };
  }

  if (mime === 'application/pdf') {
    const buffer = await storage.readBuffer(fileId);
    let scan;
    try {
      scan = extractScannedPages(buffer);
    } catch (err) {
      return { content: [text({ ...info, readable: false, reason: 'PDF illisible (endommagé, ou ce n\'est pas un PDF).' + BACK_OFFICE })] };
    }
    const total = scan.images.length;
    if (!total) {
      let reason;
      if (scan.encrypted) reason = 'PDF protégé : son contenu ne peut pas être lu ici.';
      else if (scan.skipped) reason = "PDF scanné dans un format d'image que cet outil ne sait pas rendre (scan noir et blanc, par exemple).";
      else reason = "PDF « texte » (généré par un logiciel) : son contenu n'est pas lisible par cet outil. Ne rien conclure sur ce document sans l'avoir ouvert.";
      return { content: [text({ ...info, readable: false, pdf_pages: scan.pageCount, reason: reason + BACK_OFFICE })] };
    }

    const asked = Number(args.page);
    const start = Number.isInteger(asked) && asked > 0 ? asked : 1;
    if (start > total) {
      return { content: [text({ ...info, readable: false, pdf_pages: scan.pageCount, scanned_pages: total, reason: `Ce PDF n'a que ${total} page(s) scannée(s) : la page ${start} n'existe pas.` })] };
    }

    const blocks = [];
    const shown = [];
    const failed = [];
    let bytes = 0;
    let rank = start;
    for (; rank <= total && shown.length + failed.length < PAGES_PER_CALL; rank += 1) {
      const img = await prepareImage(scan.images[rank - 1].bytes);
      if (!img.block) { failed.push({ page: rank, reason: img.reason }); continue; }
      const size = img.block.data.length;
      // Budget de la réponse : la première page passe toujours, les suivantes
      // seulement si elles tiennent. La page reportée sera la prochaine demandée.
      if (blocks.length && bytes + size > MAX_RESULT_IMAGE_BYTES * 4 / 3) break;
      bytes += size;
      blocks.push(img.block);
      shown.push(rank);
    }

    const warnings = [];
    if (scan.pageCount && total < scan.pageCount) warnings.push(`Seules ${total} page(s) sur ${scan.pageCount} sont des scans : les autres ne sont pas montrées.`);
    if (scan.hasFonts) warnings.push("Ce PDF contient aussi du texte que cet outil ne lit pas : seules les images de page sont montrées.");
    else if (scan.compressedObjects) warnings.push("Ce PDF range une partie de son contenu sous forme compressée : il peut contenir des pages ou du texte que cet outil ne montre pas.");
    if (scan.skipped) warnings.push(`${scan.skipped} page(s) scannée(s) dans un format non rendu.`);

    return { content: [text({
      ...info,
      readable: blocks.length > 0,
      pdf_pages: scan.pageCount,
      scanned_pages: total,
      shown_scanned_pages: shown,
      next_page: rank <= total ? rank : null,
      pages_not_shown: failed,
      warning: warnings.length ? warnings.join(' ') : null,
    }), ...blocks] };
  }

  if (mime.startsWith('text/')) {
    const buffer = await storage.readBuffer(fileId);
    const body = buffer.toString('utf8');
    return { content: [text({ ...info, readable: true, truncated: body.length > MAX_TEXT_CHARS }), { type: 'text', text: body.slice(0, MAX_TEXT_CHARS) }] };
  }

  return { content: [text({ ...info, readable: false, reason: 'Type de fichier non lisible ici (vidéo, archive, document bureautique).' + BACK_OFFICE })] };
}

module.exports = { definition, handler, _internal: { guessMime, prepareImage } };
