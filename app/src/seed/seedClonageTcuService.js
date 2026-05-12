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
  compatibleReferences: [
    // DQ200 (DSG7 sec) — Golf 5/6/7/8 essence, Polo, A3, Octavia, Leon…
    '0AM 927 769', '0AM 927 769 D', '0AM 927 769 E', '0AM 927 769 F', '0AM 927 769 G',
    '0AM 927 769 H', '0AM 927 769 J', '0AM 927 769 K', '0AM 927 769 L', '0AM 927 769 M',
    '0AM 927 769 N', '0AM 927 769 P', '0AM 927 769 R', '0AM 927 769 S', '0AM 927 769 T',
    '0AM 325 025', '0AM 325 025 D', '0AM 325 025 E', '0AM 325 025 F', '0AM 325 025 G',
    '0AM 325 025 H', '0AM 325 025 J', '0AM 325 025 K', '0AM 325 025 L', '0AM 325 025 N',
    '0AM 325 025 P', '0AM 325 025 R', '0AM 325 025 S', '0AM 325 025 T',
    '0AM 325 065', '0AM 325 065 D', '0AM 325 065 E', '0AM 325 065 F', '0AM 325 065 G',
    '0AM 325 065 H', '0AM 325 065 J', '0AM 325 065 K', '0AM 325 065 L',
    '0AM 398 009 A', '0AM 398 009 B', '0AM 398 009 C', '0AM 398 009 D', '0AM 398 009 E', '0AM 398 009 F',
    '0CW 927 769', '0CW 927 769 A', '0CW 927 769 B', '0CW 927 769 C', '0CW 325 025', '0CW 398 009',
    // DQ250 (DSG6 humide) — Golf GTI/R, A3/S3, TT, Cupra, Octavia RS…
    '02E 927 770', '02E 927 770 D', '02E 927 770 E', '02E 927 770 G', '02E 927 770 H',
    '02E 927 770 J', '02E 927 770 K', '02E 927 770 L', '02E 927 770 M', '02E 927 770 N',
    '02E 927 770 P', '02E 927 770 R', '02E 927 770 S', '02E 927 770 T',
    '02E 927 770 AC', '02E 927 770 AD', '02E 927 770 AE', '02E 927 770 AF', '02E 927 770 AG',
    '02E 927 770 AH', '02E 927 770 AJ', '02E 927 770 AK', '02E 927 770 AL', '02E 927 770 AM',
    '02E 325 025', '02E 325 025 AD', '02E 325 025 AE', '02E 325 025 AF', '02E 325 025 AG',
    '02E 325 065', '02E 325 065 AD', '02E 325 065 AE', '02E 325 065 AF',
    '02E 398 009 A', '02E 398 009 B', '02E 398 009 C', '02E 398 009 D', '02E 398 009 E', '02E 398 009 F', '02E 398 029',
    // DQ381 (DSG7 humide nouvelle gen) — Golf 8 GTI/R, A3 8Y, Tiguan R, Octavia 4 RS…
    '0GC 927 770', '0GC 927 770 A', '0GC 927 770 B', '0GC 927 770 C', '0GC 927 770 D',
    '0GC 325 025', '0GC 325 025 A', '0GC 325 025 B',
    '0GC 300 014', '0GC 300 014 A', '0GC 300 014 B',
    // DQ500 (DSG7 humide forte cylindrée) — TT-RS, RS3, T5/T6/T6.1, Multivan, Tiguan R…
    '0BH 927 770', '0BH 927 770 A', '0BH 927 770 B', '0BH 927 770 C', '0BH 927 770 D',
    '0BH 927 770 E', '0BH 927 770 F', '0BH 927 770 G', '0BH 927 770 H', '0BH 927 770 J',
    '0BH 325 025', '0BH 325 025 A', '0BH 325 025 B', '0BH 325 025 C',
    '0BH 398 009 A', '0BH 398 009 B', '0BH 398 009 C', '0BH 398 009 D', '0BH 398 009 E', '0BH 398 009 F',
    '0BH 300 040', '0BH 300 040 A', '0BH 300 041',
    // DQ400e (DSG6 hybride rechargeable) — Golf GTE, Passat GTE, A3 e-tron, Superb iV…
    '0DD 927 769', '0DD 927 769 A', '0DD 927 769 B', '0DD 927 769 C', '0DD 927 769 D',
    '0DD 325 025', '0DD 325 025 A', '0DD 325 025 B',
    '0DD 398 009 A', '0DD 398 009 B', '0DD 398 009 C',
    // DL501 (S-tronic 7 longitudinal première gen) — A4/A5/A6/A7 B8/B9/8T/F5/C7/4G, Q5 8R, Q7 4M ancien, RS4/RS5/S4/S5…
    '0B5 927 156', '0B5 927 156 A', '0B5 927 156 B', '0B5 927 156 C', '0B5 927 156 D',
    '0B5 927 156 E', '0B5 927 156 F', '0B5 927 156 G', '0B5 927 156 H', '0B5 927 156 J',
    '0B5 927 156 K', '0B5 927 156 L', '0B5 927 156 M', '0B5 927 156 N', '0B5 927 156 P',
    '0B5 927 156 Q', '0B5 927 156 R', '0B5 927 156 S',
    '0B5 325 025', '0B5 325 025 A', '0B5 325 025 B', '0B5 325 025 C', '0B5 325 025 D',
    '0B5 325 031',
    '0B5 398 009 A', '0B5 398 009 B', '0B5 398 009 C', '0B5 398 009 D', '0B5 398 009 E',
    '0B5 398 009 F', '0B5 398 009 G', '0B5 398 048',
    // DL382 (S-tronic 7 longitudinal nouvelle gen) — A4/A5 B9 facelift, A6 C8, A7 4K, A8 4N, Q5 FY, Q7/Q8 récent…
    '0CJ 927 156', '0CJ 927 156 A', '0CJ 927 156 B', '0CJ 927 156 C', '0CJ 927 156 D',
    '0CJ 927 156 E', '0CJ 927 156 F',
    '0CJ 325 025', '0CJ 325 025 A', '0CJ 325 025 B', '0CJ 325 025 C',
    '0CJ 300 014', '0CJ 300 014 A', '0CJ 300 014 B',
    // DL800 (S-tronic supercar) — Audi R8 V10, Lamborghini Huracán
    '0BZ 927 156', '0BZ 927 156 A', '0BZ 927 156 B', '0BZ 398 009',
  ],
  searchSynonyms: [
    'clonage TCU', 'clonage mécatronique', 'clonage DSG', 'clonage S-tronic',
    'transfert TCU', 'transfert logiciel TCU', 'programmation TCU',
    'clonage DQ200', 'clonage DQ250', 'clonage DQ381', 'clonage DQ500',
    'clonage DQ400e', 'clonage DL501', 'clonage DL382', 'clonage DL800',
    'mécatronique 0AM 927 769', 'mécatronique 02E 927 770', 'mécatronique 0B5 927 156',
    'mécatronique 0BH 927 770', 'mécatronique 0GC 927 770', 'mécatronique 0CJ 927 156',
    'TCU 0AM', 'TCU 02E', 'TCU 0B5', 'TCU 0BH', 'TCU 0GC', 'TCU 0CJ', 'TCU 0DD',
    'mode dégradé DSG', 'réglage de base DSG impossible', 'voyant boîte automatique',
    'P17BF', 'P189C', 'P0741', 'code défaut DSG', 'code défaut S-tronic',
    'remplacement mécatronique', 'mécatronique d\'occasion', 'mécatronique reconditionnée',
    'clonage Golf GTI', 'clonage Audi A3', 'clonage A4 B8', 'clonage Q5',
    'clonage Tiguan', 'clonage Octavia RS', 'clonage TT', 'clonage RS3',
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
      label: 'Modèle de boîte',
      type: 'choice',
      required: true,
      placeholder: '',
      helpText: 'Sélectionnez le modèle de votre boîte. Si vous ne savez pas, choisissez « Autre / je ne sais pas » — nous identifierons via la référence de votre mécatronique.',
      priceDeltaCents: 0,
      choices: [
        { key: 'dq200', label: 'DSG7 DQ200 (7 vitesses, embrayage sec)', priceDeltaCents: 0, absolutePriceCents: null, triggersCloning: false },
        { key: 'dq250', label: 'DSG6 DQ250 (6 vitesses, embrayage humide)', priceDeltaCents: 0, absolutePriceCents: null, triggersCloning: false },
        { key: 'dq381', label: 'DSG7 DQ381 (7 vitesses, embrayage humide)', priceDeltaCents: 0, absolutePriceCents: null, triggersCloning: false },
        { key: 'dq500', label: 'DSG7 DQ500 (7 vitesses, forte cylindrée)', priceDeltaCents: 0, absolutePriceCents: null, triggersCloning: false },
        { key: 'dq400e', label: 'DSG6 DQ400e (hybride rechargeable)', priceDeltaCents: 0, absolutePriceCents: null, triggersCloning: false },
        { key: 'dl501', label: 'S-tronic DL501 (7 vitesses, longitudinal)', priceDeltaCents: 0, absolutePriceCents: null, triggersCloning: false },
        { key: 'dl382', label: 'S-tronic DL382 (7 vitesses, longitudinal nouvelle gen.)', priceDeltaCents: 0, absolutePriceCents: null, triggersCloning: false },
        { key: 'dl800', label: 'S-tronic DL800 (Audi R8 / Lamborghini)', priceDeltaCents: 0, absolutePriceCents: null, triggersCloning: false },
        { key: 'autre', label: 'Autre / je ne sais pas (on vous recontacte)', priceDeltaCents: 0, absolutePriceCents: null, triggersCloning: false },
      ],
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
    // ─── Volkswagen ───────────────────────────────────────────────────────
    { make: 'Volkswagen', model: 'Golf 5 (1K)', years: '2003-2008', engine: 'TSI/TDI/R32 — DQ200, DQ250' },
    { make: 'Volkswagen', model: 'Golf 6 (5K)', years: '2008-2012', engine: 'TSI/TDI/GTI/R/GTD — DQ200, DQ250' },
    { make: 'Volkswagen', model: 'Golf 7 (5G)', years: '2012-2020', engine: 'TSI/TDI/GTI/R/GTD/GTE — DQ200, DQ250, DQ400e' },
    { make: 'Volkswagen', model: 'Golf 8 (CD)', years: '2019+', engine: 'TSI/TDI/GTI/R/GTD/GTE — DQ200, DQ381, DQ400e' },
    { make: 'Volkswagen', model: 'Polo 5 (6R)', years: '2009-2017', engine: 'TSI/TDI — DQ200' },
    { make: 'Volkswagen', model: 'Polo 6 (AW)', years: '2017+', engine: 'TSI/GTI — DQ200' },
    { make: 'Volkswagen', model: 'Up GTI', years: '2017+', engine: '1.0 TSI — DQ200' },
    { make: 'Volkswagen', model: 'Jetta 6 (16)', years: '2010-2018', engine: 'TSI/TDI — DQ200, DQ250' },
    { make: 'Volkswagen', model: 'Beetle 2 (5C)', years: '2011-2019', engine: '2.0 TSI/TDI — DQ250' },
    { make: 'Volkswagen', model: 'Scirocco 3', years: '2008-2017', engine: 'GT/R 2.0 TSI/TDI — DQ250' },
    { make: 'Volkswagen', model: 'Eos', years: '2006-2015', engine: '2.0 TSI/TDI — DQ250' },
    { make: 'Volkswagen', model: 'Passat B6 (3C)', years: '2005-2010', engine: 'TSI/TDI — DQ200, DQ250' },
    { make: 'Volkswagen', model: 'Passat B7 (36) / CC', years: '2010-2015', engine: 'TSI/TDI — DQ200, DQ250' },
    { make: 'Volkswagen', model: 'Passat B8 (3G) / GTE', years: '2014-2023', engine: 'TSI/TDI/GTE — DQ200, DQ250, DQ381, DQ400e' },
    { make: 'Volkswagen', model: 'Passat B9', years: '2023+', engine: 'TSI/TDI — DQ381' },
    { make: 'Volkswagen', model: 'Arteon / Arteon R', years: '2017+', engine: 'TSI/TDI/R — DQ381, DQ500' },
    { make: 'Volkswagen', model: 'Tiguan 1 (5N)', years: '2007-2016', engine: 'TSI/TDI — DQ200, DQ250' },
    { make: 'Volkswagen', model: 'Tiguan 2 (AD) / R', years: '2016+', engine: 'TSI/TDI/R — DQ200, DQ381, DQ500' },
    { make: 'Volkswagen', model: 'Tiguan Allspace', years: '2017+', engine: 'TSI/TDI — DQ381, DQ500' },
    { make: 'Volkswagen', model: 'T-Roc / T-Roc R', years: '2017+', engine: 'TSI/TDI/R — DQ200, DQ381' },
    { make: 'Volkswagen', model: 'T-Cross', years: '2018+', engine: 'TSI — DQ200' },
    { make: 'Volkswagen', model: 'Touran 1 / 2', years: '2003+', engine: 'TSI/TDI — DQ200, DQ250' },
    { make: 'Volkswagen', model: 'Sharan 2 (7N)', years: '2010+', engine: 'TSI/TDI 4Motion — DQ250' },
    { make: 'Volkswagen', model: 'Caddy 3 / 4 / 5', years: '2004+', engine: 'TSI/TDI — DQ200' },
    { make: 'Volkswagen', model: 'Touareg 3 (CR)', years: '2018+', engine: 'TSI/TDI — DL501/DL382 (longitudinal)' },
    { make: 'Volkswagen', model: 'Transporter T5 / T6 / T6.1', years: '2009+', engine: '2.0 TSI/TDI — DQ500' },
    { make: 'Volkswagen', model: 'Multivan / Caravelle', years: '2009+', engine: '2.0 TSI/TDI — DQ500' },
    { make: 'Volkswagen', model: 'Crafter (SY/SZ)', years: '2017+', engine: '2.0 TDI — DQ500' },
    { make: 'Volkswagen', model: 'Amarok', years: '2010-2023', engine: '2.0 TDI — DQ500' },

    // ─── Audi ─────────────────────────────────────────────────────────────
    { make: 'Audi', model: 'A1 (8X / GB)', years: '2010+', engine: 'TFSI/TDI — DQ200' },
    { make: 'Audi', model: 'A3 8P / S3', years: '2003-2012', engine: 'TFSI/TDI/S3 — DQ200, DQ250' },
    { make: 'Audi', model: 'A3 8V / S3 / RS3 / e-tron', years: '2012-2020', engine: 'TFSI/TDI/S3/RS3/e-tron — DQ200, DQ250, DQ500, DQ400e' },
    { make: 'Audi', model: 'A3 8Y / S3 / RS3', years: '2020+', engine: 'TFSI/TDI/S3/RS3 — DQ200, DQ381, DQ500' },
    { make: 'Audi', model: 'TT 8J / TT-RS', years: '2006-2014', engine: 'TFSI/TDI/TT-RS — DQ250, DQ500' },
    { make: 'Audi', model: 'TT 8S / TT-RS', years: '2014-2023', engine: 'TFSI/TDI/TT-RS — DQ250, DQ500' },
    { make: 'Audi', model: 'Q2 (GA)', years: '2016+', engine: 'TFSI/TDI — DQ200' },
    { make: 'Audi', model: 'Q3 8U / RSQ3', years: '2011-2018', engine: 'TFSI/TDI/RSQ3 — DQ250, DQ500' },
    { make: 'Audi', model: 'Q3 F3 / RSQ3', years: '2018+', engine: 'TFSI/TDI/RSQ3 — DQ381, DQ500' },
    { make: 'Audi', model: 'A4 B8 (8K) / S4 / RS4', years: '2007-2015', engine: 'TFSI/TDI/S4/RS4 quattro — DL501' },
    { make: 'Audi', model: 'A4 B9 (8W) / S4 / Allroad', years: '2015-2024', engine: 'TFSI/TDI/S4 quattro — DL501, DL382' },
    { make: 'Audi', model: 'A5 8T / 8F / S5 / RS5', years: '2007-2016', engine: 'TFSI/TDI/S5/RS5 quattro — DL501' },
    { make: 'Audi', model: 'A5 F5 / S5 / RS5', years: '2016+', engine: 'TFSI/TDI/S5/RS5 quattro — DL501, DL382' },
    { make: 'Audi', model: 'A6 C7 (4G) / S6 / RS6 / Allroad', years: '2011-2018', engine: 'TFSI/TDI/S6/RS6 — DL501' },
    { make: 'Audi', model: 'A6 C8 (4K) / S6 / RS6 / Allroad', years: '2018+', engine: 'TFSI/TDI/S6/RS6 — DL382' },
    { make: 'Audi', model: 'A7 4G / S7 / RS7', years: '2010-2018', engine: 'TFSI/TDI/S7/RS7 — DL501' },
    { make: 'Audi', model: 'A7 4K / S7 / RS7', years: '2018+', engine: 'TFSI/TDI/S7/RS7 — DL382' },
    { make: 'Audi', model: 'A8 4H', years: '2010-2017', engine: 'TFSI/TDI quattro — DL501' },
    { make: 'Audi', model: 'A8 4N', years: '2017+', engine: 'TFSI/TDI/hybride — DL382' },
    { make: 'Audi', model: 'Q5 8R / SQ5', years: '2008-2017', engine: 'TFSI/TDI/SQ5 — DL501' },
    { make: 'Audi', model: 'Q5 FY / 80A / SQ5 / TFSI e', years: '2017+', engine: 'TFSI/TDI/SQ5/TFSI e — DL382' },
    { make: 'Audi', model: 'Q7 4M / SQ7', years: '2015+', engine: 'TFSI/TDI/SQ7 — DL382 (anciens DL501)' },
    { make: 'Audi', model: 'Q8 4M / SQ8 / RSQ8', years: '2018+', engine: 'TFSI/TDI/SQ8/RSQ8 — DL382' },
    { make: 'Audi', model: 'e-tron / Q8 e-tron', years: '2019+', engine: 'Électrique (variantes DL382)' },
    { make: 'Audi', model: 'R8 V10 (42 / 4S)', years: '2007+', engine: 'V10 5.2 FSI — DL800' },

    // ─── Skoda ────────────────────────────────────────────────────────────
    { make: 'Skoda', model: 'Octavia 2 (1Z) / RS', years: '2004-2013', engine: 'TSI/TDI/RS — DQ200, DQ250' },
    { make: 'Skoda', model: 'Octavia 3 (5E) / RS / Scout', years: '2013-2020', engine: 'TSI/TDI/RS/Scout — DQ200, DQ250, DQ381' },
    { make: 'Skoda', model: 'Octavia 4 (NX) / RS / iV', years: '2020+', engine: 'TSI/TDI/RS/iV — DQ200, DQ381, DQ400e' },
    { make: 'Skoda', model: 'Fabia 2 / 3 / 4 / RS', years: '2007+', engine: 'TSI/RS — DQ200' },
    { make: 'Skoda', model: 'Rapid', years: '2012-2019', engine: 'TSI/TDI — DQ200' },
    { make: 'Skoda', model: 'Scala', years: '2019+', engine: 'TSI — DQ200' },
    { make: 'Skoda', model: 'Kamiq', years: '2019+', engine: 'TSI — DQ200' },
    { make: 'Skoda', model: 'Karoq', years: '2017+', engine: 'TSI/TDI 4x4 — DQ200, DQ381' },
    { make: 'Skoda', model: 'Yeti', years: '2009-2017', engine: 'TSI/TDI 4x4 — DQ250' },
    { make: 'Skoda', model: 'Kodiaq / Kodiaq RS', years: '2016+', engine: 'TSI/TDI/RS 4x4 — DQ381, DQ500' },
    { make: 'Skoda', model: 'Superb 2 (3T)', years: '2008-2015', engine: 'TSI/TDI 4x4 — DQ200, DQ250' },
    { make: 'Skoda', model: 'Superb 3 (3V) / iV', years: '2015+', engine: 'TSI/TDI/iV — DQ200, DQ381, DQ400e' },

    // ─── Seat / Cupra ─────────────────────────────────────────────────────
    { make: 'Seat', model: 'Ibiza 4 / 5 / 6 / Cupra', years: '2008+', engine: 'TSI/TDI/Cupra — DQ200' },
    { make: 'Seat', model: 'Leon 2 (1P) / Cupra', years: '2005-2012', engine: 'TSI/TDI/Cupra — DQ200, DQ250' },
    { make: 'Seat', model: 'Leon 3 (5F) / Cupra / FR', years: '2012-2020', engine: 'TSI/TDI/Cupra/FR — DQ200, DQ250, DQ381' },
    { make: 'Seat', model: 'Leon 4 (KL) / e-Hybrid', years: '2020+', engine: 'TSI/TDI/e-Hybrid — DQ200, DQ381, DQ400e' },
    { make: 'Seat', model: 'Toledo', years: '2012-2019', engine: 'TSI/TDI — DQ200' },
    { make: 'Seat', model: 'Altea / Altea XL', years: '2004-2015', engine: 'TSI/TDI — DQ250' },
    { make: 'Seat', model: 'Alhambra 2 (71)', years: '2010-2020', engine: 'TSI/TDI 4Motion — DQ250' },
    { make: 'Seat', model: 'Ateca', years: '2016+', engine: 'TSI/TDI 4x4 — DQ200, DQ381' },
    { make: 'Seat', model: 'Arona', years: '2017+', engine: 'TSI — DQ200' },
    { make: 'Seat', model: 'Tarraco / e-Hybrid', years: '2018+', engine: 'TSI/TDI/e-Hybrid — DQ381, DQ400e' },
    { make: 'Cupra', model: 'Leon / e-Hybrid', years: '2020+', engine: 'TSI/e-Hybrid — DQ381, DQ400e' },
    { make: 'Cupra', model: 'Formentor / VZ / VZ5 / e-Hybrid', years: '2020+', engine: 'TSI/VZ/VZ5/e-Hybrid — DQ200, DQ381, DQ400e' },
    { make: 'Cupra', model: 'Ateca', years: '2018+', engine: '2.0 TSI 4Drive — DQ381' },

    // ─── Lamborghini (sur DL800) ──────────────────────────────────────────
    { make: 'Lamborghini', model: 'Huracán', years: '2014+', engine: 'V10 5.2 — DL800' },
  ],
  faqs: [
    {
      question: 'Qu\'est-ce que le clonage de mécatronique TCU ?',
      answer: 'Le clonage consiste à transférer le software (logiciel) de la TCU de votre ancienne mécatronique vers la nouvelle. Cela permet à la nouvelle mécatronique d\'être reconnue par le véhicule sans passage concession, et de conserver les adaptations existantes (point de patinage, calibrations).',
    },
    {
      question: 'Toutes les boîtes DSG et S-tronic sont compatibles ?',
      answer: 'Oui, intégralement : DQ200 (DSG7 sec), DQ250 (DSG6 humide), DQ381 (DSG7 humide), DQ500 (DSG7 forte cylindrée), DQ400e (DSG hybride), DL501 et DL382 (S-tronic longitudinales), DL800 (S-tronic supercar). Préfixes de référence connus : 0AM, 0CW, 02E, 0GC, 0BH, 0DD, 0B5, 0CJ, 0BZ. Si vous n\'êtes pas sûr du type de votre boîte, choisissez "Autre" lors de la commande et nous vous recontactons.',
    },
    {
      question: 'Où trouver la référence de ma mécatronique ?',
      answer: 'La référence est imprimée sur une étiquette autocollante directement collée sur le boîtier de la mécatronique (côté boîte de vitesses, parfois sous une protection plastique). Elle se présente sous la forme « 0XX YYY YYY Z » (ex : 0AM 927 769 D, 02E 927 770 AH, 0B5 927 156 K). C\'est cette ligne qu\'il faut nous communiquer. À défaut, nous identifions le type de boîte via le VIN.',
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
