require('dotenv').config();

const mongoose = require('mongoose');
const VehicleMake = require('../models/VehicleMake');

function normalizeVehicleName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return {
    name,
    nameLower: name ? name.trim().toLowerCase() : '',
  };
}

function cleanupVehicleModelName(value) {
  let s = typeof value === 'string' ? value : '';
  s = s.trim();
  if (!s) return '';

  s = s
    .replace(/\(\s*((?:19|20)\d{2})(?:\s*[-–\/\s]+\s*((?:19|20)\d{2}))?\s*\)\s*$/g, '')
    .trim();
  s = s
    .replace(/(?:^|\s)((?:19|20)\d{2})(?:\s*[-–\/\s]+\s*((?:19|20)\d{2}))?\s*$/g, '')
    .trim();
  s = s.replace(/\s{2,}/g, ' ').trim();
  s = s.replace(/[-–\/\s]+$/g, '').trim();

  return s;
}

async function run() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI manquant');
    process.exitCode = 1;
    return;
  }

  const args = process.argv.slice(2);
  const apply = args.includes('--apply');

  console.log(apply ? 'MODE: APPLY (modifie la base)' : 'MODE: DRY-RUN (ne modifie pas la base)');

  await mongoose.connect(mongoUri);

  try {
    const makes = await VehicleMake.find({}).sort({ nameLower: 1 });

    let makesTouched = 0;
    let totalRenamed = 0;
    let totalRemoved = 0;
    let totalBefore = 0;
    let totalAfter = 0;

    for (const mk of makes) {
      const models = Array.isArray(mk.models) ? mk.models : [];
      totalBefore += models.length;

      const seenLower = new Set();
      const nextModels = [];

      let renamed = 0;
      let removed = 0;
      const examples = [];

      for (const m of models) {
        const originalName = m && m.name ? String(m.name).trim() : '';
        if (!originalName) continue;

        const cleaned = cleanupVehicleModelName(originalName);
        const finalName = cleaned || originalName;

        if (finalName !== originalName) {
          renamed += 1;
          if (examples.length < 10) examples.push({ from: originalName, to: finalName });
        }

        const normalized = normalizeVehicleName(finalName);
        if (!normalized.nameLower) continue;

        if (seenLower.has(normalized.nameLower)) {
          removed += 1;
          continue;
        }

        seenLower.add(normalized.nameLower);
        nextModels.push({ _id: m._id, name: normalized.name, nameLower: normalized.nameLower });
      }

      nextModels.sort((a, b) => String(a.name).localeCompare(String(b.name), 'fr'));

      totalAfter += nextModels.length;

      const touched = renamed > 0 || removed > 0 || nextModels.length !== models.length;
      if (touched) {
        makesTouched += 1;
        totalRenamed += renamed;
        totalRemoved += removed;

        const before = models.length;
        const after = nextModels.length;
        const diff = before !== after ? ` (${before} -> ${after})` : '';
        console.log(`${mk.name}: renommés ${renamed}, doublons supprimés ${removed}${diff}`);

        if (examples.length) {
          for (const ex of examples) {
            console.log(`  - ${ex.from} -> ${ex.to}`);
          }
          if (renamed > examples.length) {
            console.log(`  ... +${renamed - examples.length} autres`);
          }
        }

        if (apply) {
          mk.models = nextModels;
          await mk.save();
        }
      }
    }

    console.log('---');
    console.log(`Marques analysées: ${makes.length}`);
    console.log(`Marques modifiées: ${makesTouched}`);
    console.log(`Modèles renommés: ${totalRenamed}`);
    console.log(`Doublons supprimés: ${totalRemoved}`);
    console.log(`Total modèles: ${totalBefore} -> ${totalAfter}`);

    if (!apply) {
      console.log('Pour appliquer réellement: node src/seed/cleanupVehicleMakeModelNames.js --apply');
    }
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('Erreur cleanup modèles:', err);
  process.exitCode = 1;
});
