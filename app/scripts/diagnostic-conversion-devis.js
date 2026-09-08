/**
 * DIAGNOSTIC CONVERSION — tunnel devis moteurs/boîtes. 100% LECTURE SEULE.
 * Objectif : identifier la VRAIE cause du faible taux de conversion en découpant
 * les leads en 3 familles de perte :
 *   A. jamais ATTEINTS  (aucun signal : ni ouverture, ni vue, ni clic)  → problème CANAL
 *   B. atteints mais pas convaincus (vu/cliqué mais pas payé)           → problème OFFRE (prix/confiance)
 *   C. voulaient payer mais pas payé (clic paiement sans paiement)      → problème PAIEMENT (acompte/friction)
 *
 * Usage :  node scripts/diagnostic-conversion-devis.js            # 90 jours
 *          PERIOD_DAYS=180 node scripts/diagnostic-conversion-devis.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const AbandonedCart = require('../src/models/AbandonedCart');

const DAYS = parseInt(process.env.PERIOD_DAYS || '90', 10);
const MS_DAY = 24 * 3600 * 1000;

const med = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); const m = Math.floor(s.length / 2); return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (n, d) => (d > 0 ? Math.round((n / d) * 1000) / 10 + '%' : '—');
const eur = (n) => (n == null ? '—' : Math.round(n).toLocaleString('fr-FR') + ' €');
const hrs = (ms) => (ms == null ? '—' : ms < 3600e3 ? Math.round(ms / 60e3) + ' min' : ms < 48 * 3600e3 ? (ms / 3600e3).toFixed(1) + ' h' : (ms / MS_DAY).toFixed(1) + ' j');

async function main() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI manquant');
  await mongoose.connect(uri);
  const since = new Date(Date.now() - DAYS * MS_DAY);

  // leads devis (landing moteurs + boîtes)
  const carts = await AbandonedCart.find({
    captureSource: { $in: ['landing_moteurs', 'landing_boites'] }, // même périmètre que /admin/devis-moteurs
    createdAt: { $gte: since },
  }).select('createdAt captureSource phone email gclid requested engineQuote').lean();

  console.log(`\n════════ DIAGNOSTIC CONVERSION DEVIS — ${DAYS} derniers jours ════════`);
  console.log(`Leads : ${carts.length}`);
  if (!carts.length) { await mongoose.disconnect(); return; }

  const S = { leads: carts.length, quoted: 0, unquoted: 0, converted: 0, won: 0, lost: 0, silent: [] };
  const respTimes = [], convRespTimes = [];
  const buckets = { '<2h': [0, 0], '2-8h': [0, 0], '8-24h': [0, 0], '>24h': [0, 0] }; // [n, conv]
  const prices = { conv: [], lost: [], noReaction: [] };
  const deposits = { conv: [], all: [] };
  const reach = { A_jamais_atteint: 0, B_vu_pas_paye: 0, C_clicPay_pas_paye: 0, OK_converti: 0 };
  const smsStatus = {}; let noEmail = 0, noPhone = 0;
  const bySource = {}; const byCondition = {}; const relance = { avec: [0, 0], sans: [0, 0] };
  let multiVersion = 0; const quoteToPayDelays = [];

  for (const c of carts) {
    const eq = c.engineQuote || {}; const sq = Array.isArray(eq.sentQuotes) ? eq.sentQuotes : [];
    const status = eq.status || 'new';
    const isConv = status === 'acompte_recu' || status === 'won';
    if (isConv) S.converted++; if (status === 'won') S.won++; if (status === 'lost') S.lost++;
    if (!c.email) noEmail++; if (!c.phone) noPhone++;

    const src = (c.gclid ? 'GoogleAds' : 'autre') + '/' + (c.captureSource || '?');
    bySource[src] = bySource[src] || [0, 0]; bySource[src][0]++; if (isConv) bySource[src][1]++;

    const cond = (eq.condition || (c.requested && c.requested.condition) || eq.conditionKey || '?').toString().slice(0, 22);
    byCondition[cond] = byCondition[cond] || [0, 0]; byCondition[cond][0]++; if (isConv) byCondition[cond][1]++;

    if (!sq.length) { S.unquoted++; continue; }
    S.quoted++;
    if (sq.length > 1) multiVersion++;

    const last = sq[sq.length - 1];
    const anyOpen = sq.some((s) => s.openedAt), anyView = sq.some((s) => s.pdfViewedAt), anyPay = sq.some((s) => s.payClickedAt);

    // le découpage décisif A/B/C
    if (isConv) reach.OK_converti++;
    else if (anyPay) reach.C_clicPay_pas_paye++;
    else if (anyView || anyOpen) reach.B_vu_pas_paye++;
    else reach.A_jamais_atteint++;

    // vitesse de réponse
    const first = sq.reduce((m, s) => (!m || new Date(s.sentAt) < new Date(m) ? s.sentAt : m), null);
    if (first && c.createdAt) {
      const dt = new Date(first) - new Date(c.createdAt);
      if (dt >= 0) {
        respTimes.push(dt); if (isConv) convRespTimes.push(dt);
        const b = dt < 2 * 3600e3 ? '<2h' : dt < 8 * 3600e3 ? '2-8h' : dt < 24 * 3600e3 ? '8-24h' : '>24h';
        buckets[b][0]++; if (isConv) buckets[b][1]++;
      }
    }

    // prix / acompte
    const px = last.sellPriceTtc || 0;
    if (px > 0) {
      if (isConv) prices.conv.push(px);
      else if (status === 'lost') prices.lost.push(px);
      if (!anyOpen && !anyView && !anyPay && !isConv) prices.noReaction.push(px);
    }
    if (last.depositCents > 0) { deposits.all.push(last.depositCents / 100); if (isConv) deposits.conv.push(last.depositCents / 100); }

    // délai devis → clic paiement (pour les convertis)
    const payAt = sq.map((s) => s.payClickedAt).filter(Boolean).sort()[0];
    if (isConv && payAt && first) quoteToPayDelays.push(new Date(payAt) - new Date(first));

    // SMS
    for (const s of sq) if (s.sms && s.sms.status) smsStatus[s.sms.status] = (smsStatus[s.sms.status] || 0) + 1;

    // relances client envoyées ?
    const rem = Array.isArray(eq.remindersSent) ? eq.remindersSent : (Array.isArray(eq.reminders) ? eq.reminders : []);
    const hasRel = rem.length > 0;
    relance[hasRel ? 'avec' : 'sans'][0]++; if (isConv) relance[hasRel ? 'avec' : 'sans'][1]++;
  }

  console.log(`\n── FUNNEL ──`);
  console.log(`chiffrés ${S.quoted} (${pct(S.quoted, S.leads)}) · NON chiffrés ${S.unquoted} (${pct(S.unquoted, S.leads)}) · convertis ${S.converted} (${pct(S.converted, S.leads)} des leads, ${pct(S.converted, S.quoted)} des chiffrés) · perdus ${S.lost}`);

  console.log(`\n── 🎯 OÙ MEURENT LES DEVIS (le découpage décisif, sur ${S.quoted} chiffrés) ──`);
  console.log(`A. JAMAIS ATTEINTS (0 signal)      : ${reach.A_jamais_atteint} (${pct(reach.A_jamais_atteint, S.quoted)})  → cause CANAL (email spam / SMS / coordonnées)`);
  console.log(`B. VU mais pas convaincu           : ${reach.B_vu_pas_paye} (${pct(reach.B_vu_pas_paye, S.quoted)})  → cause OFFRE (prix / confiance / concurrence)`);
  console.log(`C. CLIC PAIEMENT sans paiement     : ${reach.C_clicPay_pas_paye} (${pct(reach.C_clicPay_pas_paye, S.quoted)})  → cause PAIEMENT (acompte / friction Mollie)`);
  console.log(`✓ Convertis                        : ${reach.OK_converti} (${pct(reach.OK_converti, S.quoted)})`);

  console.log(`\n── VITESSE DE RÉPONSE (lead → 1er devis) ──`);
  console.log(`médiane : ${hrs(med(respTimes))} · médiane des CONVERTIS : ${hrs(med(convRespTimes))}`);
  for (const [b, [n, cv]] of Object.entries(buckets)) console.log(`  ${b.padEnd(6)} : ${String(n).padStart(4)} devis → ${cv} conv (${pct(cv, n)})`);

  console.log(`\n── PRIX (TTC dernier devis) ──`);
  console.log(`convertis : méd ${eur(med(prices.conv))} (n=${prices.conv.length}) · perdus : méd ${eur(med(prices.lost))} (n=${prices.lost.length}) · sans AUCUNE réaction : méd ${eur(med(prices.noReaction))} (n=${prices.noReaction.length})`);
  console.log(`acompte : méd ${eur(med(deposits.all))} (tous) · ${eur(med(deposits.conv))} (convertis)`);
  console.log(`délai devis → clic paiement (convertis) : méd ${hrs(med(quoteToPayDelays))}`);

  console.log(`\n── CANAL ──`);
  console.log(`leads sans email : ${noEmail} · sans téléphone : ${noPhone}`);
  console.log(`statuts SMS devis :`, Object.entries(smsStatus).map(([k, v]) => `${k}:${v}`).join(' · ') || '(aucun)');

  console.log(`\n── PAR SOURCE ──`);
  for (const [s, [n, cv]] of Object.entries(bySource).sort((a, b) => b[1][0] - a[1][0]).slice(0, 8)) console.log(`  ${s.padEnd(34)} ${String(n).padStart(4)} leads → ${cv} conv (${pct(cv, n)})`);

  console.log(`\n── PAR ÉTAT SOUHAITÉ ──`);
  for (const [k, [n, cv]] of Object.entries(byCondition).sort((a, b) => b[1][0] - a[1][0]).slice(0, 6)) console.log(`  ${k.padEnd(24)} ${String(n).padStart(4)} leads → ${cv} conv (${pct(cv, n)})`);

  console.log(`\n── RELANCE / SUIVI ──`);
  console.log(`devis multi-versions (re-chiffrés) : ${multiVersion}/${S.quoted}`);
  console.log(`avec relance auto : ${relance.avec[0]} → ${relance.avec[1]} conv (${pct(relance.avec[1], relance.avec[0])}) · sans : ${relance.sans[0]} → ${relance.sans[1]} conv (${pct(relance.sans[1], relance.sans[0])})`);
  console.log(`\n(lecture seule — aucune écriture effectuée)\n`);
  await mongoose.disconnect();
}
main().catch((e) => { console.error('ERREUR:', e.message); process.exit(1); });
