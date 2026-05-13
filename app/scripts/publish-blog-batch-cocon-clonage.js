#!/usr/bin/env node

/**
 * Publication batch des articles satellites du cocon "Clonage mécatronique TCU".
 *
 * Lit les markdowns dans /tmp/seo-batch-2026-05-13/ et les métadonnées
 * définies en dur dans ce script (mises à jour par l'orchestrateur depuis
 * les retours JSON des sous-agents Task).
 *
 * Idempotent : upsert par slug. Liste les articles déclarés dans ARTICLES.
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const BlogPost = require('../src/models/BlogPost');
const Product = require('../src/models/Product');
const { markdownToHtml } = require('../src/services/blogContent');

const BATCH_DIR = '/tmp/seo-batch-2026-05-13';

// ⚠️ Ces métadonnées sont mises à jour par l'orchestrateur depuis les
// JSON retournés par les 3 sous-agents Task avant exécution.
const ARTICLES = [
  {
    slug: 'symptomes-mecatronique-dsg-hs-comment-diagnostiquer',
    filename: 'symptomes-mecatronique-dsg-hs-comment-diagnostiquer.md',
    title: 'Symptômes mécatronique DSG HS : comment savoir si c\'est elle',
    excerpt: 'Votre DSG fait des à-coups, refuse la marche arrière à froid ou affiche un voyant boîte ? Voici les 7 signes qui révèlent une mécatronique défaillante, les codes défaut à connaître et le test à faire avant d\'accepter un devis concession.',
    metaTitle: 'Symptômes mécatronique DSG HS : 7 signes qui ne trompent pas',
    metaDescription: 'Symptômes mécatronique DSG HS : à-coups, codes P17BF, mode dégradé. Apprenez à reconnaître une panne mécatronique avant de payer 4 000 € chez Audi.',
    primaryKeyword: 'symptômes mécatronique DSG HS',
    readingTimeMinutes: 8,
  },
  {
    slug: 'voiture-mode-degrade-apres-changement-mecatronique-dsg',
    filename: 'voiture-mode-degrade-apres-changement-mecatronique-dsg.md',
    title: 'Voiture en mode dégradé après changement de mécatronique DSG : que faire',
    excerpt: 'Votre boîte DSG est en mode dégradé après remplacement de la mécatronique ? Codes P17BF, P189C, réglage de base impossible via VCDS… Voici la cause exacte et la solution à 199€ en 4-6 jours.',
    metaTitle: 'Mode dégradé après changement mécatronique DSG : que faire',
    metaDescription: 'Mode dégradé après remplacement de mécatronique DSG ? Codes P17BF, P189C, réglage de base VCDS impossible : la cause et la solution clonage TCU 199€.',
    primaryKeyword: 'voiture en mode dégradé après changement mécatronique',
    readingTimeMinutes: 9,
  },
  {
    slug: 'clonage-tcu-vs-remplacement-mecatronique-comparatif',
    filename: 'clonage-tcu-vs-remplacement-mecatronique-comparatif.md',
    title: 'Clonage TCU vs remplacement complet de mécatronique DSG : que choisir en 2026',
    excerpt: 'Mécatronique DSG en panne ? Quatre options s\'offrent à vous : neuve OEM, reconditionnée, d\'occasion + clonage TCU, ou réparation. Comparatif objectif des prix, délais, garanties et durabilité.',
    metaTitle: 'Clonage TCU ou remplacement mécatronique DSG : comparatif 2026',
    metaDescription: 'Clonage TCU ou remplacement mécatronique DSG : 4 options comparées (neuf OEM, recond, occasion + clonage, réparation). Prix, délais, garantie, profil idéal.',
    primaryKeyword: 'clonage TCU ou remplacement mécatronique',
    readingTimeMinutes: 9,
  },
];

const COVER_IMAGE = '/media/6a0405eb31539f66b7f6382d';
const CATEGORY = { slug: 'transmission-mecatronique', label: 'Transmission > Mécatronique' };
const AUTHOR_NAME = 'Expert Autoliva';

(async () => {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI manquant');
    process.exit(1);
  }

  try {
    await mongoose.connect(mongoUri);
    console.log('Connecté à MongoDB.');

    const product = await Product.findOne({ slug: 'clonage-mecatronique-tcu-dsg-s-tronic' }).select('_id').lean();
    if (!product) {
      console.error('Produit pilier introuvable');
      process.exit(1);
    }

    const results = [];
    for (const a of ARTICLES) {
      if (a.slug.startsWith('__')) {
        console.log(`⚠️ Article placeholder non rempli : ${a.slug} → skip.`);
        continue;
      }
      const filepath = path.join(BATCH_DIR, a.filename);
      if (!fs.existsSync(filepath)) {
        console.error(`❌ Fichier manquant : ${filepath}`);
        results.push({ slug: a.slug, ok: false, error: 'file-not-found' });
        continue;
      }
      const contentMarkdown = fs.readFileSync(filepath, 'utf8');
      const wordCount = contentMarkdown.split(/\s+/).filter((w) => w.length > 0).length;
      const contentHtml = markdownToHtml(contentMarkdown);
      const readingTimeMinutes = a.readingTimeMinutes || Math.max(1, Math.round(wordCount / 200));

      const doc = {
        title: a.title,
        slug: a.slug,
        excerpt: a.excerpt,
        contentMarkdown,
        contentHtml,
        coverImageUrl: COVER_IMAGE,
        category: CATEGORY,
        authorName: AUTHOR_NAME,
        readingTimeMinutes,
        relatedProductIds: [product._id],
        isPublished: true,
        publishedAt: new Date(),
        seo: {
          primaryKeyword: a.primaryKeyword,
          metaTitle: a.metaTitle,
          metaDescription: a.metaDescription,
          metaRobots: 'index, follow',
          ogImageUrl: COVER_IMAGE,
          canonicalPath: `/blog/${a.slug}`,
        },
      };

      const existing = await BlogPost.findOne({ slug: a.slug }).lean();
      if (existing) {
        await BlogPost.updateOne({ _id: existing._id }, { $set: doc });
        console.log(`✓ Mis à jour : ${a.slug} (id=${existing._id}, ${wordCount} mots)`);
        results.push({ slug: a.slug, ok: true, id: String(existing._id), wordCount, action: 'updated' });
      } else {
        const created = await BlogPost.create(doc);
        console.log(`✓ Créé : ${a.slug} (id=${created._id}, ${wordCount} mots)`);
        results.push({ slug: a.slug, ok: true, id: String(created._id), wordCount, action: 'created' });
      }
    }

    console.log('\n=== Résumé ===');
    console.log(JSON.stringify(results, null, 2));
  } catch (err) {
    console.error('Erreur :', err.message || err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
