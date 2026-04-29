/*
 * GET /sav-files/:id — sert un fichier SAV stocké en MongoDB (GridFS).
 *
 * Contrôle d'accès :
 *   1. Admin connecté (req.session.admin) → accès total.
 *   2. Client connecté (req.session.user) dont l'email correspond au
 *      `client.email` du ticket associé au fichier.
 *   3. Suivi invité (req.session.savGuest) si le numéro de ticket en session
 *      correspond à `metadata.ticketNumero`.
 *   4. Magic link (?tk=…) si le token HMAC correspond au ticket+email.
 *   5. Fichier sans `ticketNumero` (ex : procédures internes) → admin requis.
 *
 * Querystring optionnel `?download=1` → force `Content-Disposition: attachment`.
 */

const express = require('express');
const SavTicket = require('../models/SavTicket');
const storage = require('../services/savFileStorage');
const guestCtrl = require('../controllers/savGuestController');

const router = express.Router();

async function isAdmin(req) {
  return !!(req && req.session && req.session.admin && req.session.admin.adminUserId);
}

async function userOwnsTicket(req, ticketNumero) {
  const email = req && req.session && req.session.user && req.session.user.email;
  if (!email || !ticketNumero) return false;
  try {
    const t = await SavTicket.findOne({ numero: ticketNumero, 'client.email': String(email).toLowerCase() })
      .select('_id').lean();
    return !!t;
  } catch (_) { return false; }
}

function guestMatches(req, ticketNumero) {
  const g = req && req.session && req.session.savGuest;
  if (!g || !g.numero || !g.exp) return false;
  if (g.exp < Date.now()) return false;
  return g.numero === ticketNumero;
}

async function tokenMatches(token, ticketNumero) {
  if (!token || !ticketNumero) return false;
  try {
    const t = await SavTicket.findOne({ numero: ticketNumero }).select('client.email').lean();
    if (!t || !t.client || !t.client.email) return false;
    return guestCtrl.generateGuestToken(ticketNumero, t.client.email) === token;
  } catch (_) { return false; }
}

router.get('/:id', async (req, res) => {
  try {
    const file = await storage.findOne(req.params.id);
    if (!file) return res.status(404).send('Fichier introuvable');

    const meta = (file.metadata && typeof file.metadata === 'object') ? file.metadata : {};
    const ticketNumero = meta.ticketNumero || null;

    // --- Auth ---
    let allowed = false;
    if (await isAdmin(req)) {
      allowed = true;
    } else if (ticketNumero) {
      if (await userOwnsTicket(req, ticketNumero)) allowed = true;
      else if (guestMatches(req, ticketNumero)) allowed = true;
      else if (req.query.tk && (await tokenMatches(String(req.query.tk), ticketNumero))) allowed = true;
    }
    if (!allowed) return res.status(403).send('Accès refusé');

    // --- Stream ---
    const contentType = file.contentType || meta.contentType || 'application/octet-stream';
    const filename = file.filename || 'fichier';
    const dispoType = req.query.download ? 'attachment' : 'inline';
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', file.length);
    res.setHeader('Content-Disposition',
      `${dispoType}; filename="${encodeURIComponent(filename).replace(/['()]/g, escape)}"`);
    res.setHeader('Cache-Control', 'private, max-age=300');

    const stream = storage.openDownloadStream(req.params.id);
    stream.on('error', (err) => {
      if (!res.headersSent) res.status(500).send('Erreur lecture fichier');
      else res.end();
    });
    stream.pipe(res);
  } catch (err) {
    if (!res.headersSent) res.status(500).send(err.message || 'Erreur serveur');
  }
});

module.exports = router;
