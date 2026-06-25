'use strict';

const AbandonedCart = require('../models/AbandonedCart');

// Envoie les devis instantanés PROGRAMMÉS arrivés à échéance (5 min après la
// capture par défaut, AUTO_DEVIS_DELAY_MS). Découplé de la requête HTTP :
// l'accusé de réception part à la soumission, le devis suit après le délai.
// Claim atomique scheduled -> sending = idempotence : un seul envoi même en
// multi-instance ou si le formulaire est resoumis.
async function processScheduledAutoDevis(now = new Date()) {
  const enabled = String(process.env.AUTO_DEVIS_ENABLED || '').toLowerCase() === 'true';
  if (!enabled) return { processed: 0, skipped: 'disabled' };
  const live = String(process.env.AUTO_DEVIS_LIVE || '').toLowerCase() === 'true';

  const due = await AbandonedCart.find({
    'engineQuote.autoDevis.status': 'scheduled',
    'engineQuote.autoDevis.dueAt': { $lte: now },
  }).limit(25);
  if (!due.length) return { processed: 0 };

  const engineQuoteAdmin = require('../controllers/engineQuoteAdminController');
  let processed = 0;
  for (const cart of due) {
    // Claim atomique : scheduled -> sending. Si modifiedCount===0, un autre
    // worker l'a déjà pris -> on saute (pas de double envoi).
    const claim = await AbandonedCart.updateOne(
      { _id: cart._id, 'engineQuote.autoDevis.status': 'scheduled' },
      { $set: { 'engineQuote.autoDevis.status': 'sending', 'engineQuote.autoDevis.claimedAt': new Date() } }
    );
    if (!claim.modifiedCount) continue;

    const offers = (cart.engineQuote && cart.engineQuote.autoDevis && cart.engineQuote.autoDevis.offers) || [];
    try {
      const r = await engineQuoteAdmin.sendInstantDevis(cart, { offers, dryRun: !live, sentByName: 'Devis automatique (différé)' });
      await AbandonedCart.updateOne(
        { _id: cart._id },
        { $set: {
          'engineQuote.autoDevis.status': (r && r.ok) ? 'sent' : 'error',
          'engineQuote.autoDevis.sentAt': new Date(),
          'engineQuote.autoDevis.result': (r && r.ok) ? 'ok' : ((r && r.reason) || 'fail'),
        } }
      );
      console.log(`[auto-devis-différé] ${live ? 'ENVOYÉ' : 'DRY-RUN'} → ${cart.email} · ${offers.length} devis · ok=${r && r.ok}`);
      processed += 1;
    } catch (err) {
      await AbandonedCart.updateOne(
        { _id: cart._id },
        { $set: { 'engineQuote.autoDevis.status': 'error', 'engineQuote.autoDevis.result': (err && err.message) || 'exception' } }
      );
      console.error('[auto-devis-différé] échec', String(cart._id), err && err.message);
    }
  }
  return { processed };
}

module.exports = { processScheduledAutoDevis };
