const brand = require('./config/brand');

module.exports = [
  {
    _id: '65d0fe4f5311236168a109ca',
    name: 'Moteur V8 Reconditionné Haute Performance',
    category: 'Électricité / Allumage',
    brand: brand.NAME,
    sku: 'CPF-MOT-V8-001',
    priceCents: 670000,
    compareAtPriceCents: 749000,
    inStock: true,
    imageUrl:
      'https://lh3.googleusercontent.com/aida-public/AB6AXuAzWFysjA3gWBvfnAAToFnmKjxXmRvcVwgkT4sgdAVChiHG9gor5cOstgBnPnTU-DfcWxAjuRlCWtLOFvnC__kgwEdg4kgb5ZGPziGPgb3SF29agmbaarTOHFuza1d4BHTMTuTpYgMIW1OP_5yJdhJeyCiMz5SLEKYOKeOj9mpK5t0qffFfMsQZ4pDz-LUpEGd05h5LiGWMLJGNvVHi6NmGtW_bFpfcfB9BdKZ7Qwx9HTFD0JaQU5x77mcFhQOHVecl1mDdVtEY1vbC',
    badges: {
      topLeft: 'Garantie 24 mois',
      condition: 'Reconditionné',
    },
    galleryUrls: [
      'https://lh3.googleusercontent.com/aida-public/AB6AXuCa0hjG-W-91QfQ_lAuz27C55l6VuiNVn8QbFNtf8Ec4zF9JjJWZYzlDT2p-IB5G82NSRbZpA1yZG6_B8ZZux9_CZRU45QKJlm60rVpXOqgHsOLug-eCRoYwVZSfCdx7118JZXsvFLQii6snLhEBxcewiOBJVk7FDe7-vB75wTx6GbPqLHb0f7zxLK3i49odh-FngFIUU_qbsFD0mEIxSSmIrZxNC6ZhwUG7yFmKPtBdmeDK_43klyEmjF4xJ0I7tTppFqY1admvHmt',
      'https://lh3.googleusercontent.com/aida-public/AB6AXuDgGIfrqsTyW7HgqPD_8_B1cn8dIy7A-1CmvpXNXSg3dRFn__ZBnGEdCEa3suUnRyTFBdjAPXO-zLLRqsD_7Vy628pMHE43-NfaJNOg4VYLc41IWKM55D6YCkwBw-JnCEbr7RHnvNBvSbEfE5vEgKGesvMOmUYai5KM5CiHjrzGGXudu-V3GVQIQflyx84T2jYNjDQYO4iTK3yLRXU44hI2xVGaUirsqd2wRLSiUbbcED5sSgNnCEVgUGjxCHyB2ysF5eHQYZdaBdIW',
    ],
    shortDescription: "Moteur reconditionné, testé et garanti. Expédition rapide.",
    description:
      "Ce moteur V8 a été entièrement reconditionné. Chaque élément critique est contrôlé, nettoyé et testé afin d'assurer fiabilité et performance.",
    keyPoints: [
      'Reconditionnement complet',
      'Test sur banc',
      'Garantie 24 mois',
      'Expédition rapide',
    ],
    specs: [
      { label: 'Type', value: 'Moteur V8' },
      { label: 'État', value: 'Reconditionné' },
      { label: 'Référence', value: 'CPF-MOT-V8-001' },
    ],
    reconditioningSteps: [
      { title: 'Diagnostic', description: 'Contrôle complet des éléments.' },
      { title: 'Nettoyage', description: 'Nettoyage et préparation.' },
      { title: 'Remplacement', description: 'Pièces d’usure remplacées.' },
      { title: 'Test', description: 'Test final avant expédition.' },
    ],
    compatibility: [
      { make: 'Audi', model: 'A6', years: '2012-2018', engine: '3.0' },
      { make: 'Volkswagen', model: 'Touareg', years: '2010-2018', engine: '3.0' },
    ],
    faqs: [
      {
        question: 'La pièce est-elle programmée ?',
        answer: 'Selon le modèle, une adaptation peut être nécessaire. Contacte-nous en cas de doute.',
      },
      {
        question: 'Quel est le délai de livraison ?',
        answer: 'La majorité des commandes partent sous 24/48h (jours ouvrés).',
      },
    ],
    media: {
      videoUrl: '',
    },
    sections: {
      showKeyPoints: true,
      showSpecs: true,
      showReconditioning: true,
      showCompatibility: true,
      showFaq: true,
      showVideo: true,
      showSupportBox: true,
      showRelatedProducts: true,
    },
  },
  {
    _id: '65d0fe4f5311236168a109cb',
    name: 'Pont arrière Performance Ratio 3.64',
    category: 'Suspension / Direction',
    brand: brand.NAME,
    sku: 'CPF-PONT-364-001',
    priceCents: 139000,
    inStock: true,
    imageUrl:
      'https://lh3.googleusercontent.com/aida-public/AB6AXuDArxVUymNANFSMYrzuWsWCsZOTszY8zJ3IFck-WuKwQOp2Xa8Qb935JRfs8268JxWtIx3igsGutW8Rn2HSMCLgBQnEqfMidG50cIraxaVvGD-09cvrw7S3QQ_PPyvzerVGamuMjzb4OMI97kj4Srurror1ATnFGtUjpYg6HJmTP3ziaw95ePYJPZ5rLiKFI-8hAEFKj9iyccHeTx0cs_E6OU5W808Rr8z1gYpWwCaQS-kZjManmx1W2tvpP0QjpTvvZs35BAg4jmYg',
  },
  {
    _id: '65d0fe4f5311236168a109cc',
    name: 'Boîte de transfert ATC700 Premium',
    category: 'Transmission',
    brand: brand.NAME,
    sku: 'CPF-BDT-ATC700-001',
    priceCents: 117000,
    inStock: true,
    imageUrl:
      'https://lh3.googleusercontent.com/aida-public/AB6AXuB9RrfFM4nCQ2qf5t-ZYZ32gb1ubaAT-A4sJO89sT2sOt4A0b0P4hi3ZbLWzfNq5HFssWRGSUirSyn4Z2frX1HPQFjoE2Matm-4a2to_p4Enwl29yDFFSYWd9soGo1RKybDnT0z-HCgmVtkS2sYQqD86wK_KusieLZgVqAHPszCTXseiPxx9eTTALXNSYHTFz7JmwDVbWwS13ryLW1k6AEMA0XgxhXSU53ehhtSyUMIOv_j2ZXZgBrlqmBnwK-5XUa1EzxV2-nL774t',
  },
  {
    _id: '65d0fe4f5311236168a109cd',
    name: 'Différentiel Arrière Renforcé Multimarques',
    category: 'Transmission',
    brand: brand.NAME,
    sku: 'CPF-DIFF-AR-001',
    priceCents: 219000,
    inStock: false,
    imageUrl:
      'https://lh3.googleusercontent.com/aida-public/AB6AXuAtBonuo271EYXk93w4io9KwRNQWHeq5MVggdcPgMTVj2ZtaVew-818GhYf0I0Nj5xlDSvY9-r22eyeNQzV2J41TNT7ViLRIRpX_IPrO5gWj_uv8IbEAuJhtamOiXjaweplKdy_eSojIBac6pXT61SXTiluuiGWCnCR90Y3po2yTRz5PRQcvC4sj7uxlsH3dakLN8mPdxeWQfo_r46W5P5F_oA883OPvr4emcGZoEzdoRDr5yXXTFLAiLNxsk0rDnKi3f6YBRLgrkB2',
  },
];
