// ---------------------------------------------------------------------------
// backfill-sav-ticket-conversation.js
//
// Pour chaque ticket SAV existant qui n'a pas encore de premier message client
// `inapp`, crée ce message à partir de `diagnostic.description` (ou un texte
// par défaut) et y rattache les pièces jointes pertinentes issues de
// `documentsList[]` en tant qu'`attachments[]`.
//
// Usage :
//   node scripts/backfill-sav-ticket-conversation.js          # dry-run
//   node scripts/backfill-sav-ticket-conversation.js --apply  # applique
// ---------------------------------------------------------------------------

require('dotenv').config();
const mongoose = require('mongoose');

const APPLY = process.argv.includes('--apply');

// Types de documents qu'on considère comme "remontés par le client" et donc
// affichables dans la conversation publique.
const CLIENT_DOC_KINDS = new Set([
  'client_upload',
  'factureMontage',
  'photoObd',
  'photoPiece',
  'photoVisuelle',
  'confirmationReglageBase',
  'photoCompteur',
  'bonGarantie',
  'autre',
]);

(async () => {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI manquant.');
    process.exit(1);
  }

  await mongoose.connect(process.env.MONGODB_URI);
  const SavTicket = require('../src/models/SavTicket');

  const tickets = await SavTicket.find({}).select(
    '_id numero createdAt diagnostic documentsList messages'
  );

  console.log(`[sav-backfill] ${tickets.length} ticket(s) trouvé(s)`);
  console.log(`[sav-backfill] mode : ${APPLY ? 'APPLY (écriture)' : 'DRY-RUN (lecture seule)'}\n`);

  let toUpdate = 0;
  let skippedAlreadyOk = 0;
  let updated = 0;

  for (const t of tickets) {
    const messages = Array.isArray(t.messages) ? t.messages : [];
    const hasClientInapp = messages.some(
      (m) => m && m.auteur === 'client' && m.canal === 'inapp'
    );
    if (hasClientInapp) {
      skippedAlreadyOk++;
      continue;
    }

    const description = (t.diagnostic && typeof t.diagnostic.description === 'string')
      ? t.diagnostic.description.trim()
      : '';
    const contenu = description || 'Demande SAV créée via le formulaire en ligne.';

    const docs = Array.isArray(t.documentsList) ? t.documentsList : [];
    const attachments = docs
      .filter((d) => d && d.url && (CLIENT_DOC_KINDS.has(d.kind) || !d.kind))
      .map((d) => ({
        url: d.url,
        originalName: d.originalName || '',
        size: typeof d.size === 'number' ? d.size : 0,
        mime: d.mime || '',
        kind: d.kind || '',
      }));

    toUpdate++;
    console.log(
      `  ${APPLY ? 'UPDATE' : 'WOULD UPDATE'} ${t.numero} : +1 message client inapp ` +
      `(contenu=${description ? `"${description.slice(0, 40)}…"` : 'défaut'}, ` +
      `attachments=${attachments.length})`
    );

    if (APPLY) {
      // On insère le message en tête, daté de createdAt, pour qu'il apparaisse
      // comme le premier échange du dossier.
      const newMsg = {
        date: t.createdAt || new Date(),
        auteur: 'client',
        canal: 'inapp',
        contenu,
        attachments,
      };
      t.messages = [newMsg, ...messages];
      try {
        await t.save();
        updated++;
      } catch (err) {
        console.error(`    ERREUR save ${t.numero} :`, err && err.message ? err.message : err);
      }
    }
  }

  console.log(`\n[sav-backfill] résumé :`);
  console.log(`  tickets analysés         : ${tickets.length}`);
  console.log(`  déjà conformes (ignorés) : ${skippedAlreadyOk}`);
  console.log(`  à mettre à jour          : ${toUpdate}`);
  if (APPLY) {
    console.log(`  effectivement mis à jour : ${updated}`);
  } else {
    console.log(`\n  Pour appliquer : node scripts/backfill-sav-ticket-conversation.js --apply`);
  }

  await mongoose.disconnect();
  process.exit(0);
})().catch((err) => {
  console.error('Fatal :', err);
  process.exit(1);
});
