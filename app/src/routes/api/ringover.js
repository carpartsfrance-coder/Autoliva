'use strict';

/**
 * Webhooks Ringover — trois événements.
 *
 *   `missed_call`         un appel manqué devient un lead à rappeler
 *   `sms` / `received`    la réponse du client revient sur sa fiche
 *   `ivr_response_code`   le code saisi dans le menu vocal donne le motif
 *
 * ── SÉCURITÉ, DEUX BARRIÈRES ────────────────────────────────────────────────
 *
 * 1. SECRET DANS L'URL, toujours vérifié. C'est la seule protection possible
 *    pour `ivr_response_code`, que Ringover N'ENVOIE PAS SIGNÉ (leur
 *    documentation le dit et recommande précisément une URL secrète).
 *
 * 2. SIGNATURE, vérifiée quand elle est présente. Les événements d'appel sont
 *    signés (JWT HS512 en V1, HMAC-SHA256 en V3). Si `RINGOVER_WEBHOOK_KEY`
 *    est posée et qu'une signature accompagne la requête, elle DOIT être
 *    valide — sinon on refuse.
 *
 * La signature ne remplace donc pas le secret : elle s'y ajoute. Une requête
 * sans signature reste acceptée (cas normal du SVI), mais une signature
 * présente et fausse est un rejet net.
 *
 * ── CORPS BRUT ──────────────────────────────────────────────────────────────
 *
 * La vérification porte sur les octets reçus, pas sur l'objet re-sérialisé :
 * `JSON.stringify(JSON.parse(x))` ne redonne pas `x`. D'où `express.raw` puis
 * un `JSON.parse` manuel.
 */

const express = require('express');
const crypto = require('crypto');

const { recordMissedCall, recordSmsReply, recordIvrCode } = require('../../services/ringoverCalls');
const { verifier } = require('../../services/ringoverSignature');

const router = express.Router();

/* Avertissement au démarrage : sans cette variable la route est inerte, et
   rien dans le comportement observable ne le dit. Autant l'écrire une fois
   dans les logs plutôt que de laisser chercher. */
{
  const s = String(process.env.RINGOVER_WEBHOOK_SECRET || '').trim();
  if (!s) console.warn('[ringover] RINGOVER_WEBHOOK_SECRET absent — webhooks desactives');
  else if (s.length < 16) console.warn('[ringover] RINGOVER_WEBHOOK_SECRET trop court ('
    + s.length + ') — webhooks desactives, minimum 16 caracteres');
  else console.log('[ringover] webhooks actifs (secret de ' + s.length + ' caracteres)');
}

/* `trim()` OBLIGATOIRE : Render (comme la plupart des hébergeurs) conserve les
   espaces et retours à la ligne collés par erreur dans une variable. Sans ça,
   un secret parfaitement correct échoue en silence — c'est exactement ce qui
   s'est produit à la première mise en service. */
function secretAttendu() {
  return String(process.env.RINGOVER_WEBHOOK_SECRET || '').trim();
}

/* Un webhook qui refuse tout sans rien dire est indéfendable : on ne peut pas
   le diagnostiquer depuis l'extérieur. On trace donc chaque rejet — LONGUEURS
   seulement, jamais les valeurs. */
function secretOk(recu) {
  const attendu = secretAttendu();
  const donne = String(recu || '').trim();
  if (attendu.length < 16) {
    console.error('[ringover] RINGOVER_WEBHOOK_SECRET absent ou trop court ('
      + attendu.length + ' caracteres, minimum 16) — tous les webhooks sont refuses');
    return false;
  }
  const a = Buffer.from(donne, 'utf8');
  const b = Buffer.from(attendu, 'utf8');
  if (a.length !== b.length) {
    console.error('[ringover] secret refuse : longueur recue ' + a.length
      + ', attendue ' + b.length);
    return false;
  }
  if (!crypto.timingSafeEqual(a, b)) {
    console.error('[ringover] secret refuse : meme longueur (' + a.length + ') mais valeur differente');
    return false;
  }
  return true;
}

/* Ringover nomme les événements différemment selon la ressource :
   `missed_call` sur `call`, `received` sur `sms`. On accepte les variantes
   plutôt que d'en rater une. */
const APPEL_MANQUE = new Set(['missed_call', 'missed', 'call_missed', 'voicemail']);
const SMS_ENTRANT = new Set(['received', 'sms_received', 'message_received']);

function urlPublique(req) {
  const base = String(process.env.PUBLIC_BASE_URL || 'https://autoliva.com').replace(/\/$/, '');
  return base + req.originalUrl.split('?')[0];
}

router.post('/webhook/:secret',
  express.raw({ type: '*/*', limit: '512kb' }),
  async (req, res) => {
    if (!secretOk(req.params.secret)) return res.status(404).end();

    const corpsBrut = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body || '');

    /* Barrière 2 : si une signature accompagne la requête, elle doit tenir. */
    const sig = verifier({
      headers: req.headers,
      corpsBrut,
      url: urlPublique(req),
      methode: req.method,
    });
    if (sig.version && !sig.verifiee) {
      console.error('[ringover] signature refusée :', sig.version, sig.raison);
      return res.status(401).json({ ok: false, error: 'signature_invalide' });
    }

    let b;
    try { b = JSON.parse(corpsBrut); } catch (_) { return res.json({ ok: true, ignore: 'corps_illisible' }); }
    if (!b || typeof b !== 'object') return res.json({ ok: true, ignore: 'corps_vide' });

    const evt = String(b.event || b.type || '').toLowerCase();
    const ressource = String(b.resource || '').toLowerCase();
    const d = (b.data && typeof b.data === 'object') ? b.data : b;

    /* On trace TOUT ce qui entre, y compris ce qu'on ignore. Sans ça, un
       événement qu'on ne reconnaît pas disparaît sans laisser de trace, et il
       devient impossible de savoir si Ringover nous a appelés — c'est
       exactement ce qui a bloqué la première mise en service. Numéro tronqué :
       les 4 derniers chiffres suffisent à corréler avec un appel de test. */
    {
      const t = String(d.from_number || d.caller_number || d.from || '');
      console.log('[ringover] recu event=' + (evt || '?') + ' resource=' + (ressource || '?')
        + ' de=…' + (t ? t.slice(-4) : '?') + ' sig=' + (sig.version || 'aucune'));
    }

    try {
      /* Réponse du client par SMS. On écarte `sent` : notre propre envoi
         déclenche aussi un événement, le réinjecter ferait une boucle. */
      if (ressource === 'sms' || SMS_ENTRANT.has(evt)) {
        if (!SMS_ENTRANT.has(evt) || String(d.direction || 'inbound') === 'outbound') {
          return res.json({ ok: true, ignore: 'sms_sortant' });
        }
        const r = await recordSmsReply({
          from: d.from_number || d.from,
          body: d.body || d.content || d.message,
          at: d.time ? new Date(Number(d.time) * 1000) : undefined,
          conversationId: d.conversation_id,
        });
        return res.json({ ok: true, action: r.action });
      }

      /* Code saisi dans le menu vocal — non signé, protégé par le seul secret. */
      if (evt === 'ivr_response_code') {
        const r = await recordIvrCode({
          code: d.code,
          from: d.from_number || d.from,
          callId: d.call_id,
          at: b.timestamp ? new Date(Number(b.timestamp) * 1000) : undefined,
        });
        return res.json({ ok: true, action: r.action });
      }

      /* Appel manqué. */
      if (APPEL_MANQUE.has(evt)) {
        const r = await recordMissedCall({
          callId: d.call_id || d.callId || d.id,
          callerNumber: d.from_number || d.caller_number || d.from,
          receiverNumber: d.to_number || d.receiver_number || d.to,
          at: b.timestamp ? new Date(Number(b.timestamp) * 1000)
            : (d.start_time || d.timestamp || d.date),
        });
        if (!r.ok) console.error('[ringover] appel manqué non enregistré :', r.action);
        return res.json({ ok: true, action: r.action, sms: r.sms });
      }

      /* Tout le reste est acquitté sans traitement : sur une erreur, Ringover
         rejouerait indéfiniment des événements qui ne nous concernent pas. */
      return res.json({ ok: true, ignore: evt || ressource || 'inconnu' });
    } catch (err) {
      console.error('[ringover] erreur webhook :', err && err.message ? err.message : err);
      return res.json({ ok: true, action: 'erreur' });
    }
  });

module.exports = router;
