'use strict';

/**
 * Articles blog RÉELS pour les landings devis (moteurs / boîtes / ponts&transfert).
 *
 * Remplace les cartes d'articles factices (titres inventés, images placeholder,
 * lien générique /blog) par de vrais articles publiés, pertinents pour la
 * catégorie de la landing, les plus récents d'abord — cartes cliquables vers
 * /blog/<slug> avec la vraie image de couverture.
 *
 * Les slugs de catégorie ci-dessous sont les VRAIS slugs présents en base
 * (vérifiés : transmission-pont-differentiel 238, transmission-boite-de-transfert
 * 211, transmission-boite-de-vitesses 196, moteur-diesel 150…).
 */

const mongoose = require('mongoose');
const BlogPost = require('../models/BlogPost');

// Catégorie de landing → ensemble de slugs de catégorie blog réels.
const CATEGORY_SLUGS = {
  moteur: ['moteur-diesel', 'moteur-essence', 'moteur-bloc-moteur', 'moteur-turbo-admission'],
  boite: ['transmission-boite-de-vitesses', 'transmission-boite-automatique', 'boite-de-vitesses-manuelle', 'transmission-mecatronique'],
  // Ponts & différentiels (une seule catégorie en base couvre les deux)
  pont: ['transmission-pont-differentiel'],
  // Boîtes de transfert (3 slugs doublons en base)
  transfert: ['transmission-boite-de-transfert', 'transmission-boite-transfert', 'boite-de-transfert'],
};

/**
 * @param {string} category  moteur | boite | pont | transfert
 * @param {number} [limit=3]
 * @returns {Promise<Array<{title,url,image,excerpt}>>}  [] si DB indisponible / aucun match
 */
async function getLandingArticles(category, limit = 3) {
  if (mongoose.connection.readyState !== 1) return [];
  const primary = CATEGORY_SLUGS[category] || CATEGORY_SLUGS.moteur;
  try {
    const map = (docs) => docs.map((d) => ({
      title: d.title,
      url: `/blog/${d.slug}`,
      image: d.coverImageUrl,
      excerpt: d.excerpt || '',
    }));
    const query = (slugs, n) => BlogPost.find({
      isPublished: true,
      'category.slug': { $in: slugs },
      coverImageUrl: { $nin: ['', null] },
    })
      .select('title slug excerpt coverImageUrl publishedAt')
      .sort({ publishedAt: -1, _id: -1 })
      .limit(n)
      .lean();

    let out = map(await query(primary, limit));
    // Repli si la catégorie ciblée n'a pas assez d'articles : complète avec les
    // autres familles transmission/moteur, sans doublon.
    if (out.length < limit) {
      const seen = new Set(out.map((a) => a.url));
      const fallbackSlugs = [...new Set([].concat(
        CATEGORY_SLUGS.pont, CATEGORY_SLUGS.transfert, CATEGORY_SLUGS.boite, CATEGORY_SLUGS.moteur,
      ))].filter((s) => !primary.includes(s));
      const extra = map(await query(fallbackSlugs, limit * 2)).filter((a) => !seen.has(a.url));
      out = out.concat(extra).slice(0, limit);
    }
    return out;
  } catch (_) {
    return [];
  }
}

module.exports = { getLandingArticles, CATEGORY_SLUGS };
