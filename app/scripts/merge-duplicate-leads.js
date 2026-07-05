/**
 * Fusion des leads en double (/admin/activite-panier).
 *
 * Pourquoi : historiquement, le même client pouvait générer plusieurs leads —
 *   - détection panier dédupliquée par SESSION seulement (téléphone + PC = 2 leads) ;
 *   - plaque non normalisée (« GD-694-FM » ≠ « GD694FM » → 1 lead par formatage) ;
 *   - téléphone jamais utilisé pour la déduplication.
 * Le code est corrigé pour l'avenir ; ce script nettoie l'existant.
 *
 * Ce qu'il fait :
 *   1. Normalise `requested.plate` (majuscules alphanumériques) sur tous les leads.
 *   2. Regroupe les leads par identité (email, sinon téléphone normalisé),
 *      puis par véhicule (plaque) : même client + même plaque = fusion.
 *      Deux plaques différentes = deux véhicules = leads séparés (voulu).
 *   3. Fusionne chaque groupe dans le lead le plus riche (celui qui porte un
 *      devis envoyé/paiement, sinon le plus récent) : contacts complétés,
 *      articles réunis, statuts au plus avancé, notes concaténées, compteurs
 *      additionnés. Les doublons vidés sont SUPPRIMÉS.
 *
 * Garde-fous :
 *   - MODE SIMULATION par défaut : n'écrit RIEN, affiche le plan complet.
 *   - Ne fusionne JAMAIS deux leads portant chacun un devis envoyé ou un
 *     paiement (conflit signalé, à arbitrer à la main).
 *
 * Utilisation :
 *   node scripts/merge-duplicate-leads.js                # simulation
 *   node scripts/merge-duplicate-leads.js --apply        # applique
 *   node scripts/merge-duplicate-leads.js --days=180     # fenêtre (défaut 90 j)
 */
try { require('dotenv').config(); } catch (_) {}
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const daysArg = process.argv.find((a) => a.startsWith('--days='));
const WINDOW_DAYS = daysArg ? Math.max(1, parseInt(daysArg.split('=')[1], 10) || 90) : 90;

function normPlate(v) {
  return String(v || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32);
}

const STATUS_RANK = { abandoned: 0, reminded_1: 1, reminded_2: 2, reminded_3: 3, expired: 4, recovered: 5 };
const MANUAL_RANK = { null: 0, contacted: 1, lost: 2, converted: 3 };

function isPrecious(doc) {
  const eq = doc.engineQuote || null;
  if (!eq) return false;
  if (Array.isArray(eq.sentQuotes) && eq.sentQuotes.length) return true;
  if (eq.payment && eq.payment.status === 'paid') return true;
  return false;
}

function maxDate(a, b) { if (!a) return b || null; if (!b) return a; return a > b ? a : b; }
function minDate(a, b) { if (!a) return b || null; if (!b) return a; return a < b ? a : b; }

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI manquant.'); process.exit(1); }
  await mongoose.connect(uri);
  const AbandonedCart = require('../src/models/AbandonedCart');
  const { normalizePhoneFR } = require('../src/services/smsService');

  console.log(`\n=== FUSION DES LEADS EN DOUBLE ${APPLY ? '(APPLICATION RÉELLE)' : '(SIMULATION — rien n\'est modifié)'} ===`);
  console.log('Base    :', uri.replace(/\/\/[^@]*@/, '//***@'));
  console.log('Fenêtre :', WINDOW_DAYS, 'jours\n');

  /* ── Phase 1 : normalisation des plaques ─────────────────────────────── */
  const toNormalize = await AbandonedCart.find({ 'requested.plate': { $regex: /[^A-Z0-9]/ } })
    .select('_id requested.plate').lean();
  console.log(`Phase 1 — plaques à normaliser : ${toNormalize.length}`);
  if (APPLY && toNormalize.length) {
    for (const d of toNormalize) {
      await AbandonedCart.updateOne({ _id: d._id }, { $set: { 'requested.plate': normPlate(d.requested.plate) } });
    }
    console.log('  ✓ normalisées');
  } else if (toNormalize.length) {
    toNormalize.slice(0, 10).forEach((d) => console.log(`  « ${d.requested.plate} » → « ${normPlate(d.requested.plate)} »`));
    if (toNormalize.length > 10) console.log(`  … +${toNormalize.length - 10} autres`);
  }

  /* ── Phase 2 : groupement par identité ───────────────────────────────── */
  const cutoff = new Date(Date.now() - WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const docs = await AbandonedCart.find({ lastActivityAt: { $gte: cutoff } }).lean();
  console.log(`\nPhase 2 — leads dans la fenêtre : ${docs.length}`);

  const groups = new Map();
  for (const d of docs) {
    const email = String(d.email || '').trim().toLowerCase();
    const phoneE164 = normalizePhoneFR(d.phone || '') || '';
    const identity = email ? `mail:${email}` : (phoneE164 ? `tel:${phoneE164}` : '');
    if (!identity) continue; // anonyme, rien à fusionner
    if (!groups.has(identity)) groups.set(identity, []);
    groups.get(identity).push(d);
  }

  const dupGroups = Array.from(groups.entries()).filter(([, arr]) => arr.length > 1);
  console.log(`Clients avec plusieurs leads : ${dupGroups.length}\n`);

  const report = { merged: 0, deleted: 0, conflicts: 0, groups: 0 };

  for (const [identity, arr] of dupGroups) {
    /* Sous-groupes par plaque (un véhicule = un lead). Les leads SANS plaque
       rejoignent l'unique plaque du client s'il n'y en a qu'une (bruit panier/
       newsletter autour d'une vraie demande), sinon ils restent entre eux. */
    const buckets = new Map();
    for (const d of arr) {
      const p = normPlate(d.requested && d.requested.plate);
      if (!buckets.has(p)) buckets.set(p, []);
      buckets.get(p).push(d);
    }
    const plateKeys = Array.from(buckets.keys()).filter((k) => k !== '');
    if (plateKeys.length === 1 && buckets.has('')) {
      buckets.get(plateKeys[0]).push(...buckets.get(''));
      buckets.delete('');
    }

    for (const [plate, bucket] of buckets.entries()) {
      if (bucket.length < 2) continue;
      report.groups += 1;

      const precious = bucket.filter(isPrecious);
      if (precious.length > 1) {
        report.conflicts += 1;
        console.log(`⚠ CONFLIT — ${identity}${plate ? ` (plaque ${plate})` : ''} : ${precious.length} leads portent un devis/paiement — fusion manuelle requise (ids: ${precious.map((d) => d._id).join(', ')})`);
        continue;
      }

      bucket.sort((a, b) => new Date(b.lastActivityAt || 0) - new Date(a.lastActivityAt || 0));
      const winner = precious[0] || bucket[0];
      const losers = bucket.filter((d) => String(d._id) !== String(winner._id));

      console.log(`— ${identity}${plate ? ` (plaque ${plate})` : ''} : ${bucket.length} leads → garde ${winner._id} (${winner.captureSource || 'sans source'}${isPrecious(winner) ? ', devis/paiement' : ''}), fusionne ${losers.length}`);

      if (!APPLY) { report.merged += 1; report.deleted += losers.length; continue; }

      /* Construction de la fusion */
      const set = {};
      const now = new Date();

      const pick = (field) => { if (!winner[field]) { const src = losers.find((l) => l[field]); if (src) set[field] = src[field]; } };
      ['email', 'phone', 'firstName', 'lastName'].forEach(pick);

      /* Items : union par produit */
      const itemMap = new Map();
      [winner, ...losers].forEach((d) => (d.items || []).forEach((it) => {
        const k = String(it.productId);
        if (!itemMap.has(k)) itemMap.set(k, it);
      }));
      const mergedItems = Array.from(itemMap.values());
      if (mergedItems.length !== (winner.items || []).length) {
        set.items = mergedItems;
        set.totalAmountCents = mergedItems.reduce((s, it) => s + (Number(it.price) || 0) * (Number(it.quantity) || 1), 0);
      }

      /* Statut auto : le plus avancé ; dates englobantes */
      const bestStatus = bucket.reduce((acc, d) => (STATUS_RANK[d.status] > STATUS_RANK[acc] ? d.status : acc), winner.status);
      if (bestStatus !== winner.status) set.status = bestStatus;
      const anyRecoveredAt = bucket.reduce((acc, d) => maxDate(acc, d.recoveredAt), null);
      if (anyRecoveredAt && !winner.recoveredAt) set.recoveredAt = anyRecoveredAt;
      const lastRem = bucket.reduce((acc, d) => maxDate(acc, d.lastRemindedAt), null);
      if (lastRem && String(lastRem) !== String(winner.lastRemindedAt)) set.lastRemindedAt = lastRem;
      set.abandonedAt = bucket.reduce((acc, d) => minDate(acc, d.abandonedAt), winner.abandonedAt);
      set.lastActivityAt = bucket.reduce((acc, d) => maxDate(acc, d.lastActivityAt), winner.lastActivityAt);

      /* Statut manuel : le plus fort (converted > lost > contacted) */
      const bestManual = bucket.reduce((acc, d) => ((MANUAL_RANK[d.manualStatus] || 0) > (MANUAL_RANK[acc] || 0) ? d.manualStatus : acc), winner.manualStatus || null);
      if (bestManual && bestManual !== winner.manualStatus) set.manualStatus = bestManual;

      /* requested : complète les champs vides */
      const wr = winner.requested || {};
      ['vehicle', 'vin', 'plate', 'ref', 'message'].forEach((k) => {
        if (!wr[k]) { const src = losers.find((l) => l.requested && l.requested[k]); if (src) set[`requested.${k}`] = src.requested[k]; }
      });

      /* attribution (gclid Google Ads…) : ne pas perdre */
      if (!(winner.attribution && winner.attribution.source)) {
        const src = losers.find((l) => l.attribution && l.attribution.source);
        if (src) set.attribution = src.attribution;
      }
      if (!(winner.googleAdsUpload && winner.googleAdsUpload.leadAt)) {
        const src = losers.find((l) => l.googleAdsUpload && l.googleAdsUpload.leadAt);
        if (src) set['googleAdsUpload.leadAt'] = src.googleAdsUpload.leadAt;
      }

      /* Compteurs + notes */
      const sumE = bucket.reduce((s, d) => s + (d.manualEmailsSent || 0), 0);
      const sumS = bucket.reduce((s, d) => s + (d.manualSmsSent || 0), 0);
      if (sumE !== (winner.manualEmailsSent || 0)) set.manualEmailsSent = sumE;
      if (sumS !== (winner.manualSmsSent || 0)) set.manualSmsSent = sumS;
      const lmc = bucket.reduce((acc, d) => maxDate(acc, d.lastManualContactAt), null);
      if (lmc && String(lmc) !== String(winner.lastManualContactAt)) set.lastManualContactAt = lmc;

      const loserNotes = losers.flatMap((l) => (l.notes || []));
      const mergeNote = {
        text: `🔀 Fusion de ${losers.length} doublon(s) (${losers.map((l) => `${l._id} [${l.captureSource || '—'}]`).join(', ')}) — script merge-duplicate-leads`,
        addedByName: 'Script fusion',
        addedAt: now,
      };

      await AbandonedCart.updateOne(
        { _id: winner._id },
        { $set: set, $push: { notes: { $each: [...loserNotes, mergeNote] } } }
      );
      await AbandonedCart.deleteMany({ _id: { $in: losers.map((l) => l._id) } });
      report.merged += 1;
      report.deleted += losers.length;
    }
  }

  console.log(`\n=== RÉSULTAT ${APPLY ? '' : '(simulation)'} ===`);
  console.log(`Groupes fusionnés : ${report.merged}`);
  console.log(`Doublons supprimés : ${report.deleted}`);
  console.log(`Conflits à arbitrer à la main : ${report.conflicts}`);
  if (!APPLY) console.log('\n→ Pour appliquer : node scripts/merge-duplicate-leads.js --apply\n');
  await mongoose.disconnect();
})().catch((e) => { console.error('ERR', e && e.message ? e.message : e); process.exit(1); });
