'use strict';

/**
 * API "agent" SAV — surface stable, authentifiée par clé, consommée par le
 * skill sav-autoliva (cf. references/api-contract.md).
 *
 * Préfixe (monté dans app.js) : /admin/api/sav/agent
 * Auth : Authorization: Bearer <SAV_AGENT_API_KEY>
 *
 * PHASE 1 — lecture seule (100 % sûr) : queue, ticket, templates, report.
 * Les écritures (message/status/assign/action) + garde-fous viendront en
 * phase 2.
 */

const express = require('express');
const savAgent = require('../../services/savAgentService');

const router = express.Router();

// ─── Auth par clé ────────────────────────────────────────────────────────
function requireAgentKey(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const expected = String(process.env.SAV_AGENT_API_KEY || '').trim();
  if (!expected) {
    return res.status(500).json({ error: 'sav_agent_api_key_not_configured' });
  }
  if (!token || token !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  // Identité de l'agent (pour la journalisation en phase 2)
  req.agentName = 'agent';
  return next();
}

router.use(requireAgentKey);

function wrap(handler) {
  return async (req, res) => {
    try {
      await handler(req, res);
    } catch (err) {
      console.error('[sav-agent]', req.method, req.path, '-', err && err.message);
      res.status(500).json({ error: 'internal_error', message: (err && err.message) || 'erreur' });
    }
  };
}

// ─── 2.1 GET /queue ──────────────────────────────────────────────────────
router.get('/queue', wrap(async (req, res) => {
  const data = await savAgent.getQueue(req.query || {});
  res.json(data);
}));

// ─── 2.2 GET /tickets/:id ────────────────────────────────────────────────
router.get('/tickets/:id', wrap(async (req, res) => {
  const ticket = await savAgent.getTicket(String(req.params.id || '').trim());
  if (!ticket) return res.status(404).json({ error: 'ticket_not_found' });
  res.json(ticket);
}));

// ─── 2.7 GET /templates ──────────────────────────────────────────────────
router.get('/templates', wrap(async (req, res) => {
  res.json(savAgent.getTemplates());
}));

// ─── 2.8 GET /report ─────────────────────────────────────────────────────
router.get('/report', wrap(async (req, res) => {
  const period = String((req.query && req.query.period) || 'today');
  res.json(await savAgent.getReport(period));
}));

module.exports = router;
