#!/usr/bin/env node
'use strict';

/*
 * Minifie les JS publics avec esbuild.
 *
 * Pourquoi :
 *   Semrush flaggait 3 336 issues "unminified JS and CSS files" (les CSS sont
 *   déjà minifiés par Tailwind via --minify, mais les JS de /public/js/ étaient
 *   servis tels quels). Ce script tourne dans le build (heroku-postbuild) et
 *   minifie sur place : chaque .js est réécrit dans sa version compacte. Les
 *   fichiers déjà minifiés (*.min.js) sont skippés.
 *
 * Usage :
 *   npm run js:minify
 */

const fs = require('fs');
const path = require('path');

const PUBLIC_JS_DIRS = [
  path.join(__dirname, '..', 'public', 'js'),
  path.join(__dirname, '..', 'public', 'admin'),
];

async function main() {
  let esbuild;
  try {
    esbuild = require('esbuild');
  } catch (e) {
    console.warn('[minify-js] esbuild non installé — skip (devDep manquante).');
    process.exit(0);
  }

  let totalBefore = 0;
  let totalAfter = 0;
  let filesProcessed = 0;

  for (const dir of PUBLIC_JS_DIRS) {
    if (!fs.existsSync(dir)) continue;
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.js'));
    for (const f of files) {
      // Skip déjà minifié (heuristique : présence de ".min." ou fichier déjà
      // compact = ratio caractères/lignes très élevé).
      if (f.includes('.min.')) continue;
      const fullPath = path.join(dir, f);
      const before = fs.readFileSync(fullPath, 'utf8');
      // Skip si déjà compact (ratio long-ligne / total > 0.5 = probablement minifié)
      const longLines = before.split('\n').filter((l) => l.length > 200).length;
      const totalLines = before.split('\n').length;
      if (totalLines > 5 && longLines / totalLines > 0.5) {
        continue;
      }
      try {
        const result = await esbuild.transform(before, {
          loader: 'js',
          minify: true,
          target: 'es2019',
          // Préserve les commentaires de licence pour conformité légale
          legalComments: 'inline',
        });
        fs.writeFileSync(fullPath, result.code, 'utf8');
        totalBefore += before.length;
        totalAfter += result.code.length;
        filesProcessed += 1;
        const saved = ((1 - result.code.length / before.length) * 100).toFixed(1);
        console.log(`[minify-js] ${f} : ${before.length} → ${result.code.length} (-${saved}%)`);
      } catch (err) {
        console.error(`[minify-js] ${f} FAILED :`, err.message);
      }
    }
  }

  if (filesProcessed > 0) {
    const totalSaved = ((1 - totalAfter / totalBefore) * 100).toFixed(1);
    console.log(`[minify-js] ✓ ${filesProcessed} fichier(s) minifié(s), ${totalBefore} → ${totalAfter} octets (-${totalSaved}%).`);
  } else {
    console.log('[minify-js] Aucun fichier à minifier (tous déjà compacts).');
  }
}

main().catch((err) => {
  console.error('[minify-js] FATAL :', err);
  process.exit(1);
});
