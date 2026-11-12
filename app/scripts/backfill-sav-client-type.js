'use strict';

/**
 * Backfill de `SavTicket.client.type` (B2B / B2C / inconnu) sur les tickets existants.
 *
 * Les tickets créés avant cette évolution portent tous la valeur par défaut 'B2C',
 * y compris ceux ouverts par des garages : le champ n'était jamais alimenté.
 *
 *   DRY-RUN (défaut) : node scripts/backfill-sav-client-type.js
 *   ÉCRITURE         : node scripts/backfill-sav-client-type.js --apply
 *
 * Le dry-run n'écrit RIEN et affiche exactement ce qui serait modifié.
 * Aucun email n'est envoyé : on écrit le champ via updateOne, sans déclencher
 * les hooks `save` du modèle (donc pas de recalcul de SLA sur l'historique —
 * volontaire : on ne réécrit pas le passé, on ne fait que qualifier).
 */

require('dotenv').config();
const mongoose = require('mongoose');
const SavTicket = require('../src/models/SavTicket');
const { resolveClientType } = require('../src/services/savClientType');

const APPLY = process.argv.includes('--apply');

(async () => {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI absent — abandon.');
    process.exit(1);
  }
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
  console.log(APPLY ? '>>> MODE ÉCRITURE <<<\n' : '>>> DRY-RUN (aucune écriture) <<<\n');

  const tickets = await SavTicket.find({})
    .select('numero client.email client.type client.typeSource numeroCommande motifSav')
    .lean();

  const stats = { B2B: 0, B2C: 0, inconnu: 0 };
  const sources = {};
  const changes = [];

  for (const t of tickets) {
    const r = await resolveClientType({
      email: t.client && t.client.email,
      numeroCommande: t.numeroCommande,
    });
    stats[r.type] = (stats[r.type] || 0) + 1;
    sources[r.source] = (sources[r.source] || 0) + 1;

    const avant = (t.client && t.client.type) || '(vide)';
    if (avant !== r.type) changes.push({ numero: t.numero, avant, apres: r.type, source: r.source });

    if (APPLY) {
      await SavTicket.updateOne(
        { _id: t._id },
        { $set: { 'client.type': r.type, 'client.typeSource': r.source } }
      );
    }
  }

  console.log(`Tickets analysés : ${tickets.length}\n`);
  console.log('Répartition résolue :');
  console.log(`  B2B (pro)         ${String(stats.B2B || 0).padStart(4)}`);
  console.log(`  B2C (particulier) ${String(stats.B2C || 0).padStart(4)}`);
  console.log(`  inconnu           ${String(stats.inconnu || 0).padStart(4)}`);
  console.log('\nSource du rapprochement :');
  Object.entries(sources).sort((a, b) => b[1] - a[1])
    .forEach(([k, v]) => console.log(`  ${k.padEnd(18)} ${String(v).padStart(4)}`));

  console.log(`\nTickets qui changent de valeur : ${changes.length}`);
  changes.slice(0, 15).forEach((c) =>
    console.log(`  ${c.numero.padEnd(16)} ${c.avant} → ${c.apres}  (${c.source})`));
  if (changes.length > 15) console.log(`  … et ${changes.length - 15} autres`);

  if (!APPLY) console.log('\nRien n’a été écrit. Relancer avec --apply pour appliquer.');
  else console.log('\nBackfill appliqué.');

  await mongoose.disconnect();
})().catch((e) => { console.error('ERREUR:', e && e.message); process.exit(1); });
