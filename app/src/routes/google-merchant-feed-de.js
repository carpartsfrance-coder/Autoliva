'use strict';

/* Flux Google Merchant ALLEMAND — /google-merchant-feed-de.xml
 *
 * ── Pourquoi un second flux ─────────────────────────────────────────────────
 *
 * Google Shopping Allemagne n'affichait rien : un seul flux, en français, sans
 * pays de livraison. Pour des pièces auto, c'est le canal que les Allemands
 * utilisent — ils tapent une référence, pas un mot-clé. Et Merchant Center
 * exige que la langue du flux soit celle de la page d'atterrissage : tant que
 * le site n'était pas allemand, ce flux était impossible. Il ne l'est plus.
 *
 * ── Ce qui diffère du flux français ────────────────────────────────────────
 *
 *   — titre : `localizations.de.name` ; les fiches non traduites sont EXCLUES
 *     (Merchant refuserait une page française sous un flux allemand) ;
 *   — description : la fiche allemande ne sert jamais la description (motif
 *     « langue » de claimFilter : traductions automatiques non relues) ; le
 *     flux publie donc la description courte allemande — que la fiche sert en
 *     meta description —, filtrée comme la fiche, sinon une description
 *     factuelle ;
 *   — lien : /de/produits/<slug-de>-<id>, l'adresse canonique allemande ;
 *   — `g:shipping` pays DE au prix RÉEL de la zone Europe, calculé par le même
 *     code que le panier (shippingPricing.chargerTarifsPort) : Merchant compare
 *     le port du flux à celui du checkout ; transport 2 à 4 jours ouvrés ;
 *   — la consigne encaissée n'exclut pas : la fiche allemande l'annonce près
 *     du prix (« zzgl. … Pfand »).
 *
 * Tout le reste — exclusions, état, marque, identifiants, catégorie Google,
 * délais de préparation — vient des règles communes (services/fluxMerchant.js)
 * appliquées à la fiche FRANÇAISE, qui fait foi.
 */

const mongoose = require('mongoose');
const Product = require('../models/Product');
const { normalizeProduct } = require('../controllers/productController');
const claimFilter = require('../services/claimFilter');
const scalapay = require('../services/scalapay');
const { t } = require('../services/i18n');
const { chargerTarifsPort, dernierChangementTarifs, PORT_DE_REPLI_CENTS } = require('../services/shippingPricing');
const flux = require('../services/fluxMerchant');

const ZONE = 'europe';
const PAYS = 'DE';
const CACHE_TTL_MS = 3 * 60 * 60 * 1000;

const CHAMPS = [
  '_id', 'name', 'slug', 'sku', 'description', 'shortDescription', 'priceCents', 'inStock', 'stockQty',
  'imageUrl', 'galleryUrls', 'galleryTypes', 'category', 'brand', 'badges', 'specs', 'serviceType', 'consigne',
  'shippingDelayText', 'shippingClassId', 'warranty', 'compatibility', 'compatibleReferences', 'engineCode',
  'localizations.de.name', 'localizations.de.description', 'localizations.de.shortDescription',
  'localizations.de.slug', 'localizations.de.shippingDelayText', 'localizations.de.translatedAt',
].join(' ');

/** Fiches publiées ET traduites. Base déconnectée : BASE_INDISPONIBLE (503). */
async function chargerProduits() {
  if (mongoose.connection.readyState !== 1) throw flux.baseIndisponible();
  return Product.find({
    isPublished: { $ne: false },
    'localizations.de.translatedAt': { $ne: null },
  })
    .select(CHAMPS)
    .lean();
}

/** Usage des images sur TOUTES les fiches publiées, traduites ou non : une
 *  photo générique l'est aussi en allemand. */
async function chargerUsagesImages() {
  if (mongoose.connection.readyState !== 1) return new Map();
  const docs = await Product.find({ isPublished: { $ne: false } }).select('imageUrl galleryUrls galleryTypes').lean();
  return flux.compterUsagesImages(docs);
}

async function chargerTarifs() {
  if (mongoose.connection.readyState !== 1) return null;
  return chargerTarifsPort();
}

function article({ fiche, de, images, titre, ctx }, { tarifs }) {
  const id = String(fiche._id);
  const etat = flux.etatDuProduit(fiche);
  const marque = flux.marqueGoogle(fiche);
  const mpn = flux.mpnFiable(fiche, marque);
  const liens = flux.imagesPourFlux(images, String(de.name || '').trim());
  const classe = tarifs ? tarifs.classeRetenue(fiche, ZONE) : null;
  const portCents = tarifs ? tarifs.portDomicileCents(fiche, ZONE) : PORT_DE_REPLI_CENTS;
  const preparation = flux.delaisPreparation(fiche, { classe, textes: [fiche.shippingDelayText, de.shippingDelayText] });
  const transport = flux.delaisTransport(fiche, { classe, pays: PAYS });
  return {
    id,
    title: titre,
    /* Textes ALLEMANDS uniquement : localizeProduct retomberait sur le
       français quand la traduction d'un champ manque. */
    description: flux.descriptionDuFlux({
      fiche,
      description: claimFilter.filtrer(String(de.description || ''), ctx),
      courte: claimFilter.filtrer(String(de.shortDescription || ''), ctx),
      lang: 'de',
      titre,
      etat,
    }),
    link: `${flux.BASE}/de/produits/${encodeURIComponent(de.slug || fiche.slug || id)}-${id}`,
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
      service: t('de', 'shipping.homeTitle'),
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

/** Fiches traduites (lean) → articles + bilan. `usagesImages` : sur toutes
 *  les fiches publiées. */
function construireArticles(docs, { tarifs = null, usagesImages = new Map(), scalapayActif = false } = {}) {
  const bilan = flux.nouveauBilan();
  const candidats = [];
  for (const doc of Array.isArray(docs) ? docs : []) {
    const de = (doc.localizations && doc.localizations.de) || {};
    const nomDe = String(de.name || '').trim();
    if (!nomDe) continue; // pas de titre allemand : la fiche n'est pas traduite
    bilan.fiches += 1;
    const images = flux.imagesDeLaFiche(doc);
    const fiche = normalizeProduct(doc);
    const motifs = flux.motifsSansTexte(fiche, {
      images,
      usagesImages,
      textesDelai: [fiche.shippingDelayText, de.shippingDelayText],
      exclureConsigneEncaissee: false,
    });
    if (motifs.length) {
      bilan.exclus[motifs[0]] += 1;
      continue;
    }
    const ctx = claimFilter.contexteFiche(fiche, { scalapayActif });
    /* L'état se lit sur la fiche FRANÇAISE, qui fait foi (badge, titre,
       description) ; le titre testé est celui que l'Allemand lira. */
    const affichee = {
      ...fiche,
      description: claimFilter.filtrer(fiche.description, ctx),
      shortDescription: claimFilter.filtrer(fiche.shortDescription, ctx),
    };
    const titre = flux.titreDuFlux(nomDe, ctx);
    const motifsTextes = flux.motifsDesTextes(affichee, { titre });
    if (motifsTextes.length) {
      bilan.exclus[motifsTextes[0]] += 1;
      continue;
    }
    candidats.push({ fiche: affichee, de, images, titre, ctx });
  }
  const items = flux.exclureTitresDupliques(candidats, bilan).map((c) => article(c, { tarifs }));
  items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  bilan.articles = items.length;
  return { items, bilan };
}

function construireXml(items) {
  const l = [];
  l.push('<?xml version="1.0" encoding="UTF-8"?>');
  l.push('<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">');
  l.push('  <channel>');
  l.push('    <title>Autoliva — Google Merchant Feed (Deutschland)</title>');
  l.push(`    <link>${flux.BASE}/de</link>`);
  l.push('    <description>Generalüberholte, gebrauchte und geprüfte Autoteile</description>');
  l.push(`    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>`);
  for (const it of items) l.push(...flux.articleXml(it));
  l.push('  </channel>');
  l.push('</rss>');
  return l.join('\n');
}

let cache = { xml: null, builtAt: 0 };
let enCours = null;
let dernierBilan = null;

/* Le cache mémoire ne doit pas survivre à un changement de tarif : Killian a
   posé trois prix Europe en base et le flux a continué de servir l'ancien
   port pendant des heures, jusqu'au prochain redémarrage — que Render n'a
   pas déclenché pour un commit vide. Merchant Center compare le port du flux
   au panier : servir un port périmé, c'est se faire refuser le flux. On lit
   donc la date de la dernière classe ou catégorie modifiée (quelques dizaines
   de documents, négligeable) et on reconstruit si elle est postérieure au
   cache. */
async function tarifsModifiesDepuis(instant) {
  if (mongoose.connection.readyState !== 1) return false;
  try {
    return (await dernierChangementTarifs()) > instant;
  } catch (e) {
    return false;
  }
}

async function construireAvecCache() {
  if (cache.xml && Date.now() - cache.builtAt < CACHE_TTL_MS && !(await tarifsModifiesDepuis(cache.builtAt))) {
    return cache.xml;
  }
  if (enCours) return enCours;
  enCours = (async () => {
    const docs = await module.exports.chargerProduits();
    const [usagesImages, tarifs] = await Promise.all([chargerUsagesImages(), chargerTarifs()]);
    const { items, bilan } = construireArticles(docs, { tarifs, usagesImages, scalapayActif: scalapay.estActif() });
    module.exports.journaliser(flux.resumerBilan('google-merchant-feed-de', bilan));
    const xml = construireXml(items);
    cache = { xml, builtAt: Date.now() };
    dernierBilan = bilan;
    return xml;
  })();
  try { return await enCours; } finally { enCours = null; }
}

module.exports = async function googleMerchantFeedDe(req, res) {
  try {
    const xml = await construireAvecCache();
    res.removeHeader('Set-Cookie');
    res.set({ 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
    res.send(xml);
  } catch (err) {
    res.removeHeader('Set-Cookie');
    if (err && err.code === flux.CODE_BASE_INDISPONIBLE) {
      res.status(503).set({ 'Retry-After': '120', 'Content-Type': 'text/plain; charset=utf-8' }).send('Datenbank nicht verfügbar, später erneut versuchen');
      return;
    }
    console.error('[google-merchant-feed-de] error:', err);
    res.status(500).set('Content-Type', 'text/plain').send('Feed generation failed');
  }
};

module.exports.chargerProduits = chargerProduits;
module.exports.construireArticles = construireArticles;
module.exports.construireXml = construireXml;
module.exports.construireAvecCache = construireAvecCache;
module.exports.journaliser = (ligne) => console.log(ligne); // eslint-disable-line no-console
module.exports.dernierBilan = () => dernierBilan;
module.exports._invalidateCache = () => { cache = { xml: null, builtAt: 0 }; };
