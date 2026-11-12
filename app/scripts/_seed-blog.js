/** LOCAL UNIQUEMENT — 3 articles de blog + liaison au produit test via
 *  relatedBlogPostIds (le picker de la fiche produit), pour démontrer que la
 *  section « Pour aller plus loin » n'affiche que les articles liés au back-office. */
const uri = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27018/autoliva_local';
process.env.MONGODB_URI = uri;
const mongoose = require('mongoose');
const BlogPost = require('../src/models/BlogPost');
const Product = require('../src/models/Product');

const POSTS = [
  { slug: 'trouver-code-boite-fiat-ducato', title: 'Où trouver le code boîte sur votre Fiat Ducato',
    cat: { slug: 'tutoriel', label: 'Tutoriel' }, read: 3, cover: '/design/autoparts/photo-chargement.jpg',
    excerpt: 'Plaque constructeur, gravure sur le carter : les 3 endroits où identifier votre référence en moins de 5 minutes.' },
  { slug: 'boite-qui-craque-ou-saute-5-causes', title: 'Boîte qui craque ou saute : les 5 causes fréquentes',
    cat: { slug: 'diagnostic', label: 'Diagnostic' }, read: 4, cover: '/design/autoparts/photo-sun-motors.jpg',
    excerpt: 'Synchros usés, câblerie, embrayage… comment isoler la panne avant de remplacer la boîte complète.' },
  { slug: 'monter-boite-reconditionnee-etapes-cout', title: 'Faire monter une boîte reconditionnée : étapes et coût',
    cat: { slug: 'guide', label: 'Guide' }, read: 5, cover: '/design/autoparts/photo-porsche.jpg',
    excerpt: 'Temps de main-d’œuvre, huile, purge : à quoi vous attendre chez votre garagiste, poste par poste.' },
];

(async () => {
  await mongoose.connect(uri);
  const main = await Product.findOne({ slug: /transporter-2-5-tdi-dqr/i });
  const ids = [];
  for (const p of POSTS) {
    const doc = await BlogPost.findOneAndUpdate(
      { slug: p.slug },
      { $set: {
          slug: p.slug, title: p.title, excerpt: p.excerpt, category: p.cat,
          contentHtml: '<p>' + p.excerpt + '</p>', coverImageUrl: p.cover,
          readingTimeMinutes: p.read, isPublished: true, publishedAt: new Date('2026-06-01'),
          relatedProductIds: main ? [main._id] : [],
        } },
      { upsert: true, new: true }
    );
    ids.push(doc._id);
  }
  if (main) {
    main.relatedBlogPostIds = ids;
    await main.save();
    console.log('Articles liés (back-office) à :', main.name, '→', ids.length);
  } else { console.log('⚠ produit principal introuvable'); }
  console.log('Articles de blog en base :', await BlogPost.countDocuments({}));
  await mongoose.disconnect();
})().catch((e) => { console.error('ERR', e.message); process.exit(1); });
