#!/usr/bin/env node

/**
 * Maillage inter-cocons (G15) : ajoute un encart vers le nouvel article
 * "Prix clonage mécatronique DSG" dans les piliers existants sur la
 * mécatronique DSG (DQ200, DQ250, DQ381, DQ500, DL501, DL382, etc.).
 *
 * Idempotent : ne ré-injecte pas le bloc s'il est déjà présent.
 */

require('dotenv').config();

const mongoose = require('mongoose');
const BlogPost = require('../src/models/BlogPost');
const { markdownToHtml } = require('../src/services/blogContent');

const NEW_SLUG = 'prix-clonage-mecatronique-dsg-france-guide-2026';
const NEW_TITLE = 'Prix clonage mécatronique DSG en France — Guide complet 2026';
const MARKER = '<!-- backlink:prix-clonage-2026 -->';

const APPEND_BLOCK = `

---

${MARKER}
## 💡 Vous avez déjà votre nouvelle mécatronique ?

Si vous avez acheté votre mécatronique de remplacement ailleurs (occasion, casse VAG, réseau parallèle), vous n'avez pas besoin d'une pièce reconditionnée — il vous faut juste un service de clonage standalone pour transférer le software TCU de votre ancienne pièce vers la nouvelle.

👉 **[Tarifs et comparatif marché 2026 du clonage mécatronique DSG](/blog/${NEW_SLUG})** — découvrez pourquoi le tarif tout-inclus 199 € est souvent plus avantageux que les services entrée de gamme à 140 € une fois les frais cachés ajoutés.
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

    // Cibler les piliers thématiquement liés (mécatronique DSG)
    const piliers = await BlogPost.find({
      slug: { $regex: /mecatronique-dsg/i },
      isPublished: true,
    }).select('_id slug title contentMarkdown').lean();

    console.log(`${piliers.length} pilier(s) candidat(s) identifié(s).`);

    let updated = 0;
    let skipped = 0;
    for (const pilier of piliers) {
      // Ne pas se backlinker soi-même (sécurité)
      if (pilier.slug === NEW_SLUG) {
        skipped++;
        continue;
      }
      // Idempotence : si le marker est déjà présent, on skip
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
      console.log(`  ✓ ${pilier.slug} : backlink ajouté.`);
      updated++;
    }

    console.log(`\nRésumé : ${updated} mis à jour, ${skipped} déjà à jour ou auto-référence.`);
  } catch (err) {
    console.error('Erreur :', err.message || err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
