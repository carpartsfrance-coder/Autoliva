require('dotenv').config();

const mongoose = require('mongoose');
const Product = require('../models/Product');
const brand = require('../config/brand');

function slugify(input) {
  const value = typeof input === 'string' ? input : '';
  const normalized = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

  const slug = normalized
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');

  return slug || '';
}

async function run() {
  const mongoUri = process.env.MONGODB_URI;

  if (!mongoUri) {
    console.error('MONGODB_URI manquant');
    process.exitCode = 1;
    return;
  }

  await mongoose.connect(mongoUri);

  await Product.deleteMany({});

  await Product.insertMany([
    {
      name: 'Moteur V8 Reconditionné Haute Performance',
      category: 'Électricité / Allumage',
      brand: brand.NAME,
      sku: 'CPF-MOT-V8-001',
      slug: slugify('CPF-MOT-V8-001'),
      priceCents: 670000,
      inStock: true,
      imageUrl:
        'https://lh3.googleusercontent.com/aida-public/AB6AXuAzWFysjA3gWBvfnAAToFnmKjxXmRvcVwgkT4sgdAVChiHG9gor5cOstgBnPnTU-DfcWxAjuRlCWtLOFvnC__kgwEdg4kgb5ZGPziGPgb3SF29agmbaarTOHFuza1d4BHTMTuTpYgMIW1OP_5yJdhJeyCiMz5SLEKYOKeOj9mpK5t0qffFfMsQZ4pDz-LUpEGd05h5LiGWMLJGNvVHi6NmGtW_bFpfcfB9BdKZ7Qwx9HTFD0JaQU5x77mcFhQOHVecl1mDdVtEY1vbC',
    },
    {
      name: 'Pont arrière Performance Ratio 3.64',
      category: 'Suspension / Direction',
      brand: brand.NAME,
      sku: 'CPF-PONT-364-001',
      slug: slugify('CPF-PONT-364-001'),
      priceCents: 139000,
      inStock: true,
      imageUrl:
        'https://lh3.googleusercontent.com/aida-public/AB6AXuDArxVUymNANFSMYrzuWsWCsZOTszY8zJ3IFck-WuKwQOp2Xa8Qb935JRfs8268JxWtIx3igsGutW8Rn2HSMCLgBQnEqfMidG50cIraxaVvGD-09cvrw7S3QQ_PPyvzerVGamuMjzb4OMI97kj4Srurror1ATnFGtUjpYg6HJmTP3ziaw95ePYJPZ5rLiKFI-8hAEFKj9iyccHeTx0cs_E6OU5W808Rr8z1gYpWwCaQS-kZjManmx1W2tvpP0QjpTvvZs35BAg4jmYg',
    },
    {
      name: 'Boîte de transfert ATC700 Premium',
      category: 'Transmission',
      brand: brand.NAME,
      sku: 'CPF-BDT-ATC700-001',
      slug: slugify('CPF-BDT-ATC700-001'),
      priceCents: 117000,
      inStock: true,
      imageUrl:
        'https://lh3.googleusercontent.com/aida-public/AB6AXuB9RrfFM4nCQ2qf5t-ZYZ32gb1ubaAT-A4sJO89sT2sOt4A0b0P4hi3ZbLWzfNq5HFssWRGSUirSyn4Z2frX1HPQFjoE2Matm-4a2to_p4Enwl29yDFFSYWd9soGo1RKybDnT0z-HCgmVtkS2sYQqD86wK_KusieLZgVqAHPszCTXseiPxx9eTTALXNSYHTFz7JmwDVbWwS13ryLW1k6AEMA0XgxhXSU53ehhtSyUMIOv_j2ZXZgBrlqmBnwK-5XUa1EzxV2-nL774t',
    },
    {
      name: 'Différentiel Arrière Renforcé Multimarques',
      category: 'Transmission',
      brand: brand.NAME,
      sku: 'CPF-DIFF-AR-001',
      slug: slugify('CPF-DIFF-AR-001'),
      priceCents: 219000,
      inStock: false,
      imageUrl:
        'https://lh3.googleusercontent.com/aida-public/AB6AXuAtBonuo271EYXk93w4io9KwRNQWHeq5MVggdcPgMTVj2ZtaVew-818GhYf0I0Nj5xlDSvY9-r22eyeNQzV2J41TNT7ViLRIRpX_IPrO5gWj_uv8IbEAuJhtamOiXjaweplKdy_eSojIBac6pXT61SXTiluuiGWCnCR90Y3po2yTRz5PRQcvC4sj7uxlsH3dakLN8mPdxeWQfo_r46W5P5F_oA883OPvr4emcGZoEzdoRDr5yXXTFLAiLNxsk0rDnKi3f6YBRLgrkB2',
    },
  ]);

  await mongoose.disconnect();

  console.log('Seed terminé');
}

run().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
