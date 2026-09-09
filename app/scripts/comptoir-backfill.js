/**
 * Reprise de l'historique des ventes vers Comptoir (getcomptoir.fr).
 *
 * Le connecteur pousse les commandes AU FIL DE L'EAU à partir de sa mise en
 * service. Ce script sert une seule fois, au démarrage : envoyer les ventes
 * déjà encaissées pour que le tableau de bord ne parte pas de zéro.
 *
 * Sûr à relancer : Comptoir ignore un `externalId` déjà connu (anti-doublon),
 * et le script saute de toute façon les commandes déjà marquées envoyées.
 *
 * ⚠ Le statut envoyé est FIGÉ à l'arrivée chez Comptoir (leur API ne met pas à
 * jour une commande existante). Une commande livrée partira donc bien en
 * « livree » ici, contrairement au flux temps réel qui envoie « preparation »
 * au paiement.
 *
 * Utilisation :
 *   node scripts/comptoir-backfill.js                 # simulation, 12 derniers mois
 *   node scripts/comptoir-backfill.js --apply         # envoie pour de vrai
 *   node scripts/comptoir-backfill.js --days=90       # fenêtre
 *   node scripts/comptoir-backfill.js --limit=50      # plafond d'envois
 *   node scripts/comptoir-backfill.js --apply --all   # tout l'historique
 *   node scripts/comptoir-backfill.js --apply --force # RENVOIE aussi les déjà envoyées
 *
 * `--force` sert quand Comptoir fait évoluer son ingestion et redemande les
 * commandes (vécu : 251 ventes arrivées sans produit rattaché ; le renvoi du
 * même externalId les a complétées, réponse `backfilled: true`).
 *
 * Prérequis : COMPTOIR_API_KEY dans l'environnement (même clé que sur Render).
 */
try { require('dotenv').config(); } catch (_) {}
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');
const ALL = process.argv.includes('--all');
const FORCE = process.argv.includes('--force');
const arg = (name, def) => {
  const a = process.argv.find((x) => x.startsWith(`--${name}=`));
  if (!a) return def;
  const n = parseInt(a.split('=')[1], 10);
  return Number.isFinite(n) && n > 0 ? n : def;
};
const WINDOW_DAYS = arg('days', 365);
const LIMIT = arg('limit', 500);
const PAUSE_MS = arg('pause', 250);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const comptoir = require('../src/services/comptoir');

  if (!comptoir.isConfigured()) {
    console.error('COMPTOIR_API_KEY absente : rien à faire.');
    console.error('Créer le connecteur dans Comptoir (Connecteurs → + Connecteur personnalisé),');
    console.error('puis relancer avec COMPTOIR_API_KEY=... node scripts/comptoir-backfill.js');
    process.exit(1);
  }

  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI absente.'); process.exit(1); }
  await mongoose.connect(uri);

  const Order = require('../src/models/Order');

  const filter = {
    paymentStatus: { $in: ['paid', 'captured', 'completed'] },
    deletedAt: null,
  };
  /* Sans --force, on ne reprend que ce qui n'est jamais parti. */
  if (!FORCE) filter.$or = [{ 'comptoir.sentAt': null }, { 'comptoir.sentAt': { $exists: false } }];
  if (!ALL) filter.createdAt = { $gte: new Date(Date.now() - WINDOW_DAYS * 86400000) };

  const orders = await Order.find(filter)
    .select('_id number status paymentStatus totalCents createdAt items billingAddress shippingAddress molliePaidAt scalapayCapturedAt')
    .sort({ createdAt: 1 })
    .limit(LIMIT)
    .lean();

  console.log(`Endpoint     : ${comptoir.getEndpoint()}`);
  console.log(`Fenêtre      : ${ALL ? 'tout l\'historique' : WINDOW_DAYS + ' jours'} · plafond ${LIMIT}`);
  console.log(`À envoyer    : ${orders.length} commande(s)`);
  console.log(`Mode         : ${APPLY ? 'ENVOI RÉEL' : 'SIMULATION (ajouter --apply pour envoyer)'}${FORCE ? ' · --force : renvoie aussi les déjà envoyées' : ''}`);
  console.log('');

  const out = { sent: 0, duplicates: 0, errors: 0, ignorees: 0 };

  for (const o of orders) {
    const p = comptoir.buildPayload(o);
    const ligne = `${p.externalId.padEnd(16)} ${String(p.amount).padStart(9)} €  ${p.status.padEnd(12)} ${p.productName || ''}`;

    if (!APPLY) { console.log('  [simulation] ' + ligne); continue; }

    const r = await comptoir.syncOrder(o._id, { force: FORCE });
    if (r.ok && !r.skipped) {
      out.sent++;
      if (r.duplicate) out.duplicates++;
      console.log(`  ✓ ${ligne}${r.duplicate ? '  (déjà connue)' : ''}`);
    } else if (r.skipped) {
      out.ignorees++;
      console.log(`  – ${ligne}  (${r.reason})`);
    } else {
      out.errors++;
      console.log(`  ✗ ${ligne}  → ${r.error}`);
      /* Clé morte : inutile de marteler leur API pour rien. */
      if (r.permanent && /401/.test(String(r.error))) break;
    }
    await sleep(PAUSE_MS);
  }

  if (APPLY) {
    console.log('');
    console.log(`Envoyées ${out.sent} · dont déjà connues ${out.duplicates} · ignorées ${out.ignorees} · erreurs ${out.errors}`);
  }

  await mongoose.disconnect();
}

main().catch((e) => { console.error(e); process.exit(1); });
