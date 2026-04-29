const fs = require('fs');
const path = require('path');

function usage() {
  console.log(
    'Usage: node src/seed/mergeOvokoMakeModelUrls.js --mapInput=/path/to/map.json --output=src/seed/ovoko-make-model-urls.json [--makeFilter=renault]'
  );
}

function readJsonMaybe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function asUrlsArray(data) {
  if (!data) return [];
  if (Array.isArray(data)) return data;
  if (Array.isArray(data.urls)) return data.urls;
  return [];
}

function asMakesArray(data) {
  if (!data || typeof data !== 'object') return [];
  if (Array.isArray(data.makes)) return data.makes;
  return [];
}

function extractMakeFromUrl(url) {
  if (typeof url !== 'string') return '';
  const m = url.match(/^https:\/\/ovoko\.fr\/liste-de-voitures\/([^\/?#]+)$/i);
  return m && m[1] ? String(m[1]).trim() : '';
}

function extractMakeModelFromUrl(url, makeFilter) {
  if (typeof url !== 'string') return null;

  // On accepte aussi les URLs plus longues: on prend seulement les 2 premiers segments après /liste-de-voitures/
  const m = url.match(/^https:\/\/ovoko\.fr\/liste-de-voitures\/([^\/?#]+)\/([^\/?#]+)/i);
  if (!m) return null;

  const makeSlug = String(m[1] || '').trim();
  const modelSlug = String(m[2] || '').trim();

  if (!makeSlug || !modelSlug) return null;

  if (makeFilter && makeSlug.toLowerCase() !== String(makeFilter).toLowerCase()) return null;

  const modLower = modelSlug.toLowerCase();
  if (modLower === 'tous' || modLower === 'null') return null;

  return { makeSlug, modelSlug };
}

function extractModelSlugsFromHtml(html, makeSlug) {
  if (typeof html !== 'string' || !html.trim()) return [];
  if (!makeSlug) return [];

  const slug = String(makeSlug).trim();
  if (!slug) return [];

  const re = new RegExp(`/liste-de-voitures/${slug}/([^/'\"?#]+)`, 'gi');
  const set = new Set();
  let m;
  while ((m = re.exec(html))) {
    const modelSlug = String(m[1] || '').trim();
    if (!modelSlug) continue;
    const lower = modelSlug.toLowerCase();
    if (lower === 'tous' || lower === 'null') continue;
    set.add(modelSlug);
  }

  return Array.from(set);
}

function run() {
  const args = process.argv.slice(2);
  const mapArg = args.find((a) => a.startsWith('--mapInput='));
  const outArg = args.find((a) => a.startsWith('--output='));
  const makeFilterArg = args.find((a) => a.startsWith('--makeFilter='));
  const makeSlugArg = args.find((a) => a.startsWith('--makeSlug='));

  const mapInput = mapArg ? mapArg.split('=')[1] : null;
  const output = outArg ? outArg.split('=')[1] : 'src/seed/ovoko-make-model-urls.json';
  const makeFilter = makeFilterArg ? makeFilterArg.split('=')[1] : '';
  const makeSlug = makeSlugArg ? makeSlugArg.split('=')[1] : '';

  if (!mapInput) {
    usage();
    process.exitCode = 1;
    return;
  }

  const mapResolved = path.isAbsolute(mapInput) ? mapInput : path.resolve(process.cwd(), mapInput);
  const outResolved = path.isAbsolute(output) ? output : path.resolve(process.cwd(), output);

  const existing = readJsonMaybe(outResolved);
  const existingUrls = asUrlsArray(existing);
  const urlSet = new Set(existingUrls);

  const existingMakes = asMakesArray(existing);
  const makeSet = new Set(existingMakes.map((m) => String(m).trim()).filter(Boolean));
  if (makeSet.size === 0) {
    for (const u of existingUrls) {
      const pair = extractMakeModelFromUrl(String(u));
      if (pair && pair.makeSlug) makeSet.add(pair.makeSlug);
    }
  }

  const mapData = readJsonMaybe(mapResolved);
  const mapUrls = asUrlsArray(mapData);
  const mapHtml = mapData && typeof mapData.html_content === 'string' ? mapData.html_content : '';

  let added = 0;
  if (mapUrls.length > 0) {
    for (const u of mapUrls) {
      const makeOnly = extractMakeFromUrl(String(u));
      if (makeOnly) {
        if (!makeFilter || makeOnly.toLowerCase() === String(makeFilter).toLowerCase()) makeSet.add(makeOnly);
      }

      const pair = extractMakeModelFromUrl(String(u), makeFilter);
      if (!pair) continue;

      if (pair.makeSlug) makeSet.add(pair.makeSlug);

      const canonical = `https://ovoko.fr/liste-de-voitures/${pair.makeSlug}/${pair.modelSlug}`;
      if (urlSet.has(canonical)) continue;
      urlSet.add(canonical);
      added += 1;
    }
  } else if (mapHtml) {
    const effectiveMake = makeFilter || makeSlug;
    const models = extractModelSlugsFromHtml(mapHtml, effectiveMake);
    if (effectiveMake) makeSet.add(effectiveMake);
    for (const modelSlug of models) {
      const canonical = `https://ovoko.fr/liste-de-voitures/${effectiveMake}/${modelSlug}`;
      if (urlSet.has(canonical)) continue;
      urlSet.add(canonical);
      added += 1;
    }
  }

  const out = {
    generatedAt: new Date().toISOString(),
    sources: Array.isArray(existing && existing.sources) ? existing.sources : [],
    makesCount: makeSet.size,
    makes: Array.from(makeSet).sort((a, b) => String(a).localeCompare(String(b), 'fr')),
    urlsCount: urlSet.size,
    urls: Array.from(urlSet).sort((a, b) => String(a).localeCompare(String(b), 'fr')),
  };

  out.sources.push({
    addedAt: new Date().toISOString(),
    mapInput: mapResolved,
    mapUrlsCount: mapUrls.length,
    mapHtmlSize: mapHtml ? mapHtml.length : 0,
    makeFilter: makeFilter || undefined,
    makeSlug: makeSlug || undefined,
    addedUrls: added,
  });

  fs.writeFileSync(outResolved, JSON.stringify(out, null, 2), 'utf8');
  console.log(`OK: +${added} URLs ajoutées. Total maintenant: ${out.urlsCount}. Sortie: ${outResolved}`);
}

try {
  run();
} catch (e) {
  console.error('Erreur merge:', e);
  process.exitCode = 1;
}
