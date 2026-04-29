require('dotenv').config();

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');

const Product = require('../models/Product');
const Category = require('../models/Category');

function parseArgs(argv) {
  const out = {};
  for (const raw of argv) {
    if (!raw || typeof raw !== 'string') continue;
    if (raw === '--apply') {
      out.apply = true;
      continue;
    }
    if (raw.startsWith('--input=')) {
      out.input = raw.slice('--input='.length);
      continue;
    }
    if (raw.startsWith('--limit=')) {
      const n = Number(raw.slice('--limit='.length));
      if (Number.isFinite(n) && n > 0) out.limit = Math.floor(n);
      continue;
    }
    if (raw.startsWith('--variations=')) {
      out.variations = raw.slice('--variations='.length);
      continue;
    }
    if (raw === '--includeHidden') {
      out.includeHidden = true;
      continue;
    }
    if (raw === '--includeUnpublished') {
      out.includeUnpublished = true;
      continue;
    }
  }
  return out;
}

function normalizeHeaderKey(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/^\uFEFF/, '')
    .replace(/\u00A0/g, ' ')
    .replace(/[’]/g, "'")
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

function parseCsv(content) {
  const rows = [];

  let row = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < content.length; i += 1) {
    const ch = content[i];

    if (inQuotes) {
      if (ch === '"') {
        const next = content[i + 1];
        if (next === '"') {
          field += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      inQuotes = true;
      continue;
    }

    if (ch === ',') {
      row.push(field);
      field = '';
      continue;
    }

    if (ch === '\n') {
      row.push(field);
      field = '';
      rows.push(row);
      row = [];
      continue;
    }

    if (ch === '\r') {
      continue;
    }

    field += ch;
  }

  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }

  return rows;
}

function decodeHtmlEntities(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (m, n) => {
      const code = Number(n);
      if (!Number.isFinite(code)) return m;
      return String.fromCharCode(code);
    });
}

function htmlToText(value) {
  if (typeof value !== 'string') return '';

  const normalized = value
    .replace(/\r\n/g, '\n')
    .replace(/\r/g, '\n')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/p\s*>/gi, '\n')
    .replace(/<\s*p\b[^>]*>/gi, '')
    .replace(/<\s*\/div\s*>/gi, '\n')
    .replace(/<\s*div\b[^>]*>/gi, '')
    .replace(/<\s*li\b[^>]*>/gi, '- ')
    .replace(/<\s*\/li\s*>/gi, '\n')
    .replace(/<\s*\/ul\s*>/gi, '\n')
    .replace(/<\s*ul\b[^>]*>/gi, '')
    .replace(/<\s*\/h\d\s*>/gi, '\n')
    .replace(/<\s*h\d\b[^>]*>/gi, '')
    .replace(/<[^>]+>/g, '');

  const decoded = decodeHtmlEntities(normalized);

  return decoded
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}

function parseNumberFromLooseString(value) {
  if (typeof value !== 'string') return null;

  const cleaned = value
    .replace(/[\s\u00A0]/g, '')
    .replace(/[^\d,.-]/g, '');

  if (!cleaned) return null;

  const hasComma = cleaned.includes(',');
  const hasDot = cleaned.includes('.');

  let normalized = cleaned;

  if (hasComma && hasDot) {
    if (cleaned.lastIndexOf(',') > cleaned.lastIndexOf('.')) {
      normalized = cleaned.replace(/\./g, '').replace(',', '.');
    } else {
      normalized = cleaned.replace(/,/g, '');
    }
  } else if (hasComma) {
    normalized = cleaned.replace(',', '.');
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function parseWooPriceCents(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    if (value >= 50000) return Math.round(value);
    return Math.round(value * 100);
  }

  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  const parsed = parseNumberFromLooseString(trimmed);
  if (parsed === null) return null;

  if (parsed >= 50000) return Math.round(parsed);
  return Math.round(parsed * 100);
}

function parseIntOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.floor(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const parsed = Number.parseInt(trimmed, 10);
  if (!Number.isFinite(parsed)) return null;
  return parsed;
}

function parseBool(value) {
  if (value === true) return true;
  if (value === false) return false;
  if (typeof value === 'number') return value === 1;
  if (typeof value !== 'string') return false;
  const v = value.trim().toLowerCase();
  return v === '1' || v === 'true' || v === 'yes' || v === 'oui' || v === 'on';
}

function splitCommaList(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((p) => p.trim())
    .filter(Boolean);
}

function extractLeafCategory(rawCategories) {
  const list = splitCommaList(rawCategories);
  if (list.length === 0) return '';

  const first = list[0];
  const parts = first.split('>').map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : first.trim();
}

function slugify(input) {
  const value = typeof input === 'string' ? input : '';
  const normalized = value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim();

  const slug = normalized
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');

  return slug || 'categorie';
}

function buildAttributeSpecs(row, headerIndex) {
  const specs = [];

  for (let i = 1; i <= 20; i += 1) {
    const nameKey = `Nom de l’attribut ${i}`;
    const valueKey = `Valeur(s) de l’attribut ${i}`;

    const label = String(getRowValue(row, headerIndex, nameKey) || '').trim();
    const raw = String(getRowValue(row, headerIndex, valueKey) || '').trim();

    if (!label || !raw) continue;

    specs.push({ label, value: raw });
  }

  return specs;
}

function getRowValue(row, headerIndex, name) {
  const idx = headerIndex.get(normalizeHeaderKey(name));
  if (idx === undefined) return '';
  return row[idx] ?? '';
}

function getWooIdFromParentField(value) {
  if (typeof value !== 'string') return null;
  const m = value.match(/id\s*:\s*(\d+)/i);
  if (!m) return null;
  return m[1];
}

function uniqueStrings(list) {
  const out = [];
  const seen = new Set();
  for (const v of list) {
    const s = typeof v === 'string' ? v.trim() : '';
    if (!s) continue;
    if (seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

function buildProductDocFromWooRow(row, headerIndex, opts) {
  const wooId = String(getRowValue(row, headerIndex, 'ID') || '').trim();

  const name = String(getRowValue(row, headerIndex, 'Nom') || '').trim();
  if (!name) return null;

  const skuRaw = String(getRowValue(row, headerIndex, 'UGS') || '').trim();
  const sku = skuRaw || (wooId ? `WC-${wooId}` : '');
  const slug = sku ? slugify(sku) : '';

  const brand = String(getRowValue(row, headerIndex, 'Marques') || '').trim();

  const shortDescription = htmlToText(getRowValue(row, headerIndex, 'Description courte'));
  const description = htmlToText(getRowValue(row, headerIndex, 'Description'));

  const rawCategory = extractLeafCategory(getRowValue(row, headerIndex, 'Catégories'));
  const category = rawCategory || (opts && opts.forVariation ? '' : 'Autre');

  const images = splitCommaList(getRowValue(row, headerIndex, 'Images'))
    .map((u) => u.replace(/^\s+/, '').trim())
    .filter(Boolean);

  const galleryUrls = uniqueStrings(images);
  const imageUrl = galleryUrls[0] || '';

  const regularPriceCents = parseWooPriceCents(getRowValue(row, headerIndex, 'Tarif régulier'));
  const salePriceCents = parseWooPriceCents(getRowValue(row, headerIndex, 'Tarif promo'));

  const priceCents = Number.isFinite(salePriceCents) ? salePriceCents : regularPriceCents;
  const compareAtPriceCents =
    Number.isFinite(regularPriceCents) && Number.isFinite(salePriceCents) && regularPriceCents > salePriceCents
      ? regularPriceCents
      : null;

  if (!Number.isFinite(priceCents) || priceCents === null) return null;

  const enStock = parseBool(getRowValue(row, headerIndex, 'En stock ?'));
  const stockQty = parseIntOrNull(getRowValue(row, headerIndex, 'Stock'));

  const allowBackorders = parseBool(
    getRowValue(row, headerIndex, 'Autoriser les commandes de produits en rupture ?')
  );

  const resolvedStockQty = Number.isFinite(stockQty) && stockQty !== null ? Math.max(0, stockQty) : null;
  const inStock =
    resolvedStockQty !== null
      ? resolvedStockQty > 0
      : enStock || allowBackorders;

  const specs = [];

  const gtin = String(getRowValue(row, headerIndex, 'GTIN, UPC, EAN ou ISBN') || '').trim();
  if (gtin) specs.push({ label: 'GTIN', value: gtin });

  const weightKg = String(getRowValue(row, headerIndex, 'Poids (kg)') || '').trim();
  if (weightKg) specs.push({ label: 'Poids', value: `${weightKg} kg` });

  const lengthCm = String(getRowValue(row, headerIndex, 'Longueur (cm)') || '').trim();
  const widthCm = String(getRowValue(row, headerIndex, 'Largeur (cm)') || '').trim();
  const heightCm = String(getRowValue(row, headerIndex, 'Hauteur (cm)') || '').trim();
  const dims = [lengthCm && `${lengthCm} cm`, widthCm && `${widthCm} cm`, heightCm && `${heightCm} cm`]
    .filter(Boolean)
    .join(' x ');
  if (dims) specs.push({ label: 'Dimensions', value: dims });

  specs.push(...buildAttributeSpecs(row, headerIndex));

  const finalSpecs = uniqueStrings(
    specs
      .filter((s) => s && s.label && s.value)
      .map((s) => `${String(s.label).trim()}::${String(s.value).trim()}`)
  ).map((packed) => {
    const [label, value] = packed.split('::');
    return { label, value };
  });

  return {
    name,
    category,
    brand,
    sku,
    slug,
    priceCents,
    compareAtPriceCents,
    inStock,
    stockQty: resolvedStockQty,
    imageUrl,
    galleryUrls,
    shortDescription,
    description,
    specs: finalSpecs,
    badges: {
      topLeft: 'GARANTIE',
      condition: '',
    },
  };
}

async function upsertCategory(name, apply) {
  const clean = typeof name === 'string' ? name.trim() : '';
  if (!clean) return;

  const slug = slugify(clean);

  if (!apply) return;

  await Category.findOneAndUpdate(
    { slug },
    { $set: { name: clean, slug, isActive: true } },
    { upsert: true, new: true }
  );
}

async function run() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI manquant');
    process.exitCode = 1;
    return;
  }

  const args = parseArgs(process.argv.slice(2));
  const apply = !!args.apply;

  const variationsModeRaw = typeof args.variations === 'string' ? args.variations.trim().toLowerCase() : '';
  const variationsMode = variationsModeRaw || 'separate';

  const input = args.input ? String(args.input) : '';

  if (!input) {
    console.error('Paramètre manquant: --input=/chemin/vers/export.csv');
    process.exitCode = 1;
    return;
  }

  const resolvedInput = path.isAbsolute(input) ? input : path.resolve(process.cwd(), input);

  if (!fs.existsSync(resolvedInput)) {
    console.error(`Fichier introuvable: ${resolvedInput}`);
    process.exitCode = 1;
    return;
  }

  console.log(apply ? 'MODE: IMPORT (écrit en base)' : 'MODE: DRY-RUN (ne modifie pas la base)');
  console.log(`CSV: ${resolvedInput}`);
  console.log(`VARIATIONS: ${variationsMode}`);

  const content = fs.readFileSync(resolvedInput, 'utf8');
  const table = parseCsv(content);

  if (!Array.isArray(table) || table.length < 2) {
    console.error('CSV vide ou illisible');
    process.exitCode = 1;
    return;
  }

  const header = table[0];
  const headerIndex = new Map();
  header.forEach((h, idx) => {
    const key = normalizeHeaderKey(String(h ?? ''));
    if (!key) return;
    if (!headerIndex.has(key)) headerIndex.set(key, idx);
  });

  const rows = table.slice(1);

  await mongoose.connect(mongoUri);

  let scanned = 0;
  let skipped = 0;
  let createdOrUpdated = 0;
  let categoriesTouched = 0;

  try {
    const parentsById = new Map();
    const variations = [];
    const variationsByParentId = new Map();

    for (const r of rows) {
      const type = String(getRowValue(r, headerIndex, 'Type') || '').trim().toLowerCase();
      const id = String(getRowValue(r, headerIndex, 'ID') || '').trim();

      if (!id) continue;

      if (type === 'variation') {
        variations.push(r);
      } else {
        parentsById.set(id, r);
      }
    }

    for (const vr of variations) {
      const parentRaw = String(getRowValue(vr, headerIndex, 'Parent') || '');
      const parentId = getWooIdFromParentField(parentRaw);
      if (!parentId) continue;
      if (!variationsByParentId.has(parentId)) variationsByParentId.set(parentId, []);
      variationsByParentId.get(parentId).push(vr);
    }

    const productDocs = [];

    for (const r of rows) {
      if (args.limit && scanned >= args.limit) break;

      const type = String(getRowValue(r, headerIndex, 'Type') || '').trim().toLowerCase();
      const published = parseBool(getRowValue(r, headerIndex, 'Publié'));
      const visibility = String(getRowValue(r, headerIndex, 'Visibilité dans le catalogue') || '')
        .trim()
        .toLowerCase();

      if (!args.includeUnpublished && !published) {
        continue;
      }

      if (!args.includeHidden) {
        if (visibility === 'hidden' || visibility === 'caché' || visibility === 'cache') {
          continue;
        }
      }

      if (type === 'variation') {
        continue;
      }

      scanned += 1;

      if (type === 'variable') {
        if (variationsMode === 'skip') {
          const doc = buildProductDocFromWooRow(r, headerIndex, args);
          if (!doc) {
            skipped += 1;
            continue;
          }
          productDocs.push(doc);
          continue;
        }

        const parentId = String(getRowValue(r, headerIndex, 'ID') || '').trim();
        const childVariations = variationsByParentId.get(parentId) || [];

        if (childVariations.length === 0 || variationsMode === 'parent') {
          const doc = buildProductDocFromWooRow(r, headerIndex, args);
          if (!doc) {
            skipped += 1;
            continue;
          }
          productDocs.push(doc);
          continue;
        }

        if (variationsMode !== 'separate') {
          const doc = buildProductDocFromWooRow(r, headerIndex, args);
          if (!doc) {
            skipped += 1;
            continue;
          }
          productDocs.push(doc);
          continue;
        }

        const parentDoc = buildProductDocFromWooRow(r, headerIndex, args) || {};

        for (const vr of childVariations) {
          const variationDoc = buildProductDocFromWooRow(vr, headerIndex, { ...args, forVariation: true });

          const variationWooId = String(getRowValue(vr, headerIndex, 'ID') || '').trim();
          const parentSkuBase = parentDoc.sku || (parentId ? `WC-${parentId}` : '');
          const resolvedSku =
            variationDoc && variationDoc.sku
              ? variationDoc.sku
              : variationWooId
                ? `${parentSkuBase}-VAR-${variationWooId}`
                : `${parentSkuBase}-VAR`;

          const baseName = parentDoc.name || String(getRowValue(r, headerIndex, 'Nom') || '').trim();
          const attrSpecs = buildAttributeSpecs(vr, headerIndex);
          const suffix = attrSpecs
            .filter((s) => s && s.label && s.value)
            .map((s) => `${String(s.label).trim()}: ${String(s.value).trim()}`)
            .join(' • ');

          const mergedName = suffix ? `${baseName} — ${suffix}` : baseName;

          if (!variationDoc && !parentDoc.priceCents) {
            skipped += 1;
            continue;
          }

          const merged = {
            ...parentDoc,
            ...variationDoc,
            name: mergedName,
            sku: resolvedSku,
            slug: resolvedSku ? slugify(resolvedSku) : (variationDoc && variationDoc.slug ? variationDoc.slug : ''),
            imageUrl: (parentDoc && parentDoc.imageUrl) || (variationDoc && variationDoc.imageUrl) || '',
            galleryUrls: uniqueStrings([
              ...(parentDoc && Array.isArray(parentDoc.galleryUrls) ? parentDoc.galleryUrls : []),
              ...(variationDoc && Array.isArray(variationDoc.galleryUrls) ? variationDoc.galleryUrls : []),
            ]),
            specs: uniqueStrings([
              ...(parentDoc && Array.isArray(parentDoc.specs) ? parentDoc.specs : []).map((s) => `${s.label}::${s.value}`),
              ...attrSpecs.map((s) => `${s.label}::${s.value}`),
              ...(variationDoc && Array.isArray(variationDoc.specs) ? variationDoc.specs : []).map((s) => `${s.label}::${s.value}`),
            ]).map((packed) => {
              const [label, value] = packed.split('::');
              return { label, value };
            }),
          };

          if (!merged.priceCents || !Number.isFinite(merged.priceCents)) {
            skipped += 1;
            continue;
          }

          if (!merged.category) {
            merged.category = parentDoc.category || 'Autre';
          }

          productDocs.push(merged);
        }

        continue;
      }

      const doc = buildProductDocFromWooRow(r, headerIndex, args);
      if (!doc) {
        skipped += 1;
        continue;
      }
      productDocs.push(doc);
    }

    const categories = uniqueStrings(productDocs.map((d) => d.category)).filter(Boolean);

    for (const c of categories) {
      categoriesTouched += 1;
      await upsertCategory(c, apply);
    }

    for (const doc of productDocs) {
      if (!doc || !doc.sku) {
        skipped += 1;
        continue;
      }

      if (!apply) {
        createdOrUpdated += 1;
        continue;
      }

      await Product.findOneAndUpdate(
        { sku: doc.sku },
        { $set: doc },
        { upsert: true, new: true }
      );

      createdOrUpdated += 1;
    }

    console.log('---');
    console.log(`Produits analysés (hors variations): ${scanned}`);
    console.log(`Produits prêts: ${createdOrUpdated}`);
    console.log(`Produits ignorés: ${skipped}`);
    console.log(`Catégories: ${categoriesTouched}`);

    if (!apply) {
      console.log('---');
      console.log('Pour importer réellement, relance avec: --apply');
      console.log('Exemple:');
      console.log('  node src/seed/importWooProductsFromCsv.js --apply --input=/chemin/vers/export.csv');
    }
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('Erreur import WooCommerce:', err);
  process.exitCode = 1;
});
