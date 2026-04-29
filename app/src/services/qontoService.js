/*
 * Qonto invoicing — service avec toggle env.
 * Si QONTO_API_LOGIN et QONTO_SECRET_KEY sont définis, fait de vrais appels HTTP.
 * Sinon, retourne un faux objet pour permettre le développement local.
 *
 * NB : la lib `node:https` est utilisée volontairement pour ne pas ajouter
 * de dépendance npm. Le payload réel suit le schéma Qonto v2 (à ajuster
 * selon votre compte Keobiz / abonnement).
 */

const https = require('https');

const QONTO_BASE = process.env.QONTO_API_BASE || 'https://thirdparty.qonto.com/v2';
const LOGIN = process.env.QONTO_API_LOGIN || '';
const KEY = process.env.QONTO_SECRET_KEY || '';
const ORGANIZATION_SLUG = process.env.QONTO_ORG_SLUG || '';
const STAKEHOLDER_ID = process.env.QONTO_STAKEHOLDER_ID || '';

function isConfigured() {
  return Boolean(LOGIN && KEY);
}

function httpRequest(method, urlStr, headers, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const opts = {
      hostname: u.hostname,
      port: u.port || 443,
      path: u.pathname + u.search,
      method,
      headers: Object.assign({ 'Content-Type': 'application/json' }, headers || {}),
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => {
        try {
          const j = data ? JSON.parse(data) : {};
          resolve({ status: res.statusCode, body: j });
        } catch (e) {
          resolve({ status: res.statusCode, body: data });
        }
      });
    });
    req.on('error', reject);
    if (body) req.write(typeof body === 'string' ? body : JSON.stringify(body));
    req.end();
  });
}

/**
 * Crée une facture Qonto 149 € TTC pour un ticket SAV.
 * @returns {Promise<{ invoiceId, invoiceUrl, pdfUrl, fake }>}
 */
async function createInvoice149({ ticket, amountCents = 14900 }) {
  const number = `SAV-${ticket.numero}-149`;
  if (!isConfigured()) {
    // Mode dev : retourne un objet "comme si"
    return {
      fake: true,
      invoiceId: 'qto_dev_' + ticket.numero,
      invoiceUrl: `https://app.qonto.com/dev/invoices/${number}`,
      pdfUrl: `/uploads/sav-cgv/${ticket.numero}.pdf`, // recycle le PDF CGV en placeholder local
      number,
    };
  }
  // Appel réel : POST /v2/client_invoices
  const headers = {
    Authorization: `${LOGIN}:${KEY}`,
  };
  const payload = {
    client_invoice: {
      number,
      organization_slug: ORGANIZATION_SLUG,
      stakeholder_id: STAKEHOLDER_ID,
      issue_date: new Date().toISOString().slice(0, 10),
      due_date: new Date(Date.now() + 14 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      currency: 'EUR',
      client: {
        name: (ticket.client && ticket.client.nom) || ticket.client.email,
        email: (ticket.client && ticket.client.email) || '',
        type: ticket.client && ticket.client.type === 'B2B' ? 'company' : 'individual',
      },
      items: [
        {
          title: `Forfait analyse SAV — Dossier ${ticket.numero}`,
          quantity: 1,
          unit_price: { value: (amountCents / 100).toFixed(2), currency: 'EUR' },
          vat_rate: '0.20',
        },
      ],
    },
  };
  try {
    const res = await httpRequest('POST', `${QONTO_BASE}/client_invoices`, headers, payload);
    if (res.status >= 400) {
      throw new Error(`Qonto API ${res.status}: ${JSON.stringify(res.body).slice(0, 200)}`);
    }
    const inv = (res.body && res.body.client_invoice) || res.body || {};
    return {
      fake: false,
      invoiceId: inv.id || inv.number || number,
      invoiceUrl: inv.invoice_url || inv.url || '',
      pdfUrl: inv.pdf_url || '',
      number,
    };
  } catch (e) {
    console.error('[qonto] createInvoice149 failed:', e.message);
    // Fallback vers le mode "fake" pour ne pas bloquer le ticket
    return {
      fake: true,
      error: e.message,
      invoiceId: 'qto_fail_' + ticket.numero,
      invoiceUrl: '',
      pdfUrl: '',
      number,
    };
  }
}

module.exports = { createInvoice149, isConfigured };
