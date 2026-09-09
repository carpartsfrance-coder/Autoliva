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
 *   — titre, description : `localizations.de` ; les fiches non traduites sont
 *     EXCLUES (Merchant refuserait une page française sous un flux allemand) ;
 *   — lien : /de/produits/<slug-de>-<id>, l'adresse canonique allemande ;
 *   — `g:shipping` pays DE avec le prix RÉEL de la zone Europe, calculé par le
 *     même code que le panier (priceForZone). Merchant compare le port du flux
 *     à celui du checkout : s'ils divergent, le flux est refusé. Les lire à la
 *     même source les rend cohérents par construction — y compris quand les
 *     trois classes sans prix Europe seront enfin renseignées.
 *
 * Tout ce qui ne dépend pas de la langue (état, marque, images, catégorie
 * Google) est repris du flux français, pas dupliqué.
 */

const mongoose = require('mongoose');
const Product = require('../models/Product');
const Category = require('../models/Category');
const ShippingClass = require('../models/ShippingClass');
const { buildSeoMediaUrl } = require('../services/mediaStorage');
const { priceForZone } = require('../services/shippingPricing');
const feedFr = require('./google-merchant-feed');

const BASE = 'https://autoliva.com';
const ZONE = 'europe';
const PAYS = 'DE';
const CACHE_TTL_MS = 3 * 60 * 60 * 1000;

const xmlEscape = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const stripHtml = (s) => String(s || '').replace(/<[^>]*>/g, ' ').replace(/\s{2,}/g, ' ').trim();

function normaliserCle(v) {
  return String(v || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

/* Classe d'expédition d'un produit : celle du produit, sinon celle de sa
   catégorie (nom complet, puis catégorie principale), sinon la classe par
   défaut. Même cascade que le panier. */
async function resoudreClasses() {
  const [classes, categories] = await Promise.all([
    ShippingClass.find({ isActive: { $ne: false } }).lean(),
    Category.find({}).select('name shippingClassId').lean(),
  ]);
  const parId = new Map(classes.map((c) => [String(c._id), c]));
  const defaut = classes.find((c) => c.isDefault) || null;
  const parCategorie = new Map();
  for (const c of categories) {
    const nom = String(c.name || '').trim();
    if (!nom || !c.shippingClassId) continue;
    const cls = parId.get(String(c.shippingClassId));
    if (!cls) continue;
    parCategorie.set(normaliserCle(nom), cls);
    const principale = normaliserCle(nom.split('>')[0]);
    if (!parCategorie.has(principale)) parCategorie.set(principale, cls);
  }
  return (produit) => {
    if (produit.shippingClassId && parId.has(String(produit.shippingClassId))) {
      return parId.get(String(produit.shippingClassId));
    }
    const cat = normaliserCle(produit.category);
    return parCategorie.get(cat) || parCategorie.get(cat.split('>')[0].trim()) || defaut;
  };
}

async function chargerProduits() {
  if (mongoose.connection.readyState !== 1) return [];
  const docs = await Product.find({
    isPublished: { $ne: false },
    'localizations.de.translatedAt': { $ne: null },
  })
    .select('_id slug sku priceCents inStock stockQty imageUrl galleryUrls galleryTypes category brand badges shippingClassId '
      + 'localizations.de.name localizations.de.description localizations.de.shortDescription localizations.de.slug '
      + 'localizations.de.badges.condition')
    .lean();
  const classeDe = await resoudreClasses();

  return docs.map((p) => {
    const de = (p.localizations && p.localizations.de) || {};
    const nom = String(de.name || '').trim();
    if (!nom) return null;
    const seoPath = (raw) => buildSeoMediaUrl(raw, nom) || raw;

    const images = [];
    if (typeof p.imageUrl === 'string' && p.imageUrl.trim()) images.push(seoPath(p.imageUrl.trim()));
    if (Array.isArray(p.galleryUrls)) {
      const types = Array.isArray(p.galleryTypes) ? p.galleryTypes : [];
      p.galleryUrls.forEach((u, i) => {
        if (typeof u === 'string' && u.trim() && (types[i] || 'image') === 'image') images.push(seoPath(u.trim()));
      });
    }
    if (!images.length) return null;

    const cls = classeDe(p);
    const portCents = cls ? priceForZone(cls, ZONE) : 1290;
    const stockQty = typeof p.stockQty === 'number' ? p.stockQty : null;
    const enStock = stockQty !== null ? stockQty > 0 : (p.inStock !== false);
    const etatFr = (p.badges && p.badges.condition) || '';

    return {
      id: String(p._id),
      title: nom.slice(0, 150),
      description: stripHtml(de.description || de.shortDescription || nom).slice(0, 5000),
      link: `${BASE}/de/produits/${encodeURIComponent(de.slug || p.slug || String(p._id))}-${p._id}`,
      images,
      price: `${(Number(p.priceCents) / 100).toFixed(2)} EUR`,
      availability: enStock ? 'in_stock' : 'out_of_stock',
      /* L'état vient du FRANÇAIS, pas de la traduction : c'est lui qui fait
         foi, et le flux français le classe déjà avec ses heuristiques. */
      condition: feedFr.classifyCondition({ slug: p.slug || '', title: etatFr + ' ' + (p.slug || ''), explicit: null }),
      brand: (typeof p.brand === 'string' && p.brand.trim()) || feedFr.inferBrand(nom) || 'Autoliva',
      mpn: (typeof p.sku === 'string' && p.sku) || String(p._id),
      product_type: typeof p.category === 'string' ? p.category : '',
      shippingPrice: `${(portCents / 100).toFixed(2)} EUR`,
    };
  }).filter(Boolean);
}

function urlImage(path) {
  if (!path) return null;
  if (path.startsWith('http')) return path;
  const p = path.startsWith('/') ? path : `/${path}`;
  return `${BASE}${p}${p.match(/\.(jpe?g|png|gif|webp)$/i) ? '' : '.jpeg'}`;
}

function construireXml(items) {
  const l = [];
  l.push('<?xml version="1.0" encoding="UTF-8"?>');
  l.push('<rss version="2.0" xmlns:g="http://base.google.com/ns/1.0">');
  l.push('  <channel>');
  l.push('    <title>Autoliva — Google Merchant Feed (Deutschland)</title>');
  l.push(`    <link>${BASE}/de</link>`);
  l.push('    <description>Generalüberholte, gebrauchte und geprüfte Autoteile</description>');
  l.push(`    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>`);
  for (const it of items) {
    l.push('    <item>');
    l.push(`      <g:id>${xmlEscape(it.id)}</g:id>`);
    l.push(`      <g:title>${xmlEscape(it.title)}</g:title>`);
    l.push(`      <g:description><![CDATA[${it.description.replace(/]]>/g, ']]]]><![CDATA[>')}]]></g:description>`);
    l.push(`      <g:link>${xmlEscape(it.link)}</g:link>`);
    l.push(`      <g:image_link>${xmlEscape(urlImage(it.images[0]))}</g:image_link>`);
    for (const im of it.images.slice(1, 11)) l.push(`      <g:additional_image_link>${xmlEscape(urlImage(im))}</g:additional_image_link>`);
    l.push(`      <g:price>${xmlEscape(it.price)}</g:price>`);
    l.push(`      <g:availability>${xmlEscape(it.availability)}</g:availability>`);
    l.push(`      <g:condition>${xmlEscape(it.condition)}</g:condition>`);
    l.push(`      <g:brand>${xmlEscape(it.brand)}</g:brand>`);
    l.push(`      <g:mpn>${xmlEscape(it.mpn)}</g:mpn>`);
    l.push('      <g:identifier_exists>no</g:identifier_exists>');
    l.push('      <g:google_product_category>888</g:google_product_category>');
    if (it.product_type) l.push(`      <g:product_type>${xmlEscape(it.product_type)}</g:product_type>`);
    l.push('      <g:shipping>');
    l.push(`        <g:country>${PAYS}</g:country>`);
    l.push(`        <g:price>${xmlEscape(it.shippingPrice)}</g:price>`);
    l.push('      </g:shipping>');
    l.push('    </item>');
  }
  l.push('  </channel>');
  l.push('</rss>');
  return l.join('\n');
}

let cache = { xml: null, builtAt: 0 };
let enCours = null;

/* Le cache mémoire ne doit pas survivre à un changement de tarif : Killian a
   posé trois prix Europe en base et le flux a continué de servir l'ancien
   port pendant des heures, jusqu'au prochain redémarrage — que Render n'a
   pas déclenché pour un commit vide. Merchant Center compare le port du flux
   au panier : servir un port périmé, c'est se faire refuser le flux. On lit
   donc la date de la dernière classe modifiée (7 documents, négligeable) et
   on reconstruit si elle est postérieure au cache. */
async function tarifsModifiesDepuis(instant) {
  try {
    const d = await ShippingClass.findOne({}).sort({ updatedAt: -1 }).select('updatedAt').lean();
    return Boolean(d && d.updatedAt && new Date(d.updatedAt).getTime() > instant);
  } catch (e) { return false; }
}

async function construireAvecCache() {
  if (cache.xml && Date.now() - cache.builtAt < CACHE_TTL_MS && !(await tarifsModifiesDepuis(cache.builtAt))) {
    return cache.xml;
  }
  if (enCours) return enCours;
  enCours = (async () => {
    const items = await chargerProduits();
    items.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const xml = construireXml(items);
    cache = { xml, builtAt: Date.now() };
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
    console.error('[google-merchant-feed-de] error:', err);
    res.status(500).set('Content-Type', 'text/plain').send('Feed generation failed');
  }
};

module.exports.chargerProduits = chargerProduits;
module.exports._invalidateCache = () => { cache = { xml: null, builtAt: 0 }; };
