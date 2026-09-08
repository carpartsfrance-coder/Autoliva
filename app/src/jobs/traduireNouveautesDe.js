'use strict';

/* Traduction allemande automatique du contenu neuf ou modifié.
 *
 * ── Pourquoi un balayage et pas un hook à l'enregistrement ──────────────────
 *
 * Une fiche n'arrive pas que par l'admin : il y a les imports fournisseurs,
 * les scripts de lot, les corrections en base. Un hook posé sur le formulaire
 * ne verrait que le formulaire — et les 2 fiches parties en français le
 * 07/09/2026 étaient justement arrivées par un autre chemin.
 *
 * Un balayage régulier ne se demande pas COMMENT le contenu est arrivé : il
 * regarde ce qui est publié et pas encore traduit. Il rattrape aussi ce qu'une
 * panne de l'API a fait échouer, sans rien à rejouer.
 *
 * ── Comment on sait qu'une traduction est périmée ───────────────────────────
 *
 * Par une empreinte du texte FRANÇAIS, pas par `updatedAt` : celui-ci bouge à
 * chaque changement de stock ou de prix, et il bouge aussi quand on écrit la
 * traduction — une fiche serait donc éternellement « à retraduire ».
 *
 * ── Deux passes, et pourquoi ────────────────────────────────────────────────
 *
 * PASSE A, le neuf : requête EXACTE sur `translatedAt` absent, triée du plus
 * ancien au plus récent. Une seule requête large triée par `updatedAt` ne
 * suffisait pas : la moindre synchro de stock sur 800 fiches repousse les
 * fiches non traduites hors de la fenêtre, et elles n'y reviennent jamais.
 * Trier du plus ancien garantit qu'aucune fiche ne peut être doublée
 * indéfiniment par du contenu plus frais.
 *
 * PASSE B, le réécrit : là, une fenêtre sur `updatedAt` est légitime — une
 * réécriture bouge forcément `updatedAt`, donc la fiche est en tête.
 *
 * ── Garde-fous ──────────────────────────────────────────────────────────────
 *
 * Lot plafonné : une erreur qui invaliderait les empreintes coûterait un lot
 * par heure, pas 14 000 appels d'un coup. Une fiche qui échoue trois fois de
 * suite sur le MÊME texte est mise de côté — sans ça elle consomme un créneau
 * et un appel payant à chaque passage, pour toujours. Elle repart dès que son
 * texte français change. Et un verrou empêche deux instances de traduire le
 * même lot deux fois.
 */

const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const mongoose = require('mongoose');
const translator = require('../services/productTranslator');

/* Les pastilles et les délais ont leur table de vocabulaire, construite une
   fois et appliquée aux 13 348 fiches du catalogue. Le modèle, lui, retraduit
   à chaque fois : livré à lui-même il écrit « generalüberholt » là où le reste
   du catalogue dit « Generalüberholt », et il laisse le délai vide. Une
   pastille fait deux mots et se lit en colonne — elle doit être IDENTIQUE
   partout. La table tranche donc, le modèle ne sert que pour l'inconnu. */
function lire(nom) {
  try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', nom), 'utf8')); }
  catch (e) { return {}; }
}
const BADGES_DE = lire('badges-de.json');
const DELAIS_DE = lire('delais-de.json');

function harmoniserVocabulaire(fr, de) {
  const t = (table, valeurFr, valeurDe) => {
    const cle = String(valeurFr || '').trim();
    return (cle && table[cle]) || valeurDe || '';
  };
  if (fr.badges) {
    de.badges = de.badges || {};
    de.badges.topLeft = t(BADGES_DE, fr.badges.topLeft, de.badges.topLeft);
    de.badges.condition = t(BADGES_DE, fr.badges.condition, de.badges.condition);
    if (Array.isArray(fr.badges.cards)) {
      de.badges.cards = fr.badges.cards.map((c, i) => t(BADGES_DE, c, (de.badges.cards || [])[i]));
    }
  }
  const delai = t(DELAIS_DE, fr.shippingDelayText, de.shippingDelayText);
  if (delai) de.shippingDelayText = delai;
  return de;
}

/* Plafonds par passage. Volontairement bas : le balayage tourne toutes les
   heures, et personne ne publie 60 fiches par heure à la main. */
const MAX_FICHES = Number(process.env.DE_AUTO_MAX_PRODUITS || 60);
const MAX_ARTICLES = Number(process.env.DE_AUTO_MAX_ARTICLES || 5);
const MODELE = process.env.DE_AUTO_MODEL || 'gpt-4o-mini';
/* Au-delà, on cesse de payer pour la même fiche. Elle repart si son texte
   change — c'est le seul signal qui laisse espérer un autre résultat. */
const MAX_ECHECS = 3;
/* Fenêtre de la passe B. Une réécriture bouge `updatedAt` : la fiche est donc
   en tête, et il n'y a pas de famine possible ici. */
const FENETRE_REECRITS = 400;

/** Empreinte du contenu traduisible d'un article (pendant de sourceHash). */
function blogSourceHash(post) {
  const p = post || {};
  const src = [
    p.title || '',
    p.excerpt || '',
    p.contentHtml || p.contentMarkdown || '',
    (p.seo && p.seo.metaTitle) || '',
    (p.seo && p.seo.metaDescription) || '',
  ].join(' ');
  return crypto.createHash('sha1').update(src).digest('hex');
}

/** Une traduction périmée : le texte français a changé depuis. */
function estPerime(doc, empreinte) {
  const de = (doc.localizations && doc.localizations.de) || {};
  if (!de.translatedAt) return true;
  /* Empreinte absente = traduite avant leur mise en place. On ne dépense pas
     sur un doute : le script de rattrapage en pose une sur tout l'existant. */
  if (!de.sourceHash) return false;
  return de.sourceHash !== empreinte(doc);
}

/** Mise de côté après trois échecs consécutifs sur le MÊME texte. */
function estEnQuarantaine(doc, empreinte) {
  const de = (doc.localizations && doc.localizations.de) || {};
  if (!de.failedHash || !(de.failedCount >= MAX_ECHECS)) return false;
  return de.failedHash === empreinte(doc);
}

/* Compat : l'ancien nom, conservé pour les tests et les appels existants. */
function aTraiter(doc, empreinte) {
  return estPerime(doc, empreinte) && !estEnQuarantaine(doc, empreinte);
}

/* Verrou : deux instances qui balaient en même temps traduiraient le même lot
   deux fois — deux fois la dépense, et la seconde écrase la première. Un
   document daté suffit : il expire tout seul si le processus meurt en cours. */
async function prendreVerrou(nom, dureeMs) {
  const col = mongoose.connection.collection('jobLocks');
  const maintenant = new Date();
  const perime = new Date(maintenant.getTime() - dureeMs);
  /* On ne se fie PAS à la forme du retour de findOneAndUpdate : elle a changé
     entre les versions du driver ({ value } jusqu'à la v5, le document nu
     ensuite). `updateOne` renvoie des compteurs, qui eux sont stables. */
  const r = await col.updateOne(
    { _id: nom, $or: [{ pris: { $lt: perime } }, { pris: null }, { pris: { $exists: false } }] },
    { $set: { pris: maintenant } },
    { upsert: true }
  ).catch((e) => (e && e.code === 11000 ? null : Promise.reject(e)));
  /* Verrou obtenu si on a modifié la ligne existante OU créé la ligne. Une
     collision d'upsert (11000) veut dire qu'un autre l'a pris à l'instant. */
  return Boolean(r && (r.modifiedCount === 1 || r.upsertedCount === 1));
}
async function rendreVerrou(nom) {
  try { await mongoose.connection.collection('jobLocks').updateOne({ _id: nom }, { $set: { pris: null } }); }
  catch (e) { /* le verrou expirera seul */ }
}

/** Note l'échec sur la fiche, sans toucher à sa traduction ni à son état. */
async function noterEchec(Modele, id, empreinte, precedent) {
  const memeTexte = precedent && precedent.failedHash === empreinte;
  await Modele.updateOne({ _id: id }, {
    $set: {
      'localizations.de.failedHash': empreinte,
      'localizations.de.failedCount': memeTexte ? (precedent.failedCount || 0) + 1 : 1,
      'localizations.de.failedAt': new Date(),
    },
  });
}

async function traduireFiches({ apiKey, Product }) {
  const neuves = await Product.find({
    isPublished: true,
    $or: [
      { 'localizations.de.translatedAt': null },
      { 'localizations.de.translatedAt': { $exists: false } },
      { 'localizations.de': { $exists: false } },
    ],
  })
    .sort({ createdAt: 1 })
    .limit(MAX_FICHES * 4)
    .lean();

  let aFaire = neuves.filter((p) => !estEnQuarantaine(p, translator.sourceHash)).slice(0, MAX_FICHES);

  if (aFaire.length < MAX_FICHES) {
    const recents = await Product.find({
      isPublished: true,
      'localizations.de.translatedAt': { $ne: null },
      'localizations.de.sourceHash': { $exists: true, $ne: '' },
    })
      .sort({ updatedAt: -1 })
      .limit(FENETRE_REECRITS)
      .lean();
    const reecrits = recents.filter((p) => aTraiter(p, translator.sourceHash));
    aFaire = aFaire.concat(reecrits.slice(0, MAX_FICHES - aFaire.length));
  }

  if (!aFaire.length) return { traitees: 0, echecs: 0, quarantaine: 0 };

  let ok = 0;
  let ko = 0;
  for (const produit of aFaire) {
    const empreinte = translator.sourceHash(produit);
    try {
      const de = harmoniserVocabulaire(produit, await translator.translateProduct(produit, { apiKey, model: MODELE }));
      de.sourceHash = empreinte;
      de.failedHash = '';
      de.failedCount = 0;
      await Product.updateOne({ _id: produit._id }, { $set: { 'localizations.de': de } });
      ok++;
    } catch (err) {
      ko++;
      const de = (produit.localizations && produit.localizations.de) || {};
      await noterEchec(Product, produit._id, empreinte, de).catch(() => {});
      console.warn('[traduction DE] fiche ' + produit._id + ' : ' + (err && err.message ? err.message : err));
    }
  }
  const quarantaine = await Product.countDocuments({
    isPublished: true,
    'localizations.de.failedCount': { $gte: MAX_ECHECS },
  });
  return { traitees: ok, echecs: ko, quarantaine };
}

async function traduireArticles({ BlogPost }) {
  const neufs = await BlogPost.find({
    isPublished: true,
    $or: [
      { 'localizations.de.translatedAt': null },
      { 'localizations.de.translatedAt': { $exists: false } },
      { 'localizations.de': { $exists: false } },
    ],
  })
    .sort({ createdAt: 1 })
    .limit(MAX_ARTICLES * 8)
    .lean();

  /* Un article sans texte français n'a rien à traduire : le modèle rendrait un
     objet incomplet et on le reprendrait à chaque passage, pour rien. */
  const aDuTexte = (b) => String(b.contentHtml || b.contentMarkdown || '').trim().length > 200;
  let aFaire = neufs.filter((b) => aDuTexte(b) && !estEnQuarantaine(b, blogSourceHash)).slice(0, MAX_ARTICLES);

  if (aFaire.length < MAX_ARTICLES) {
    const recents = await BlogPost.find({
      isPublished: true,
      'localizations.de.translatedAt': { $ne: null },
      'localizations.de.sourceHash': { $exists: true, $ne: '' },
    })
      .sort({ updatedAt: -1 })
      .limit(FENETRE_REECRITS)
      .lean();
    aFaire = aFaire.concat(
      recents.filter((b) => aDuTexte(b) && aTraiter(b, blogSourceHash)).slice(0, MAX_ARTICLES - aFaire.length)
    );
  }

  if (!aFaire.length) return { traitees: 0, echecs: 0, quarantaine: 0 };

  /* Le blog passe par son script dédié (prompt, glossaire et garde-fous des
     métas lui appartiennent) : on ne duplique pas cette logique ici. Le
     fournisseur est IMPOSÉ : ce script lit son défaut sur argv, et le cron n'a
     pas d'argv — il partait donc chez Anthropic, sans clé, à chaque passage. */
  const { traduireArticle } = require('../../scripts/translate-blog-de');
  let ok = 0;
  let ko = 0;
  for (const post of aFaire) {
    const empreinte = blogSourceHash(post);
    try {
      const de = await traduireArticle(post, { model: MODELE, provider: 'openai' });
      de.sourceHash = empreinte;
      de.failedHash = '';
      de.failedCount = 0;
      await BlogPost.updateOne({ _id: post._id }, { $set: { 'localizations.de': de } });
      ok++;
    } catch (err) {
      ko++;
      const de = (post.localizations && post.localizations.de) || {};
      await noterEchec(BlogPost, post._id, empreinte, de).catch(() => {});
      console.warn('[traduction DE] article ' + post.slug + ' : ' + (err && err.message ? err.message : err));
    }
  }
  const quarantaine = await BlogPost.countDocuments({
    isPublished: true,
    'localizations.de.failedCount': { $gte: MAX_ECHECS },
  });
  return { traitees: ok, echecs: ko, quarantaine };
}

async function traduireNouveautesDe() {
  if (process.env.DE_AUTO_TRANSLATE !== 'true') return null;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    console.warn('[traduction DE] OPENAI_API_KEY absente — passage ignoré.');
    return null;
  }
  if (mongoose.connection.readyState !== 1) return null;

  /* 50 min : plus long qu'un passage plein (60 fiches × ~8 s ≈ 8 min), plus
     court que l'intervalle du cron — un processus tué ne bloque pas la suite. */
  if (!(await prendreVerrou('traduction-de', 50 * 60 * 1000))) {
    console.log('[traduction DE] déjà en cours sur une autre instance — passage ignoré.');
    return null;
  }

  try {
    const Product = require('../models/Product');
    const BlogPost = require('../models/BlogPost');

    const fiches = await traduireFiches({ apiKey, Product });
    const articles = await traduireArticles({ BlogPost });

    if (fiches.traitees || fiches.echecs || articles.traitees || articles.echecs) {
      console.log('[traduction DE] fiches ' + fiches.traitees + ' ok / ' + fiches.echecs + ' ko'
        + (fiches.quarantaine ? ' (' + fiches.quarantaine + ' en quarantaine)' : '')
        + ' — articles ' + articles.traitees + ' ok / ' + articles.echecs + ' ko'
        + (articles.quarantaine ? ' (' + articles.quarantaine + ' en quarantaine)' : ''));
    }
    return { fiches, articles };
  } finally {
    await rendreVerrou('traduction-de');
  }
}

module.exports = {
  traduireNouveautesDe,
  blogSourceHash,
  aTraiter,
  estPerime,
  estEnQuarantaine,
  prendreVerrou,
  rendreVerrou,
  MAX_FICHES,
  MAX_ARTICLES,
  MAX_ECHECS,
};
