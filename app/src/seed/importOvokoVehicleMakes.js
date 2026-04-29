require('dotenv').config();

const https = require('https');
const zlib = require('zlib');
const mongoose = require('mongoose');

const VehicleMake = require('../models/VehicleMake');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function decodeHtmlEntities(value) {
  if (typeof value !== 'string') return '';
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#(\d+);/g, (m, n) => {
      const code = Number(n);
      if (!Number.isFinite(code)) return m;
      return String.fromCharCode(code);
    })
    .trim();
}

function normalizeVehicleName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  return {
    name,
    nameLower: name ? name.toLowerCase() : '',
  };
}

function modelNameFromSlug(slug) {
  const raw = typeof slug === 'string' ? slug.trim() : '';
  if (!raw) return '';

  const parts = raw
    .split('-')
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => {
      const hasDigit = /\d/.test(p);
      if (hasDigit) return p.toUpperCase();
      if (p.length === 1) return p.toUpperCase();
      return p.charAt(0).toUpperCase() + p.slice(1);
    });

  return parts.join(' ').trim();
}

function getHtml(url) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'fr-FR,fr;q=0.9,en-US;q=0.8,en;q=0.7',
          'Accept-Encoding': 'gzip, deflate, br',
          'Upgrade-Insecure-Requests': '1',
          Referer: 'https://ovoko.fr/',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'same-origin',
          'Sec-Fetch-User': '?1',
          'Sec-CH-UA': '"Chromium";v="120", "Google Chrome";v="120", ";Not A Brand";v="99"',
          'Sec-CH-UA-Mobile': '?0',
          'Sec-CH-UA-Platform': '"macOS"',
        },
      },
      (res) => {
        const status = res.statusCode || 0;
        if (status >= 300 && status < 400 && res.headers.location) {
          const nextUrl = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, url).toString();
          res.resume();
          return resolve(getHtml(nextUrl));
        }

        if (status !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${status} for ${url}`));
        }

        const chunks = [];
        res.on('data', (chunk) => {
          chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });
        res.on('end', () => {
          try {
            const buf = Buffer.concat(chunks);
            const encoding = String(res.headers['content-encoding'] || '').toLowerCase().trim();

            let out = buf;
            if (encoding === 'gzip') out = zlib.gunzipSync(buf);
            else if (encoding === 'deflate') out = zlib.inflateSync(buf);
            else if (encoding === 'br') out = zlib.brotliDecompressSync(buf);

            resolve(out.toString('utf8'));
          } catch (e) {
            reject(e);
          }
        });
      }
    );

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error(`Timeout for ${url}`));
    });
  });
}

function extractMakes(html) {
  const makes = new Map();
  const rx = /<a\b[^>]*\bhref=['"]\/liste-de-voitures\/([^'"\/?#]+)['"][^>]*>([^<]+)<\/a>/gi;
  let match;
  while ((match = rx.exec(html)) !== null) {
    const slug = (match[1] || '').trim();
    const name = decodeHtmlEntities(match[2] || '');
    if (!slug || !name) continue;
    if (slug === 'liste-de-voitures') continue;

    const normalized = normalizeVehicleName(name);
    if (!normalized.nameLower) continue;

    if (!makes.has(slug)) {
      makes.set(slug, normalized.name);
    }
  }

  return Array.from(makes.entries()).map(([slug, name]) => ({ slug, name }));
}

function extractModels(html, makeSlug, makeName) {
  const models = new Map();

  const escaped = String(makeSlug).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const rxAbs = new RegExp(
    `<a\\b[^>]*\\bhref=['\"]https?:\\/\\/ovoko\\.fr\\/liste-de-voitures\\/${escaped}\\/([^'\"\\/?#]+)['\"][^>]*>([^<]+)<\\/a>`,
    'gi'
  );
  const rxRel = new RegExp(
    `<a\\b[^>]*\\bhref=['\"]\\/liste-de-voitures\\/${escaped}\\/([^'\"\\/?#]+)['\"][^>]*>([^<]+)<\\/a>`,
    'gi'
  );

  const addFromRx = (rx) => {
    let match;
    while ((match = rx.exec(html)) !== null) {
      const slug = (match[1] || '').trim();

      if (!slug) continue;
      if (slug === 'tous') continue;

      const labelFromSlug = modelNameFromSlug(slug);
      if (!labelFromSlug) continue;

      const normalized = normalizeVehicleName(labelFromSlug);
      if (!normalized.nameLower) continue;

      if (!models.has(normalized.nameLower)) {
        models.set(normalized.nameLower, normalized.name);
      }
    }
  };

  addFromRx(rxAbs);
  addFromRx(rxRel);

  return Array.from(models.values()).sort((a, b) => String(a).localeCompare(String(b), 'fr'));
}

async function upsertMakeAndModels(makeName, modelNames, apply) {
  const normalized = normalizeVehicleName(makeName);
  if (!normalized.nameLower) return { created: false, updated: false, addedModels: 0 };

  const make = apply
    ? await VehicleMake.findOneAndUpdate(
        { nameLower: normalized.nameLower },
        { $set: { name: normalized.name, nameLower: normalized.nameLower }, $setOnInsert: { models: [] } },
        { upsert: true, new: true }
      )
    : await VehicleMake.findOne({ nameLower: normalized.nameLower }).lean();

  const existingModels = make && make.models && Array.isArray(make.models)
    ? make.models
        .map((m) => (m && m.nameLower ? String(m.nameLower) : ''))
        .filter(Boolean)
    : [];
  const existingSet = new Set(existingModels);

  let added = 0;
  const toAdd = [];
  for (const modelName of modelNames) {
    const mn = normalizeVehicleName(modelName);
    if (!mn.nameLower) continue;
    if (existingSet.has(mn.nameLower)) continue;
    existingSet.add(mn.nameLower);
    toAdd.push({ name: mn.name, nameLower: mn.nameLower });
    added += 1;
  }

  if (!apply) return { created: !make, updated: false, addedModels: added };

  if (toAdd.length > 0) {
    const doc = await VehicleMake.findOne({ nameLower: normalized.nameLower });
    if (doc) {
      doc.models = Array.isArray(doc.models) ? doc.models : [];
      doc.models.push(...toAdd);
      await doc.save();
    }
  }

  return { created: !make, updated: toAdd.length > 0, addedModels: added };
}

async function run() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('MONGODB_URI manquant');
    process.exitCode = 1;
    return;
  }

  const args = process.argv.slice(2);
  const apply = args.includes('--apply');

  const makeLimitArg = args.find((a) => a.startsWith('--limitMakes='));
  const makeLimit = makeLimitArg ? Number(makeLimitArg.split('=')[1]) : null;

  const delayArg = args.find((a) => a.startsWith('--delayMs='));
  const delayMs = delayArg ? Math.max(0, Number(delayArg.split('=')[1])) : 700;

  console.log(apply ? 'MODE: IMPORT (écrit en base)' : 'MODE: DRY-RUN (ne modifie pas la base)');

  await mongoose.connect(mongoUri);

  let totalModels = 0;

  try {
    const makesHtml = await getHtml('https://ovoko.fr/liste-de-voitures');
    let makes = extractMakes(makesHtml);

    if (makeLimit && Number.isFinite(makeLimit) && makeLimit > 0) {
      makes = makes.slice(0, Math.floor(makeLimit));
    }

    console.log(`Marques trouvées: ${makes.length}`);

    for (let i = 0; i < makes.length; i += 1) {
      const mk = makes[i];

      const makeUrl = `https://ovoko.fr/liste-de-voitures/${encodeURIComponent(mk.slug)}`;
      console.log(`[${i + 1}/${makes.length}] ${mk.name} -> ${makeUrl}`);

      try {
        const html = await getHtml(makeUrl);
        const modelNames = extractModels(html, mk.slug, mk.name);
        totalModels += modelNames.length;

        const res = await upsertMakeAndModels(mk.name, modelNames, apply);
        console.log(`  modèles: ${modelNames.length} | ajoutés: ${res.addedModels}`);
      } catch (err) {
        console.warn(`  ERREUR: ${err.message}`);
      }

      if (delayMs) await sleep(delayMs);
    }

    console.log(`Terminé. Total modèles trouvés (brut): ${totalModels}`);
    if (!apply) {
      console.log('Pour importer réellement, relance avec: --apply');
    }
  } finally {
    await mongoose.disconnect();
  }
}

run().catch((err) => {
  console.error('Erreur import ovoko:', err);
  process.exitCode = 1;
});
