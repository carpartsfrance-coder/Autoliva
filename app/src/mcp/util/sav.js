'use strict';

// Petits outils partagés par les outils SAV du connecteur (lecture seule).

const JOUR_MS = 24 * 3600 * 1000;

/* « 134 », « 0134 », « sav-2026-0134 » → « SAV-2026-0134 ».
 * Un numéro seul est rattaché à l'année en cours. Rend '' si rien d'exploitable. */
function normalizeTicketId(input, now = new Date()) {
  const s = String(input || '').trim().toUpperCase();
  if (!s) return '';
  if (/^\d{1,4}$/.test(s)) return `SAV-${now.getFullYear()}-${s.padStart(4, '0')}`;
  const m = s.match(/^SAV-(\d{4})-(\d{1,4})$/);
  if (m) return `SAV-${m[1]}-${m[2].padStart(4, '0')}`;
  return /^[A-Z0-9-]{3,40}$/.test(s) ? s : '';
}

function iso(d) {
  return d ? new Date(d).toISOString() : null;
}

function daysSince(d, now = Date.now()) {
  if (!d) return null;
  return Math.max(0, Math.floor((now - new Date(d).getTime()) / JOUR_MS));
}

/* Identifiant GridFS porté par une URL « /sav-files/<id> » (absolue ou non). */
function fileIdFromUrl(url) {
  const m = String(url || '').match(/\/sav-files\/([a-fA-F0-9]{24})(?:[/?#].*)?$/);
  return m ? m[1].toLowerCase() : null;
}

/* Résultat MCP en JSON compact : les listes sont longues, l'indentation
 * doublerait leur poids pour rien. */
function compactJson(payload) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] };
}

module.exports = { JOUR_MS, normalizeTicketId, iso, daysSince, fileIdFromUrl, compactJson };
