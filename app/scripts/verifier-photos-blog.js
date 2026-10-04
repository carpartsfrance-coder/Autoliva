'use strict';

/**
 * Articles de blog dont l'image ne s'affiche pas : les trouver, et retirer les
 * adresses mortes.
 *
 *   AUDIT (défaut)   : node scripts/verifier-photos-blog.js
 *   RÉPARATION       : node scripts/verifier-photos-blog.js --apply
 *
 * ── Pourquoi (04/10/2026) ────────────────────────────────────────────────────
 *
 * Même défaut que sur les fiches produits, trouvé en remontant une vignette
 * morte restée sur une fiche : les images vivent dans GridFS, les documents ne
 * gardent que l'adresse, et quand le fichier manque la route renvoie un carré
 * gris en 200 (mediaController.servePlaceholder). Rien dans les journaux, rien
 * pour le visiteur à part un carré gris. 201 articles étaient dans ce cas :
 * 191 couvertures, 152 og:image, 75 images dans le corps des textes.
 *
 * ── Ce que fait --apply ──────────────────────────────────────────────────────
 *
 * Il VIDE les adresses mortes au lieu de les remplacer. C'est le geste utile :
 * tout le site teste « l'article a-t-il une couverture ? » et bascule sur la
 * photo du premier produit lié quand il n'en a pas (blogController.js:325 pour
 * les listes, :730 pour l'article). Une couverture morte est une chaîne bien
 * remplie : le repli ne se déclenchait donc jamais. La vider le réveille, et
 * l'article récupère une photo qui est dans son sujet — l'article sur le pont
 * Haldex prend la photo du pont Haldex qu'on vend. 188 des 191 articles ont un
 * produit lié dont la photo est vivante.
 *
 * Dans le corps des textes, l'image morte est retirée (avec le paragraphe qui
 * ne contenait qu'elle), en français, en markdown et en allemand, pour que les
 * trois restent d'accord.
 *
 * Rien n'est inventé : aucune image n'est créée, aucune n'est déplacée d'un
 * article à un autre.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const BlogPost = require('../src/models/BlogPost');
const Product = require('../src/models/Product');
const { extractMediaIdFromUrl } = require('../src/services/mediaStorage');
const { blogSourceHash } = require('../src/jobs/traduireNouveautesDe');
const { verdictEcriture } = require('../src/services/gardeFousMedias');

const APPLY = process.argv.includes('--apply');
const LOT = 5000;

/* Les champs de texte où une image peut se cacher. Les trois portent les mêmes
   adresses : le markdown est la source, le HTML français en est le rendu, et
   l'allemand la traduction du même texte. */
const CHAMPS_TEXTE = [
  { chemin: 'contentHtml', genre: 'html' },
  { chemin: 'contentMarkdown', genre: 'markdown' },
  { chemin: 'localizations.de.contentHtml', genre: 'html' },
];

function lire(doc, chemin) {
  return chemin.split('.').reduce((o, k) => (o && typeof o === 'object' ? o[k] : undefined), doc);
}

function echapper(texte) {
  return String(texte).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Toutes les adresses /media/… d'une chaîne, sans doublon. */
function adressesDe(texte) {
  return [...new Set([...String(texte || '').matchAll(/\/media\/[A-Za-z0-9._-]+/g)].map((m) => m[0]))];
}

/**
 * Retire une adresse morte d'un texte.
 *
 * En HTML, l'image est presque toujours seule dans son paragraphe
 * (`<p><img …/></p>`) : on retire le paragraphe entier, sinon il resterait un
 * blanc. Si elle est accompagnée, on ne retire que la balise <img>.
 * En markdown, on retire `![légende](adresse)` et on recolle les lignes vides.
 */
function retirerImage(texte, url, genre) {
  const u = echapper(url);
  let sortie = String(texte || '');
  if (genre === 'html') {
    sortie = sortie.replace(new RegExp(`<p>\\s*<img[^>]*src=["']${u}["'][^>]*>\\s*</p>`, 'gi'), '');
    sortie = sortie.replace(new RegExp(`<img[^>]*src=["']${u}["'][^>]*>`, 'gi'), '');
  } else {
    sortie = sortie.replace(new RegExp(`!\\[[^\\]]*\\]\\(${u}\\)`, 'g'), '');
    sortie = sortie.replace(/\n{3,}/g, '\n\n');
  }
  return sortie;
}

(async () => {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI absent — abandon.');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  console.log(APPLY ? '>>> MODE ÉCRITURE <<<\n' : '>>> AUDIT (aucune écriture) <<<\n');

  const articles = await BlogPost.find({})
    .select('slug title excerpt isPublished coverImageUrl seo.ogImageUrl seo.metaTitle '
      + 'seo.metaDescription relatedProductIds contentHtml contentMarkdown '
      + 'localizations.de.contentHtml localizations.de.translatedAt localizations.de.sourceHash')
    .lean();

  /* Ce que chaque article récupérera si on vide sa couverture : la photo de son
     premier produit lié. Chargée AVANT le contrôle d'existence, pour que ces
     photos-là soient vérifiées elles aussi — sinon on les déclarerait mortes
     faute de les avoir demandées, et le rapport annoncerait à tort des articles
     sans repli. */
  const tousProduits = [...new Set(articles.flatMap((a) => (a.relatedProductIds || []).map(String)))];
  const photoProduit = new Map();
  for (let i = 0; i < tousProduits.length; i += 2000) {
    const lot = tousProduits.slice(i, i + 2000)
      .filter((x) => mongoose.Types.ObjectId.isValid(x))
      .map((x) => new mongoose.Types.ObjectId(x));
    /* eslint-disable no-await-in-loop */
    const docs = await Product.find({ _id: { $in: lot } }).select('_id imageUrl name').lean();
    /* eslint-enable no-await-in-loop */
    for (const d of docs) photoProduit.set(String(d._id), d);
  }

  /* Les identifiants réellement stockés. */
  const references = new Set();
  const noter = (url) => { const id = extractMediaIdFromUrl(url); if (id) references.add(String(id)); };
  for (const a of articles) {
    noter(a.coverImageUrl);
    noter(a.seo && a.seo.ogImageUrl);
    for (const { chemin } of CHAMPS_TEXTE) for (const u of adressesDe(lire(a, chemin))) noter(u);
  }
  for (const p of photoProduit.values()) noter(p.imageUrl);

  const collection = mongoose.connection.db.collection('media.files');

  /* GARDE-FOU 1 — stockage vide : on ne juge RIEN. Branché par erreur sur une
     base dont les médias ne sont pas restaurés, --apply effacerait sinon toutes
     les illustrations du blog, sans retour possible. */
  const stockes = await collection.estimatedDocumentCount();
  if (stockes === 0) {
    console.error('AUCUN média dans le stockage : base incomplète, ou mauvaise base. Abandon.');
    await mongoose.disconnect();
    process.exit(1);
  }

  const ids = [...references];
  const presents = new Set();
  for (let i = 0; i < ids.length; i += LOT) {
    const lot = ids.slice(i, i + LOT)
      .filter((x) => mongoose.Types.ObjectId.isValid(x))
      .map((x) => new mongoose.Types.ObjectId(x));
    /* eslint-disable no-await-in-loop */
    const docs = await collection.find({ _id: { $in: lot } }).project({ _id: 1, length: 1 }).toArray();
    /* eslint-enable no-await-in-loop */
    for (const d of docs) if ((d.length || 0) > 0) presents.add(String(d._id));
  }
  const absentsBlogSeul = ids.length - presents.size;
  const morte = (url) => {
    const id = extractMediaIdFromUrl(url);
    return !!id && !presents.has(String(id));
  };

  const repliDe = (a) => (a.relatedProductIds || [])
    .map((id) => photoProduit.get(String(id)))
    .find((p) => p && p.imageUrl && !morte(p.imageUrl)) || null;

  const aReparer = [];
  let couverturesMortes = 0;
  let ogMortes = 0;
  let imagesCorps = 0;
  const sansRepli = [];

  for (const a of articles) {
    const changements = {};
    const traces = [];

    if (morte(a.coverImageUrl)) {
      couverturesMortes += 1;
      changements.coverImageUrl = '';
      const repli = repliDe(a);
      traces.push(repli
        ? `couverture morte → reprendra la photo de « ${(repli.name || '').slice(0, 54)} »`
        : 'couverture morte → AUCUN repli, l’article restera sans image');
      if (!repli) sansRepli.push(a);
    }
    if (morte(a.seo && a.seo.ogImageUrl)) {
      ogMortes += 1;
      changements['seo.ogImageUrl'] = '';
      traces.push('og:image morte → suivra la couverture');
    }
    for (const { chemin, genre } of CHAMPS_TEXTE) {
      const texte = lire(a, chemin);
      if (typeof texte !== 'string' || !texte) continue;
      const mortes = adressesDe(texte).filter(morte);
      if (!mortes.length) continue;
      let sortie = texte;
      for (const u of mortes) sortie = retirerImage(sortie, u, genre);
      if (sortie === texte) continue;
      changements[chemin] = sortie;
      imagesCorps += mortes.length;
      traces.push(`${chemin} : ${mortes.length} image(s) morte(s) retirée(s)`);
    }

    /* Retirer une image cassée n'est pas une réécriture de l'article : la
       traduction allemande reste valable. Sans cette ligne, l'empreinte de
       traduction (qui porte sur contentHtml, traduireNouveautesDe.js:113) ne
       correspondrait plus, et les 65 articles seraient remis dans la file de
       retraduction le jour où DE_AUTO_TRANSLATE passe à « true » — texte
       allemand relu écrasé, et facture de traduction à la clé. On réaligne
       donc l'empreinte, et seulement si l'article en avait déjà une. */
    const empreinteActuelle = a.localizations && a.localizations.de && a.localizations.de.sourceHash;
    if (empreinteActuelle && (changements.contentHtml !== undefined || changements.contentMarkdown !== undefined)) {
      const apres = {
        ...a,
        contentHtml: changements.contentHtml !== undefined ? changements.contentHtml : a.contentHtml,
        contentMarkdown: changements.contentMarkdown !== undefined ? changements.contentMarkdown : a.contentMarkdown,
      };
      changements['localizations.de.sourceHash'] = blogSourceHash(apres);
      traces.push('empreinte de traduction réalignée (pas de retraduction)');
    }

    if (Object.keys(changements).length) aReparer.push({ article: a, changements, traces });
  }

  /* GARDE-FOU 2 — le stockage répond-il correctement ?
     La question n'est pas « le blog a-t-il beaucoup d'images mortes ? » mais
     « peut-on faire confiance à ce que la base nous répond ? ». Mesurée sur le
     seul blog, elle donne une réponse fausse : il ne référence que 707
     illustrations, très partagées, donc 58 fichiers supprimés font 8 % — un
     chiffre qui ressemble à une panne alors que c'est la casse elle-même.
     On la pose donc à TOUT ce que le site référence, fiches comprises. Une
     base incomplète, une mauvaise base ou une connexion qui échoue font
     plonger les deux ensembles d'un coup ; une suppression de couvertures ne
     touche que le blog. Au 04/10/2026 : 0 % sur 7 775 médias de fiches, 8,2 %
     sur le blog, 0,74 % sur l'ensemble. */
  const mediasFiches = new Set();
  await Product.find({}).select('imageUrl galleryUrls').lean().cursor()
    .eachAsync((p) => {
      for (const u of [p.imageUrl, ...(Array.isArray(p.galleryUrls) ? p.galleryUrls : [])]) {
        const id = extractMediaIdFromUrl(u);
        if (id) mediasFiches.add(String(id));
      }
    });
  /* Ces identifiants-là n'ont pas encore été demandés : sans cette boucle ils
     passeraient tous pour absents, et le garde-fou crierait à la panne. */
  const resteADemander = [...mediasFiches].filter((x) => !presents.has(x));
  for (let i = 0; i < resteADemander.length; i += LOT) {
    const lot = resteADemander.slice(i, i + LOT)
      .filter((x) => mongoose.Types.ObjectId.isValid(x))
      .map((x) => new mongoose.Types.ObjectId(x));
    if (!lot.length) continue;
    /* eslint-disable no-await-in-loop */
    const docs = await collection.find({ _id: { $in: lot } }).project({ _id: 1, length: 1 }).toArray();
    /* eslint-enable no-await-in-loop */
    for (const d of docs) if ((d.length || 0) > 0) presents.add(String(d._id));
  }

  const absentsFiches = [...mediasFiches].filter((x) => !presents.has(x)).length;
  const toutLeSite = new Set([...ids, ...mediasFiches]);
  const absentsPartout = [...toutLeSite].filter((x) => !presents.has(x)).length;
  const partAbsente = toutLeSite.size ? absentsPartout / toutLeSite.size : 0;

  const publies = articles.filter((a) => a.isPublished !== false).length;
  console.log(`articles analysés              : ${articles.length} (${publies} publiés, ${articles.length - publies} brouillons)`);
  console.log(`adresses de médias distinctes  : ${ids.length} (${ids.length - absentsBlogSeul} présentes, ${absentsBlogSeul} absentes)`);
  console.log(`santé du stockage              : ${(100 * partAbsente).toFixed(2)} % d'absents sur tout le site `
    + `(${absentsFiches} sur ${mediasFiches.size} médias de fiches)`);
  console.log('');
  console.log(`couvertures mortes             : ${couverturesMortes}`);
  console.log(`og:image mortes                : ${ogMortes}`);
  console.log(`images mortes dans les textes  : ${imagesCorps}`);
  console.log(`articles à réparer             : ${aReparer.length}`);

  if (sansRepli.length) {
    console.log('\n── Ces articles n’auront AUCUNE image (aucun produit lié avec photo) ──');
    for (const a of sansRepli) {
      console.log(`   ${a.title || a.slug}`);
      console.log(`      https://autoliva.com/blog/${a.slug}`);
    }
  }

  if (APPLY) {
    const verdict = verdictEcriture({
      mediasStockes: stockes,
      totalSite: toutLeSite.size,
      absentsSite: absentsPartout,
      totalCorpus: ids.length,
      absentsCorpus: absentsBlogSeul,
    });
    if (!verdict.ecrire) {
      console.error(`\n${verdict.raison}`);
      console.error('Rien n’a été écrit.');
      await mongoose.disconnect();
      process.exit(1);
    }
  }

  if (!APPLY) {
    console.log(`\n(aucune écriture — relancer avec --apply pour réparer ces ${aReparer.length} article(s))`);
    await mongoose.disconnect();
    return;
  }

  let faits = 0;
  for (const { article, changements, traces } of aReparer) {
    /* eslint-disable no-await-in-loop */
    await BlogPost.updateOne({ _id: article._id }, { $set: changements });
    /* eslint-enable no-await-in-loop */
    faits += 1;
    console.log(`   ✔ ${article.slug}`);
    for (const t of traces) console.log(`       ${t}`);
  }
  console.log(`\n${faits} article(s) réparé(s).`);
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
