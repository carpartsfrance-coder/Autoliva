/*
 * Documents techniques produit — stockage MongoDB (GridFS).
 *
 * Bucket dédié `product_docs`, VOLONTAIREMENT distinct de `media` : ce dernier
 * est exposé publiquement par /media/:id, alors que les documents techniques
 * (manuel de montage, conditions, etc.) sont RÉSERVÉS aux acheteurs. Ils ne sont
 * servis QUE par la route gated /compte/commandes/:orderId/documents/:docId
 * (session client propriétaire, magic-link HMAC dans l'email, ou admin).
 *
 * Métadonnées : { kind: 'product_doc', productId, title, uploadedBy }.
 */

const mongoose = require('mongoose');
const { GridFSBucket, ObjectId } = require('mongodb');
const { Readable } = require('stream');

const BUCKET_NAME = 'product_docs';

let _bucket = null;

function getBucket() {
  if (_bucket) return _bucket;
  const conn = mongoose.connection;
  if (!conn || conn.readyState !== 1 || !conn.db) {
    throw new Error('MongoDB non connecté — impossible d\'initialiser GridFS');
  }
  _bucket = new GridFSBucket(conn.db, { bucketName: BUCKET_NAME });
  return _bucket;
}

mongoose.connection.on('disconnected', () => { _bucket = null; });
mongoose.connection.on('connected', () => { _bucket = null; });

function toObjectId(id) {
  if (!id) return null;
  if (id instanceof ObjectId) return id;
  try { return new ObjectId(String(id)); } catch (_) { return null; }
}

/**
 * Sauvegarde un buffer PDF dans GridFS.
 * @returns {Promise<{ id: string, size: number }>}
 */
function saveBuffer({ buffer, filename, mime, metadata }) {
  return new Promise((resolve, reject) => {
    if (!Buffer.isBuffer(buffer)) return reject(new Error('buffer requis'));
    const safeName = String(filename || 'document.pdf').slice(0, 200);
    const meta = Object.assign({ kind: 'product_doc' }, metadata || {});
    const bucket = getBucket();
    const uploadStream = bucket.openUploadStream(safeName, {
      contentType: mime || 'application/pdf',
      metadata: meta,
    });
    uploadStream.on('error', reject);
    uploadStream.on('finish', () => {
      resolve({ id: String(uploadStream.id), size: buffer.length });
    });
    Readable.from(buffer).pipe(uploadStream);
  });
}

/** Métadonnées d'un fichier (length, contentType, filename) sans télécharger. */
async function findOne(id) {
  const oid = toObjectId(id);
  if (!oid) return null;
  const docs = await getBucket().find({ _id: oid }).limit(1).toArray();
  return docs[0] || null;
}

/** Ouvre un stream de lecture pour un fichier GridFS. */
function openDownloadStream(id) {
  const oid = toObjectId(id);
  if (!oid) throw new Error('id invalide');
  return getBucket().openDownloadStream(oid);
}

/** Supprime un fichier (et ses chunks). */
async function deleteFile(id) {
  const oid = toObjectId(id);
  if (!oid) return false;
  try {
    await getBucket().delete(oid);
    return true;
  } catch (err) {
    if (err && err.message && /file not found/i.test(err.message)) return false;
    throw err;
  }
}

module.exports = {
  BUCKET_NAME,
  saveBuffer,
  findOne,
  openDownloadStream,
  deleteFile,
};
