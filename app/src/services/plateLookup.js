'use strict';

// Client de l'API plaque d'immatriculation (RapidAPI) : à partir d'une plaque
// FR, renvoie le code moteur + caractéristiques. Clé via PLATE_API_KEY.
// NB : Cloudflare (côté API) bloque les requêtes sans User-Agent -> on en met un.

const PLATE_API_HOST =
  process.env.PLATE_API_HOST || 'api-de-plaque-d-immatriculation-france.p.rapidapi.com';
const PLATE_API_KEY = process.env.PLATE_API_KEY || '';
const TIMEOUT_MS = 8000;

// Formate en SIV « AA-123-AA » si possible, sinon renvoie nettoyé.
function formatPlate(raw) {
  const s = String(raw == null ? '' : raw)
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '');
  const m = s.match(/^([A-Z]{2})(\d{3})([A-Z]{2})$/);
  return m ? `${m[1]}-${m[2]}-${m[3]}` : String(raw == null ? '' : raw).trim();
}

async function lookupPlate(rawPlate) {
  if (!PLATE_API_KEY) {
    const err = new Error('PLATE_API_KEY manquant');
    err.code = 'NO_KEY';
    throw err;
  }
  const plaque = formatPlate(rawPlate);
  const url = `https://${PLATE_API_HOST}/?plaque=${encodeURIComponent(plaque)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      headers: {
        'x-rapidapi-key': PLATE_API_KEY,
        'x-rapidapi-host': PLATE_API_HOST,
        plaque,
        'User-Agent': 'Mozilla/5.0',
      },
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const json = await res.json();
    const d = (json && json.data) || {};
    const codeMoteur = d.AWN_code_moteur;
    if (!codeMoteur) return null;
    return {
      plaque,
      codeMoteur,
      codesMoteur: Array.isArray(d.AWN_codes_moteur) ? d.AWN_codes_moteur : [],
      label: d.AWN_label_moteur || '',
      marque: d.AWN_marque || '',
      modele: d.AWN_modele || '',
      energie: d.AWN_energie || '',
      cylindree: d.AWN_nbr_cylindre_energie || '',
      puissance: d.AWN_puissance_chevaux || '',
    };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { lookupPlate, formatPlate };
