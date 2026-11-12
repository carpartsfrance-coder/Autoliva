'use strict';

/* État de santé de la traduction allemande.
 *
 * ── Pourquoi ce fichier existe ──────────────────────────────────────────────
 *
 * En deux jours, deux pannes SILENCIEUSES ont été trouvées à la main : le blog
 * qui partait chez un fournisseur sans clé, et des empreintes qui ne se
 * relisaient pas — de quoi retraduire tout le blog en boucle. Aucune des deux
 * n'aurait levé la moindre erreur. Elles auraient tourné des semaines.
 *
 * Un mécanisme qui dépense de l'argent tout seul et se tait quand il déraille
 * n'est pas fiable, même si son code est juste. Ce qui manquait n'était pas un
 * test de plus : c'était de rendre la panne VISIBLE, là où on regarde
 * — l'admin — et pas dans les journaux d'un hébergeur.
 *
 * Trois questions, trois réponses chiffrées :
 *   — combien de pages sont en attente, et depuis quand ;
 *   — combien ont été mises de côté après des échecs répétés ;
 *   — le balayage a-t-il seulement tourné récemment.
 */

const mongoose = require('mongoose');

/* Au-delà, quelque chose ne va pas : le balayage traite 60 fiches par heure,
   un retard qui ne se résorbe pas veut dire qu'il est bloqué ou désarmé. */
const RETARD_ANORMAL_H = 6;

function heuresDepuis(date) {
  if (!date) return null;
  return Math.round((Date.now() - new Date(date).getTime()) / 36e5 * 10) / 10;
}

/**
 * Un seul verdict, pour ne pas avoir à interpréter cinq chiffres.
 *
 * Désarmée = PAUSE VOULUE, pas une panne (plan de reprise SEO du 14/09/2026,
 * décision 2 : la couche allemande sort de Google et la traduction automatique
 * reste coupée — les traductions gpt-4o-mini non relues des 04–08/09 font partie
 * du contenu produit en masse). L'ancien message, en rouge sur le tableau de
 * bord — « N page(s) en français sur le site allemand — la traduction
 * automatique n'est pas armée » —, poussait à la réarmer : exactement ce qu'il
 * ne faut pas faire. Le verdict « pause » s'affiche en gris, sans alerte, et
 * dit ce que la pause coûte (les fiches neuves n'entrent pas dans le flux
 * Shopping allemand, qui ne prend que les fiches traduites).
 */
function verdictTraduction({ arme, enAttente = 0, quarantaine = 0, attenteDepuisH = null } = {}) {
  if (!arme) {
    return {
      verdict: 'pause',
      message: enAttente
        ? `Traduction allemande en pause volontaire (plan SEO du 14/09/2026). ${enAttente} page(s) récente(s) restent en français sous /de et hors du flux Shopping allemand : c'est attendu, ne pas réarmer DE_AUTO_TRANSLATE avant le point d'étape SEO.`
        : 'Traduction allemande en pause volontaire (plan SEO du 14/09/2026). Rien en attente.',
    };
  }
  if (quarantaine) {
    return { verdict: 'alerte', message: `${quarantaine} page(s) mise(s) de côté après plusieurs échecs — elles resteront en français.` };
  }
  if (enAttente && attenteDepuisH !== null && attenteDepuisH > RETARD_ANORMAL_H) {
    return { verdict: 'alerte', message: `${enAttente} page(s) en attente depuis ${attenteDepuisH} h — le balayage ne progresse pas.` };
  }
  if (enAttente) {
    return { verdict: 'en_cours', message: `${enAttente} page(s) en attente, rattrapage en cours.` };
  }
  return { verdict: 'ok', message: 'Tout est traduit.' };
}

async function etatTraductionDe() {
  if (mongoose.connection.readyState !== 1) return null;

  const Product = mongoose.model('Product');
  const BlogPost = mongoose.model('BlogPost');
  const jamaisTraduit = {
    $or: [
      { 'localizations.de.translatedAt': null },
      { 'localizations.de.translatedAt': { $exists: false } },
      { 'localizations.de': { $exists: false } },
    ],
  };

  const [
    fichesPubliees, fichesEnAttente, fichesQuarantaine, fichesDerniere,
    articlesPublies, articlesEnAttente, articlesQuarantaine, articlesDerniere,
    verrou,
  ] = await Promise.all([
    Product.countDocuments({ isPublished: true }),
    Product.countDocuments({ isPublished: true, ...jamaisTraduit }),
    Product.countDocuments({ isPublished: true, 'localizations.de.failedCount': { $gte: 3 } }),
    Product.findOne({ 'localizations.de.translatedAt': { $ne: null } })
      .sort({ 'localizations.de.translatedAt': -1 }).select('localizations.de.translatedAt').lean(),
    BlogPost.countDocuments({ isPublished: true }),
    BlogPost.countDocuments({ isPublished: true, ...jamaisTraduit }),
    BlogPost.countDocuments({ isPublished: true, 'localizations.de.failedCount': { $gte: 3 } }),
    BlogPost.findOne({ 'localizations.de.translatedAt': { $ne: null } })
      .sort({ 'localizations.de.translatedAt': -1 }).select('localizations.de.translatedAt').lean(),
    mongoose.connection.collection('jobLocks').findOne({ _id: 'traduction-de' }),
  ]);

  /* La plus ancienne chose en attente : c'est elle qui dit depuis combien de
     temps un visiteur allemand voit une page française. */
  const plusVieilleAttente = await Product.findOne({ isPublished: true, ...jamaisTraduit })
    .sort({ createdAt: 1 }).select('createdAt name').lean();

  const derniereTraduction = [
    fichesDerniere && fichesDerniere.localizations.de.translatedAt,
    articlesDerniere && articlesDerniere.localizations.de.translatedAt,
  ].filter(Boolean).sort((a, b) => new Date(b) - new Date(a))[0] || null;

  const enAttente = fichesEnAttente + articlesEnAttente;
  const quarantaine = fichesQuarantaine + articlesQuarantaine;
  const attenteDepuisH = heuresDepuis(plusVieilleAttente && plusVieilleAttente.createdAt);
  const arme = process.env.DE_AUTO_TRANSLATE === 'true';
  const { verdict, message } = verdictTraduction({ arme, enAttente, quarantaine, attenteDepuisH });

  return {
    verdict,
    message,
    arme,
    fiches: { publiees: fichesPubliees, enAttente: fichesEnAttente, quarantaine: fichesQuarantaine },
    articles: { publies: articlesPublies, enAttente: articlesEnAttente, quarantaine: articlesQuarantaine },
    enAttente,
    quarantaine,
    attenteDepuisH,
    derniereTraductionH: heuresDepuis(derniereTraduction),
    balayageEnCours: Boolean(verrou && verrou.pris),
  };
}

module.exports = { etatTraductionDe, verdictTraduction, RETARD_ANORMAL_H };
