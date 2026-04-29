require('dotenv').config();

const mongoose = require('mongoose');
const VehicleMake = require('../models/VehicleMake');

function normalizeModelKey(value) {
  const v = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!v) return '';

  return v
    .replace(/[_\s]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

function scoreModelName(name) {
  const n = typeof name === 'string' ? name : '';
  const underscores = (n.match(/_/g) || []).length;
  const hyphens = (n.match(/-/g) || []).length;
  return {
    underscores,
    hyphens,
    length: n.length,
  };
}

function isBetterName(a, b) {
  // Retourne true si a est meilleur que b
  const sa = scoreModelName(a);
  const sb = scoreModelName(b);

  if (sa.underscores !== sb.underscores) return sa.underscores < sb.underscores;
  if (sa.hyphens !== sb.hyphens) return sa.hyphens < sb.hyphens;
  return sa.length >= sb.length;
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

    let totalBefore = 0;
    let totalAfter = 0;
    let makesTouched = 0;

    for (const mk of makes) {
      const models = Array.isArray(mk.models) ? mk.models : [];
      totalBefore += models.length;

      const bestByKey = new Map();

      for (const m of models) {
        const name = m && m.name ? String(m.name) : '';
        const lower = m && m.nameLower ? String(m.nameLower) : '';
        const key = normalizeModelKey(lower || name);
        if (!key) continue;

        const existing = bestByKey.get(key);
        if (!existing) {
          bestByKey.set(key, { name, nameLower: lower || name.toLowerCase() });
          continue;
        }

        if (isBetterName(name, existing.name)) {
          bestByKey.set(key, { name, nameLower: lower || name.toLowerCase() });
        }
      }

      const deduped = Array.from(bestByKey.values())
        .filter((x) => x && x.name)
        .sort((a, b) => String(a.name).localeCompare(String(b.name), 'fr'));

      totalAfter += deduped.length;

      if (deduped.length !== models.length) {
        makesTouched += 1;
        const removed = models.length - deduped.length;
        console.log(`${mk.name}: ${models.length} -> ${deduped.length} (supprimés: ${removed})`);

        if (apply) {
          mk.models = deduped;
          await mk.save();
        }
      }
    }

    console.log('---');
    console.log(`Marques analysées: ${makes.length}`);
    console.log(`Marques modifiées: ${makesTouched}`);
    console.log(`Total modèles: ${totalBefore} -> ${totalAfter}`);

    if (!apply) {
      console.log('Pour appliquer réellement: node src/seed/dedupeVehicleMakeModels.js --apply');
    }
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('Erreur dedupe:', err);
  process.exitCode = 1;
});
