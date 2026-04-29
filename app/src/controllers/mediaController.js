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
function servePlaceholder(res) {
  if (placeholderBuf) {
    res.set('Content-Type', 'image/svg+xml');
    res.set('Cache-Control', 'public, max-age=3600');
    return res.status(200).send(placeholderBuf);
  }
  return res.status(404).end();
}

async function serveMedia(id, res, next) {
  try {
    const file = await mediaStorage.findFileById(id);
    if (!file) {
      return servePlaceholder(res);
    }

    const contentType = typeof file.contentType === 'string' && file.contentType.trim()
      ? file.contentType.trim()
      : 'application/octet-stream';

    res.set('Content-Type', contentType);
    res.set('Cache-Control', 'public, max-age=31536000, immutable');

    const filename = typeof file.filename === 'string' ? file.filename.trim() : '';
    if (filename) {
      res.set('Content-Disposition', `inline; filename="${filename.replace(/\"/g, '')}"`);
    }

    const stream = mediaStorage.openDownloadStream(id);
    stream.on('error', () => {
      servePlaceholder(res);
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
