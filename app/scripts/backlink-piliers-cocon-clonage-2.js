#!/usr/bin/env node

/**
 * Maillage inter-cocons (G15) — vague 2 : ajoute un encart unique vers les
 * 3 nouveaux articles satellites du cocon clonage TCU (symptômes, mode
 * dégradé, comparatif) dans les anciens piliers mécatronique.
 *
 * Idempotent : marker HTML-comment `cocon-clonage-v2-2026-05-13`.
 */

require('dotenv').config();

const mongoose = require('mongoose');
const BlogPost = require('../src/models/BlogPost');
const { markdownToHtml } = require('../src/services/blogContent');

const MARKER = '<!-- backlink:cocon-clonage-v2-2026-05-13 -->';

const APPEND_BLOCK = `

---

${MARKER}
## 🔧 Diagnostic et solutions clonage — guides récents

Si votre mécatronique présente des signes de défaillance ou si vous hésitez sur la stratégie de remplacement, ces guides vous aideront à prendre la bonne décision :

- 👉 **[Les 7 symptômes d'une mécatronique DSG défaillante](/blog/symptomes-mecatronique-dsg-hs-comment-diagnostiquer)** — comment savoir si c'est elle avant d'accepter un devis concession.
- 👉 **[Voiture en mode dégradé après changement de mécatronique : que faire](/blog/voiture-mode-degrade-apres-changement-mecatronique-dsg)** — codes P17BF, P189C, réglage de base impossible : la cause et la solution.
- 👉 **[Clonage TCU vs remplacement complet : comparatif des 4 options](/blog/clonage-tcu-vs-remplacement-mecatronique-comparatif)** — neuve OEM, recond, occasion + clonage, ou réparation : que choisir.
`;

(async () => {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI manquant');
    process.exit(1);
  }

  try {
    await mongoose.connect(mongoUri);
    console.log('Connecté à MongoDB.');

    // Cible les piliers mécatronique mais exclut les 4 articles du cocon clonage
    // pour éviter l'auto-référence.
    const EXCLUDE_SLUGS = [
      'prix-clonage-mecatronique-dsg-france-guide-2026',
      'symptomes-mecatronique-dsg-hs-comment-diagnostiquer',
      'voiture-mode-degrade-apres-changement-mecatronique-dsg',
      'clonage-tcu-vs-remplacement-mecatronique-comparatif',
    ];

    const piliers = await BlogPost.find({
      slug: { $regex: /mecatronique-dsg/i, $nin: EXCLUDE_SLUGS },
      isPublished: true,
    }).select('_id slug title contentMarkdown').lean();

    console.log(`${piliers.length} pilier(s) candidat(s) identifié(s).`);

    let updated = 0;
    let skipped = 0;
    for (const pilier of piliers) {
      if (pilier.contentMarkdown && pilier.contentMarkdown.includes(MARKER)) {
        console.log(`  → ${pilier.slug} : marker déjà présent, skip.`);
        skipped++;
        continue;
      }
      const newMarkdown = (pilier.contentMarkdown || '') + APPEND_BLOCK;
      const newHtml = markdownToHtml(newMarkdown);
      await BlogPost.updateOne(
        { _id: pilier._id },
        { $set: { contentMarkdown: newMarkdown, contentHtml: newHtml } }
      );
      console.log(`  ✓ ${pilier.slug} : backlinks ajoutés.`);
      updated++;
    }

    console.log(`\nRésumé : ${updated} mis à jour, ${skipped} déjà à jour.`);
  } catch (err) {
    console.error('Erreur :', err.message || err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
