'use strict';

/*
 * referenceLandingController.js
 *
 * Route GET /reference/:ref — landing page pour une référence OEM.
 * Capture les recherches Google par numéro de référence (mécanos pros qui
 * ont la référence exacte d'une pièce et la Googlent directement).
 *
 * Approche :
 *   - Trouve tous les produits où compatibleReferences inclut :ref (case-insensitive)
 *   - 404 si aucun produit (évite thin content)
 *   - Render un template minimal qui liste ces produits + JSON-LD
 */

const mongoose = require('mongoose');
const brand = require('../config/brand');
const Product = require('../models/Product');
const { buildProductPublicPath, getPublicBaseUrlFromReq } = require('../services/productPublic');
const { buildSeoMediaUrl } = require('../services/mediaStorage');

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function toJsonLdSafe(value) {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

/* Normalise une référence pour matching : trim + uppercase. */
function normalizeRef(raw) {
  return String(raw || '').trim().toUpperCase();
}

async function getReferenceLanding(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const rawRef = String(req.params.ref || '').trim();
    if (!rawRef || rawRef.length < 4 || rawRef.length > 50) {
      return res.status(404).render('errors/404', { title: `Page introuvable - ${brand.NAME}` });
    }
    /* La référence doit ressembler à une référence OEM (alphanumérique + tirets/points). */
    if (!/^[A-Za-z0-9._\-/]+$/.test(rawRef)) {
      return res.status(404).render('errors/404', { title: `Page introuvable - ${brand.NAME}` });
    }
    const refUpper = normalizeRef(rawRef);

    if (!dbConnected) {
      return res.status(404).render('errors/404', { title: `Page introuvable - ${brand.NAME}` });
    }

    /* Match insensible à la casse + ignore les espaces internes possibles
     * (certaines références ont des variations de format). */
    const products = await Product.find({
      isPublished: { $ne: false },
      compatibleReferences: {
        $elemMatch: { $regex: `^${escapeRegex(refUpper)}$`, $options: 'i' },
      },
    })
      .select('_id name slug priceCents inStock stockQty imageUrl galleryUrls compatibility category sku')
      .limit(50)
      .lean();

    if (!products || !products.length) {
      return res.status(404).render('errors/404', { title: `Page introuvable - ${brand.NAME}` });
    }

    const productsView = products.map((p) => {
      const rawImage = p.imageUrl
        || (Array.isArray(p.galleryUrls) && p.galleryUrls.find((u) => typeof u === 'string' && u.trim()))
        || '';
      return {
        ...p,
        publicPath: buildProductPublicPath(p),
        imageUrl: buildSeoMediaUrl(rawImage, p.name),
        inStock: Number.isFinite(p.stockQty) ? p.stockQty > 0 : (p.inStock !== false),
      };
    });

    const baseUrl = getPublicBaseUrlFromReq(req);
    const canonicalUrl = baseUrl ? `${baseUrl}/reference/${encodeURIComponent(rawRef)}` : `/reference/${encodeURIComponent(rawRef)}`;

    /* Compile les véhicules compatibles à partir des produits trouvés (utile
     * pour le contenu et les schemas). */
    const vehicleCompatSet = new Set();
    for (const p of products) {
      for (const c of (p.compatibility || [])) {
        const make = (c && c.make ? String(c.make).trim() : '');
        const model = (c && c.model ? String(c.model).trim() : '');
        if (make) vehicleCompatSet.add(model ? `${make} ${model}` : make);
      }
    }
    const vehicleCompat = Array.from(vehicleCompatSet).slice(0, 12);

    const title = `Référence ${refUpper} - Pièce auto reconditionnée | ${brand.NAME}`;
    const compatStr = vehicleCompat.length ? ` Compatible ${vehicleCompat.slice(0, 3).join(', ')}.` : '';
    const metaDescription = `Pièce auto référence ${refUpper} reconditionnée et garantie 2 ans.${compatStr} Livraison 24-48h. Paiement 3x/4x sans frais.`;

    /* JSON-LD : ItemList des produits avec cette référence */
    const itemListElements = productsView.map((p, idx) => ({
      '@type': 'ListItem',
      position: idx + 1,
      name: p.name,
      url: baseUrl ? `${baseUrl}${p.publicPath}` : p.publicPath,
    }));

    const jsonLd = toJsonLdSafe({
      '@context': 'https://schema.org',
      '@graph': [
        {
          '@type': 'CollectionPage',
          name: title,
          url: canonicalUrl,
          description: metaDescription,
          mainEntity: {
            '@type': 'ItemList',
            numberOfItems: productsView.length,
            itemListElement: itemListElements,
          },
        },
        {
          '@type': 'BreadcrumbList',
          itemListElement: [
            { '@type': 'ListItem', position: 1, name: 'Accueil', item: baseUrl ? `${baseUrl}/` : '/' },
            { '@type': 'ListItem', position: 2, name: 'Recherche par référence', item: canonicalUrl },
          ],
        },
      ],
    });

    return res.render('vehicle/reference', {
      title,
      metaDescription,
      canonicalUrl,
      ogTitle: title,
      ogDescription: metaDescription,
      ogUrl: canonicalUrl,
      ogType: 'website',
      ogSiteName: brand.NAME,
      jsonLd,
      reference: refUpper,
      products: productsView,
      vehicleCompat,
      dbConnected,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { getReferenceLanding };
