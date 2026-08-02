'use strict';

/**
 * Webhook Ringover.
 *
 * SÉCURITÉ — Ringover ne signe pas ses webhooks (vérifié dans leur
 * documentation : le payload ne porte ni HMAC ni token). La seule barrière est
 * donc le SECRET DANS L'URL, comparé en temps constant. Conséquences :
 *   - `RINGOVER_WEBHOOK_SECRET` doit être long et aléatoire (32+ caractères) ;
 *   - sans cette variable, la route répond 404 et n'écrit rien. Un webhook
 *     ouvert créerait des leads sur commande de n'importe qui.
 *
 * On répond TOUJOURS 200 sur un payload accepté, même si le traitement échoue :
 * Ringover réessaie sur erreur, et un rejeu ne réparerait pas une donnée
 * invalide — il ne ferait que remplir les logs. Les échecs sont tracés côté
 * serveur.
 */

const express = require('express');
const crypto = require('crypto');

const { recordMissedCall } = require('../../services/ringoverCalls');

const router = express.Router();

/** Comparaison à temps constant, tolérante aux longueurs différentes. */
function secretOk(recu) {
  const attendu = String(process.env.RINGOVER_WEBHOOK_SECRET || '');
  if (attendu.length < 16) return false;              // non configuré / trop faible
  const a = Buffer.from(String(recu || ''), 'utf8');
  const b = Buffer.from(attendu, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

/* Ringover peut nommer l'événement de plusieurs façons selon la configuration ;
   on accepte les variantes plutôt que d'en rater. */
const EVENEMENTS_MANQUES = new Set(['missed_call', 'missed', 'call_missed', 'voicemail']);

router.post('/webhook/:secret', express.json({ limit: '32kb' }), async (req, res) => {
  if (!secretOk(req.params.secret)) return res.status(404).end();

  const b = (req.body && typeof req.body === 'object') ? req.body : {};
  const evt = String(b.event || b.type || '').toLowerCase();

  /* Les autres événements (appel entrant, décroché) sont acquittés sans
     traitement : on ne veut pas que Ringover les rejoue indéfiniment. */
  if (!EVENEMENTS_MANQUES.has(evt)) return res.json({ ok: true, ignore: evt || 'inconnu' });

  try {
    const r = await recordMissedCall({
      callId: b.call_id || b.callId || b.id,
      callerNumber: b.caller_number || b.from_number || b.from,
      receiverNumber: b.receiver_number || b.to_number || b.to,
      at: b.timestamp || b.start_time || b.date,
    });
    if (!r.ok) console.error('[ringover] appel manqué non enregistré :', r.action, b.call_id || '');
    return res.json({ ok: true, action: r.action });
  } catch (err) {
    console.error('[ringover] erreur webhook :', err && err.message ? err.message : err);
    return res.json({ ok: true, action: 'erreur' });
  }
});

module.exports = router;
