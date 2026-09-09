'use strict';

/* Polices servies depuis notre domaine — génération des fichiers.
 *
 * ── Pourquoi ─────────────────────────────────────────────────────────────
 *
 * Chaque page chargeait depuis Google 6,4 Mo de polices d'icônes : les deux
 * fichiers Material Symbols COMPLETS (Rounded 5,2 Mo + Outlined 1,1 Mo), pour
 * un site qui en utilise ~330 sur 4 277. Sur mobile, à 1,6 Mbit/s, c'est
 * trente secondes de téléchargement qui passent avant les photos : Lighthouse
 * mesurait un LCP de 15 à 63 s. Et la feuille de style de Google bloquait le
 * rendu ~1 s de plus (DNS + TLS vers deux hôtes de plus).
 *
 * ── Ce que fait ce script ───────────────────────────────────────────────
 *
 *   1. relève les noms d'icônes réellement utilisés dans les vues et les JS ;
 *   2. demande à Google le sous-ensemble de police correspondant (paramètre
 *      icon_names), plus Inter et Outfit en version variable, latin + latin
 *      étendu (le français et l'allemand n'ont besoin de rien d'autre) ;
 *   3. écrit les .woff2 dans public/fonts/ et un manifest.json : liste des
 *      icônes embarquées, plages unicode, empreinte de version pour le cache.
 *
 * src/services/policesLocales.js lit ce manifest et produit le CSS inline du
 * gabarit. Les fichiers sont versionnés dans le dépôt : le déploiement n'a
 * rien à télécharger, et le site ne dépend plus de Google pour s'afficher
 * (ce qui règle au passage la question RGPD des polices Google, jugée en
 * Allemagne — LG München, 2022).
 *
 * ── Quand le relancer ───────────────────────────────────────────────────
 *
 * Dès qu'une vue ou un script utilise une icône NOUVELLE : sinon elle
 * s'affiche en toutes lettres (« shopping_cart ») à la place du pictogramme.
 * tests/unit/polices-locales.test.js le signale.
 *
 *   node scripts/polices-locales.js
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');

const RACINE = path.join(__dirname, '..');
const DOSSIERS_SOURCES = ['src/views', 'public/js'];
const DESTINATION = path.join(RACINE, 'public', 'fonts');
const MANIFEST = path.join(DESTINATION, 'manifest.json');

/* Un navigateur récent : c'est à lui que Google sert du woff2 variable. */
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const LISTE_OFFICIELLE = 'https://raw.githubusercontent.com/google/material-design-icons/master/variablefont/MaterialSymbolsOutlined%5BFILL%2CGRAD%2Copsz%2Cwght%5D.codepoints';

/* Les axes demandés pour les icônes sont ceux que le site fait varier :
   graisse (font-variation-settings 'wght') et remplissage ('FILL'). */
const FAMILLES = [
  { cle: 'inter', famille: 'Inter', spec: 'Inter:wght@400..800', sousEnsembles: ['latin', 'latin-ext'], display: 'swap', preload: ['latin'] },
  { cle: 'outfit', famille: 'Outfit', spec: 'Outfit:wght@500..700', sousEnsembles: ['latin', 'latin-ext'], display: 'swap', preload: ['latin'] },
  /* La fiche produit a sa propre police de texte ; préchargée par la fiche
     elle-même (voir products/show.ejs), pas par le gabarit commun. */
  { cle: 'plus-jakarta-sans', famille: 'Plus Jakarta Sans', spec: 'Plus+Jakarta+Sans:wght@400..800', sousEnsembles: ['latin', 'latin-ext'], display: 'swap', preload: [] },
  { cle: 'plus-jakarta-sans-italic', famille: 'Plus Jakarta Sans', spec: 'Plus+Jakarta+Sans:ital,wght@1,700..800', sousEnsembles: ['latin', 'latin-ext'], display: 'swap', preload: [] },
  { cle: 'material-symbols-outlined', famille: 'Material Symbols Outlined', spec: 'Material+Symbols+Outlined:wght,FILL@100..700,0..1', icones: true, display: 'block', preload: true },
  { cle: 'material-symbols-rounded', famille: 'Material Symbols Rounded', spec: 'Material+Symbols+Rounded:wght,FILL@100..700,0..1', icones: true, display: 'block', preload: false },
];

function listerFichiers(dossier, acc = []) {
  for (const e of fs.readdirSync(dossier, { withFileTypes: true })) {
    const p = path.join(dossier, e.name);
    if (e.isDirectory()) listerFichiers(p, acc);
    else if (/\.(ejs|js|html)$/.test(e.name)) acc.push(p);
  }
  return acc;
}

/** Noms d'icônes utilisés dans les sources.
 *
 *  - `strictes` : le motif sans ambiguïté `class="material-symbols-…">nom<`.
 *  - `larges` : toute chaîne littérale qui est un nom officiel, dans un
 *    fichier qui utilise la police — pour les icônes posées par JavaScript
 *    (`icon: 'check_circle'`). Sur-collecter coûte quelques octets, oublier
 *    une icône coûte un mot en toutes lettres à l'écran : on prend large.
 */
function extraireIcones({ officiels, racine = RACINE } = {}) {
  const strictes = new Set();
  const larges = new Set();
  const fichiers = DOSSIERS_SOURCES.flatMap((d) => listerFichiers(path.join(racine, d)));
  for (const f of fichiers) {
    const s = fs.readFileSync(f, 'utf8');
    if (!/material-symbols/.test(s)) continue;
    for (const m of s.matchAll(/material-symbols-(?:outlined|rounded)[^>]*>\s*([a-z][a-z0-9_]+)\s*</g)) strictes.add(m[1]);
    if (officiels) {
      for (const m of s.matchAll(/["'`>]\s*([a-z][a-z0-9_]{2,})\s*["'`<]/g)) if (officiels.has(m[1])) larges.add(m[1]);
    }
  }
  return { strictes, larges };
}

function telecharger(url, tentatives = 3) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': UA } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return telecharger(new URL(res.headers.location, url).toString(), tentatives).then(resolve, reject);
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode} pour ${url}`));
      }
      const morceaux = [];
      res.on('data', (c) => morceaux.push(c));
      res.on('end', () => resolve(Buffer.concat(morceaux)));
      res.on('error', reject);
    }).on('error', (e) => (tentatives > 1 ? telecharger(url, tentatives - 1).then(resolve, reject) : reject(e)));
  });
}

/* Blocs @font-face de la feuille Google : sous-ensemble (commentaire qui
   précède), URL du woff2, plage unicode, graisse. */
function analyserCss(css) {
  const blocs = [];
  const re = /(?:\/\*\s*([a-z-]+)\s*\*\/\s*)?@font-face\s*\{([^}]+)\}/g;
  for (const m of css.matchAll(re)) {
    const corps = m[2];
    const url = (corps.match(/url\(([^)]+)\)\s*format\(['"]woff2['"]\)/) || [])[1];
    if (!url) continue;
    blocs.push({
      sousEnsemble: m[1] || null,
      url,
      poids: ((corps.match(/font-weight:\s*([^;]+);/) || [])[1] || '400').trim(),
      style: ((corps.match(/font-style:\s*([^;]+);/) || [])[1] || 'normal').trim(),
      unicodeRange: ((corps.match(/unicode-range:\s*([^;]+);/) || [])[1] || '').replace(/\s+/g, ' ').trim() || null,
    });
  }
  return blocs;
}

async function main() {
  console.log('Liste officielle des icônes…');
  const officiels = new Set(String(await telecharger(LISTE_OFFICIELLE)).split('\n').map((l) => l.split(' ')[0]).filter(Boolean));

  const { strictes, larges } = extraireIcones({ officiels });
  const inconnues = [...strictes].filter((n) => !officiels.has(n));
  if (inconnues.length) {
    throw new Error('Nom(s) d\'icône inconnu(s) de Material Symbols, à corriger dans les vues : ' + inconnues.join(', '));
  }
  const icones = [...new Set([...strictes, ...larges])].sort();
  console.log(`${icones.length} icônes utilisées (${strictes.size} dans les vues, le reste posé par JavaScript).`);

  fs.mkdirSync(DESTINATION, { recursive: true });
  const polices = [];
  for (const fam of FAMILLES) {
    const params = new URLSearchParams();
    let url = `https://fonts.googleapis.com/css2?family=${fam.spec}&display=${fam.display}`;
    if (fam.icones) url += '&icon_names=' + icones.join(',');
    void params;
    const css = String(await telecharger(url));
    const blocs = analyserCss(css);
    if (!blocs.length) throw new Error('Aucun @font-face renvoyé pour ' + fam.famille);

    const retenus = fam.icones ? blocs.slice(0, 1) : blocs.filter((b) => fam.sousEnsembles.includes(b.sousEnsemble));
    if (!fam.icones && retenus.length !== fam.sousEnsembles.length) {
      throw new Error(`Sous-ensembles manquants pour ${fam.famille} : reçu ${retenus.map((b) => b.sousEnsemble).join(', ')}`);
    }
    for (const b of retenus) {
      const fichier = fam.icones ? `${fam.cle}.woff2` : `${fam.cle}-${b.sousEnsemble}.woff2`;
      const octets = await telecharger(b.url);
      if (octets.length < 1000 || octets.slice(0, 4).toString('latin1') !== 'wOF2') throw new Error('Fichier inattendu pour ' + fichier);
      fs.writeFileSync(path.join(DESTINATION, fichier), octets);
      polices.push({
        famille: fam.famille,
        fichier,
        poids: b.poids,
        style: b.style,
        display: fam.display,
        unicodeRange: b.unicodeRange,
        icones: Boolean(fam.icones),
        preload: fam.icones ? Boolean(fam.preload) : fam.preload.includes(b.sousEnsemble),
        octets: octets.length,
      });
      console.log(`  ${fichier.padEnd(40)} ${Math.round(octets.length / 1024)} Ko`);
    }
  }

  const empreinte = crypto.createHash('sha1');
  for (const p of polices) empreinte.update(fs.readFileSync(path.join(DESTINATION, p.fichier)));
  const manifest = {
    version: empreinte.digest('hex').slice(0, 10),
    genereLe: new Date().toISOString(),
    icones,
    polices,
  };
  fs.writeFileSync(MANIFEST, JSON.stringify(manifest, null, 2) + '\n');

  /* Fichiers d'une génération précédente qui ne servent plus. */
  const attendus = new Set(polices.map((p) => p.fichier).concat('manifest.json'));
  for (const f of fs.readdirSync(DESTINATION)) if (!attendus.has(f)) fs.unlinkSync(path.join(DESTINATION, f));

  const total = polices.reduce((s, p) => s + p.octets, 0);
  console.log(`OK — ${polices.length} fichiers, ${Math.round(total / 1024)} Ko au total, version ${manifest.version}.`);
}

module.exports = { extraireIcones, analyserCss, FAMILLES, MANIFEST };

if (require.main === module) main().catch((e) => { console.error('\nÉCHEC', e.message); process.exit(1); });
