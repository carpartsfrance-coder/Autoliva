'use strict';

/**
 * Corrige les fiches moteur dont les textes donnent « Distrimotor » comme
 * MARQUE DE VÉHICULE.
 *
 * ── Pourquoi (14/09/2026) ────────────────────────────────────────────────────
 *
 * 65 fiches du fournisseur ASY portaient, dans leurs compatibilités, la
 * marque « Distrimotor » — le nom d'un concurrent (distrimotor.com), pas d'un
 * constructeur. L'erreur, venue de l'import, s'était recopiée partout : titre
 * (« … reconditionné – Audi / Distrimotor »), description (« Ce moteur équipe
 * notamment : Distrimotor Fiorino »), méta, FAQ, résumé, champ marque, et leur
 * traduction allemande (« um Ihren Distrimotor in Stand zu setzen »).
 *
 * Trois cas, traités sans rien deviner :
 *   - entrée « Distrimotor » SANS modèle, à côté des vraies marques (51) :
 *     parasite, retirée ;
 *   - modèle connu (« Fiorino » → Fiat, « Touareg » → Volkswagen…) : la vraie
 *     marque est posée ;
 *   - plusieurs modèles sous une seule entrée (« Boxer Daily Ducato Jumper »)
 *     : une entrée par véhicule, avec sa marque.
 * Tout ce qui n'entre pas dans ces cas part en « à revoir à la main » et
 * n'est PAS modifié.
 *
 * Jamais touchés : les adresses (slug FR et DE, 62 et 45 contiennent
 * « distrimotor ») — les changer casserait les liens et les annonces — ni le
 * SKU. Rien n'est supprimé.
 *
 * Usage (depuis le dossier app) :
 *   node scripts/corriger-marque-distrimotor.js              # ESSAI : n'écrit rien
 *   node scripts/corriger-marque-distrimotor.js --appliquer  # écrit en base
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const MARQUE_DU_MODELE = {
  fiorino: 'Fiat', ducato: 'Fiat', doblo: 'Fiat', panda: 'Fiat', punto: 'Fiat',
  daily: 'Iveco',
  boxer: 'Peugeot', expert: 'Peugeot', 207: 'Peugeot', partner: 'Peugeot',
  jumper: 'Citroën', jumpy: 'Citroën', c3: 'Citroën', berlingo: 'Citroën',
  proace: 'Toyota', vivaro: 'Opel',
  amarok: 'Volkswagen', caddy: 'Volkswagen', touareg: 'Volkswagen', touran: 'Volkswagen',
  megane: 'Renault', 'mégane': 'Renault',
  leon: 'Seat',
};

const NOM_DU_MODELE = { leon: 'Leon', megane: 'Mégane', c3: 'C3', 207: '207' };

/* Champs jamais réécrits : adresses et identifiants. */
const CHAMPS_INTOUCHABLES = /(^|\.)(slug|slugAliases|sku|canonicalPath|imageUrl|galleryUrls|_id)(\.|$)/i;

const EST_DISTRIMOTOR = /^\s*distrimotor\s*$/i;

function unique(liste) {
  return [...new Set(liste.filter(Boolean))];
}

/** « Boxer Daily Ducato Jumper » → ['boxer','daily','ducato','jumper'], ou null si un mot est inconnu. */
function modelesConnus(chaine) {
  const mots = String(chaine || '').trim().split(/\s+/).filter(Boolean);
  if (!mots.length) return [];
  const cles = mots.map((m) => m.toLowerCase());
  return cles.every((c) => MARQUE_DU_MODELE[c]) ? cles : null;
}

function nomModele(cle, original) {
  if (NOM_DU_MODELE[cle]) return NOM_DU_MODELE[cle];
  const brut = String(original || cle);
  return brut.charAt(0).toUpperCase() + brut.slice(1).toLowerCase();
}

/**
 * Corrige le tableau des compatibilités.
 * @returns {{ compat: object[], marquesDistri: string[], reprises: {avant:string, apres:string}[], manuel: string[] }}
 */
function corrigerCompatibilites(compat) {
  const sortie = [];
  const marquesDistri = [];
  const reprises = [];
  const manuel = [];
  const deja = new Set((compat || [])
    .filter((e) => e && !EST_DISTRIMOTOR.test(e.make || ''))
    .map((e) => `${String(e.make).toLowerCase()}|${String(e.model || '').toLowerCase()}`));

  for (const entree of (compat || [])) {
    if (!entree || !EST_DISTRIMOTOR.test(entree.make || '')) { sortie.push(entree); continue; }
    const modele = String(entree.model || '').trim();
    if (!modele) continue; /* parasite : les vraies marques sont déjà listées */
    const cles = modelesConnus(modele);
    if (!cles) { manuel.push(`modèle inconnu « ${modele} »`); sortie.push(entree); continue; }
    const vehicules = [];
    for (const [i, cle] of cles.entries()) {
      const make = MARQUE_DU_MODELE[cle];
      const model = nomModele(cle, modele.split(/\s+/)[i]);
      marquesDistri.push(make);
      vehicules.push(`${make} ${model}`);
      const k = `${make.toLowerCase()}|${model.toLowerCase()}`;
      if (deja.has(k)) continue;
      deja.add(k);
      const { _id, ...reste } = entree; // eslint-disable-line no-unused-vars
      sortie.push({ ...reste, make, model });
    }
    reprises.push({ avant: `Distrimotor ${modele}`, apres: vehicules.join(', ') });
  }
  return { compat: sortie, marquesDistri: unique(marquesDistri), reprises, manuel };
}

/* Marque l'endroit d'un retrait, pour ne recoller QUE là. */
const TROU = '\u0001';

/* Recolle le texte autour des seuls mots retirés. L'ancienne version
   normalisait tout le champ : sur 63 descriptions, « main d'œuvre ; »
   devenait « main d'œuvre; » (typographie française), et des espaces
   doubles ou retours à la ligne sans rapport avec Distrimotor auraient été
   écrasés. */
function recoller(t) {
  return t
    .replace(/[ \t]*\([ \t]*\u0001+[ \t]*\)/g, '')
    .replace(/[ \t]*\u0001+[ \t]*(?=[.,;:!?)\]|]|$)/g, '')
    .replace(/(^|[(\[])[ \t]*\u0001+[ \t]*/g, '$1')
    .replace(/[ \t]*\u0001+[ \t]*/g, (m) => (/[ \t]/.test(m) ? ' ' : ''));
}

/**
 * Réécrit un texte (FR ou DE) d'après la correction des compatibilités.
 * @returns {string|null} le texte corrigé, ou null s'il faut une relecture humaine
 */
function corrigerTexte(texte, { lang, reprises, marquesDistri, marquePrincipale }) {
  if (typeof texte !== 'string' || !/distrimotor/i.test(texte)) return texte;
  let t = texte;

  /* 1. « Distrimotor Boxer Daily Ducato Jumper » → les vrais véhicules. */
  for (const r of reprises) t = t.split(r.avant).join(r.apres);

  /* 2. Le véhicule du lecteur : « votre Distrimotor », « Ihren Distrimotor ». */
  const seule = marquesDistri.length === 1 ? marquesDistri[0] : (marquesDistri.length === 0 ? marquePrincipale : '');
  t = lang === 'de'
    ? t.replace(/\bIhren Distrimotor\b/g, seule ? `Ihren ${seule}` : 'Ihr Fahrzeug')
    : t.replace(/\bvotre Distrimotor\b/g, seule ? `votre ${seule}` : 'votre véhicule');

  /* 3. Dans une liste de marques : on retire le mot et son séparateur. */
  t = t.replace(/\s*(?:\/|,)\s*Distrimotor\b(?!\s+[A-Z0-9])/g, TROU)
    .replace(/\bDistrimotor\s*(?:\/|,)\s*/g, TROU);

  /* 4. Resté seul (« – Distrimotor », « pour Distrimotor. ») : la vraie marque. */
  const remplacement = marquesDistri.length ? marquesDistri.join(' / ') : (marquePrincipale || '');
  if (/\bDistrimotor\b/.test(t)) {
    if (!remplacement) return null;
    t = t.replace(/\bDistrimotor\b/g, remplacement);
  }
  t = recoller(t);
  return /distrimotor/i.test(t) ? null : t;
}

/* Parcourt les champs texte d'une fiche (hors adresses) et propose les corrections. */
function champsTexte(doc, base = '', acc = []) {
  if (typeof doc === 'string') { acc.push([base, doc]); return acc; }
  if (Array.isArray(doc)) { doc.forEach((v, i) => champsTexte(v, base ? `${base}.${i}` : String(i), acc)); return acc; }
  if (doc && typeof doc === 'object' && !doc._bsontype && !(doc instanceof Date)) {
    for (const [k, v] of Object.entries(doc)) champsTexte(v, base ? `${base}.${k}` : k, acc);
  }
  return acc;
}

/**
 * Transformation complète d'une fiche. Fonction PURE (testée).
 * @returns {{ set: object, avantApres: {champ:string, avant:string, apres:string}[], manuel: string[] }}
 */
function transformer(produit) {
  const c = corrigerCompatibilites(produit.compatibility || []);
  const manuel = [...c.manuel];
  const reelles = unique(c.compat.map((e) => e && e.make).filter((m) => m && !EST_DISTRIMOTOR.test(m)));
  const marquePrincipale = reelles[0] || '';
  const set = {};
  const avantApres = [];

  if (JSON.stringify(c.compat) !== JSON.stringify(produit.compatibility || [])) {
    set.compatibility = c.compat;
    avantApres.push({
      champ: 'compatibility',
      avant: (produit.compatibility || []).map((e) => `${e.make} ${e.model || ''}`.trim()).join(' | '),
      apres: c.compat.map((e) => `${e.make} ${e.model || ''}`.trim()).join(' | '),
    });
  }

  if (EST_DISTRIMOTOR.test(produit.brand || '')) {
    set.brand = reelles.length === 1 ? reelles[0] : 'Multimarque';
    avantApres.push({ champ: 'brand', avant: produit.brand, apres: set.brand });
  }

  const { compatibility, brand, ...reste } = produit; // eslint-disable-line no-unused-vars
  for (const [chemin, valeur] of champsTexte(reste)) {
    if (CHAMPS_INTOUCHABLES.test(chemin) || !/distrimotor/i.test(valeur)) continue;
    const lang = chemin.startsWith('localizations.de') ? 'de' : 'fr';
    const corrige = corrigerTexte(valeur, { lang, reprises: c.reprises, marquesDistri: c.marquesDistri, marquePrincipale });
    if (corrige === null) { manuel.push(`${chemin} : « ${valeur.slice(0, 80)} »`); continue; }
    if (corrige !== valeur) {
      set[chemin] = corrige;
      avantApres.push({ champ: chemin, avant: valeur, apres: corrige });
    }
  }
  return { set, avantApres, manuel };
}

async function main() {
  /* .env chargé ici, pas au require : les tests importent ce module et ne
     doivent pas recevoir l'adresse de la base de production. */
  require('dotenv').config();
  const appliquer = process.argv.includes('--appliquer');
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI manquante');
  const { MongoClient } = require('mongodb');
  const client = new MongoClient(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  await client.connect();
  try {
    const col = client.db().collection('products');
    const produits = await col.find({ 'compatibility.make': /^\s*distrimotor\s*$/i }).toArray();
    console.log(`${produits.length} fiche(s) concernée(s) — ${appliquer ? 'APPLICATION' : 'ESSAI, rien ne sera écrit'}\n`);

    const lignes = ['# Correction « Distrimotor » — ' + new Date().toISOString().slice(0, 10), ''];
    let aEcrire = 0; let aRevoir = 0; let ecrites = 0;
    for (const p of produits) {
      const { set, avantApres, manuel } = transformer(p);
      const statut = manuel.length ? 'À REVOIR À LA MAIN' : (Object.keys(set).length ? 'corrigée' : 'rien à faire');
      lignes.push(`## ${p.sku} — ${p.isPublished === false ? 'brouillon' : 'publiée'} — ${statut}`, '');
      for (const a of avantApres) lignes.push(`- **${a.champ}**`, `  - avant : ${a.avant}`, `  - après : ${a.apres}`);
      for (const m of manuel) lignes.push(`- ⚠ ${m}`);
      lignes.push('');
      if (manuel.length) { aRevoir++; continue; }
      if (!Object.keys(set).length) continue;
      aEcrire++;
      if (appliquer) {
        const r = await col.updateOne({ _id: p._id }, { $set: set });
        ecrites += r.modifiedCount;
      }
    }

    const rapport = path.join(os.homedir(), 'Downloads', `corriger-marque-distrimotor-${new Date().toISOString().slice(0, 10)}.md`);
    fs.writeFileSync(rapport, lignes.join('\n'), 'utf8');
    console.log(`À corriger : ${aEcrire} · à revoir à la main : ${aRevoir}`);
    console.log(appliquer ? `Écrites : ${ecrites}` : 'ESSAI : rien n’a été écrit. Relis le rapport, puis relance avec --appliquer.');
    console.log(`Rapport détaillé (avant → après, champ par champ) : ${rapport}`);
  } finally {
    await client.close();
  }
}

module.exports = { transformer, corrigerCompatibilites, corrigerTexte, modelesConnus };

if (require.main === module) {
  main().catch((e) => { console.error('\n❌', e && e.message ? e.message : e); process.exit(1); });
}
