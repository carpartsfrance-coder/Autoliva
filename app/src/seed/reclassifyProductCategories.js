require('dotenv').config();

const mongoose = require('mongoose');

const Product = require('../models/Product');
const Category = require('../models/Category');

function parseArgs(argv) {
  const out = { apply: false, limit: null };
  for (const raw of argv) {
    if (!raw || typeof raw !== 'string') continue;
    if (raw === '--apply') out.apply = true;
    if (raw.startsWith('--limit=')) {
      const n = Number(raw.slice('--limit='.length));
      if (Number.isFinite(n) && n > 0) out.limit = Math.floor(n);
    }
  }
  return out;
}

function normalizeText(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function makeCategoryName(main, sub) {
  const m = typeof main === 'string' ? main.trim() : '';
  const s = typeof sub === 'string' ? sub.trim() : '';
  if (!m) return '';
  if (!s) return m;
  return `${m} > ${s}`;
}

function buildCanonicalCategoryNames() {
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
    { main: 'Freinage', subs: ['Plaquettes', 'Disques', 'Étriers', 'ABS / Capteurs'] },
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
    { main: 'Habitacle', subs: ['Multimédia', 'Consoles / Accoudoirs', 'Airbags'] },
    { main: 'Entretien', subs: ['Filtres', 'Huiles', 'Bougies'] },
    { main: 'Autre', subs: [] },
  ];

  const out = [];
  for (const g of groups) {
    out.push(makeCategoryName(g.main, ''));
    for (const s of g.subs || []) out.push(makeCategoryName(g.main, s));
  }

  return out.filter(Boolean);
}

function buildMainCategoryNames() {
  return [
    'Moteur',
    'Transmission',
    'Freinage',
    'Suspension / Direction',
    'Électricité / Électronique',
    'Carrosserie / Éclairage',
    'Habitacle',
    'Entretien',
    'Autre',
  ];
}

function extractProductText(p) {
  const parts = [];
  if (p && typeof p.name === 'string') parts.push(p.name);
  if (p && typeof p.brand === 'string') parts.push(p.brand);
  if (p && typeof p.sku === 'string') parts.push(p.sku);

  if (p && Array.isArray(p.specs)) {
    for (const s of p.specs) {
      if (!s) continue;
      if (typeof s.label === 'string') parts.push(s.label);
      if (typeof s.value === 'string') parts.push(s.value);
    }
  }

  return normalizeText(parts.join(' '));
}

function looksLikeObjectId(value) {
  if (typeof value !== 'string') return false;
  return /^[0-9a-f]{24}$/i.test(value.trim());
}

function decideCategoryFromText(text) {
  const t = text || '';

  // Transmission
  if (t.includes('mecatron') || t.includes('dq200') || t.includes('dl501') || t.includes('s-tronic') || t.includes('tcm') || t.includes('tcu')) {
    return makeCategoryName('Transmission', 'Mécatronique');
  }
  if (t.includes('boite de transfert') || t.includes('transfer case') || t.includes('atc') || t.includes('transfert')) {
    return makeCategoryName('Transmission', 'Boîte de transfert');
  }
  if (t.includes('boite de vitesses') || t.includes('boite auto') || t.includes('dsg') || t.includes('multitronic') || t.includes('tiptronic') || t.includes('zf') || t.includes('s tronic')) {
    return makeCategoryName('Transmission', 'Boîte de vitesses');
  }
  if (t.includes('pont arriere') || t.includes('pont avant') || t.includes('differenti') || t.includes('différenti') || t.includes('differentiel') || t.includes('différentiel')) {
    return makeCategoryName('Transmission', 'Pont / Différentiel');
  }
  if (t.includes('cardan')) {
    return makeCategoryName('Transmission', 'Cardans');
  }
  if (t.includes('embrayage') || t.includes('clutch')) {
    return makeCategoryName('Transmission', 'Embrayage');
  }
  if (t.includes('convertisseur')) {
    return makeCategoryName('Transmission', 'Convertisseur');
  }

  // Moteur
  if (t.includes('moteur')) {
    if (t.includes('vilebrequin')) return makeCategoryName('Moteur', 'Vilebrequin');
    if (t.includes('alternateur') || t.includes('demarreur') || t.includes('démarreur')) {
      return makeCategoryName('Moteur', 'Alternateur / Démarreur');
    }
    if (t.includes('capteur')) return makeCategoryName('Moteur', 'Capteurs moteur');
    if (t.includes('turbo') || t.includes('admission')) return makeCategoryName('Moteur', 'Turbo / Admission');
    if (t.includes('inject')) return makeCategoryName('Moteur', 'Injection');
    if (t.includes('culasse')) return makeCategoryName('Moteur', 'Culasse');
    if (t.includes('refroid') || t.includes('radiateur') || t.includes('pompe a eau') || t.includes('pompe à eau')) {
      return makeCategoryName('Moteur', 'Refroidissement');
    }
    if (t.includes('bougie') || t.includes('allumage')) return makeCategoryName('Moteur', 'Allumage');
    if (t.includes('distribution') || t.includes('courroie') || t.includes('chaine') || t.includes('chaîne')) {
      return makeCategoryName('Moteur', 'Distribution');
    }
    return makeCategoryName('Moteur', 'Bloc moteur');
  }

  // Freinage
  if (t.includes('plaquette')) return makeCategoryName('Freinage', 'Plaquettes');
  if (t.includes('disque de frein') || t.includes('disques de frein')) return makeCategoryName('Freinage', 'Disques');
  if (t.includes('etrier') || t.includes('étrier')) return makeCategoryName('Freinage', 'Étriers');
  if (t.includes('abs') || t.includes('capteur abs')) return makeCategoryName('Freinage', 'ABS / Capteurs');

  // Suspension / Direction
  if (t.includes('amortisseur')) return makeCategoryName('Suspension / Direction', 'Amortisseurs');
  if (t.includes('ressort')) return makeCategoryName('Suspension / Direction', 'Ressorts');
  if (t.includes('triangle')) return makeCategoryName('Suspension / Direction', 'Triangles');
  if (t.includes('cremaillere') || t.includes('crémaillère')) return makeCategoryName('Suspension / Direction', 'Crémaillère');
  if (t.includes('rotule')) return makeCategoryName('Suspension / Direction', 'Rotules');

  // Électricité / Électronique
  if (t.includes('batterie')) return makeCategoryName('Électricité / Électronique', 'Batteries');
  if (t.includes('calculateur') || t.includes('ecu') || t.includes('pcm a reparer') || t.includes('pcm à reparer') || t.includes('tcu') || t.includes('tcm')) {
    return makeCategoryName('Électricité / Électronique', 'Calculateurs');
  }
  if (t.includes('kit demarrage') || t.includes('kit démarrage') || t.includes('demarrage') || t.includes('démarrage')) {
    return makeCategoryName('Électricité / Électronique', 'Démarrage / Charge');
  }
  if (t.includes('capteur')) return makeCategoryName('Électricité / Électronique', 'Capteurs');

  // Carrosserie / Éclairage
  if (t.includes('phare') || t.includes('feu arriere') || t.includes('feux arrieres') || t.includes('feux') || t.includes('optique')) {
    return makeCategoryName('Carrosserie / Éclairage', 'Phares / Feux');
  }
  if (t.includes('essuie') || t.includes('balai')) return makeCategoryName('Carrosserie / Éclairage', 'Essuie-glaces');
  if (t.includes('pare-choc') || t.includes('pare choc')) return makeCategoryName('Carrosserie / Éclairage', 'Pare-chocs');
  if (t.includes('retro') || t.includes('rétro')) return makeCategoryName('Carrosserie / Éclairage', 'Rétroviseurs');

  // Habitacle
  if (t.includes('multimedia') || t.includes('multimédia') || t.includes('audio') || t.includes('pcm')) {
    return makeCategoryName('Habitacle', 'Multimédia');
  }
  if (t.includes('accoudoir') || t.includes('console')) return makeCategoryName('Habitacle', 'Consoles / Accoudoirs');
  if (t.includes('airbag')) return makeCategoryName('Habitacle', 'Airbags');

  // Entretien
  if (t.includes('filtre')) return makeCategoryName('Entretien', 'Filtres');
  if (t.includes('huile')) return makeCategoryName('Entretien', 'Huiles');
  if (t.includes('bougie')) return makeCategoryName('Entretien', 'Bougies');

  return makeCategoryName('Autre', '');
}

function mapLegacyCategoryString(raw) {
  const c = typeof raw === 'string' ? raw.trim() : '';
  const n = normalizeText(c);

  if (!n) return '';

  if (n === 'boite de transfert') return makeCategoryName('Transmission', 'Boîte de transfert');
  if (n.includes('boites de vitesses') || n.includes('boite de vitesses')) return makeCategoryName('Transmission', 'Boîte de vitesses');
  if (n.includes('ponts') || n.includes('differentiel') || n.includes('différentiel') || n.includes('diff')) {
    return makeCategoryName('Transmission', 'Pont / Différentiel');
  }
  if (n.includes('mecatronique') || n.includes('mécatronique')) return makeCategoryName('Transmission', 'Mécatronique');

  if (n.includes('feux') || n.includes('phares') || n.includes('eclairage') || n.includes('éclairage')) {
    return makeCategoryName('Carrosserie / Éclairage', 'Phares / Feux');
  }

  if (n === 'freinage') return makeCategoryName('Freinage', '');

  if (n.includes('filtres')) return makeCategoryName('Entretien', 'Filtres');
  if (n.includes('huile')) return makeCategoryName('Entretien', 'Huiles');
  if (n.includes('essuie')) return makeCategoryName('Carrosserie / Éclairage', 'Essuie-glaces');

  if (n.includes('alternateur') || n.includes('demarreur') || n.includes('démarreur')) {
    return makeCategoryName('Moteur', 'Alternateur / Démarreur');
  }
  if (n.includes('vilebrequin')) return makeCategoryName('Moteur', 'Vilebrequin');
  if (n.includes('moteur')) return makeCategoryName('Moteur', 'Bloc moteur');

  if (n.includes('calculateur')) return makeCategoryName('Électricité / Électronique', 'Calculateurs');
  if (n.includes('batterie')) return makeCategoryName('Électricité / Électronique', 'Batteries');

  if (n.includes('multimedia') || n.includes('multimédia') || n.includes('audio')) {
    return makeCategoryName('Habitacle', 'Multimédia');
  }

  if (n === 'autre' || n === 'autres') return makeCategoryName('Autre', '');

  return '';
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
    const canonical = new Set(buildCanonicalCategoryNames());
    const mainCategories = new Set(buildMainCategoryNames());

    const categoryDocs = await Category.find({}).select('_id name').lean();
    const byId = new Map(categoryDocs.map((c) => [String(c._id), String(c.name || '')]));

    const cursor = Product.find({}).cursor();

    let scanned = 0;
    let changed = 0;
    let unchanged = 0;
    let skipped = 0;

    const moves = new Map();

    for await (const p of cursor) {
      scanned += 1;
      if (args.limit && scanned > args.limit) break;

      const currentRaw = typeof p.category === 'string' ? p.category.trim() : '';
      const rawIsObjectId = looksLikeObjectId(currentRaw);
      const currentResolved = rawIsObjectId && byId.has(currentRaw) ? byId.get(currentRaw) : currentRaw;
      const currentResolvedTrimmed = typeof currentResolved === 'string' ? currentResolved.trim() : '';

      let next = '';

      const resolvedIsAutre = currentResolvedTrimmed === 'Autre' || currentResolvedTrimmed === 'Autres';
      const resolvedIsMain = mainCategories.has(currentResolvedTrimmed);
      const resolvedHasSub = currentResolvedTrimmed.includes('>');

      if (resolvedHasSub && canonical.has(currentResolvedTrimmed)) {
        next = currentResolvedTrimmed;
      } else if (!resolvedIsAutre && !resolvedIsMain && canonical.has(currentResolvedTrimmed)) {
        next = currentResolvedTrimmed;
      } else {
        if (!resolvedIsAutre && !resolvedIsMain) {
          const fromLegacy = mapLegacyCategoryString(currentResolvedTrimmed);
          if (fromLegacy) {
            next = fromLegacy;
          } else {
            const text = extractProductText(p);
            next = decideCategoryFromText(text);
          }
        } else {
          const text = extractProductText(p);
          next = decideCategoryFromText(text);
        }
      }

      if (!next) {
        skipped += 1;
        continue;
      }

      const alreadyNormalized = !rawIsObjectId;
      if (alreadyNormalized && next === currentRaw) {
        unchanged += 1;
        continue;
      }

      changed += 1;
      const fromLabel = currentResolvedTrimmed || currentRaw || '(vide)';
      const key = `${fromLabel} -> ${next}`;
      moves.set(key, (moves.get(key) || 0) + 1);

      if (apply) {
        await Product.updateOne({ _id: p._id }, { $set: { category: next } });
      }
    }

    const sortedMoves = Array.from(moves.entries()).sort((a, b) => b[1] - a[1]);

    console.log('---');
    console.log(`Produits analysés: ${scanned}`);
    console.log(`Produits modifiés: ${changed}`);
    console.log(`Produits inchangés: ${unchanged}`);
    console.log(`Produits ignorés: ${skipped}`);
    console.log('---');
    console.log('Top changements (max 25):');
    sortedMoves.slice(0, 25).forEach(([k, v]) => console.log(`${v} | ${k}`));

    if (!apply) {
      console.log('---');
      console.log('Pour appliquer réellement, relance avec: --apply');
      console.log('Exemple:');
      console.log('  node src/seed/reclassifyProductCategories.js --apply');
    }
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('Erreur reclassement catégories produits:', err);
  process.exitCode = 1;
});
