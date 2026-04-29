const mongoose = require('mongoose');
const { Readable } = require('stream');

let cachedBucket = null;
let cachedDbId = null;

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function getDbIdentity(db) {
  try {
    return db && typeof db.databaseName === 'string' ? db.databaseName : String(db);
  } catch (err) {
    return String(db);
  }
}

function getBucket() {
  const conn = mongoose.connection;
  const db = conn && conn.db;
  if (!db) {
    throw new Error('MongoDB non connectée');
  }

  const dbId = getDbIdentity(db);
  if (!cachedBucket || cachedDbId !== dbId) {
    cachedBucket = new mongoose.mongo.GridFSBucket(db, { bucketName: 'media' });
    cachedDbId = dbId;
  }

  return cachedBucket;
}

function normalizeContentType(mimeType) {
  const v = getTrimmedString(mimeType).toLowerCase();
  if (!v) return 'application/octet-stream';
  return v;
}

function buildFilenameFallback(originalName, fallbackPrefix = 'file') {
  const name = getTrimmedString(originalName);
  if (name) return name.slice(0, 180);
  return `${fallbackPrefix}-${Date.now()}`;
}

async function saveBuffer({ buffer, filename, mimeType, metadata } = {}) {
  const buf = Buffer.isBuffer(buffer) ? buffer : null;
  if (!buf || !buf.length) {
    throw new Error('Fichier vide');
  }

  const safeFilename = buildFilenameFallback(filename, 'upload');
  const contentType = normalizeContentType(mimeType);

  const bucket = getBucket();

  return new Promise((resolve, reject) => {
    const uploadStream = bucket.openUploadStream(safeFilename, {
      contentType,
      metadata: metadata && typeof metadata === 'object' ? metadata : undefined,
    });

    uploadStream.on('error', reject);
    uploadStream.on('finish', () => {
      resolve({
        id: String(uploadStream.id),
        url: `/media/${encodeURIComponent(String(uploadStream.id))}`,
        filename: safeFilename,
        contentType,
      });
    });

    Readable.from(buf).pipe(uploadStream);
  });
}

async function saveMulterFile(file, { metadata, fallbackPrefix } = {}) {
  if (!file || typeof file !== 'object') throw new Error('Fichier manquant');

  const buffer = file.buffer;
  const filename = file.originalname;
  const mimeType = file.mimetype;

  return saveBuffer({
    buffer,
    filename: buildFilenameFallback(filename, fallbackPrefix || 'upload'),
    mimeType,
    metadata,
  });
}

function extractMediaIdFromUrl(url) {
  const input = getTrimmedString(url);
  if (!input) return null;

  let path = input;
  if (/^https?:\/\//i.test(input)) {
    try {
      const parsed = new URL(input);
      path = parsed.pathname;
    } catch (err) {
      path = input;
    }
  }

  /* Support both /media/{id} and /media/{slug}-{id}.{ext} SEO URLs */
  const seoMatch = path.match(/^\/media\/(?:.+-)?([a-f0-9]{24})(?:\.[a-z0-9]+)?$/i);
  if (!seoMatch) return null;

  const id = seoMatch[1];
  if (!mongoose.Types.ObjectId.isValid(id)) return null;
  return new mongoose.Types.ObjectId(id);
}

async function deleteById(objectId) {
  const bucket = getBucket();

  const id = typeof objectId === 'string'
    ? (mongoose.Types.ObjectId.isValid(objectId) ? new mongoose.Types.ObjectId(objectId) : null)
    : objectId;

  if (!id) return { ok: false, reason: 'invalid_id' };

  try {
    await bucket.delete(id);
    return { ok: true };
  } catch (err) {
    return { ok: false, reason: 'not_found_or_error' };
  }
}

async function deleteFromUrl(url) {
  const id = extractMediaIdFromUrl(url);
  if (!id) return { ok: false, reason: 'not_media_url' };
  return deleteById(id);
}

async function findFileById(objectId) {
  const bucket = getBucket();

  const id = typeof objectId === 'string'
    ? (mongoose.Types.ObjectId.isValid(objectId) ? new mongoose.Types.ObjectId(objectId) : null)
    : objectId;

  if (!id) return null;

  const files = await bucket.find({ _id: id }).limit(1).toArray();
  return files && files.length ? files[0] : null;
}

function openDownloadStream(objectId) {
  const bucket = getBucket();

  const id = typeof objectId === 'string'
    ? (mongoose.Types.ObjectId.isValid(objectId) ? new mongoose.Types.ObjectId(objectId) : null)
    : objectId;

  if (!id) {
    throw new Error('invalid_id');
  }

  return bucket.openDownloadStream(id);
}

/**
 * Build an SEO-friendly media URL from a raw /media/{id} URL and a label (product name, article title…).
 * Example: /media/mecatronique-dsg7-dq200-69c04f97e322b45070853f43.jpeg
 * Falls back to the original URL if no label is provided.
 */
function slugifyForMedia(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
}

const MIME_TO_EXT = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
};

function buildSeoMediaUrl(rawUrl, label, contentType) {
  if (!rawUrl || typeof rawUrl !== 'string') return rawUrl || '';
  const id = extractMediaIdFromUrl(rawUrl);
  if (!id) return rawUrl;

  const slug = slugifyForMedia(label);
  const ext = (contentType && MIME_TO_EXT[contentType]) || 'jpeg';

  if (slug) {
    return `/media/${slug}-${String(id)}.${ext}`;
  }
  return `/media/${String(id)}.${ext}`;
}

module.exports = {
  saveBuffer,
  saveMulterFile,
  extractMediaIdFromUrl,
  deleteById,
  deleteFromUrl,
  findFileById,
  openDownloadStream,
  buildSeoMediaUrl,
  slugifyForMedia,
};
