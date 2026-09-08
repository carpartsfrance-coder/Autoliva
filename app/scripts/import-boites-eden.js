/**
 * Import des fiches boîtes de vitesses (générées depuis les données Eden).
 * - Uploade le template photo UNE fois en GridFS, puis l'affecte à toutes les fiches
 *   (l'import ACR standard ne touche pas aux images → ici on les pose).
 * - Upsert par sku. Statut BROUILLON par défaut (isPublished=false) — publication = humain.
 *
 * SÉCURITÉ : --dry-run n'écrit RIEN (et n'uploade pas). --publish met en ligne direct.
 *
 * Fichiers (défauts dans scripts/, surchargeables par env) :
 *   BOITES_JSON=scripts/boites_pilote.json
 *   TEMPLATE_PATH=scripts/gen-boite-manuelle.webp
 *   TEMPLATE_URL=/media/<id>   (pour réutiliser un template déjà uploadé, évite un doublon GridFS)
 *
 * Usage :
 *   node scripts/import-boites-eden.js --dry-run
 *   node scripts/import-boites-eden.js                       # crée en brouillon
 *   TEMPLATE_URL=/media/abc node scripts/import-boites-eden.js   # réutilise le template
 *   node scripts/import-boites-eden.js --publish             # crée + publie
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const Product = require('../src/models/Product');
const mediaStorage = require('../src/services/mediaStorage');

const DRY = process.argv.includes('--dry-run');
const PUBLISH = process.argv.includes('--publish');
// NO_TEMPLATE : n'attache AUCUNE image (imageUrl reste vide) → les vraies photos sont
// posées ensuite par upload-acr-photos.js (cas Dekram : photos détourées par offer_id).
const NO_TEMPLATE = process.argv.includes('--no-template') || !!process.env.NO_TEMPLATE;
const PURGE_EDEN = process.argv.includes('--purge-eden'); // supprime les anciennes fiches EDEN-BX-
// --purge-orphans : supprime les fiches PUBLISH_PREFIX présentes en base mais ABSENTES du JSON courant
// (nettoie les doublons d'avant la déduplication). Ex. PUBLISH_PREFIX=DEK- … --purge-orphans
const PURGE_ORPHANS = process.argv.includes('--purge-orphans');
const _pw = process.argv.indexOf('--publish-wave');
const PUBLISH_WAVE = _pw >= 0 ? parseInt(process.argv[_pw + 1], 10) || 0 : 0; // publie N brouillons ALV-BX
// --publish-all : publie TOUS les brouillons dont le sku commence par PUBLISH_PREFIX (défaut ALV-BX-).
// Ex. Dekram : PUBLISH_PREFIX=DEK- node scripts/import-boites-eden.js --publish-all
const PUBLISH_ALL = process.argv.includes('--publish-all');
// --unpublish-all : repasse en brouillon TOUS les PUBLISH_PREFIX actuellement publiés (inverse de --publish-all).
const UNPUBLISH_ALL = process.argv.includes('--unpublish-all');
const PUB_PREFIX = process.env.PUBLISH_PREFIX || 'ALV-BX-';
const JSON_PATH = process.env.BOITES_JSON || path.join(__dirname, 'boites_pilote.json');
const TEMPLATE_PATH = process.env.TEMPLATE_PATH || path.join(__dirname, 'gen-boite-manuelle.webp');
const TEMPLATE_URL_ENV = process.env.TEMPLATE_URL || '';

const str = (v) => (v == null ? '' : String(v).trim());

function mapProduct(p, imageUrl) {
  const out = {
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
    inStock: true,
    stockQty: Number(p.stock_qty) || 1,
  };
  // Images posées UNIQUEMENT si un template est fourni. En NO_TEMPLATE (imageUrl vide), on ne touche
  // PAS imageUrl/galleryUrls → un ré-import ne détruit jamais les photos déjà uploadées (upload-acr-photos).
  if (imageUrl) { out.imageUrl = imageUrl; out.galleryUrls = [imageUrl]; }
  return out;
}

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI manquant (.env)');
  if (!fs.existsSync(JSON_PATH)) throw new Error('JSON introuvable : ' + JSON_PATH);
  const items = JSON.parse(fs.readFileSync(JSON_PATH, 'utf8'));
  await mongoose.connect(uri);
  console.log('MongoDB :', uri.replace(/\/\/[^@]*@/, '//***@').slice(0, 50), '…');

  if (PURGE_EDEN) {
    const q = { sku: { $regex: /^EDEN-BX-/ } };
    const n = await Product.countDocuments(q);
    if (DRY) console.log(`[purge-eden] ${n} fiche(s) EDEN-BX- seraient supprimées (dry-run).`);
    else { const r = await Product.deleteMany(q); console.log(`[purge-eden] supprimées : ${r.deletedCount}`); }
    await mongoose.disconnect();
    return;
  }

  if (PURGE_ORPHANS) {
    const keep = new Set(items.map((x) => str(x.sku)).filter(Boolean));
    const all = await Product.find({ sku: { $regex: new RegExp('^' + PUB_PREFIX) } }).select('sku isPublished').lean();
    const orphans = all.filter((p) => !keep.has(p.sku));
    const pubOrph = orphans.filter((p) => p.isPublished).length;
    console.log(`[purge-orphans] base ${PUB_PREFIX}: ${all.length} · JSON: ${keep.size} · orphelins: ${orphans.length} (dont publiés: ${pubOrph})`);
    if (DRY) console.log('  (dry-run) ex.:', orphans.slice(0, 6).map((p) => p.sku));
    else if (orphans.length) {
      const r = await Product.deleteMany({ sku: { $in: orphans.map((p) => p.sku) } });
      console.log(`  supprimés : ${r.deletedCount}`);
    }
    await mongoose.disconnect();
    return;
  }

  if (UNPUBLISH_ALL) {
    const q = { sku: { $regex: new RegExp('^' + PUB_PREFIX) }, isPublished: true };
    const n = await Product.countDocuments(q);
    if (DRY) console.log(`[unpublish-all] ${n} fiche(s) ${PUB_PREFIX} publiées repasseraient en brouillon (dry-run).`);
    else { const r = await Product.updateMany(q, { $set: { isPublished: false } }); console.log(`[unpublish-all] ✅ dé-publiées : ${r.modifiedCount} (${PUB_PREFIX})`); }
    await mongoose.disconnect();
    return;
  }

  if (PUBLISH_ALL) {
    const q = { sku: { $regex: new RegExp('^' + PUB_PREFIX) }, isPublished: false };
    const n = await Product.countDocuments(q);
    if (DRY) console.log(`[publish-all] ${n} brouillon(s) ${PUB_PREFIX} seraient publiés (dry-run).`);
    else { const r = await Product.updateMany(q, { $set: { isPublished: true } }); console.log(`[publish-all] ✅ publiés : ${r.modifiedCount} (${PUB_PREFIX})`); }
    await mongoose.disconnect();
    return;
  }

  if (PUBLISH_WAVE) {
    const q = { sku: { $regex: /^ALV-BX-/ }, isPublished: false };
    const docs = await Product.find(q).sort({ priceCents: -1 }).limit(PUBLISH_WAVE).select('_id sku name').lean();
    const remaining = await Product.countDocuments(q);
    console.log(`[publish-wave] ${docs.length} à publier${DRY ? ' (dry-run)' : ''} · restant en brouillon : ${remaining}`);
    if (!DRY) {
      for (const d of docs) await Product.updateOne({ _id: d._id }, { $set: { isPublished: true } });
      console.log(`[publish-wave] ✅ ${docs.length} publiées · reste ${remaining - docs.length} en brouillon`);
    }
    await mongoose.disconnect();
    return;
  }

  console.log(`Fiches : ${items.length} | ${DRY ? '🟢 DRY-RUN' : '🔴 ÉCRITURE'}${PUBLISH ? ' + PUBLISH' : ' (brouillon)'}`);

  // Template : réutiliser l'URL fournie, sinon uploader une fois.
  let templateUrl = TEMPLATE_URL_ENV;
  if (NO_TEMPLATE) {
    templateUrl = '';
    console.log('Sans template (imageUrl vide) — photos posées ensuite par upload-acr-photos.js.');
  } else if (!DRY && !templateUrl) {
    if (!fs.existsSync(TEMPLATE_PATH)) throw new Error('Template introuvable : ' + TEMPLATE_PATH);
    const buffer = fs.readFileSync(TEMPLATE_PATH);
    const res = await mediaStorage.saveBuffer({
      buffer, filename: 'template-boite-vitesses-manuelle.webp', mimeType: 'image/webp',
      metadata: { kind: 'gearbox-template' },
    });
    templateUrl = res.url;
    console.log('Template uploadé →', templateUrl, '  (réutilise-le : TEMPLATE_URL=' + templateUrl + ')');
  } else if (templateUrl) {
    console.log('Template réutilisé :', templateUrl);
  }

  let created = 0, updated = 0, failed = 0;
  for (const p of items) {
    const sku = str(p.sku);
    if (!sku) { failed++; continue; }
    if (DRY) {
      const exists = await Product.exists({ sku });
      console.log(`  ${exists ? '~' : '+'} ${sku}  ${str(p.nom).slice(0, 54)}  ${p.prix_ttc}€`);
      continue;
    }
    const fields = mapProduct(p, templateUrl);
    const wantPub = PUBLISH || str(p.statut) === 'publie';
    let done = false;
    for (let attempt = 0; attempt < 5 && !done; attempt++) {
      try {
        const slug = attempt === 0 ? fields.slug : `${fields.slug}-${attempt + 1}`;
        // isPublished : posé UNIQUEMENT à la création ($setOnInsert) → un re-import ne dé-publie jamais.
        // (sauf --publish qui force la publication.)
        const update = PUBLISH
          ? { $set: { sku, ...fields, slug, isPublished: true } }
          : { $set: { sku, ...fields, slug }, $setOnInsert: { isPublished: wantPub } };
        const r = await Product.updateOne({ sku }, update, { upsert: true });
        if (r.upsertedCount) created++; else updated++;
        done = true;
      } catch (e) {
        if (e.code === 11000 && /slug/.test(e.message) && attempt < 4) continue; // collision slug → suffixe
        failed++; console.error('  ✗', sku, e.message); done = true;
      }
    }
  }
  console.log(DRY ? '\n🟢 DRY-RUN terminé — rien écrit.' : `\n✅ créés ${created} · mis à jour ${updated} · échecs ${failed}`);
  if (!DRY && !PUBLISH) console.log('   (brouillon — publie depuis l\'admin ou relance avec --publish)');
  await mongoose.disconnect();
}
main().catch((e) => { console.error('ERREUR:', e.message); process.exit(1); });
