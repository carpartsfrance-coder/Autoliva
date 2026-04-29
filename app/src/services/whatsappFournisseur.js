/*
 * WhatsApp Business — préparation du dossier fournisseur + envoi.
 *
 * Stub safe : si WHATSAPP_API_TOKEN est défini, fait un POST réel à l'API
 * Cloud WhatsApp (graph.facebook.com/v18.0/{phone_id}/messages). Sinon,
 * renvoie un objet "preview" avec URL wa.me prête à cliquer.
 *
 * Le contenu du message s'inspire du skill assistant-sav-mecatronique :
 * codes défaut, symptômes, VIN, kilométrage, lien rapport banc.
 */

const https = require('https');
const brand = require('../config/brand');

function isConfigured() {
  return Boolean(process.env.WHATSAPP_API_TOKEN && process.env.WHATSAPP_PHONE_ID);
}

function buildMessage(ticket) {
  const v = ticket.vehicule || {};
  const d = ticket.diagnostic || {};
  const e = ticket.diagnosticEnrichi || {};
  const lines = [];
  lines.push(`🔧 *Dossier SAV ${ticket.numero}* — ${brand.NAME}`);
  lines.push(`Pièce : ${ticket.pieceType}`);
  if (v.vin) lines.push(`VIN : ${v.vin}`);
  if (v.marque || v.modele) lines.push(`Véhicule : ${[v.marque, v.modele, v.annee].filter(Boolean).join(' ')}`);
  if (v.kilometrage) lines.push(`Kilométrage : ${v.kilometrage} km`);
  if (d.symptomes && d.symptomes.length) lines.push(`Symptômes : ${d.symptomes.join(', ')}`);
  if (d.codesDefaut && d.codesDefaut.length) lines.push(`Codes OBD : ${d.codesDefaut.join(', ')}`);
  if (e && e.scoreCalcule != null) lines.push(`Score risque : ${e.scoreCalcule}/100`);
  if (e && e.mesures) {
    const m = e.mesures;
    if (m.pressionHydraulique != null) lines.push(`Pression hydraulique : ${m.pressionHydraulique} bar`);
    if (m.fuiteInterne) lines.push(`Fuite interne : ${m.fuiteInterne}`);
  }
  if (ticket.analyse && ticket.analyse.rapport) lines.push(`Rapport banc : ${ticket.analyse.rapport}`);
  lines.push('');
  lines.push('Pouvez-vous nous confirmer votre prise en charge et le délai ?');
  lines.push('Merci d\'avance.');
  return lines.join('\n');
}

function buildClientScript(ticket) {
  const f = ticket.fournisseur || {};
  const lines = [];
  lines.push(`Bonjour ${(ticket.client && ticket.client.nom) || ''},`);
  lines.push('');
  lines.push(`Suite à votre dossier SAV ${ticket.numero}, nous avons transmis les éléments à notre fournisseur d'origine pour analyse complémentaire.`);
  if (f.dateEnvoi) lines.push(`Envoi effectué le ${new Date(f.dateEnvoi).toLocaleDateString('fr-FR')}.`);
  lines.push('Nous revenons vers vous dès retour du fournisseur (généralement sous 5 à 10 jours ouvrés).');
  lines.push('');
  lines.push('Merci de votre patience.');
  return lines.join('\n');
}

function preview(ticket, fournisseurPhone) {
  const text = buildMessage(ticket);
  // wa.me/<phone>?text=<encoded>
  const cleanPhone = String(fournisseurPhone || '').replace(/[^\d]/g, '');
  const waUrl = cleanPhone ? `https://wa.me/${cleanPhone}?text=${encodeURIComponent(text)}` : '';
  return {
    text,
    waUrl,
    clientScript: buildClientScript(ticket),
    configured: isConfigured(),
  };
}

async function sendReal(ticket, fournisseurPhone) {
  return new Promise((resolve) => {
    const cleanPhone = String(fournisseurPhone || '').replace(/[^\d]/g, '');
    if (!cleanPhone) return resolve({ ok: false, error: 'phone_missing' });
    const text = buildMessage(ticket);
    const phoneId = process.env.WHATSAPP_PHONE_ID;
    const token = process.env.WHATSAPP_API_TOKEN;
    const body = JSON.stringify({
      messaging_product: 'whatsapp',
      to: cleanPhone,
      type: 'text',
      text: { body: text },
    });
    const opts = {
      hostname: 'graph.facebook.com',
      path: `/v18.0/${phoneId}/messages`,
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = https.request(opts, (res) => {
      let data = '';
      res.on('data', (c) => { data += c; });
      res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, body: data }));
    });
    req.on('error', (e) => resolve({ ok: false, error: e.message }));
    req.write(body);
    req.end();
  });
}

module.exports = { preview, sendReal, buildMessage, buildClientScript, isConfigured };
