require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const VehicleMake = require('../models/VehicleMake');

function normalizeVehicleName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return {
    name,
    nameLower: name ? name.toLowerCase() : '',
  };
}

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

function nameFromSlug(slug) {
  const raw = typeof slug === 'string' ? slug.trim() : '';
  if (!raw) return '';

  const parts = raw
    .split(/[-_]+/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const onlyLetters = /^[a-z]+$/i.test(p);
      const hasDigit = /\d/.test(p);

      if (onlyLetters && p.length <= 3) return p.toUpperCase();
      if (hasDigit) return p.toUpperCase();
      if (p.length === 1) return p.toUpperCase();
      return p.charAt(0).toUpperCase() + p.slice(1);
    });

  return parts.join(' ').trim();
}

function extractMakeModelFromUrl(url) {
  if (typeof url !== 'string') return null;

  const m = url.match(/^https:\/\/ovoko\.fr\/liste-de-voitures\/([^\/?#]+)\/([^\/?#]+)$/i);
  if (!m) return null;

  const makeSlug = String(m[1] || '').trim();
  const modelSlug = String(m[2] || '').trim();

  if (!makeSlug || !modelSlug) return null;
  if (modelSlug.toLowerCase() === 'tous') return null;

  return { makeSlug, modelSlug };
}

async function upsertMakeAndModels(makeName, modelNames, apply) {
  const normalized = normalizeVehicleName(makeName);
  if (!normalized.nameLower) return { created: false, updated: false, addedModels: 0 };

  const make = apply
    ? await VehicleMake.findOneAndUpdate(
        { nameLower: normalized.nameLower },
        { $set: { name: normalized.name, nameLower: normalized.nameLower }, $setOnInsert: { models: [] } },
        { upsert: true, new: true }
      )
    : await VehicleMake.findOne({ nameLower: normalized.nameLower }).lean();

  const existingKeys =
    make && make.models && Array.isArray(make.models)
      ? make.models
          .map((m) => {
            const lower = m && m.nameLower ? String(m.nameLower) : '';
            const name = m && m.name ? String(m.name) : '';
            return normalizeModelKey(lower || name);
          })
          .filter(Boolean)
      : [];
  const existingSet = new Set(existingKeys);

  let added = 0;
  const toAdd = [];
  for (const modelName of modelNames) {
    const mn = normalizeVehicleName(modelName);
    if (!mn.nameLower) continue;
    const key = normalizeModelKey(mn.nameLower);
    if (!key) continue;
    if (existingSet.has(key)) continue;
    existingSet.add(key);
    toAdd.push({ name: mn.name, nameLower: mn.nameLower });
    added += 1;
  }

  if (!apply) return { created: !make, updated: false, addedModels: added };

  if (toAdd.length > 0) {
    const doc = await VehicleMake.findOne({ nameLower: normalized.nameLower });
    if (doc) {
      doc.models = Array.isArray(doc.models) ? doc.models : [];
      doc.models.push(...toAdd);
      await doc.save();
    }
  }

  return { created: !make, updated: toAdd.length > 0, addedModels: added };
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

  const inputArg = args.find((a) => a.startsWith('--input='));
  const inputFile = inputArg ? inputArg.split('=')[1] : process.env.OVOKO_URLS_FILE;

  if (!inputFile) {
    console.error('Fichier manquant. Utilise --input=chemin/vers/fichier.json');
    process.exitCode = 1;
    return;
  }

  const makeLimitArg = args.find((a) => a.startsWith('--limitMakes='));
  const makeLimit = makeLimitArg ? Number(makeLimitArg.split('=')[1]) : null;

  const resolved = path.isAbsolute(inputFile) ? inputFile : path.resolve(process.cwd(), inputFile);

  console.log(apply ? 'MODE: IMPORT (écrit en base)' : 'MODE: DRY-RUN (ne modifie pas la base)');
  console.log(`Lecture URLs: ${resolved}`);

  const raw = fs.readFileSync(resolved, 'utf8');
  const parsed = JSON.parse(raw);
  const urls = Array.isArray(parsed) ? parsed : Array.isArray(parsed.urls) ? parsed.urls : [];
  const makes = parsed && typeof parsed === 'object' && Array.isArray(parsed.makes) ? parsed.makes : [];

  const byMake = new Map();
  for (const u of urls) {
    const pair = extractMakeModelFromUrl(u);
    if (!pair) continue;

    if (!byMake.has(pair.makeSlug)) byMake.set(pair.makeSlug, new Set());
    byMake.get(pair.makeSlug).add(pair.modelSlug);
  }

  for (const makeSlugRaw of makes) {
    const makeSlug = typeof makeSlugRaw === 'string' ? makeSlugRaw.trim() : '';
    if (!makeSlug) continue;
    if (!byMake.has(makeSlug)) byMake.set(makeSlug, new Set());
  }

  if (byMake.size === 0) {
    console.error('Aucune marque trouvée dans le fichier');
    process.exitCode = 1;
    return;
  }

  let makeSlugs = Array.from(byMake.keys()).sort((a, b) => String(a).localeCompare(String(b), 'fr'));
  if (makeLimit && Number.isFinite(makeLimit) && makeLimit > 0) {
    makeSlugs = makeSlugs.slice(0, Math.floor(makeLimit));
  }

  console.log(`Marques (via URLs) trouvées: ${makeSlugs.length}`);

  await mongoose.connect(mongoUri);

  try {
    let totalModels = 0;
    for (let i = 0; i < makeSlugs.length; i += 1) {
      const makeSlug = makeSlugs[i];
      const modelSlugs = byMake.get(makeSlug) ? Array.from(byMake.get(makeSlug)) : [];

      const makeName = nameFromSlug(makeSlug);
      const modelNames = modelSlugs
        .map((s) => nameFromSlug(s))
        .filter(Boolean)
        .sort((a, b) => String(a).localeCompare(String(b), 'fr'));

      totalModels += modelNames.length;
      console.log(`[${i + 1}/${makeSlugs.length}] ${makeName} (slug: ${makeSlug}) -> modèles: ${modelNames.length}`);

      const res = await upsertMakeAndModels(makeName, modelNames, apply);
      console.log(`  ajoutés: ${res.addedModels}`);
    }

    console.log(`Terminé. Total modèles (brut): ${totalModels}`);
    if (!apply) console.log('Pour importer réellement, relance avec: --apply');
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('Erreur import ovoko (depuis URLs):', err);
  process.exitCode = 1;
});
