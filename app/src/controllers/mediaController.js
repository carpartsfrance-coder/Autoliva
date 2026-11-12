const mongoose = require('mongoose');
const path = require('path');
const fs = require('fs');

const mediaStorage = require('../services/mediaStorage');

/* Placeholder SVG served when a GridFS file is missing (avoids 404 for SEO) */
const PLACEHOLDER_PATH = path.join(__dirname, '..', '..', 'public', 'images', 'placeholder-product.svg');
let placeholderBuf = null;
try { placeholderBuf = fs.readFileSync(PLACEHOLDER_PATH); } catch (_) { /* ignore */ }

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Serve media by raw ObjectId: GET /media/:id
 */
async function getMediaById(req, res, next) {
  try {
    const id = getTrimmedString(req.params && req.params.id);
    if (!id || !mongoose.Types.ObjectId.isValid(id)) {
      return res.status(404).end();
    }

    return serveMedia(id, res, next);
  } catch (err) {
    return next(err);
  }
}

/**
 * Serve media by SEO URL: GET /media/:slug-:id.:ext
 * Extracts the 24-char hex ObjectId from the filename portion.
 */
async function getMediaBySeoUrl(req, res, next) {
  try {
    const seoName = getTrimmedString(req.params && req.params.seoName);
    if (!seoName) return res.status(404).end();

    /* Extract ObjectId from patterns like "slug-{24hex}.ext" or "{24hex}.ext" */
    const match = seoName.match(/(?:^|-)([a-f0-9]{24})(?:\.[a-z0-9]+)?$/i);
    if (!match || !mongoose.Types.ObjectId.isValid(match[1])) {
      return res.status(404).end();
    }

    return serveMedia(match[1], res, next);
  } catch (err) {
    return next(err);
  }
}

/**
 * Common media serving logic.
 */
/* ── Pourquoi ce journal ────────────────────────────────────────────────────
 *
 * Servir un carré gris en 200 était un bon choix pour la mise en page, mais il
 * a rendu le problème INVISIBLE : ni erreur, ni 404, ni ligne de journal. Des
 * fiches et 191 articles ont affiché ce carré pendant des mois sans que rien
 * ne le signale. On trace donc chaque identifiant manquant — une seule fois
 * par heure et par identifiant, et au plus 200 identifiants retenus : un robot
 * qui martèle une vieille adresse ne doit pas noyer les journaux.
 */
const MANQUANTS_VUS = new Map();
const MANQUANT_SILENCE_MS = 60 * 60 * 1000;
const MANQUANTS_MAX = 200;

function signalerMediaManquant(id) {
  const cle = getTrimmedString(id);
  if (!cle) return;
  const maintenant = Date.now();
  const derniere = MANQUANTS_VUS.get(cle);
  if (derniere && maintenant - derniere < MANQUANT_SILENCE_MS) return;
  if (MANQUANTS_VUS.size >= MANQUANTS_MAX) MANQUANTS_VUS.clear();
  MANQUANTS_VUS.set(cle, maintenant);
  console.warn(`[media] fichier absent, carré gris servi : /media/${cle}`);
}

function servePlaceholder(res, id) {
  signalerMediaManquant(id);
  if (placeholderBuf) {
    res.set('Content-Type', 'image/svg+xml');
    // Image absente temporairement → NE PAS la cacher comme un vrai 200 (sinon
    // elle resterait « manquante » 1h dans le navigateur/CDN même après le
    // ré-upload du fichier).
    res.set('Cache-Control', 'no-store');
    return res.status(200).send(placeholderBuf);
  }
  return res.status(404).end();
}

async function serveMedia(id, res, next) {
  try {
    const file = await mediaStorage.findFileById(id);
    if (!file) {
      return servePlaceholder(res, id);
    }

    const contentType = typeof file.contentType === 'string' && file.contentType.trim()
      ? file.contentType.trim()
      : 'application/octet-stream';

    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');
    // Taille connue (doc GridFS déjà chargé) → progression navigateur + meilleur cache.
    if (Number.isFinite(file.length)) res.set('Content-Length', String(file.length));

    const filename = typeof file.filename === 'string' ? file.filename.trim() : '';
    if (filename) {
      // Un en-tête HTTP n'accepte que de l'ASCII (latin1). Un nom de fichier
      // avec un accent décomposé (« a » + accent combinant, ex. images
      // « ChatGPT Image … à … ») contient des caractères hors-ASCII qui font
      // planter res.set (ERR_INVALID_CHAR → 502). On nettoie : on retire les
      // caractères non imprimables/non-ASCII et les guillemets.
      const safeName = filename.replace(/[^\x20-\x7E]/g, '').replace(/"/g, '').trim();
      if (safeName) res.set('Content-Disposition', `inline; filename="${safeName}"`);
    }

    const stream = mediaStorage.openDownloadStream(id);
    stream.on('error', () => {
      servePlaceholder(res, id);
    });
    stream.pipe(res);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getMediaById,
  getMediaBySeoUrl,
};
