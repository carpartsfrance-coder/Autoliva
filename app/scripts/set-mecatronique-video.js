'use strict';
/**
 * Applique une vidéo (galerie) sur les fiches MÉCATRONIQUE / TCU.
 *
 * Périmètre validé (13 fiches) : catégorie « Transmission > Mécatronique »
 * + la mécatronique mal classée en « Autre » (« Mécatronique S tronic 0B5 DL501 »).
 *
 * Usage (depuis le dossier app, avec .env contenant MONGODB_URI) :
 *   node scripts/set-mecatronique-video.js            # DRY-RUN : liste, n'écrit rien
 *   APPLY=1 node scripts/set-mecatronique-video.js    # APPLIQUE (+ backup auto)
 *   UNDO=1  node scripts/set-mecatronique-video.js     # ANNULE (restaure le backup)
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const VIDEO_URL = 'https://www.youtube.com/shorts/gxFTwanXX0I';
const BACKUP = path.join(__dirname, 'mecatronique-video-backup.json');
const APPLY = process.env.APPLY === '1';
const UNDO = process.env.UNDO === '1';

const QUERY = {
  $or: [
    { category: 'Transmission > Mécatronique' },
    { category: 'Autre', name: /^Mécatronique S tronic 0B5 DL501/i },
  ],
};

(async () => {
  if (!process.env.MONGODB_URI) {
    console.error('❌ MONGODB_URI absent. Lance le script depuis le dossier app (où se trouve le .env).');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('DB :', mongoose.connection.name);
  const Product = require('../src/models/Product');

  // ── ANNULATION ──
  if (UNDO) {
    if (!fs.existsSync(BACKUP)) { console.error('❌ Pas de backup à restaurer (' + BACKUP + ').'); process.exit(1); }
    const backup = JSON.parse(fs.readFileSync(BACKUP, 'utf8'));
    let n = 0;
    for (const b of backup) {
      await Product.updateOne(
        { _id: b._id },
        { $set: { 'media.videoUrl': b.oldVideoUrl || '', 'sections.showVideo': b.oldShowVideo == null ? true : b.oldShowVideo } }
      );
      n++;
    }
    console.log('↩️  Restauré ' + n + ' fiche(s) à leur état précédent.');
    await mongoose.disconnect();
    return;
  }

  const docs = await Product.find(QUERY).select('name category media.videoUrl sections.showVideo').lean();
  console.log('\nFiches ciblées : ' + docs.length + '\n');
  docs.forEach((p, i) => console.log('  ' + (i + 1) + '. [' + p.category + '] ' + p.name
    + (p.media && p.media.videoUrl ? '\n       vidéo actuelle: ' + p.media.videoUrl : '')));

  if (!APPLY) {
    console.log('\n(DRY-RUN — aucune écriture. Relance avec APPLY=1 pour appliquer.)');
    await mongoose.disconnect();
    return;
  }

  // backup avant écriture (réversibilité)
  const backup = docs.map((p) => ({
    _id: String(p._id), name: p.name,
    oldVideoUrl: (p.media && p.media.videoUrl) || '',
    oldShowVideo: p.sections ? p.sections.showVideo : null,
  }));
  fs.writeFileSync(BACKUP, JSON.stringify(backup, null, 2));

  const res = await Product.updateMany(
    { _id: { $in: docs.map((p) => p._id) } },
    { $set: { 'media.videoUrl': VIDEO_URL, 'sections.showVideo': true } }
  );
  const matched = res.matchedCount != null ? res.matchedCount : res.n;
  const modified = res.modifiedCount != null ? res.modifiedCount : res.nModified;
  console.log('\n✅ Vidéo appliquée — matched=' + matched + '  modified=' + modified);
  console.log('Backup état précédent : ' + BACKUP + '  (UNDO=1 pour annuler)');
  await mongoose.disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
