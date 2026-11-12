'use strict';

/**
 * Fiches dont la photo ne s'affiche pas : les trouver, et retirer les
 * références mortes.
 *
 *   AUDIT (défaut)   : node scripts/verifier-photos-produits.js
 *   RÉPARATION       : node scripts/verifier-photos-produits.js --apply
 *
 * ── Pourquoi (02/10/2026) ────────────────────────────────────────────────────
 *
 * Les images sont dans GridFS (bucket « media ») et les fiches n'en gardent que
 * l'adresse : /media/<id>. Quand le fichier manque, la route ne renvoie pas une
 * erreur — elle sert un carré gris avec un appareil photo, pour ne pas casser la
 * mise en page. Vu du visiteur : un article sans photo. Vu des journaux : rien.
 * Cinq fiches sont restées comme ça pendant plus de six mois.
 *
 * L'origine, datée : les quinze références mortes ont toutes été créées le
 * 22/03/2026 entre 21:18 et 21:22 UTC, et AUCUN média n'a été stocké dans cette
 * tranche (885 le reste de la journée). Les envois ont échoué, les fiches ont
 * gardé les adresses. Rien n'a été supprimé après coup.
 *
 * ── Ce que fait --apply ──────────────────────────────────────────────────────
 *
 * Il retire des fiches les adresses dont le fichier n'existe pas, et remonte en
 * image principale la première image valide qui reste (galleryTypes suit, index
 * par index). Une fiche qui n'avait QUE des adresses mortes se retrouve sans
 * aucune image : c'est la vérité, et c'est ce qui permet au flux Merchant de
 * l'écarter au lieu d'envoyer un carré gris à Google. Elle demande alors une
 * vraie photo — le script la nomme.
 *
 * Aucune vidéo n'est touchée (galleryTypes === 'video'), aucune adresse
 * extérieure non plus : on ne juge que ce qu'on héberge.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('../src/models/Product');
const { extractMediaIdFromUrl } = require('../src/services/mediaStorage');

const APPLY = process.argv.includes('--apply');
const LOT = 5000;

/** Les adresses d'image d'une fiche, dans l'ordre d'affichage. */
function referencesDe(fiche) {
  const refs = [];
  if (fiche.imageUrl) refs.push({ url: fiche.imageUrl, champ: 'imageUrl', index: -1, type: 'image' });
  const urls = Array.isArray(fiche.galleryUrls) ? fiche.galleryUrls : [];
  const types = Array.isArray(fiche.galleryTypes) ? fiche.galleryTypes : [];
  urls.forEach((url, i) => {
    if (!url) return;
    refs.push({ url, champ: 'galleryUrls', index: i, type: types[i] === 'video' ? 'video' : 'image' });
  });
  return refs;
}

(async () => {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI absent — abandon.');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  console.log(APPLY ? '>>> MODE ÉCRITURE <<<\n' : '>>> AUDIT (aucune écriture) <<<\n');

  /* Brouillons compris : une photo morte sur un brouillon se verra le jour de
     sa publication, et les compteurs seraient faux sans eux. */
  const fiches = await Product.find({})
    .select('name sku slug category imageUrl galleryUrls galleryTypes inStock priceCents isPublished')
    .lean();

  /* Les ids de médias réellement stockés, en quelques requêtes. */
  const tousLesIds = new Set();
  for (const f of fiches) {
    for (const r of referencesDe(f)) {
      const id = extractMediaIdFromUrl(r.url);
      if (id) tousLesIds.add(String(id));
    }
  }
  const ids = [...tousLesIds];
  const presents = new Set();
  const collection = mongoose.connection.db.collection('media.files');

  /* GARDE-FOU 1 — stockage vide : on ne juge RIEN. Branché par erreur sur une
     base dont les médias ne sont pas restaurés, --apply effacerait sinon toutes
     les photos du catalogue, sans retour possible. */
  const stockes = await collection.estimatedDocumentCount();
  if (stockes === 0) {
    console.error('AUCUN média dans le stockage : base incomplète, ou mauvaise base. Abandon.');
    await mongoose.disconnect();
    process.exit(1);
  }
  for (let i = 0; i < ids.length; i += LOT) {
    const docs = await collection
      .find({ _id: { $in: ids.slice(i, i + LOT).map((x) => new mongoose.Types.ObjectId(x)) } })
      .project({ _id: 1, length: 1 })
      .toArray();
    for (const d of docs) if ((d.length || 0) > 0) presents.add(String(d._id));
  }

  /* Une adresse est « morte » seulement si c'est un média à nous, absent du
     stockage. Le reste (fichier statique, adresse extérieure) n'est pas jugé. */
  const morte = (url) => {
    const id = extractMediaIdFromUrl(url);
    return !!id && !presents.has(String(id));
  };

  const sansAucunePhoto = [];
  const principaleMorte = [];
  const aNettoyer = [];
  let referencesMortes = 0;

  for (const f of fiches) {
    const refs = referencesDe(f);
    const mortes = refs.filter((r) => morte(r.url));
    if (!mortes.length) continue;
    referencesMortes += mortes.length;

    const survivantes = refs.filter((r) => !morte(r.url));
    const imagesSurvivantes = survivantes.filter((r) => r.type === 'image');
    const entree = {
      id: String(f._id),
      sku: f.sku || '',
      nom: f.name || '',
      slug: f.slug || '',
      categorie: f.category || '',
      prix: Math.round((f.priceCents || 0) / 100),
      enStock: f.inStock !== false,
      publiee: f.isPublished !== false,
      mortes: mortes.map((r) => r.url),
      restantes: imagesSurvivantes.map((r) => r.url),
    };
    if (!imagesSurvivantes.length) sansAucunePhoto.push(entree);
    else if (morte(f.imageUrl || '')) principaleMorte.push(entree);
    aNettoyer.push({ fiche: f, mortes, survivantes });
  }

  /* GARDE-FOU 2 — proportion. Une poignée d'adresses mortes est un incident ;
     au-delà de 1 % des médias référencés, c'est le stockage ou la connexion qui
     est en cause, pas les fiches. On refuse d'écrire plutôt que de vider le
     site. */
  const partAbsente = ids.length ? (ids.length - presents.size) / ids.length : 0;
  const SEUIL = 0.01;

  const publiees = fiches.filter((f) => f.isPublished !== false).length;
  console.log(`fiches analysées               : ${fiches.length} (${publiees} publiées, ${fiches.length - publiees} brouillons)`);
  console.log(`adresses de médias distinctes  : ${ids.length} (${presents.size} présentes, ${ids.length - presents.size} absentes)`);
  console.log(`références mortes sur les fiches : ${referencesMortes}, réparties sur ${aNettoyer.length} fiche(s)`);
  console.log('');
  console.log(`fiches SANS AUCUNE photo        : ${sansAucunePhoto.length}`);
  console.log(`fiches dont la 1re photo manque : ${principaleMorte.length} (une autre photo prendra sa place)`);

  const ligne = (e) => `   ${e.sku.padEnd(12)} ${e.publiee ? 'publiée  ' : 'brouillon'} ${e.enStock ? 'en stock ' : 'hors stock'} ${String(e.prix).padStart(5)} €  https://autoliva.com/product/${e.slug}/`;
  if (sansAucunePhoto.length) {
    console.log('\n── Ces fiches demandent une VRAIE photo (il n’en reste aucune) ──');
    for (const e of sansAucunePhoto) { console.log(`   ${e.nom}`); console.log(ligne(e)); }
  }
  if (principaleMorte.length) {
    console.log('\n── Ces fiches ont une photo valide plus loin : elle remonte en principale ──');
    for (const e of principaleMorte) { console.log(`   ${e.nom}`); console.log(ligne(e)); }
  }

  if (APPLY && partAbsente > SEUIL) {
    console.error(`\n${(100 * partAbsente).toFixed(1)} % des médias référencés sont absents (seuil : ${100 * SEUIL} %).`);
    console.error('Ce n’est pas un incident de fiches, c’est le stockage. Rien n’a été écrit.');
    await mongoose.disconnect();
    process.exit(1);
  }

  if (!APPLY) {
    console.log(`\n(aucune écriture — relancer avec --apply pour retirer les ${referencesMortes} références mortes)`);
    await mongoose.disconnect();
    return;
  }

  let modifiees = 0;
  for (const { fiche, survivantes } of aNettoyer) {
    const images = survivantes.filter((r) => r.type === 'image');
    const nouvelleImage = images.length ? images[0].url : '';
    /* La galerie garde son ordre et ses vidéos ; galleryTypes suit index par
       index, sinon une vidéo se retrouverait étiquetée image. */
    const galerie = survivantes.filter((r) => r.champ === 'galleryUrls');
    await Product.updateOne(
      { _id: fiche._id },
      {
        $set: {
          imageUrl: nouvelleImage,
          galleryUrls: galerie.map((r) => r.url),
          galleryTypes: galerie.map((r) => r.type),
        },
      }
    );
    modifiees += 1;
    console.log(`   ✔ ${fiche.sku || fiche._id} — image principale : ${nouvelleImage || '(aucune)'}`);
  }
  console.log(`\n${modifiees} fiche(s) nettoyée(s).`);
  await mongoose.disconnect();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
