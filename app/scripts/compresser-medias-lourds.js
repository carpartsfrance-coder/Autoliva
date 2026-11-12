'use strict';

/* Recompresse EN PLACE les images déjà en base au-dessus d'un seuil.
 *
 * L'accueil servait un PNG de 2 Mo (une image générée, enregistrée telle
 * quelle comme photo de fiche) ; 34 fichiers dépassaient 500 Ko pour 57 Mo.
 * Depuis, mediaStorage réduit les images à l'entrée — ce script rattrape ce
 * qui est déjà là, avec les mêmes règles (imageCompress.optimiserImageCatalogue).
 *
 * Même identifiant GridFS avant/après : aucune référence (fiches, articles,
 * e-mails, flux Merchant, caches) n'a à changer. Un navigateur qui a l'ancien
 * fichier en cache garde une image plus lourde, mais identique. Entre la
 * suppression et la ré-écriture (quelques dizaines de millisecondes), une
 * requête tomberait sur l'image de remplacement, servie sans cache.
 *
 * Si la ré-écriture échoue, l'ORIGINAL est remis sous le même identifiant :
 * on ne perd jamais une photo.
 *
 *   node scripts/compresser-medias-lourds.js                              # inventaire
 *   node scripts/compresser-medias-lourds.js --appliquer [--seuil-ko=500] [--limite=N] [--sauvegarde=DOSSIER]
 *
 * --sauvegarde=DOSSIER écrit chaque original sur disque avant de le réécrire
 * (nommé <id>.<ext>) : l'assurance de pouvoir revenir en arrière.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { Readable } = require('stream');
const { optimiserImageCatalogue } = require('../src/services/imageCompress');

function option(nom, defaut) {
  const a = process.argv.find((x) => x.startsWith('--' + nom + '='));
  return a ? Number(a.split('=')[1]) : defaut;
}

function lireTout(stream) {
  return new Promise((resolve, reject) => {
    const morceaux = [];
    stream.on('data', (c) => morceaux.push(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(morceaux)));
  });
}

function ecrireSousId(bucket, id, filename, options, buffer) {
  return new Promise((resolve, reject) => {
    const up = bucket.openUploadStreamWithId(id, filename, options);
    up.on('error', reject);
    up.on('finish', resolve);
    Readable.from(buffer).pipe(up);
  });
}

async function main() {
  const appliquer = process.argv.includes('--appliquer');
  const seuil = option('seuil-ko', 500) * 1024;
  const limite = option('limite', Infinity);
  const argSauvegarde = process.argv.find((x) => x.startsWith('--sauvegarde='));
  const sauvegarde = argSauvegarde ? argSauvegarde.split('=').slice(1).join('=') : '';
  if (sauvegarde) fs.mkdirSync(sauvegarde, { recursive: true });

  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 20000 });
  const db = mongoose.connection.db;
  const bucket = new mongoose.mongo.GridFSBucket(db, { bucketName: 'media' });
  const fichiers = await db.collection('media.files')
    .find({ contentType: { $in: ['image/jpeg', 'image/png'] }, length: { $gt: seuil } })
    .sort({ length: -1 }).limit(Number.isFinite(limite) ? limite : 0).toArray();

  console.log(`${fichiers.length} image(s) au-dessus de ${Math.round(seuil / 1024)} Ko` + (appliquer ? '' : ' — inventaire seul, rien n\'est écrit'));
  let avantTotal = 0; let apresTotal = 0; let faits = 0; let intacts = 0; let echecs = 0;

  for (const f of fichiers) {
    const nom = String(f.filename || '').slice(0, 40).padEnd(40);
    try {
      const original = await lireTout(bucket.openDownloadStream(f._id));
      const r = await optimiserImageCatalogue(original, f.contentType, { seuilOctets: 0 });
      avantTotal += original.length;
      if (!r.modifie) { intacts++; apresTotal += original.length; console.log(`  = ${nom} ${Math.round(original.length / 1024)} Ko, déjà au mieux`); continue; }
      apresTotal += r.buffer.length;
      console.log(`  ${appliquer ? '✓' : '·'} ${nom} ${String(Math.round(original.length / 1024)).padStart(5)} Ko → ${String(Math.round(r.buffer.length / 1024)).padStart(4)} Ko ${r.mime.replace('image/', '')} ${r.largeur}x${r.hauteur}`);
      if (!appliquer) continue;
      if (sauvegarde) {
        fs.writeFileSync(path.join(sauvegarde, String(f._id) + (f.contentType === 'image/png' ? '.png' : '.jpg')), original);
      }

      const filename = r.mime === f.contentType ? f.filename
        : String(f.filename || 'image').replace(/\.(png|jpe?g)$/i, '') + (r.mime === 'image/jpeg' ? '.jpg' : '.png');
      const options = {
        contentType: r.mime,
        metadata: { ...(f.metadata || {}), optimise: { avantOctets: original.length, apresOctets: r.buffer.length, largeur: r.largeur, hauteur: r.hauteur, le: new Date() } },
      };
      await bucket.delete(f._id);
      try {
        await ecrireSousId(bucket, f._id, filename, options, r.buffer);
      } catch (e) {
        console.error(`    ré-écriture échouée (${e.message}), original remis en place`);
        await ecrireSousId(bucket, f._id, f.filename, { contentType: f.contentType, metadata: f.metadata }, original);
        echecs++;
        continue;
      }
      const relu = await db.collection('media.files').findOne({ _id: f._id });
      if (!relu || relu.length !== r.buffer.length) throw new Error('relecture incohérente pour ' + f._id);
      faits++;
    } catch (e) {
      echecs++;
      console.error(`  ✗ ${nom} ${e.message}`);
    }
  }

  console.log(`\n${Math.round(avantTotal / 1048576)} Mo → ${Math.round(apresTotal / 1048576)} Mo. ` + (appliquer ? `${faits} réécrite(s), ${intacts} intacte(s), ${echecs} échec(s).` : `${fichiers.length - intacts} à réécrire, ${intacts} intacte(s).`));
  await mongoose.disconnect();
  if (echecs) process.exit(1);
}

if (require.main === module) main().catch((e) => { console.error('\nÉCHEC', e.message); process.exit(1); });
