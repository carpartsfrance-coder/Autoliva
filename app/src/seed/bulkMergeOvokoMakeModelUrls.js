const fs = require('fs');
const path = require('path');

function usage() {
  console.log(
    'Usage: node src/seed/bulkMergeOvokoMakeModelUrls.js --output=src/seed/ovoko-make-model-urls.json (--input=/path/a.json --input=/path/b.json | --inputs=/path/a.json,/path/b.json) [--makeFilter=renault,peugeot]'
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

function normalizeMakeSlug(value) {
  const s = typeof value === 'string' ? value.trim().toLowerCase() : '';
  return s;
}

function extractMakeFromUrl(url) {
  if (typeof url !== 'string') return '';
  const m = url.match(/^https:\/\/ovoko\.fr\/liste-de-voitures\/([^\/?#]+)$/i);
  return m && m[1] ? String(m[1]).trim() : '';
}

function parseMakeModelFromUrl(url) {
  if (typeof url !== 'string') return null;
  const m = url.match(/^https:\/\/ovoko\.fr\/liste-de-voitures\/([^\/?#]+)\/([^\/?#]+)/i);
  if (!m) return null;

  const makeSlug = String(m[1] || '').trim();
  const modelSlug = String(m[2] || '').trim();
  if (!makeSlug || !modelSlug) return null;

  const modLower = modelSlug.toLowerCase();
  if (modLower === 'tous' || modLower === 'null') return null;

  return { makeSlug, modelSlug };
}

function extractMakeModelPairsFromHtml(html) {
  if (typeof html !== 'string' || !html.trim()) return [];

  const re = /\/liste-de-voitures\/([^/'\"?#]+)\/([^/'\"?#]+)/gi;
  const set = new Set();
  const pairs = [];

  let m;
  while ((m = re.exec(html))) {
    const makeSlug = String(m[1] || '').trim();
    const modelSlug = String(m[2] || '').trim();
    if (!makeSlug || !modelSlug) continue;

    const modLower = modelSlug.toLowerCase();
    if (modLower === 'tous' || modLower === 'null') continue;

    const key = `${makeSlug.toLowerCase()}|${modelSlug.toLowerCase()}`;
    if (set.has(key)) continue;
    set.add(key);
    pairs.push({ makeSlug, modelSlug });
  }

  return pairs;
}

function extractMakesFromHtml(html) {
  if (typeof html !== 'string' || !html.trim()) return [];

  const re = /\/liste-de-voitures\/([^/'\"?#]+)\b/gi;
  const set = new Set();
  let m;
  while ((m = re.exec(html))) {
    const makeSlug = String(m[1] || '').trim();
    if (!makeSlug) continue;
    if (makeSlug.toLowerCase() === 'tous') continue;
    set.add(makeSlug);
  }

  return Array.from(set);
}

function splitCsv(value) {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((v) => v.trim())
    .filter(Boolean);
}

function run() {
  const args = process.argv.slice(2);
  const outArg = args.find((a) => a.startsWith('--output='));
  const inputsArg = args.find((a) => a.startsWith('--inputs='));
  const inputArgs = args.filter((a) => a.startsWith('--input='));
  const makeFilterArg = args.find((a) => a.startsWith('--makeFilter='));

  const output = outArg ? outArg.split('=')[1] : '';
  const makeFilterCsv = makeFilterArg ? makeFilterArg.split('=')[1] : '';

  const inputs = [];
  if (inputsArg) inputs.push(...splitCsv(inputsArg.split('=')[1]));
  for (const a of inputArgs) inputs.push(a.split('=')[1]);

  if (!output || inputs.length === 0) {
    usage();
    process.exitCode = 1;
    return;
  }

  const makeFilterList = splitCsv(makeFilterCsv).map(normalizeMakeSlug);
  const makeFilterSet = new Set(makeFilterList);
  const hasMakeFilter = makeFilterSet.size > 0;

  const outResolved = path.isAbsolute(output) ? output : path.resolve(process.cwd(), output);

  const existing = readJsonMaybe(outResolved);
  const existingUrls = asUrlsArray(existing);
  const urlSet = new Set(existingUrls);

  const existingMakes = asMakesArray(existing);
  const makeSet = new Set(existingMakes.map((m) => String(m).trim()).filter(Boolean));
  if (makeSet.size === 0) {
    for (const u of existingUrls) {
      const pair = parseMakeModelFromUrl(String(u));
      if (pair && pair.makeSlug) makeSet.add(pair.makeSlug);
    }
  }

  const sources = Array.isArray(existing && existing.sources) ? existing.sources : [];

  let totalAdded = 0;

  for (const inputFile of inputs) {
    const inputResolved = path.isAbsolute(inputFile)
      ? inputFile
      : path.resolve(process.cwd(), inputFile);

    const mapData = readJsonMaybe(inputResolved);
    const mapUrls = asUrlsArray(mapData);
    const mapHtml = mapData && typeof mapData.html_content === 'string' ? mapData.html_content : '';

    let added = 0;

    if (mapUrls.length > 0) {
      for (const u of mapUrls) {
        const makeOnly = extractMakeFromUrl(String(u));
        if (makeOnly) {
          if (!hasMakeFilter || makeFilterSet.has(normalizeMakeSlug(makeOnly))) makeSet.add(makeOnly);
        }

        const pair = parseMakeModelFromUrl(String(u));
        if (!pair) continue;

        if (pair.makeSlug) makeSet.add(pair.makeSlug);

        if (hasMakeFilter && !makeFilterSet.has(normalizeMakeSlug(pair.makeSlug))) continue;

        const canonical = `https://ovoko.fr/liste-de-voitures/${pair.makeSlug}/${pair.modelSlug}`;
        if (urlSet.has(canonical)) continue;
        urlSet.add(canonical);
        added += 1;
      }
    } else if (mapHtml) {
      for (const m of extractMakesFromHtml(mapHtml)) {
        if (!hasMakeFilter || makeFilterSet.has(normalizeMakeSlug(m))) makeSet.add(m);
      }
      const pairs = extractMakeModelPairsFromHtml(mapHtml);
      for (const pair of pairs) {
        if (hasMakeFilter && !makeFilterSet.has(normalizeMakeSlug(pair.makeSlug))) continue;

        if (pair.makeSlug) makeSet.add(pair.makeSlug);

        const canonical = `https://ovoko.fr/liste-de-voitures/${pair.makeSlug}/${pair.modelSlug}`;
        if (urlSet.has(canonical)) continue;
        urlSet.add(canonical);
        added += 1;
      }
    }

    totalAdded += added;

    sources.push({
      addedAt: new Date().toISOString(),
      mapInput: inputResolved,
      mapUrlsCount: mapUrls.length,
      mapHtmlSize: mapHtml ? mapHtml.length : 0,
      makeFilter: hasMakeFilter ? Array.from(makeFilterSet) : undefined,
      addedUrls: added,
    });
  }

  const out = {
    generatedAt: new Date().toISOString(),
    sources,
    makesCount: makeSet.size,
    makes: Array.from(makeSet).sort((a, b) => String(a).localeCompare(String(b), 'fr')),
    urlsCount: urlSet.size,
    urls: Array.from(urlSet).sort((a, b) => String(a).localeCompare(String(b), 'fr')),
  };

  fs.writeFileSync(outResolved, JSON.stringify(out, null, 2), 'utf8');
  console.log(
    `OK: +${totalAdded} URLs ajoutées (tous inputs confondus). Total maintenant: ${out.urlsCount}. Sortie: ${outResolved}`
  );
}

try {
  run();
} catch (e) {
  console.error('Erreur bulk merge:', e);
  process.exitCode = 1;
}
