/*
 * Slack/Discord notifier — Incoming Webhook (compatible Slack et Discord avec
 * un payload simple). Toggle via env SLACK_WEBHOOK_URL (ou DISCORD_WEBHOOK_URL).
 *
 * Si aucune URL configurée, les fonctions log "skipped" et retournent immédiatement.
 * Aucune dépendance npm : utilise node:https.
 */

const https = require('https');
const brand = require('../config/brand');

function getWebhookUrl() {
  return (process.env.SLACK_WEBHOOK_URL || process.env.DISCORD_WEBHOOK_URL || '').trim();
}

function siteUrl() {
  return (brand.SITE_URL).replace(/\/$/, '');
}

function postWebhook(payload) {
  return new Promise((resolve) => {
    const url = getWebhookUrl();
    if (!url) {
      console.log('[slack] skipped (no webhook configured)');
      return resolve({ ok: false, skipped: true });
    }
    try {
      const u = new URL(url);
      const body = JSON.stringify(payload);
      const opts = {
        hostname: u.hostname,
        port: u.port || 443,
        path: u.pathname + u.search,
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      };
      const req = https.request(opts, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: data }));
      });
      req.on('error', (e) => { console.error('[slack] err', e.message); resolve({ ok: false, error: e.message }); });
      req.write(body);
      req.end();
    } catch (e) {
      console.error('[slack] exception', e.message);
      resolve({ ok: false, error: e.message });
    }
  });
}

function ticketLink(ticket) {
  return `${siteUrl()}/admin/sav/tickets/${encodeURIComponent(ticket.numero)}`;
}

// ----- Builders Slack format (blocks). Discord ignore les blocks et lit "text". -----
function buildMessage(text, ticket, color) {
  return {
    text,
    attachments: [
      {
        color: color || '#ec1313',
        fields: [
          { title: 'Ticket', value: ticket.numero, short: true },
          { title: 'Pièce', value: ticket.pieceType || '—', short: true },
          { title: 'Client', value: (ticket.client && ticket.client.email) || '—', short: false },
          { title: 'Lien', value: ticketLink(ticket), short: false },
        ],
      },
    ],
  };
}

async function notifyTicketCreated(ticket) {
  return postWebhook(buildMessage(`🆕 Nouveau ticket SAV créé : *${ticket.numero}*`, ticket, '#0ea5e9'));
}
async function notifyTicketAssigned(ticket) {
  return postWebhook(buildMessage(`👤 Ticket *${ticket.numero}* assigné à ${ticket.assignedToName || '—'}`, ticket, '#6366f1'));
}
async function notifySlaWarning(ticket, label) {
  return postWebhook(buildMessage(`⚠️ SAV *${ticket.numero}* — SLA ${label || 'proche'} !`, ticket, '#f97316'));
}
async function notifyDefautProduit(ticket) {
  return postWebhook(buildMessage(`✅ Défaut produit confirmé sur *${ticket.numero}*`, ticket, '#10b981'));
}
async function notifyPaymentReceived(ticket) {
  return postWebhook(buildMessage(`💰 Paiement 149 € reçu pour *${ticket.numero}*`, ticket, '#10b981'));
}

module.exports = {
  notifyTicketCreated,
  notifyTicketAssigned,
  notifySlaWarning,
  notifyDefautProduit,
  notifyPaymentReceived,
};
