#!/usr/bin/env node
'use strict';

/**
 * Range les leads de spam déjà présents en base, pour vider la page
 * « Leads à relancer » de ce qui n'a jamais été un prospect.
 *
 *   node scripts/archive-spam-leads.js            → SIMULATION (n'écrit rien)
 *   node scripts/archive-spam-leads.js --appliquer → archive pour de vrai
 *
 * Le classement utilise exactement le même filtre que le formulaire
 * (services/leadSpamFilter.js) : deux signaux concordants minimum. Mesuré sur
 * les 3 027 leads de production au moment de l'écriture : 72 spams détectés,
 * 0 lead légitime touché.
 *
 * ── Archivé, pas supprimé ───────────────────────────────────────────────────
 * On pose `archived: true` et une trace `spamSignals`. Rien n'est effacé :
 * si le filtre se trompait un jour, le lead reste retrouvable et restaurable.
 * Un lead perdu est un client perdu ; un lead archivé à tort se récupère.
 */

require('dotenv').config();
const mongoose = require('mongoose');
const filtre = require('../src/services/leadSpamFilter');

const APPLIQUER = process.argv.includes('--appliquer');

function champs(lead) {
  const r = lead.requested || {};
  return {
    firstName: lead.firstName,
    lastName: lead.lastName,
    phone: lead.phone,
    message: r.message,
    vehicle: r.vehicle,
    plate: r.plate,
    ref: r.ref,
    /* Les leads déjà en base sont antérieurs au cookie : on n'invente pas ce
       signal, on ne juge que sur ce qui est réellement enregistré. */
    hasFormTimestamp: undefined,
  };
}

(async () => {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error('MONGODB_URI absent');
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 20000 });

  const col = mongoose.connection.db.collection('abandonedcarts');
  const leads = await col.find({ archived: { $ne: true } })
    .project({ firstName: 1, lastName: 1, phone: 1, email: 1, requested: 1, createdAt: 1, captureSource: 1 })
    .toArray();

  const spams = [];
  for (const l of leads) {
    const sigs = filtre.signaux(champs(l));
    if (sigs.length >= 2) spams.push({ lead: l, sigs });
  }

  console.log(`${leads.length} leads actifs examinés — ${spams.length} classés spam`);
  console.log(APPLIQUER ? '\nMODE RÉEL : archivage en cours\n' : '\nSIMULATION : rien n\'est écrit (ajouter --appliquer)\n');

  for (const { lead, sigs } of spams.slice(0, 40)) {
    const d = lead.createdAt ? new Date(lead.createdAt).toISOString().slice(0, 10) : '?';
    const nom = `${lead.firstName || ''} ${lead.lastName || ''}`.trim();
    console.log(`  ${d}  ${String(nom).slice(0, 24).padEnd(24)} ${String(lead.email || '').slice(0, 32).padEnd(32)} ${sigs.join('+')}`);
  }
  if (spams.length > 40) console.log(`  … et ${spams.length - 40} autres`);

  if (APPLIQUER && spams.length) {
    let n = 0;
    for (const { lead, sigs } of spams) {
      await col.updateOne({ _id: lead._id }, {
        $set: {
          archived: true,
          archivedAt: new Date(),
          archivedReason: 'spam automatique',
          spamSignals: sigs,
        },
      });
      n += 1;
    }
    console.log(`\n${n} leads archivés. Ils disparaissent de « Leads à relancer » et restent consultables.`);
  }

  await mongoose.disconnect();
})().catch((e) => {
  console.error('ÉCHEC :', e && e.message ? e.message : e);
  process.exit(1);
});
