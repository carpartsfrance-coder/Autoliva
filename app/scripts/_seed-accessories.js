/** SEED LOCAL UNIQUEMENT (127.0.0.1:27018) — 4 produits accessoires + liaison au
 *  produit test (accessorySkus) pour prouver « Complétez votre montage » fonctionnel. */
process.env.MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27018/autoliva_local';
const mongoose = require('mongoose');
const Product = require('../src/models/Product');

const ACCS = [
  { sku: 'CLU-2306', name: "Kit d'embrayage renforcé", priceCents: 18900 },
  { sku: 'HUI-75W80', name: 'Huile de boîte 75W-80 — 2 L', priceCents: 2490 },
  { sku: 'BUT-0911', name: 'Butée hydraulique', priceCents: 7900 },
  { sku: 'FIX-4402', name: 'Kit visserie & joints de montage', priceCents: 3490 },
];
const slugify = (s) => String(s).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '')
  .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

(async () => {
  await mongoose.connect(process.env.MONGODB_URI);
  const ids = [];
  for (const a of ACCS) {
    const doc = await Product.findOneAndUpdate(
      { sku: a.sku },
      {
        $set: {
          sku: a.sku, name: a.name, slug: slugify(a.name) + '-' + a.sku.toLowerCase(),
          category: 'Accessoires', brand: '', priceCents: a.priceCents,
          shortDescription: 'Accessoire de montage neuf, recommandé avec votre boîte reconditionnée.',
          badges: { condition: 'Neuf' }, inStock: true, stockQty: 50, isPublished: true,
          shippingDelayText: '24/48h',
        },
      },
      { upsert: true, new: true }
    );
    ids.push(doc._id);
  }
  // Lier au produit principal par ID (nouveau modèle product.accessories)
  const main = await Product.findOne({ slug: /transporter-2-5-tdi-dqr/i });
  if (main) {
    main.accessories = ids;
    // nettoie l'ancien champ SKU s'il traîne
    if (main.accessorySkus) main.accessorySkus = undefined;
    await main.save();
    console.log('Accessoires liés (IDs) à :', main.name, '→', ids.map(String).join(', '));
  } else {
    console.log('⚠ produit principal introuvable');
  }
  const n = await Product.countDocuments({ category: 'Accessoires' });
  console.log('Produits accessoires en base :', n);
  await mongoose.disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
