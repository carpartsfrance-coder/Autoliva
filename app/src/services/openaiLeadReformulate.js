// ---------------------------------------------------------------------------
// openaiLeadReformulate.js
//
// Reformulation IA (OpenAI Chat Completions) des MESSAGES COMMERCIAUX « leads » :
//   - modèles SMS / email de /admin/parametres/modeles-messages
//   - messages réels envoyés depuis « Leads à relancer » (avant envoi client)
//
// Même moteur que openaiSavReformulate.js, mais ton commercial (relance lead) et
// non SAV : on conserve les variables {prenom}, {telephone}…, on n'impose PAS la
// signature SAV, et on respecte les contraintes propres au canal (SMS court &
// sans lien, email structuré).
//
// Variables d'environnement :
//   - OPENAI_API_KEY                 (obligatoire — déjà utilisée par le SAV)
//   - OPENAI_LEAD_REFORMULATE_MODEL  (optionnel)
//   - OPENAI_SAV_REFORMULATE_MODEL   (optionnel, repli)
//   → défaut : gpt-4o-mini
// ---------------------------------------------------------------------------

const brand = require('../config/brand');

const OPENAI_CHAT_URL = 'https://api.openai.com/v1/chat/completions';
const DEFAULT_MODEL = 'gpt-4o-mini';
const MAX_INPUT_CHARS = 5000;
const TIMEOUT_MS = 30 * 1000;

// Variables de gabarit à conserver À L'IDENTIQUE (cf. leadTemplateSettings.LEAD_TEMPLATE_VARS).
const KNOWN_VARS = [
  'prenom', 'nom', 'nom_produit', 'prix_total', 'telephone', 'nom_commercial',
  'brand', 'vehicule', 'immatriculation', 'lien_panier', 'lien_produit',
];

const COMMON_RULES = [
  '1. Conserver intégralement le sens, les faits, les chiffres, les dates, les prix,',
  '   les références et toute information factuelle. Ne rien inventer, ne rien retirer.',
  `2. Conserver À L'IDENTIQUE toutes les variables entre accolades (ex. {prenom},`,
  '   {telephone}, {nom_commercial}, {brand}, {nom_produit}, {prix_total}, {vehicule},',
  '   {immatriculation}, {lien_panier}). Ne jamais les traduire, renommer ni supprimer.',
  '3. Vouvoiement systématique. Français impeccable (orthographe, grammaire, ponctuation).',
  '4. Ton commercial : chaleureux, professionnel, orienté conversion, jamais familier.',
  "5. Ne pas ajouter d'emoji, ni de markdown, ni de balises HTML.",
  '6. Ne pas inventer de promesse commerciale absente du brouillon (remise, délai, garantie).',
  '7. Renvoyer UNIQUEMENT le message reformulé : pas de préface, pas de guillemets,',
  '   pas de commentaire ("Voici la reformulation :" est interdit).',
];

function buildSystemPrompt(channel) {
  const head = [
    `Tu es un assistant rédactionnel commercial pour ${brand.NAME}, spécialiste de la`,
    "pièce auto reconditionnée. Tu reçois le brouillon d'un message de relance écrit par",
    'un conseiller à destination d\'un prospect (lead). Ta mission : reformuler ce',
    'brouillon proprement, en respectant strictement les règles suivantes.',
    '',
    'Règles obligatoires :',
    ...COMMON_RULES,
  ];
  if (channel === 'sms') {
    head.push(
      '8. Canal SMS : message COURT (idéalement moins de 320 caractères), une seule idée',
      '   claire, une invitation à rappeler ou à répondre. AUCUN lien ni URL (les',
      '   opérateurs FR bloquent les SMS contenant un lien). Pas de saut de ligne inutile.',
      '9. Terminer par une signature courte du type "{nom_commercial} – {brand}" si le',
      '   brouillon en comportait une.'
    );
  } else {
    head.push(
      '8. Canal e-mail : message structuré et aéré (sauts de ligne entre les idées),',
      '   commençant par une salutation ("Bonjour {prenom}," si présent) et se terminant',
      '   par une formule de politesse puis la signature du brouillon si elle existe',
      '   (ex. "{nom_commercial} – {brand}"). Ne pas inventer de signature absente.',
      '9. Ne pas produire d\'objet d\'e-mail : reformuler uniquement le corps du message.'
    );
  }
  return head.join('\n');
}

function getApiKey() {
  const k = (process.env.OPENAI_API_KEY || '').trim();
  return k || null;
}

function getModel() {
  const m = (process.env.OPENAI_LEAD_REFORMULATE_MODEL || process.env.OPENAI_SAV_REFORMULATE_MODEL || '').trim();
  return m || DEFAULT_MODEL;
}

/**
 * Reformule un brouillon de message commercial (lead).
 * @param {string} draft - texte brut (modèle ou message à envoyer)
 * @param {object} [opts]
 * @param {'sms'|'email'} [opts.channel='email'] - canal (contraintes de style)
 * @param {string} [opts.clientName] - prénom/nom du client (personnalisation)
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
    const err = new Error('Message vide');
    err.code = 'EMPTY_DRAFT';
    throw err;
  }
  if (text.length > MAX_INPUT_CHARS) {
    const err = new Error(`Message trop long (max ${MAX_INPUT_CHARS} caractères)`);
    err.code = 'INPUT_TOO_LONG';
    throw err;
  }

  const channel = opts.channel === 'sms' ? 'sms' : 'email';
  const model = getModel();

  const contextLines = [];
  if (opts.clientName) contextLines.push(`Prénom/nom du client : ${opts.clientName}`);
  const contextBlock = contextLines.length
    ? `Contexte (à utiliser si pertinent, sans l'expliciter) :\n${contextLines.join('\n')}\n\n`
    : '';
  const userMessage = `${contextBlock}Brouillon à reformuler (${channel === 'sms' ? 'SMS' : 'e-mail'}) :\n"""\n${text}\n"""`;

  const body = {
    model,
    temperature: 0.5,
    max_tokens: 1200,
    messages: [
      { role: 'system', content: buildSystemPrompt(channel) },
      { role: 'user', content: userMessage },
    ],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(OPENAI_CHAT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
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

  const content = json && json.choices && json.choices[0] && json.choices[0].message && json.choices[0].message.content;
  if (!content || typeof content !== 'string') {
    const err = new Error('Réponse OpenAI vide');
    err.code = 'OPENAI_EMPTY';
    throw err;
  }

  return { reformulated: content.trim(), model };
}

module.exports = { reformulate, MAX_INPUT_CHARS, KNOWN_VARS };
