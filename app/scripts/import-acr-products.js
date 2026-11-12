/**
 * Import des moteurs d'occasion ACR dans le catalogue (upsert par SKU).
 *
 * - Lit un JSON au format d'import FR (tableau de produits) — cf. gen_all.py.
 * - Mappe vers le modèle Product et upsert par `sku` (idempotent).
 * - NE TOUCHE PAS aux images (imageUrl/galleryUrls) : préservées si le produit
 *   existe déjà ; renseignées séparément par scripts/upload-acr-photos.js.
 * - Force stockQty=1 + inStock=true (pièces uniques → décrément actif, anti-survente).
 * - statut "brouillon" par défaut (isPublished=false) — publication = action humaine.
 *
 * Usage :
 *   IMPORT_JSON=/Users/killianbelabbes/Documents/Moteur/import_all.json \
 *   node scripts/import-acr-products.js [--dry-run] [--limit N]
 */
require('dotenv').config();
const fs = require('fs');
const mongoose = require('mongoose');
const Product = require('../src/models/Product');

const IMPORT_JSON = process.env.IMPORT_JSON || '/Users/killianbelabbes/Documents/Moteur/import_all.json';
const DRY_RUN = process.argv.includes('--dry-run');
const limArg = process.argv.indexOf('--limit');
const LIMIT = limArg !== -1 ? parseInt(process.argv[limArg + 1], 10) : 0;

function str(v) { return (v == null ? '' : String(v)).trim(); }

function mapProduct(p) {
  const setFields = {
    name: str(p.nom),
    slug: str(p.slug).toLowerCase(),
    category: str(p.categorie) || 'Autre',
    brand: str(p.marque),
    engineCode: str(p.code_moteur),
    compatibleReferences: Array.isArray(p.references_compatibles) ? p.references_compatibles.map(str).filter(Boolean) : [],
    priceCents: Math.round(Number(p.prix_ttc || 0) * 100),
    shortDescription: str(p.resume),
    description: str(p.description),
    keyPoints: Array.isArray(p.points_techniques) ? p.points_techniques.map(str).filter(Boolean) : [],
    shippingDelayText: str(p.delai_expedition),
    'badges.condition': str(p.etat_affiche),
    'badges.cards': Array.isArray(p.badges) ? p.badges.map(str).filter(Boolean).slice(0, 4) : [],
    specs: p.type ? [{ label: 'Type', value: str(p.type) }] : [],
    warranty: { months: Number(p.garantie_mois || 0) || 0, text: str(p.garantie_detail) },
    compatibility: (Array.isArray(p.compatibilites) ? p.compatibilites : []).map((c) => ({
      make: str(c.marque), model: str(c.modele), years: str(c.annees), engine: str(c.motorisation), kw: 0, ch: 0,
    })),
    faqs: (Array.isArray(p.faq) ? p.faq : []).map((f) => ({ question: str(f.question), answer: str(f.reponse) })),
    reconditioningSteps: (Array.isArray(p.etapes_reconditionnement) ? p.etapes_reconditionnement : []).map((s) => ({ title: str(s.type), description: str(s.description) })),
    infoBlockIds: [],
    isPublished: str(p.statut) === 'publie',
    inStock: true,
    stockQty: 1,
  };
  return setFields;
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI manquant (.env)');
  if (!fs.existsSync(IMPORT_JSON)) throw new Error('Fichier introuvable : ' + IMPORT_JSON);
  let items = JSON.parse(fs.readFileSync(IMPORT_JSON, 'utf8'));
  if (!Array.isArray(items)) items = items.produits || [];
  if (LIMIT > 0) items = items.slice(0, LIMIT);
  console.log('MongoDB :', uri.replace(/\/\/[^@]*@/, '//***@').slice(0, 55), '…');
  console.log('Produits à importer :', items.length, DRY_RUN ? '(DRY-RUN)' : '');

  await mongoose.connect(uri);
  let created = 0, updated = 0, failed = 0;
  for (const p of items) {
    const sku = str(p.sku);
    if (!sku) { failed++; continue; }
    try {
      if (DRY_RUN) {
        const exists = await Product.exists({ sku });
        console.log(`  ${exists ? '~' : '+'} ${sku}  ${str(p.nom).slice(0, 60)}  ${p.prix_ttc}€`);
        continue;
      }
      const res = await Product.findOneAndUpdate(
        { sku },
        { $set: mapProduct(p) },
        { upsert: true, new: false, setDefaultsOnInsert: true }
      );
      if (res) updated++; else created++;
    } catch (e) {
      failed++; console.error('  ! ', sku, e.message);
    }
  }
  console.log(`\nTerminé : ${created} créés, ${updated} mis à jour, ${failed} échecs ${DRY_RUN ? '(dry)' : ''}`);
  await mongoose.disconnect();
}
main().catch((e) => { console.error('ERREUR:', e.message); process.exit(1); });
