'use strict';

/**
 * GET /google-merchant-feed.xml — flux Google Merchant FRANÇAIS (RSS 2.0).
 *
 * N'y entrent que les fiches publiées exactes et conformes aux règles
 * Merchant ; les règles vivent dans services/fluxMerchant.js (partagées avec
 * le flux allemand) :
 *   - exclues, avec un motif compté et journalisé à chaque construction :
 *     copies distrimotor (DM-), service de clonage, image générique (partagée
 *     par plus de 3 fiches publiées), titre générique ou porté par une autre
 *     fiche, état impossible à établir ou contredit, consigne encaissée à la
 *     commande (la fiche française ne l'affiche pas encore près du prix), hors
 *     stock, délai « sur commande / sur demande / selon disponibilité /
 *     confirmé à la commande » ;
 *   - titre et description passés par les filtres de la fiche (ancien nom,
 *     allégations non prouvées) ; description jamais servie pour les familles
 *     dont la fiche la masque ;
 *   - `g:shipping` France métropolitaine au prix exact du panier (même code :
 *     shippingPricing.chargerTarifsPort), délais de préparation et de
 *     transport des CGV art. 7.2 ;
 *   - marque normalisée, jamais « Autoliva » ; MPN seulement s'il est fiable,
 *     sinon identifier_exists=no ; catégorie Google par type de pièce.
 *
 * Base déconnectée : 503 + Retry-After, jamais un flux vide — Merchant
 * retirerait tous les articles d'un coup.
 */

const mongoose = require('mongoose');
const Product = require('../models/Product');
const { normalizeProduct } = require('../controllers/productController');
const claimFilter = require('../services/claimFilter');
const scalapay = require('../services/scalapay');
const { t } = require('../services/i18n');
const { buildProductPublicPath } = require('../services/productPublic');
const { chargerTarifsPort, dernierChangementTarifs, PORT_DE_REPLI_CENTS } = require('../services/shippingPricing');
const flux = require('../services/fluxMerchant');

const PAYS = 'FR';
const ZONE = 'metropole';

/* Champs lus : ceux que la fiche affiche et que les règles consultent. */
const CHAMPS = [
  '_id', 'name', 'slug', 'sku', 'description', 'shortDescription', 'priceCents', 'inStock', 'stockQty',
  'imageUrl', 'galleryUrls', 'galleryTypes', 'category', 'brand', 'badges', 'specs', 'serviceType', 'consigne',
  'shippingDelayText', 'shippingClassId', 'warranty', 'compatibility', 'compatibleReferences', 'engineCode',
].join(' ');

/**
 * Fiches publiées, telles qu'en base (lean). Base déconnectée : erreur
 * BASE_INDISPONIBLE (la route répond 503), jamais un tableau vide.
 */
async function loadProducts() {
  if (mongoose.connection.readyState !== 1) throw flux.baseIndisponible();
  return Product.find({ isPublished: { $ne: false } }).select(CHAMPS).lean();
}

/** Tarifs d'expédition du panier, chargés une fois ; null sans base. */
async function chargerTarifs() {
  if (mongoose.connection.readyState !== 1) return null;
  return chargerTarifsPort();
}

function article({ fiche, images, titre }, { tarifs }) {
  const etat = flux.etatDuProduit(fiche);
  const marque = flux.marqueGoogle(fiche);
  const mpn = flux.mpnFiable(fiche, marque);
  const liens = flux.imagesPourFlux(images, fiche.name);
  const classe = tarifs ? tarifs.classeRetenue(fiche, ZONE) : null;
  const portCents = tarifs ? tarifs.portDomicileCents(fiche, ZONE) : PORT_DE_REPLI_CENTS;
  const preparation = flux.delaisPreparation(fiche, { classe, textes: [fiche.shippingDelayText] });
  const transport = flux.delaisTransport(fiche, { classe, pays: PAYS });
  return {
    id: String(fiche._id),
    title: titre,
    description: flux.descriptionDuFlux({
      fiche, description: fiche.description, courte: fiche.shortDescription, lang: 'fr', titre, etat,
    }),
    link: `${flux.BASE}${buildProductPublicPath(fiche)}`,
    image_link: liens[0],
    additional_image_link: liens.slice(1),
    availability: 'in_stock',
    price: flux.prixXml(fiche.priceCents),
    condition: etat,
    brand: marque,
    mpn,
    identifier_exists: mpn ? null : 'no',
    google_product_category: flux.categorieGoogle(fiche),
    product_type: typeof fiche.category === 'string' ? fiche.category.trim() : '',
    shipping: {
      country: PAYS,
      service: t('fr', 'shipping.homeTitle'),
      price: flux.prixXml(portCents),
      min_handling_time: preparation.min,
      max_handling_time: preparation.max,
      min_transit_time: transport.min,
      max_transit_time: transport.max,
    },
    min_handling_time: preparation.min,
    max_handling_time: preparation.max,
  };
}

/**
 * Fiches publiées (lean) → articles du flux + bilan des exclusions.
 * Les règles sans texte d'abord ; le filtre des allégations ne tourne que sur
 * les fiches qui restent.
 */
function construireArticles(docs, { tarifs = null, scalapayActif = false } = {}) {
  const liste = Array.isArray(docs) ? docs : [];
  const bilan = flux.nouveauBilan();
  bilan.fiches = liste.length;
  /* Une fois par construction : combien de fiches publiées partagent chaque image. */
  const usagesImages = flux.compterUsagesImages(liste);
  const candidats = [];

  for (const doc of liste) {
    const images = flux.imagesDeLaFiche(doc);
    const fiche = normalizeProduct(doc);
    const motifs = flux.motifsSansTexte(fiche, {
      images, usagesImages, textesDelai: [fiche.shippingDelayText], exclureConsigneEncaissee: true,
    });
    if (motifs.length) {
      bilan.exclus[motifs[0]] += 1;
      continue;
    }
    /* Les textes tels que la fiche les affiche (productController.getProduct). */
    const ctx = claimFilter.contexteFiche(fiche, { scalapayActif });
    const affichee = {
      ...fiche,
      description: claimFilter.filtrer(fiche.description, ctx),
      shortDescription: claimFilter.filtrer(fiche.shortDescription, ctx),
    };
    const titre = flux.titreDuFlux(fiche.name, ctx);
    const motifsTextes = flux.motifsDesTextes(affichee, { titre });
    if (motifsTextes.length) {
      bilan.exclus[motifsTextes[0]] += 1;
      continue;
    }
    candidats.push({ fiche: affichee, images, titre });
  }

  const items = flux.exclureTitresDupliques(candidats, bilan).map((c) => article(c, { tarifs }));
  /* Tri stable par id pour des diffs propres. */
  items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  bilan.articles = items.length;
  return { items, bilan };
}

function buildFeedXml(items) {
  const lines = [];
  lines.push('<?xml version="1.0" encoding="UTF-8"?>');
  lines.push('<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">');
  lines.push('  <channel>');
  lines.push('    <title>Autoliva — Google Merchant Feed</title>');
  lines.push(`    <link>${flux.BASE}</link>`);
  lines.push('    <description>Pièces auto reconditionnées, occasion et neuves</description>');
  lines.push(`    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>`);
  for (const it of items) lines.push(...flux.articleXml(it));
  lines.push('  </channel>');
  lines.push('</rss>');
  return lines.join('\n');
}

/* Cache mémoire process.
 *
 * Mesuré en production (08/2026) : 10 s et 28 Mo par reconstruction, les
 * 14 464 fiches chargées avec leur description. Deux problèmes :
 *   1. le cache d'une heure expirait ~24 fois par jour, chaque expiration
 *      valant une reconstruction pendant laquelle tout le site ralentissait ;
 *   2. aucun verrou : deux demandes pendant une reconstruction lançaient DEUX
 *      reconstructions (58 Mo en mémoire, deux fois le travail).
 * Google Merchant relit le flux selon SON calendrier (typiquement quelques fois
 * par jour), pas selon notre cache : 3 h ne changent rien pour lui. Le stock
 * du site n'est de toute façon pas le stock réel (sourcing à la commande).
 * Le port, lui, doit suivre le panier : un tarif modifié (classe ou catégorie)
 * après la construction la relance, comme pour le flux allemand. */
let cache = { xml: null, builtAt: 0 };
const CACHE_TTL_MS = 3 * 60 * 60 * 1000;
let constructionEnCours = null;
let dernierBilan = null;

async function tarifsModifiesDepuis(instant) {
  if (mongoose.connection.readyState !== 1) return false;
  try {
    return (await dernierChangementTarifs()) > instant;
  } catch (err) {
    return false;
  }
}

async function buildFeedCached() {
  if (cache.xml && Date.now() - cache.builtAt < CACHE_TTL_MS && !(await module.exports._tarifsModifiesDepuis(cache.builtAt))) {
    return cache.xml;
  }
  /* Verrou anti-ruée : les demandes concurrentes partagent UNE construction. */
  if (constructionEnCours) return constructionEnCours;
  constructionEnCours = (async () => {
    const products = await module.exports.loadProducts();
    const tarifs = await module.exports.chargerTarifs();
    const { items, bilan } = construireArticles(products, { tarifs, scalapayActif: scalapay.estActif() });
    /* Une ligne par construction : combien gardés, combien exclus et pourquoi. */
    module.exports.journaliser(flux.resumerBilan('google-merchant-feed', bilan));
    const xml = buildFeedXml(items);
    cache = { xml, builtAt: Date.now() };
    dernierBilan = bilan;
    return xml;
  })();
  try {
    return await constructionEnCours;
  } finally {
    constructionEnCours = null;
  }
}

module.exports = async function googleMerchantFeed(req, res) {
  try {
    const xml = await buildFeedCached();
    /* Le middleware express-session pose un Set-Cookie sur toutes les réponses
       (rolling: true) ; on nettoie pour ne pas casser le cache CDN ni le crawl
       Merchant. Inoffensif si la route est montée avant session — défensif. */
    res.removeHeader('Set-Cookie');
    res.set({
      'Content-Type': 'application/xml; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    });
    res.send(xml);
  } catch (err) {
    res.removeHeader('Set-Cookie');
    if (err && err.code === flux.CODE_BASE_INDISPONIBLE) {
      res.status(503).set({ 'Retry-After': '120', 'Content-Type': 'text/plain; charset=utf-8' }).send('Base indisponible, réessayer plus tard');
      return;
    }
    // eslint-disable-next-line no-console
    console.error('[google-merchant-feed] error:', err);
    res.status(500).set('Content-Type', 'text/plain').send('Feed generation failed');
  }
};

// Export interne pour tests / régénération forcée
module.exports.loadProducts = loadProducts;
module.exports.chargerTarifs = chargerTarifs;
module.exports.construireArticles = construireArticles;
module.exports.buildFeedXml = buildFeedXml;
module.exports.buildFeedCached = buildFeedCached;
module.exports.journaliser = (ligne) => console.log(ligne); // eslint-disable-line no-console
module.exports.dernierBilan = () => dernierBilan;
module.exports._tarifsModifiesDepuis = tarifsModifiesDepuis;
module.exports._invalidateCache = function invalidateCache() {
  cache = { xml: null, builtAt: 0 };
};
