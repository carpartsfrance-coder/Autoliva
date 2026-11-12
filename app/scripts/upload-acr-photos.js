/**
 * Upload des photos locales ACR vers le stockage du site (GridFS) + association aux fiches produit.
 *
 * - Lit les photos locales dans ACR_PHOTOS/<offer_id>/NN.jpg (4 max par défaut)
 * - Pousse chaque photo dans GridFS via le service mediaStorage du site
 * - Renseigne imageUrl + galleryUrls (/media/<id>) sur le produit dont sku = "ACR-<offer_id>"
 *
 * SCALE : même script pour 10 ou pour 1171 (il parcourt tous les sous-dossiers présents).
 *
 * Usage :
 *   ACR_PHOTOS=/Users/killianbelabbes/Documents/Moteur/import10-photos \
 *   MAX_PHOTOS=4 \
 *   node scripts/upload-acr-photos.js [--dry-run] [--overwrite]
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const mediaStorage = require('../src/services/mediaStorage');
const Product = require('../src/models/Product');

const PHOTOS_ROOT = process.env.ACR_PHOTOS || '/Users/killianbelabbes/Documents/Moteur/import10-photos';
const MAX_PHOTOS = parseInt(process.env.MAX_PHOTOS || '4', 10);
const DRY_RUN = process.argv.includes('--dry-run');
const OVERWRITE = process.argv.includes('--overwrite');

function logDbHint(uri) {
  try {
    const host = (uri || '').replace(/\/\/[^@]*@/, '//***@').slice(0, 60);
    console.log('MongoDB :', host, '…');
  } catch (_) {}
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI manquant (.env)');
  logDbHint(uri);
  if (!fs.existsSync(PHOTOS_ROOT)) throw new Error('Dossier photos introuvable : ' + PHOTOS_ROOT);

  await mongoose.connect(uri);
  console.log('Connecté. Dossier photos :', PHOTOS_ROOT, DRY_RUN ? '(DRY-RUN)' : '');

  // OFFERS=18266611573,18541593601 → ne traite QUE ces offers (re-upload ciblé, ex. correction pancartes).
  const ONLY = (process.env.OFFERS || '').split(',').map((s) => s.trim()).filter(Boolean);
  const onlySet = ONLY.length ? new Set(ONLY) : null;
  // dossiers = offer_id numériques (ACR/Dekram) OU codes alphanumériques (Eden : NAY, MLL…)
  let offers = fs.readdirSync(PHOTOS_ROOT).filter((d) => /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(d) && !d.startsWith('IMG')).sort();
  if (onlySet) offers = offers.filter((o) => onlySet.has(o));
  if (onlySet) console.log('Filtre OFFERS actif :', offers.length, 'moteurs ciblés');
  let updated = 0, skippedNoProduct = 0, skippedHasImage = 0, totalPhotos = 0;

  const SKU_PREFIX = process.env.SKU_PREFIX || 'AUTO-';
  for (const offer of offers) {
    const sku = SKU_PREFIX + offer;
    const product = await Product.findOne({ sku });
    if (!product) { console.log('  · pas de produit pour', sku, '→ ignoré'); skippedNoProduct++; continue; }
    if (product.imageUrl && !OVERWRITE) { console.log('  · ', sku, 'a déjà une image → ignoré (--overwrite pour forcer)'); skippedHasImage++; continue; }

    const dir = path.join(PHOTOS_ROOT, offer);
    const files = fs.readdirSync(dir).filter((f) => /\.jpe?g$/i.test(f)).sort().slice(0, MAX_PHOTOS);
    if (!files.length) { console.log('  · ', sku, 'aucune photo locale → ignoré'); continue; }

    const urls = [];
    for (const f of files) {
      const buffer = fs.readFileSync(path.join(dir, f));
      if (DRY_RUN) { urls.push('(dry)/media/xxxx'); continue; }
      const res = await mediaStorage.saveBuffer({
        buffer,
        filename: `${(product.slug || sku)}-${f}`.slice(0, 180),
        mimeType: 'image/jpeg',
        metadata: { source: 'acr-rudka', offer, sku },
      });
      urls.push(res.url);
    }
    totalPhotos += urls.length;

    if (!DRY_RUN) {
      product.imageUrl = urls[0];
      product.galleryUrls = urls;
      product.galleryTypes = urls.map(() => 'image');
      await product.save();
    }
    console.log('  ✓', sku, '→', urls.length, 'photos', DRY_RUN ? '' : ('· ' + urls[0]));
    updated++;
  }

  console.log(`\nTerminé : ${updated} produits ${DRY_RUN ? '(dry) ' : ''}mis à jour (${totalPhotos} photos), ${skippedNoProduct} sans produit, ${skippedHasImage} déjà imagés.`);
  await mongoose.disconnect();
}

main().catch((e) => { console.error('ERREUR:', e.message); process.exit(1); });
