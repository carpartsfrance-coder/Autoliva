#!/usr/bin/env node

/**
 * Seed idempotent du produit-service "Clonage mécatronique TCU DSG & S-tronic".
 *
 * Comportement : upsert par slug. Lancer plusieurs fois est sans effet destructif.
 *
 * Usage : node src/seed/seedClonageTcuService.js
 */

require('dotenv').config();

const mongoose = require('mongoose');
const Product = require('../models/Product');

const SLUG = 'clonage-mecatronique-tcu-dsg-s-tronic';
const SKU = 'CPF-SVC-CLONE-TCU-001';

const productDoc = {
  name: 'Clonage mécatronique TCU DSG & S-tronic',
  category: 'Transmission',
  brand: 'Autoliva',
  sku: SKU,
  slug: SLUG,
  serviceType: 'standalone_cloning',
  priceCents: 19900,
  compareAtPriceCents: null,
  consigne: { enabled: false, amountCents: 0, delayDays: 30 },
  inStock: true,
  stockQty: null,
  imageUrl: '',
  shippingClassId: null,
  shippingDelayText: 'Clonage 24h après réception',
  compatibleReferences: [],
  searchSynonyms: [
    'clonage TCU',
    'clonage mécatronique',
    'clonage DSG',
    'clonage S-tronic',
    'transfert TCU',
    'clonage DQ200',
    'clonage DQ250',
    'clonage DQ381',
    'clonage DQ500',
    'clonage DL501',
    'clonage DL382',
  ],
  badges: {
    topLeft: 'Service • 199€',
    condition: 'Service à distance',
  },
  galleryUrls: [],
  galleryTypes: [],
  shortDescription:
    'Service de clonage logiciel TCU pour mécatroniques DSG et S-tronic. Toutes boîtes VAG. 199€ TTC, étiquette retour incluse, clonage en 24h après réception de vos pièces.',
  description: `<p><strong>Le seul service de clonage mécatronique DSG &amp; S-tronic à prix fixe en France.</strong></p>
<p>Vous avez remplacé votre mécatronique mais votre boîte refuse le réglage de base, reste en mode dégradé, ou refuse les adaptations ? Le clonage logiciel TCU transfère le software de votre ancienne mécatronique vers la nouvelle, et tout fonctionne sans passage concession.</p>
<p>Ce service couvre <strong>toutes les boîtes DSG et S-tronic du groupe VAG</strong> : DQ200, DQ250, DQ381, DQ500, DL501, DL382. Vous nous envoyez vos 2 mécatroniques (ou les 2 TCU), nous clonons sous 24h ouvrées après réception et nous vous renvoyons les pièces.</p>
<h3>Ce qui est inclus</h3>
<ul>
<li>Transfert logiciel TCU complet (ancienne → nouvelle mécatronique)</li>
<li>Test post-clonage sur banc</li>
<li>Étiquettes d'expédition aller et retour incluses (aucun frais d'envoi)</li>
<li>Garantie 30 jours sur l'opération de clonage</li>
</ul>
<h3>Ce qui n'est pas inclus</h3>
<ul>
<li>Diagnostic mécanique de la boîte ou de la mécatronique</li>
<li>Réglage de base / adaptation après remontage (à faire chez vous via VCDS/ODIS)</li>
<li>Flash performance ou reprog</li>
<li>Garantie sur le hardware de la mécatronique (avant ou après clonage)</li>
</ul>`,
  keyPoints: [
    '199€ TTC tout compris — prix fixe toutes boîtes',
    'Clonage en 24h ouvrées après réception',
    'Toutes boîtes DSG & S-tronic VAG (DQ200/250/381/500, DL501/382)',
    'Étiquettes aller et retour incluses',
    'Garantie 30 jours sur l\'opération logicielle',
  ],
  specs: [
    { label: 'Boîtes compatibles', value: 'DQ200, DQ250, DQ381, DQ500, DL501, DL382' },
    { label: 'Délai atelier', value: '24h ouvrées après réception' },
    { label: 'Expédition', value: 'Étiquettes aller + retour incluses' },
    { label: 'Garantie', value: '30 jours sur l\'opération de clonage' },
    { label: 'Périmètre', value: 'Clonage logiciel TCU uniquement' },
    { label: 'Marque atelier', value: 'Autoliva — Car Parts France' },
  ],
  options: [
    {
      key: 'type_boite',
      label: 'Type de boîte',
      type: 'choice',
      required: true,
      placeholder: '',
      helpText: 'Sélectionnez la boîte concernée. Si vous ne savez pas, vérifiez la plaque constructeur de la mécatronique.',
      priceDeltaCents: 0,
      choices: [
        { key: 'dq200', label: 'DSG7 DQ200 (7 vitesses sèches)', priceDeltaCents: 0, absolutePriceCents: null, triggersCloning: false },
        { key: 'dq250', label: 'DSG6 DQ250 (6 vitesses humides)', priceDeltaCents: 0, absolutePriceCents: null, triggersCloning: false },
        { key: 'dq381', label: 'DSG7 DQ381 (7 vitesses humides)', priceDeltaCents: 0, absolutePriceCents: null, triggersCloning: false },
        { key: 'dq500', label: 'DSG7 DQ500 (7 vitesses humides forte cylindrée)', priceDeltaCents: 0, absolutePriceCents: null, triggersCloning: false },
        { key: 'dl501', label: 'S-tronic DL501 (7 vitesses longitudinal)', priceDeltaCents: 0, absolutePriceCents: null, triggersCloning: false },
        { key: 'dl382', label: 'S-tronic DL382 (7 vitesses longitudinal nouvelle gen.)', priceDeltaCents: 0, absolutePriceCents: null, triggersCloning: false },
        { key: 'autre', label: 'Autre / je ne sais pas (on vous recontacte)', priceDeltaCents: 0, absolutePriceCents: null, triggersCloning: false },
      ],
    },
    {
      key: 'reference_mecatronique',
      label: 'Référence mécatronique (étiquette)',
      type: 'text',
      required: false,
      placeholder: 'Ex : 0AM 927 769 D',
      helpText: 'Référence inscrite sur l\'étiquette de la mécatronique (facultatif mais accélère le traitement).',
      priceDeltaCents: 0,
      choices: [],
    },
    {
      key: 'vin_vehicule',
      label: 'VIN du véhicule',
      type: 'text',
      required: true,
      placeholder: '17 caractères',
      helpText: 'Numéro de châssis (VIN). Obligatoire pour identification et lutte contre la fraude.',
      priceDeltaCents: 0,
      choices: [],
    },
    {
      key: 'codes_defaut',
      label: 'Codes défaut actuels',
      type: 'text',
      required: false,
      placeholder: 'Ex : P17BF, P189C',
      helpText: 'Codes défaut lus à la valise (facultatif). Aide notre atelier à confirmer le diagnostic.',
      priceDeltaCents: 0,
      choices: [],
    },
  ],
  optionTemplateIds: [],
  reconditioningSteps: [
    {
      title: '1. Vous commandez en ligne',
      description: 'Paiement sécurisé 199€ TTC. Vous recevez immédiatement par email votre étiquette d\'expédition aller pré-payée et les instructions d\'emballage.',
    },
    {
      title: '2. Vous nous envoyez vos 2 mécatroniques',
      description: 'Emballez l\'ancienne et la nouvelle mécatronique (ou les 2 TCU) ensemble. Collez l\'étiquette aller pré-payée et expédiez-nous le colis — aucun frais à votre charge.',
    },
    {
      title: '3. On clone en 24h',
      description: 'Réception → diagnostic rapide → transfert logiciel TCU → test sur banc. Le tout en 24h ouvrées maximum.',
    },
    {
      title: '4. On vous renvoie les 2 pièces',
      description: 'Retour en colis suivi à l\'adresse de votre choix, étiquette retour également incluse. Vous remontez sur le véhicule, finissez les adaptations à la valise, et c\'est terminé.',
    },
  ],
  compatibility: [
    { make: 'Volkswagen', model: 'Golf 5/6/7/8 (DSG)', years: '2003+', engine: 'Tous moteurs essence/diesel' },
    { make: 'Volkswagen', model: 'Polo / Passat / Tiguan / T-Roc (DSG)', years: '2003+', engine: 'Tous moteurs' },
    { make: 'Audi', model: 'A1 / A3 / A4 / A5 / A6 / A7 / Q3 / Q5 / Q7 (S-tronic)', years: '2005+', engine: 'Tous moteurs' },
    { make: 'Skoda', model: 'Octavia / Superb / Kodiaq (DSG)', years: '2005+', engine: 'Tous moteurs' },
    { make: 'Seat', model: 'Leon / Ibiza / Ateca / Tarraco (DSG)', years: '2005+', engine: 'Tous moteurs' },
    { make: 'Cupra', model: 'Formentor / Leon / Ateca (DSG)', years: '2018+', engine: 'Tous moteurs' },
  ],
  faqs: [
    {
      question: 'Qu\'est-ce que le clonage de mécatronique TCU ?',
      answer: 'Le clonage consiste à transférer le software (logiciel) de la TCU de votre ancienne mécatronique vers la nouvelle. Cela permet à la nouvelle mécatronique d\'être reconnue par le véhicule sans passage concession, et de conserver les adaptations existantes (point de patinage, calibrations).',
    },
    {
      question: 'Toutes les boîtes DSG et S-tronic sont compatibles ?',
      answer: 'Oui : DQ200, DQ250, DQ381, DQ500 (toutes DSG transversales) et DL501, DL382 (S-tronic longitudinales). Si vous n\'êtes pas sûr du type de votre boîte, choisissez "Autre" lors de la commande et nous vous recontactons.',
    },
    {
      question: 'Et si ma nouvelle mécatronique est défectueuse (problème hardware) ?',
      answer: 'Le clonage logiciel sera effectué correctement, mais si la nouvelle mécatronique a un défaut matériel, elle ne fonctionnera pas sur le véhicule. Le clonage en lui-même n\'est pas en cause. Nous recommandons fortement de diagnostiquer la nouvelle mécatronique avant achat.',
    },
    {
      question: 'Quelle est la garantie ?',
      answer: 'Nous garantissons l\'opération de clonage logiciel pendant 30 jours : si le clonage est défaillant pour une raison logicielle, nous reclonons gratuitement. La garantie ne couvre pas le hardware des mécatroniques (avant ni après clonage), ni le résultat final sur le véhicule si une autre pièce est en cause.',
    },
    {
      question: 'Combien de temps total entre ma commande et la réception du retour ?',
      answer: 'Comptez 4 à 6 jours porte-à-porte : 1-2 jours pour que votre colis arrive chez nous, 24h ouvrées de clonage en atelier, puis 1-2 jours pour le retour.',
    },
    {
      question: 'Je peux suivre l\'avancement ?',
      answer: 'Oui, votre espace client affiche en temps réel : étiquette retour envoyée → colis attendu → reçu atelier → clonage en cours → cloné → expédié retour. Vous recevez aussi un email à chaque étape.',
    },
    {
      question: 'Vous acceptez les TCU seuls (sans le boîtier mécatronique complet) ?',
      answer: 'Oui, vous pouvez nous envoyer uniquement les 2 TCU si vous avez démonté les mécatroniques. Précisez-le simplement dans le commentaire au moment de la commande.',
    },
    {
      question: 'Comment vous envoyer mes pièces ?',
      answer: 'Vous recevez immédiatement après commande une étiquette d\'expédition aller pré-payée (incluse dans les 199€). Vous emballez vos 2 mécatroniques (ou TCU), collez l\'étiquette, et expédiez-nous le colis. L\'étiquette retour pour la réexpédition de vos pièces clonées est également comprise. Aucun frais d\'envoi additionnel, ni à l\'aller ni au retour.',
    },
    {
      question: 'Vous reprenez l\'ancienne mécatronique ?',
      answer: 'Non, nous ne pratiquons pas la consigne sur ce service. Vos 2 pièces (ancienne et nouvelle) vous sont retournées après clonage.',
    },
    {
      question: 'Facture pro avec TVA récupérable ?',
      answer: 'Oui, nous émettons une facture avec mention SIRET et TVA récupérable pour les garages, casses et professionnels. Précisez votre numéro de TVA intracommunautaire au moment de la commande.',
    },
  ],
  relatedBlogPostIds: [],
  media: { videoUrl: '' },
  seo: {
    metaTitle: 'Clonage mécatronique TCU DSG & S-tronic — 199€, retour 24h | Autoliva',
    metaDescription: 'Service de clonage logiciel TCU pour mécatroniques DSG (DQ200, DQ250, DQ381, DQ500) et S-tronic (DL501, DL382). 199€ TTC, étiquette retour incluse, clonage en 24h ouvrées. Toutes boîtes VAG.',
  },
  sections: {
    showKeyPoints: true,
    showSpecs: true,
    showReconditioning: true,
    showCompatibility: true,
    showFaq: true,
    showVideo: false,
    showSupportBox: true,
    showRelatedProducts: false,
  },
};

(async () => {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI manquant dans l\'environnement.');
    process.exit(1);
  }

  try {
    await mongoose.connect(mongoUri);
    console.log('Connecté à MongoDB.');

    const existing = await Product.findOne({ slug: SLUG }).lean();

    if (existing) {
      await Product.updateOne(
        { _id: existing._id },
        { $set: productDoc }
      );
      console.log(`Produit existant mis à jour : ${SLUG} (id=${existing._id})`);
    } else {
      const created = await Product.create(productDoc);
      console.log(`Produit créé : ${SLUG} (id=${created._id})`);
    }

    console.log('Seed terminé.');
  } catch (err) {
    console.error('Erreur seed :', err.message || err);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
