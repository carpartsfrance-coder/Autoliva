// ---------------------------------------------------------------------------
// openaiSavReformulate.js
//
// Service de reformulation de réponses SAV via OpenAI Chat Completions.
// Adopte un ton brand-aware : professionnel, poli, empathique, vouvoiement
// systématique, signature "L'équipe SAV ${brand.NAME}".
//
// Variables d'environnement utilisées :
//   - OPENAI_API_KEY              (obligatoire)
//   - OPENAI_SAV_REFORMULATE_MODEL (optionnel, défaut : gpt-4o-mini)
//
// Limites :
//   - Texte d'entrée : 5000 caractères max (vérifié par l'appelant aussi)
//   - Timeout réseau : 30 s
//   - Pas de retry automatique côté service (l'admin réessaiera s'il veut)
// ---------------------------------------------------------------------------

const brand = require('../config/brand');

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_INPUT_CHARS = 5000;
const TIMEOUT_MS = 30 * 1000;

const SYSTEM_PROMPT = [
  `Tu es un assistant rédactionnel pour le Service Après-Vente de ${brand.NAME},`,
  'spécialiste de la pièce auto reconditionnée. Tu reçois un brouillon de réponse',
  'écrit par un conseiller SAV à destination d\'un client. Ta mission : reformuler',
  'ce brouillon en respectant strictement les règles suivantes.',
  '',
  'Règles obligatoires :',
  '1. Conserver intégralement le sens, les faits, les chiffres, les dates, les',
  '   numéros de commande/ticket/suivi et toute information factuelle. Ne rien',
  '   inventer, ne rien retirer.',
  '2. Ton professionnel, poli, empathique, rassurant. Vouvoiement systématique.',
  '3. Français impeccable (orthographe, grammaire, ponctuation).',
  '4. Phrases claires, courtes, structurées. Aérer si nécessaire avec des sauts',
  '   de ligne, pas avec des listes à puces sauf si le brouillon en contenait.',
  '5. Toujours commencer par une formule de politesse adaptée au contexte',
  '   (Bonjour, Bonjour Madame/Monsieur si le nom est connu — sinon "Bonjour").',
  '6. Toujours terminer par exactement cette signature, sur une ligne dédiée :',
  `   "Cordialement,\\nL'équipe SAV ${brand.NAME}"`,
  '7. Ne pas ajouter d\'emoji, ni de markdown, ni de balises HTML.',
  '8. Si le brouillon contient des marqueurs techniques ou variables (ex. {{nom}},',
  '   numéros, liens), les conserver à l\'identique.',
  '9. Ne pas faire de promesses commerciales ou juridiques absentes du brouillon',
  '   (ex. délais de remboursement, garanties élargies).',
  '10. Renvoyer UNIQUEMENT le texte reformulé, sans préface, sans guillemets,',
  '    sans commentaire ("Voici la reformulation :" est interdit).',
].join('\n');

function getApiKey() {
  const k = (process.env.OPENAI_API_KEY || '').trim();
  return k || null;
}

function getModel() {
  const m = (process.env.OPENAI_SAV_REFORMULATE_MODEL || '').trim();
  return m || DEFAULT_MODEL;
}

/**
 * Reformule un brouillon de réponse SAV.
 * @param {string} draft - texte brut tapé par l'admin
 * @param {object} [opts]
 * @param {string} [opts.clientName] - nom du client (optionnel, pour personnalisation)
 * @param {string} [opts.ticketNumero] - n° de ticket (optionnel, contexte)
 * @returns {Promise<{ reformulated: string, model: string }>}
 */
async function reformulate(draft, opts = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    const err = new Error('OPENAI_API_KEY manquante');
    err.code = 'OPENAI_KEY_MISSING';
    throw err;
  }
  const text = String(draft || '').trim();
  if (!text) {
    const err = new Error('Brouillon vide');
    err.code = 'EMPTY_DRAFT';
    throw err;
  }
  if (text.length > MAX_INPUT_CHARS) {
    const err = new Error(`Brouillon trop long (max ${MAX_INPUT_CHARS} caractères)`);
    err.code = 'INPUT_TOO_LONG';
    throw err;
  }

  const model = getModel();
  const contextLines = [];
  if (opts.clientName) contextLines.push(`Nom du client : ${opts.clientName}`);
  if (opts.ticketNumero) contextLines.push(`N° de ticket : ${opts.ticketNumero}`);
  const contextBlock = contextLines.length
    ? `Contexte (à utiliser si pertinent, sans l'expliciter) :\n${contextLines.join('\n')}\n\n`
    : '';

  const userMessage = `${contextBlock}Brouillon à reformuler :\n"""\n${text}\n"""`;

  const body = {
    model,
    temperature: 0.4,
    max_tokens: 1200,
    messages: [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: userMessage },
    ],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e) {
    clearTimeout(timer);
    const err = new Error(e && e.name === 'AbortError' ? 'Timeout OpenAI' : `Erreur réseau OpenAI : ${e.message}`);
    err.code = 'OPENAI_NETWORK';
    throw err;
  }
  clearTimeout(timer);

  if (!resp.ok) {
    let errBody = '';
    try { errBody = await resp.text(); } catch (_) {}
    const err = new Error(`OpenAI HTTP ${resp.status} : ${errBody.slice(0, 300)}`);
    err.code = 'OPENAI_HTTP_' + resp.status;
    throw err;
  }

  let json;
  try { json = await resp.json(); } catch (e) {
    const err = new Error('Réponse OpenAI illisible');
    err.code = 'OPENAI_PARSE';
    throw err;
  }

  const content =
    json &&
    json.choices &&
    json.choices[0] &&
    json.choices[0].message &&
    json.choices[0].message.content;
  if (!content || typeof content !== 'string') {
    const err = new Error('Réponse OpenAI vide');
    err.code = 'OPENAI_EMPTY';
    throw err;
  }

  return {
    reformulated: content.trim(),
    model,
  };
}

module.exports = {
  reformulate,
  MAX_INPUT_CHARS,
};
