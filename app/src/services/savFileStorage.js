/*
 * SAV — Stockage des fichiers en MongoDB (GridFS)
 *
 * Tous les fichiers SAV (PJ client, PJ admin, PJ emails entrants, PDFs
 * générés CGV / rapports) sont persistés dans le bucket GridFS `savFiles`.
 * Plus aucun fichier n'est stocké sur le disque local.
 *
 * URL publique côté app : `/sav-files/<id>` (servie par routes/savFiles.js).
 *
 * Métadonnées stockées sur chaque fichier :
 *   {
 *     ticketNumero: 'SAV-2026-0008' | null,  // null pour fichiers globaux (procédures)
 *     kind: 'client_upload' | 'piece_jointe_email' | 'cgv_pdf' | 'rapport_pdf' | …,
 *     uploadedBy: 'client' | 'admin' | 'inbound_email' | 'system',
 *     originalName: 'facture.pdf',
 *   }
 */

const mongoose = require('mongoose');
const { GridFSBucket, ObjectId } = require('mongodb');
const { Readable } = require('stream');

const BUCKET_NAME = 'savFiles';

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

// Reset si la connexion est recréée (utile pour tests / hot-reload)
mongoose.connection.on('disconnected', () => { _bucket = null; });
mongoose.connection.on('connected', () => { _bucket = null; });

function toObjectId(id) {
  if (!id) return null;
  if (id instanceof ObjectId) return id;
  try { return new ObjectId(String(id)); } catch (_) { return null; }
}

function buildUrl(id) {
  return `/sav-files/${String(id)}`;
}

/**
 * Sauvegarde un buffer dans GridFS.
 * @param {Object} opts
 * @param {Buffer} opts.buffer
 * @param {string} opts.filename       Nom original (info)
 * @param {string} [opts.mime]         Content-Type
 * @param {Object} [opts.metadata]     { ticketNumero, kind, uploadedBy, … }
 * @returns {Promise<{ id: string, url: string, size: number }>}
 */
function saveBuffer({ buffer, filename, mime, metadata }) {
  return new Promise((resolve, reject) => {
    if (!Buffer.isBuffer(buffer)) return reject(new Error('buffer requis'));
    const safeName = String(filename || 'fichier').slice(0, 200);
    const meta = Object.assign({}, metadata || {});
    if (mime) meta.contentType = mime;

    const bucket = getBucket();
    const uploadStream = bucket.openUploadStream(safeName, {
      contentType: mime || 'application/octet-stream',
      metadata: meta,
    });
    uploadStream.on('error', reject);
    uploadStream.on('finish', () => {
      resolve({
        id: String(uploadStream.id),
        url: buildUrl(uploadStream.id),
        size: buffer.length,
      });
    });
    Readable.from(buffer).pipe(uploadStream);
  });
}

/**
 * Récupère les métadonnées d'un fichier (sans télécharger les bytes).
 */
async function findOne(id) {
  const oid = toObjectId(id);
  if (!oid) return null;
  const bucket = getBucket();
  const cursor = bucket.find({ _id: oid }).limit(1);
  const docs = await cursor.toArray();
  return docs[0] || null;
}

/**
 * Recherche par métadonnées (ex : { 'metadata.ticketNumero': 'SAV-2026-0008' }).
 */
async function findByMetadata(query) {
  const bucket = getBucket();
  return bucket.find(query || {}).toArray();
}

/**
 * Ouvre un stream de lecture pour un fichier GridFS.
 */
function openDownloadStream(id) {
  const oid = toObjectId(id);
  if (!oid) throw new Error('id invalide');
  return getBucket().openDownloadStream(oid);
}

/**
 * Supprime un fichier (et ses chunks) du bucket.
 */
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

/**
 * Lit un fichier complet en buffer (utile pour pièces jointes email).
 */
function readBuffer(id) {
  return new Promise((resolve, reject) => {
    try {
      const stream = openDownloadStream(id);
      const chunks = [];
      stream.on('data', (c) => chunks.push(c));
      stream.on('end', () => resolve(Buffer.concat(chunks)));
      stream.on('error', reject);
    } catch (err) { reject(err); }
  });
}

/**
 * Extrait l'id GridFS depuis une URL `/sav-files/<id>`.
 * Retourne null si l'URL n'est pas au format attendu.
 */
function extractIdFromUrl(url) {
  if (!url || typeof url !== 'string') return null;
  const m = url.match(/^\/sav-files\/([a-fA-F0-9]{24})(?:[/?#].*)?$/);
  return m ? m[1] : null;
}

module.exports = {
  BUCKET_NAME,
  buildUrl,
  saveBuffer,
  findOne,
  findByMetadata,
  openDownloadStream,
  readBuffer,
  deleteFile,
  extractIdFromUrl,
};
