require('dotenv').config();

const mongoose = require('mongoose');

const Category = require('../models/Category');

function parseArgs(argv) {
  const out = { apply: false };
  for (const raw of argv) {
    if (!raw || typeof raw !== 'string') continue;
    if (raw === '--apply') out.apply = true;
  }
  return out;
}

function slugify(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

function makeCategoryName(main, sub) {
  const m = typeof main === 'string' ? main.trim() : '';
  const s = typeof sub === 'string' ? sub.trim() : '';
  if (!m) return '';
  if (!s) return m;
  return `${m} > ${s}`;
}

function buildCategoryList() {
  const groups = [
    {
      main: 'Moteur',
      subs: [
        'Bloc moteur',
        'Culasse',
        'Injection',
        'Turbo / Admission',
        'Refroidissement',
        'Allumage',
        'Alternateur / Démarreur',
        'Vilebrequin',
        'Distribution',
        'Capteurs moteur',
      ],
    },
    {
      main: 'Transmission',
      subs: [
        'Boîte de vitesses',
        'Boîte de transfert',
        'Pont / Différentiel',
        'Mécatronique',
        'Convertisseur',
        'Embrayage',
        'Cardans',
      ],
    },
    {
      main: 'Freinage',
      subs: ['Plaquettes', 'Disques', 'Étriers', 'ABS / Capteurs'],
    },
    {
      main: 'Suspension / Direction',
      subs: ['Amortisseurs', 'Ressorts', 'Triangles', 'Crémaillère', 'Rotules'],
    },
    {
      main: 'Électricité / Électronique',
      subs: ['Batteries', 'Calculateurs', 'Capteurs', 'Démarrage / Charge'],
    },
    {
      main: 'Carrosserie / Éclairage',
      subs: ['Phares / Feux', 'Pare-chocs', 'Rétroviseurs', 'Essuie-glaces'],
    },
    {
      main: 'Habitacle',
      subs: ['Multimédia', 'Consoles / Accoudoirs', 'Airbags'],
    },
    {
      main: 'Entretien',
      subs: ['Filtres', 'Huiles', 'Bougies'],
    },
    {
      main: 'Autre',
      subs: [],
    },
  ];

  const out = [];
  let order = 0;
  for (const g of groups) {
    const mainName = makeCategoryName(g.main, '');
    if (mainName) {
      out.push({ name: mainName, sortOrder: order });
      order += 10;
    }

    const subs = Array.isArray(g.subs) ? g.subs : [];
    let subOrder = 0;
    for (const sub of subs) {
      const name = makeCategoryName(g.main, sub);
      if (!name) continue;
      out.push({ name, sortOrder: order + subOrder });
      subOrder += 1;
    }

    order += 10;
  }

  return out;
}

async function upsertCategory(doc, apply) {
  const name = typeof doc.name === 'string' ? doc.name.trim() : '';
  const slug = slugify(name);
  const sortOrder = Number.isFinite(doc.sortOrder) ? doc.sortOrder : 0;

  if (!name || !slug) return { ok: false, created: false, updated: false };

  if (!apply) return { ok: true, created: false, updated: false };

  const existing = await Category.findOne({ slug }).select('_id name sortOrder isActive').lean();

  await Category.findOneAndUpdate(
    { slug },
    { $set: { name, slug, sortOrder, isActive: true } },
    { upsert: true, new: true }
  );

  if (!existing) return { ok: true, created: true, updated: false };

  const needsUpdate = existing.name !== name || (Number(existing.sortOrder) || 0) !== sortOrder || existing.isActive === false;
  return { ok: true, created: false, updated: needsUpdate };
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const apply = !!args.apply;

  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI manquant');
    process.exitCode = 1;
    return;
  }

  console.log(apply ? 'MODE: IMPORT (écrit en base)' : 'MODE: DRY-RUN (ne modifie pas la base)');

  await mongoose.connect(mongoUri);

  try {
    const list = buildCategoryList();
    let created = 0;
    let updated = 0;
    let skipped = 0;

    for (const c of list) {
      const res = await upsertCategory(c, apply);
      if (!res.ok) {
        skipped += 1;
        continue;
      }
      if (res.created) created += 1;
      if (res.updated) updated += 1;
    }

    console.log('---');
    console.log(`Catégories prévues: ${list.length}`);
    console.log(`Créées: ${created}`);
    console.log(`Mises à jour: ${updated}`);
    console.log(`Ignorées: ${skipped}`);

    if (!apply) {
      console.log('---');
      console.log('Pour appliquer réellement, relance avec: --apply');
    }
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('Erreur setup categories:', err);
  process.exitCode = 1;
});
