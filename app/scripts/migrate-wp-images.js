#!/usr/bin/env node
// ---------------------------------------------------------------------------
// migrate-wp-images.js
// Télécharge les images produit hébergées sur l'ancien WordPress
// (carpartsfrance.fr/wp-content/...) et les stocke dans GridFS (/media/...).
// Met à jour imageUrl, galleryUrls, description et shortDescription en base.
//
// Usage :  node scripts/migrate-wp-images.js [--dry-run]
// ---------------------------------------------------------------------------

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const https = require('https');
const http = require('http');
const mongoose = require('mongoose');

const Product = require('../src/models/Product');
const mediaStorage = require('../src/services/mediaStorage');

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------
const WP_PATTERN = /https?:\/\/carpartsfrance\.fr\/wp-content\/[^\s"'<>)]+/gi;
const HTTP_TIMEOUT_MS = 15_000;
const DRY_RUN = process.argv.includes('--dry-run');

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
const stats = {
  productsScanned: 0,
  productsWithWpUrls: 0,
  imagesDownloaded: 0,
  imagesAlreadyLocal: 0,
  imageErrors: [],
  descriptionsUpdated: 0,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isWpUrl(url) {
  return typeof url === 'string' && WP_PATTERN.test(url);
}

function resetPattern() {
  WP_PATTERN.lastIndex = 0;
}

function extractFilename(url) {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    return segments[segments.length - 1] || `wp-image-${Date.now()}`;
  } catch {
    return `wp-image-${Date.now()}`;
  }
}

function guessMimeType(url) {
  const lower = url.toLowerCase();
  if (lower.includes('.png')) return 'image/png';
  if (lower.includes('.webp')) return 'image/webp';
  if (lower.includes('.gif')) return 'image/gif';
  return 'image/jpeg';
}

function downloadBuffer(url) {
  return new Promise((resolve, reject) => {
    const client = url.startsWith('https') ? https : http;
    const req = client.get(url, { timeout: HTTP_TIMEOUT_MS }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return downloadBuffer(res.headers.location).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const contentType = (res.headers['content-type'] || '').split(';')[0].trim();
        resolve({ buffer: Buffer.concat(chunks), contentType });
      });
      res.on('error', reject);
    });
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.on('error', reject);
  });
}

// Cache : évite de re-télécharger la même image WP si elle apparait dans plusieurs produits
const urlCache = new Map();

async function migrateUrl(wpUrl) {
  if (urlCache.has(wpUrl)) {
    return urlCache.get(wpUrl);
  }

  const filename = extractFilename(wpUrl);

  if (DRY_RUN) {
    const placeholder = `/media/dry-run-${stats.imagesDownloaded}`;
    urlCache.set(wpUrl, placeholder);
    stats.imagesDownloaded++;
    console.log(`  ↓ (dry-run) ${filename}`);
    return placeholder;
  }

  console.log(`  ↓ Téléchargement : ${filename}`);

  const { buffer, contentType } = await downloadBuffer(wpUrl);
  const mime = contentType.startsWith('image/') ? contentType : guessMimeType(wpUrl);

  const result = await mediaStorage.saveBuffer({
    buffer,
    filename,
    mimeType: mime,
    metadata: { migratedFrom: wpUrl },
  });

  urlCache.set(wpUrl, result.url);
  stats.imagesDownloaded++;
  console.log(`  ✓ Sauvegardé : ${result.url}`);
  return result.url;
}

function isLocalUrl(url) {
  if (typeof url !== 'string') return true;
  if (!url) return true;
  if (url.startsWith('/media/')) return true;
  if (url.startsWith('/')) return true;
  return false;
}

async function migrateTextField(text) {
  if (typeof text !== 'string' || !text) return { text, changed: false };

  resetPattern();
  const matches = text.match(WP_PATTERN);
  if (!matches || matches.length === 0) return { text, changed: false };

  const uniqueUrls = [...new Set(matches)];
  let result = text;

  for (const wpUrl of uniqueUrls) {
    try {
      const newUrl = await migrateUrl(wpUrl);
      result = result.split(wpUrl).join(newUrl);
    } catch (err) {
      stats.imageErrors.push({ url: wpUrl, error: err.message, context: 'description' });
      console.log(`  ✗ Erreur description : ${wpUrl} → ${err.message}`);
    }
  }

  return { text: result, changed: result !== text };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI non défini dans .env');
    process.exit(1);
  }

  console.log(`\n${'='.repeat(60)}`);
  console.log('Migration des images WordPress → GridFS');
  console.log(DRY_RUN ? '*** MODE DRY-RUN — aucune modification ***' : '*** MODE RÉEL — modifications en base ***');
  console.log(`${'='.repeat(60)}\n`);

  await mongoose.connect(mongoUri);
  console.log('MongoDB connectée\n');

  const products = await Product.find({}).lean();
  stats.productsScanned = products.length;
  console.log(`${products.length} produits trouvés\n`);

  for (const product of products) {
    const updates = {};
    let hasWpUrl = false;

    // --- imageUrl ---
    if (typeof product.imageUrl === 'string' && product.imageUrl) {
      resetPattern();
      if (isWpUrl(product.imageUrl)) {
        hasWpUrl = true;
        try {
          const newUrl = await migrateUrl(product.imageUrl);
          updates.imageUrl = newUrl;
        } catch (err) {
          stats.imageErrors.push({ url: product.imageUrl, error: err.message, product: product.name });
          console.log(`  ✗ Erreur imageUrl : ${product.imageUrl} → ${err.message}`);
        }
      } else if (isLocalUrl(product.imageUrl)) {
        stats.imagesAlreadyLocal++;
      }
    }

    // --- galleryUrls ---
    if (Array.isArray(product.galleryUrls) && product.galleryUrls.length > 0) {
      const newGallery = [...product.galleryUrls];
      let galleryChanged = false;

      for (let i = 0; i < newGallery.length; i++) {
        const url = newGallery[i];
        resetPattern();
        if (typeof url === 'string' && isWpUrl(url)) {
          hasWpUrl = true;
          try {
            newGallery[i] = await migrateUrl(url);
            galleryChanged = true;
          } catch (err) {
            stats.imageErrors.push({ url, error: err.message, product: product.name });
            console.log(`  ✗ Erreur gallery[${i}] : ${url} → ${err.message}`);
          }
        } else if (isLocalUrl(url)) {
          stats.imagesAlreadyLocal++;
        }
      }

      if (galleryChanged) {
        updates.galleryUrls = newGallery;
      }
    }

    // --- description ---
    const descResult = await migrateTextField(product.description);
    if (descResult.changed) {
      hasWpUrl = true;
      updates.description = descResult.text;
      stats.descriptionsUpdated++;
    }

    // --- shortDescription ---
    const shortDescResult = await migrateTextField(product.shortDescription);
    if (shortDescResult.changed) {
      hasWpUrl = true;
      updates.shortDescription = shortDescResult.text;
      stats.descriptionsUpdated++;
    }

    if (hasWpUrl) {
      stats.productsWithWpUrls++;
      console.log(`\n[${product.name || product._id}]`);
    }

    // --- Mise à jour en base ---
    if (Object.keys(updates).length > 0) {
      if (DRY_RUN) {
        console.log('  (dry-run) Modifications prévues :', Object.keys(updates).join(', '));
      } else {
        await Product.updateOne({ _id: product._id }, { $set: updates });
        console.log('  → Base mise à jour');
      }
    }
  }

  // --- Résumé ---
  console.log(`\n${'='.repeat(60)}`);
  console.log('RÉSUMÉ');
  console.log(`${'='.repeat(60)}`);
  console.log(`Produits scannés        : ${stats.productsScanned}`);
  console.log(`Produits avec URL WP    : ${stats.productsWithWpUrls}`);
  console.log(`Images téléchargées     : ${stats.imagesDownloaded}`);
  console.log(`Images déjà locales     : ${stats.imagesAlreadyLocal}`);
  console.log(`Descriptions mises à jour: ${stats.descriptionsUpdated}`);
  console.log(`Erreurs                 : ${stats.imageErrors.length}`);

  if (stats.imageErrors.length > 0) {
    console.log('\nDétail des erreurs :');
    for (const e of stats.imageErrors) {
      console.log(`  - ${e.url} → ${e.error}${e.product ? ` (produit: ${e.product})` : ''}`);
    }
  }

  console.log('');
  await mongoose.disconnect();
  process.exit(stats.imageErrors.length > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('Erreur fatale :', err);
  process.exit(2);
});
