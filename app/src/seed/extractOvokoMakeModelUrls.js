const fs = require('fs');
const path = require('path');

function extractMakeModelFromUrl(url) {
  if (typeof url !== 'string') return null;

  const m = url.match(/^https:\/\/ovoko\.fr\/liste-de-voitures\/([^\/?#]+)\/([^\/?#]+)$/i);
  if (!m) return null;

  const makeSlug = String(m[1] || '').trim();
  const modelSlug = String(m[2] || '').trim();

  if (!makeSlug || !modelSlug) return null;
  if (modelSlug.toLowerCase() === 'tous') return null;

  return { makeSlug, modelSlug };
}

function usage() {
  console.log('Usage: node src/seed/extractOvokoMakeModelUrls.js --input=map.json --output=urls.json');
}

function run() {
  const args = process.argv.slice(2);

  const inputArg = args.find((a) => a.startsWith('--input='));
  const outputArg = args.find((a) => a.startsWith('--output='));

  const inputFile = inputArg ? inputArg.split('=')[1] : null;
  const outputFile = outputArg ? outputArg.split('=')[1] : null;

  if (!inputFile || !outputFile) {
    usage();
    process.exitCode = 1;
    return;
  }

  const inputResolved = path.isAbsolute(inputFile) ? inputFile : path.resolve(process.cwd(), inputFile);
  const outputResolved = path.isAbsolute(outputFile) ? outputFile : path.resolve(process.cwd(), outputFile);

  const raw = fs.readFileSync(inputResolved, 'utf8');
  const parsed = JSON.parse(raw);
  const urls = Array.isArray(parsed) ? parsed : Array.isArray(parsed.urls) ? parsed.urls : [];

  if (!Array.isArray(urls) || urls.length === 0) {
    console.error('Aucune URL trouvée dans le fichier d\'entrée');
    process.exitCode = 1;
    return;
  }

  const uniq = new Set();
  for (const u of urls) {
    const pair = extractMakeModelFromUrl(u);
    if (!pair) continue;
    uniq.add(`https://ovoko.fr/liste-de-voitures/${pair.makeSlug}/${pair.modelSlug}`);
  }

  const out = {
    generatedAt: new Date().toISOString(),
    input: inputResolved,
    urlsCount: uniq.size,
    urls: Array.from(uniq).sort((a, b) => String(a).localeCompare(String(b), 'fr')),
  };

  fs.writeFileSync(outputResolved, JSON.stringify(out, null, 2), 'utf8');
  console.log(`OK: ${out.urlsCount} URLs marque/modèle écrites dans ${outputResolved}`);
}

try {
  run();
} catch (err) {
  console.error('Erreur extract:', err);
  process.exitCode = 1;
}
