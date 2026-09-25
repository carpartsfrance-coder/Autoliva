#!/usr/bin/env node
'use strict';

/**
 * Génère src/data/seo/index-policy.json, lu par src/services/seoIndexPolicy.js.
 *
 * ── Pourquoi (plan de reprise SEO du 14/09/2026, action A5 — PR-1b) ──────────
 *
 * La politique d'indexation (quelles pages sortent de Google, famille par
 * famille, derrière l'interrupteur SEO_PRUNE) vient des listes du plan, pas
 * d'un calcul fait au démarrage : elles croisent la Search Console, les
 * commandes, les devis et les appels, que l'application n'a pas sous la main.
 * On les committe telles quelles dans src/data/seo/listes/, et ce script en
 * tire un fichier compact que le serveur charge une fois.
 *
 * Listes lues (copies À L'IDENTIQUE de celles du plan, empreintes SHA-256
 * reportées dans le JSON pour qu'un test vérifie qu'il est à jour) :
 *   - keep-blog-fr.txt            : les 295 articles français GARDÉS (liste
 *                                   blanche : tout autre article sort quand
 *                                   « blog » est actif) ;
 *   - gone-410-blog.txt           : les 268 adresses en 410 (134 articles du
 *                                   05–06/09 et leurs 134 copies allemandes) ;
 *   - kept-posts-need-inlinks.txt : les 76 articles gardés qui n'ont plus de
 *                                   lien depuis un autre article gardé ;
 *   - keep-pieces-auto.txt        : les 242 pages /pieces-auto gardées (liste
 *                                   blanche : toute autre /pieces-auto/* sort) ;
 *   - keep-reference.txt          : les 3 pages /reference gardées ;
 *   - products-fr-noindex.ids.tsv.gz : les fiches d'import sans signal
 *                                   (identifiants), gzip de la liste du plan :
 *                                   11 273 au 14/09/2026, 11 125 depuis le
 *                                   rafraîchissement du 25/09/2026 (148 fiches
 *                                   avec un clic Google depuis avril, ou une
 *                                   vente, un devis, un panier, un appel ou une
 *                                   visite Google depuis le 10/09, restent).
 * S'y ajoute la règle de préfixe « DM- » : les 6 327 fiches DM- sont des copies
 * mot pour mot de distrimotor.com (décision de Killian du 14/09/2026) ; toutes
 * sortent avec « products », y compris les 335 que le plan gardait.
 *
 * Usage :
 *   node scripts/generer-index-policy.js
 *       relit src/data/seo/listes/ et réécrit index-policy.json ;
 *   node scripts/generer-index-policy.js --depuis=<dossier des listes du plan>
 *       recopie d'abord les listes du plan dans src/data/seo/listes/ ;
 *   node scripts/generer-index-policy.js --verifier
 *       n'écrit rien ; code de sortie 1 si le JSON commité n'est plus à jour.
 *
 * Aucun accès à la base, aucun réseau : le script ne lit que des fichiers.
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const crypto = require('crypto');

const RACINE = path.join(__dirname, '..');
const DOSSIER_LISTES = path.join(RACINE, 'src', 'data', 'seo', 'listes');
const FICHIER_POLITIQUE = path.join(RACINE, 'src', 'data', 'seo', 'index-policy.json');
const HOTE = 'https://autoliva.com';

/* Décision de Killian du 14/09/2026 : les fiches DM- sont des copies de
   distrimotor.com (mêmes identifiants, slugs, titres et descriptions). */
const PREFIXES_SKU_NOINDEX = ['DM-'];

const LISTES_TEXTE = [
  'keep-blog-fr.txt',
  'gone-410-blog.txt',
  'kept-posts-need-inlinks.txt',
  'keep-pieces-auto.txt',
  'keep-reference.txt',
];
const LISTE_PRODUITS = 'products-fr-noindex.ids.tsv';

function empreinte(contenu) {
  return crypto.createHash('sha256').update(contenu).digest('hex');
}

function lignes(contenu) {
  return String(contenu).split('\n').map((l) => l.replace(/\r$/, '').trim()).filter(Boolean);
}

/** Chemin d'une URL de liste (https://autoliva.com/xxx → /xxx). */
function cheminDe(url, fichier) {
  if (!url.startsWith(HOTE + '/')) {
    throw new Error(`${fichier} : URL hors du site : ${url}`);
  }
  return url.slice(HOTE.length);
}

function lireListes(dossier) {
  const brut = {};
  for (const nom of LISTES_TEXTE) {
    brut[nom] = fs.readFileSync(path.join(dossier, nom), 'utf8');
  }
  brut[LISTE_PRODUITS] = zlib.gunzipSync(fs.readFileSync(path.join(dossier, LISTE_PRODUITS + '.gz'))).toString('utf8');
  return brut;
}

/**
 * Construit la politique à partir du contenu brut des listes. Pure : pas
 * d'écriture, pas de date du jour — deux exécutions sur les mêmes listes
 * donnent exactement le même fichier (un test le vérifie).
 */
function construirePolitique(brut) {
  const RE_SLUG = /^[a-z0-9][a-z0-9-]*$/;

  const garderBlog = lignes(brut['keep-blog-fr.txt']).map((u) => {
    const m = cheminDe(u, 'keep-blog-fr.txt').match(/^\/blog\/([^/]+)$/);
    if (!m || !RE_SLUG.test(m[1])) throw new Error(`keep-blog-fr.txt : pas un article français : ${u}`);
    return m[1];
  });

  const disparusFr = [];
  const disparusDe = [];
  for (const u of lignes(brut['gone-410-blog.txt'])) {
    const m = cheminDe(u, 'gone-410-blog.txt').match(/^(\/de)?\/blog\/([^/]+)$/);
    if (!m || !RE_SLUG.test(m[2])) throw new Error(`gone-410-blog.txt : pas un article : ${u}`);
    (m[1] ? disparusDe : disparusFr).push(m[2]);
  }

  const maillage = lignes(brut['kept-posts-need-inlinks.txt']).map((u) => {
    const m = cheminDe(u, 'kept-posts-need-inlinks.txt').match(/^\/blog\/([^/]+)$/);
    if (!m) throw new Error(`kept-posts-need-inlinks.txt : pas un article français : ${u}`);
    return m[1];
  });

  const garderPiecesAuto = lignes(brut['keep-pieces-auto.txt']).map((u) => {
    const p = cheminDe(u, 'keep-pieces-auto.txt').toLowerCase().replace(/\/+$/, '');
    /* La racine /pieces-auto est une page statique, hors de la règle : elle
       ne doit pas figurer dans la liste (on la refuse plutôt que de l'ignorer). */
    if (!/^\/pieces-auto\/[^/]+(\/[^/]+){0,2}$/.test(p)) throw new Error(`keep-pieces-auto.txt : pas une page véhicule : ${u}`);
    return p;
  });

  const garderReferences = lignes(brut['keep-reference.txt']).map((u) => {
    const m = cheminDe(u, 'keep-reference.txt').match(/^\/reference\/([^/]+)$/);
    if (!m) throw new Error(`keep-reference.txt : pas une page référence : ${u}`);
    return m[1].toUpperCase();
  });

  const lignesProduits = lignes(brut[LISTE_PRODUITS]);
  if (lignesProduits[0] !== 'product_id\tsku\tsegment\turl') {
    throw new Error(`${LISTE_PRODUITS} : en-tête inattendu : ${lignesProduits[0]}`);
  }
  const produitsNoindex = lignesProduits.slice(1).map((l) => {
    const id = l.split('\t')[0];
    if (!/^[a-f0-9]{24}$/.test(id)) throw new Error(`${LISTE_PRODUITS} : identifiant invalide : ${l}`);
    return id;
  });

  /* Contrôles de cohérence : une page n'est jamais gardée ET retirée. */
  const unique = (liste, nom) => {
    if (new Set(liste).size !== liste.length) throw new Error(`${nom} : doublons`);
  };
  unique(garderBlog, 'keep-blog-fr.txt');
  unique(disparusFr, 'gone-410-blog.txt (FR)');
  unique(disparusDe, 'gone-410-blog.txt (DE)');
  unique(garderPiecesAuto, 'keep-pieces-auto.txt');
  unique(garderReferences, 'keep-reference.txt');
  unique(produitsNoindex, LISTE_PRODUITS);
  const setGarder = new Set(garderBlog);
  const croises = disparusFr.filter((s) => setGarder.has(s));
  if (croises.length) throw new Error(`article à la fois gardé et en 410 : ${croises.join(', ')}`);
  const orphelins = maillage.filter((s) => !setGarder.has(s));
  if (orphelins.length) throw new Error(`kept-posts-need-inlinks.txt : article non gardé : ${orphelins.join(', ')}`);

  const sources = {};
  for (const nom of [...LISTES_TEXTE, LISTE_PRODUITS]) {
    sources[nom] = { lignes: lignes(brut[nom]).length, sha256: empreinte(brut[nom]) };
  }

  const tri = (liste) => liste.slice().sort();
  return {
    _lisezMoi: [
      "Politique d'indexation — plan de reprise SEO du 14/09/2026, action A5 (PR-1b). Lu par src/services/seoIndexPolicy.js.",
      'FICHIER GÉNÉRÉ par scripts/generer-index-policy.js à partir de src/data/seo/listes/ : ne pas l’éditer à la main. Pour garder ou retirer une page, modifier la liste puis relancer le script (un test refuse un JSON qui ne correspond plus aux listes).',
      'Rien de ce fichier ne s’applique tant que la famille n’est pas citée dans la variable SEO_PRUNE (Render) : gone, blog, reference, pieces-auto, de, products.',
      'blog.garder et piecesAuto.garder et references.garder sont des LISTES BLANCHES : quand leur famille est active, toute autre page de la famille passe en noindex, follow.',
      'disparus : adresses servies en 410 quand « gone » est actif (le contenu reste en base). produits.noindex + produits.prefixesSku : fiches en noindex quand « products » est actif ; le choix fait fiche par fiche dans l’admin (seo.indexOverride) passe devant.',
      'Les dates de bascule (lastmod des sitemaps de retrait) sont dans dates-bascule.json ou dans les variables SEO_PRUNE_SINCE_<FAMILLE>.',
    ],
    sources,
    disparus: { fr: tri(disparusFr), de: tri(disparusDe) },
    blog: { garder: tri(garderBlog), maillage: tri(maillage) },
    piecesAuto: { garder: tri(garderPiecesAuto) },
    references: { garder: tri(garderReferences) },
    produits: { prefixesSku: PREFIXES_SKU_NOINDEX.slice(), noindex: tri(produitsNoindex) },
  };
}

function serialiser(politique) {
  return JSON.stringify(politique, null, 1) + '\n';
}

/** Recopie les listes du plan dans src/data/seo/listes/ (à l'identique). */
function importerDepuis(dossierPlan) {
  fs.mkdirSync(DOSSIER_LISTES, { recursive: true });
  for (const nom of LISTES_TEXTE) {
    fs.copyFileSync(path.join(dossierPlan, nom), path.join(DOSSIER_LISTES, nom));
  }
  /* gzip sans horodatage : le même fichier source donne les mêmes octets. */
  const tsv = fs.readFileSync(path.join(dossierPlan, LISTE_PRODUITS));
  fs.writeFileSync(path.join(DOSSIER_LISTES, LISTE_PRODUITS + '.gz'), zlib.gzipSync(tsv, { level: 9 }));
}

function main(argv) {
  const depuis = (argv.find((a) => a.startsWith('--depuis=')) || '').slice('--depuis='.length);
  const verifier = argv.includes('--verifier');
  if (depuis) importerDepuis(depuis);

  const sortie = serialiser(construirePolitique(lireListes(DOSSIER_LISTES)));
  if (verifier) {
    const actuel = fs.existsSync(FICHIER_POLITIQUE) ? fs.readFileSync(FICHIER_POLITIQUE, 'utf8') : '';
    if (actuel !== sortie) {
      console.error('index-policy.json n’est plus à jour : relancer node scripts/generer-index-policy.js');
      return 1;
    }
    console.log('index-policy.json est à jour.');
    return 0;
  }
  fs.writeFileSync(FICHIER_POLITIQUE, sortie);
  const p = JSON.parse(sortie);
  console.log(`index-policy.json écrit : ${p.blog.garder.length} articles gardés, ${p.disparus.fr.length}+${p.disparus.de.length} adresses en 410, `
    + `${p.piecesAuto.garder.length} pages véhicule et ${p.references.garder.length} références gardées, `
    + `${p.produits.noindex.length} fiches listées + préfixe(s) ${p.produits.prefixesSku.join(', ')}.`);
  return 0;
}

module.exports = { construirePolitique, serialiser, lireListes, DOSSIER_LISTES, FICHIER_POLITIQUE };

if (require.main === module) {
  process.exitCode = main(process.argv.slice(2));
}
