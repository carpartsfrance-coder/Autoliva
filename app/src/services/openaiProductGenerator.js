const brand = require('../config/brand');

const OPENAI_RESPONSES_URL = 'https://api.openai.com/v1/responses';
const GENERATED_DESCRIPTION_TARGET_LENGTH = 1197;
const GENERATED_DESCRIPTION_MIN_LENGTH = 1050;
const OPENAI_RATE_LIMIT_MAX_RETRIES = 8;
const OPENAI_RATE_LIMIT_FALLBACK_WAIT_MS = 5000;
const OPENAI_RATE_LIMIT_MAX_WAIT_MS = 120000;
const OPENAI_NETWORK_MAX_RETRIES = 4;
const OPENAI_NETWORK_RETRY_BASE_MS = 2000;
const OPENAI_NETWORK_RETRY_MAX_WAIT_MS = 30000;

const DEFAULT_SINGLE_AI_PROFILE_KEY = 'single_premium';
const DEFAULT_BATCH_AI_PROFILE_KEY = 'batch_quality';

const AI_GENERATION_PROFILES = Object.freeze({
  single_standard: Object.freeze({
    key: 'single_standard',
    scope: 'single',
    label: 'Standard',
    description: 'Bonne qualité avec un budget temps et coût plus raisonnable.',
    defaultModel: 'gpt-4.1',
    modelEnvKeys: ['OPENAI_PRODUCT_STANDARD_MODEL', 'OPENAI_MODEL'],
    defaultReasoning: 'low',
    reasoningEnvKeys: ['OPENAI_PRODUCT_STANDARD_REASONING_EFFORT'],
    useWebSearch: true,
    maxDurationMs: 4 * 60 * 1000,
    maxOutputTokens: 3600,
    maxRateLimitRetries: 4,
    maxNetworkRetries: 3,
    promptStyle: 'standard',
    descriptionTargetWords: 200,
    descriptionMinWords: 180,
    descriptionMaxWords: 220,
    descriptionMaxLength: 1500,
  }),
  single_balanced: Object.freeze({
    key: 'single_balanced',
    scope: 'single',
    label: 'Avancé',
    description: 'Qualité renforcée avec gpt-5.4, mais avec une recherche plus ciblée que Premium.',
    defaultModel: 'gpt-5.4',
    modelEnvKeys: ['OPENAI_PRODUCT_BALANCED_MODEL', 'OPENAI_PRODUCT_MID_MODEL', 'OPENAI_PRODUCT_MODEL', 'OPENAI_MODEL'],
    defaultReasoning: 'low',
    reasoningEnvKeys: ['OPENAI_PRODUCT_BALANCED_REASONING_EFFORT', 'OPENAI_PRODUCT_MID_REASONING_EFFORT'],
    useWebSearch: true,
    maxDurationMs: 5 * 60 * 1000,
    maxOutputTokens: 5000,
    maxRateLimitRetries: 6,
    maxNetworkRetries: 4,
    promptStyle: 'balanced',
    descriptionTargetWords: 220,
    descriptionMinWords: 190,
    descriptionMaxWords: 250,
    descriptionMaxLength: 1700,
  }),
  single_premium: Object.freeze({
    key: 'single_premium',
    scope: 'single',
    label: 'Premium',
    description: 'Recherche plus poussée et fiche plus riche, mais plus lente.',
    defaultModel: 'gpt-5.4',
    modelEnvKeys: ['OPENAI_PRODUCT_PREMIUM_MODEL', 'OPENAI_PRODUCT_MODEL', 'OPENAI_MODEL'],
    defaultReasoning: 'medium',
    reasoningEnvKeys: ['OPENAI_PRODUCT_PREMIUM_REASONING_EFFORT'],
    useWebSearch: true,
    maxDurationMs: 8 * 60 * 1000,
    maxOutputTokens: 6800,
    maxRateLimitRetries: 8,
    maxNetworkRetries: 4,
    promptStyle: 'premium',
  }),
  batch_fast: Object.freeze({
    key: 'batch_fast',
    scope: 'batch',
    label: 'Rapide',
    description: 'Priorité à la vitesse et au coût pour les lots.',
    defaultModel: 'gpt-4.1',
    modelEnvKeys: ['OPENAI_PRODUCT_BATCH_FAST_MODEL', 'OPENAI_PRODUCT_BATCH_MODEL', 'OPENAI_MODEL'],
    defaultReasoning: 'low',
    reasoningEnvKeys: ['OPENAI_PRODUCT_BATCH_FAST_REASONING_EFFORT', 'OPENAI_PRODUCT_BATCH_REASONING_EFFORT'],
    useWebSearch: true,
    maxDurationMs: 3 * 60 * 1000,
    maxOutputTokens: 3000,
    maxRateLimitRetries: 2,
    maxNetworkRetries: 2,
    promptStyle: 'batch_fast',
  }),
  batch_balanced: Object.freeze({
    key: 'batch_balanced',
    scope: 'batch',
    label: 'Avancé',
    description: 'Qualité renforcée avec gpt-5.4 pour les lots, plus poussée que Qualité sans aller jusqu’au niveau Premium.',
    defaultModel: 'gpt-5.4',
    modelEnvKeys: ['OPENAI_PRODUCT_BATCH_BALANCED_MODEL', 'OPENAI_PRODUCT_BATCH_MODEL', 'OPENAI_PRODUCT_MODEL', 'OPENAI_MODEL'],
    defaultReasoning: 'low',
    reasoningEnvKeys: ['OPENAI_PRODUCT_BATCH_BALANCED_REASONING_EFFORT', 'OPENAI_PRODUCT_BATCH_REASONING_EFFORT'],
    useWebSearch: true,
    maxDurationMs: 5 * 60 * 1000,
    maxOutputTokens: 5000,
    maxRateLimitRetries: 6,
    maxNetworkRetries: 4,
    promptStyle: 'balanced',
    descriptionTargetWords: 220,
    descriptionMinWords: 190,
    descriptionMaxWords: 250,
    descriptionMaxLength: 1700,
  }),
  batch_quality: Object.freeze({
    key: 'batch_quality',
    scope: 'batch',
    label: 'Qualité',
    description: 'Meilleur équilibre entre qualité, délai et coût pour les lots.',
    defaultModel: 'gpt-4.1',
    modelEnvKeys: ['OPENAI_PRODUCT_BATCH_QUALITY_MODEL', 'OPENAI_PRODUCT_BATCH_MODEL', 'OPENAI_MODEL'],
    defaultReasoning: 'medium',
    reasoningEnvKeys: ['OPENAI_PRODUCT_BATCH_QUALITY_REASONING_EFFORT', 'OPENAI_PRODUCT_BATCH_REASONING_EFFORT'],
    useWebSearch: true,
    maxDurationMs: 5 * 60 * 1000,
    maxOutputTokens: 3800,
    maxRateLimitRetries: 4,
    maxNetworkRetries: 3,
    promptStyle: 'batch_quality',
  }),
});

function normalizeEnvString(value) {
  if (typeof value !== 'string') return '';
  let v = value.trim();
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    v = v.slice(1, -1);
  }
  return v;
}

function getDefaultAiGenerationProfileKey(scope = 'single') {
  return scope === 'batch' ? DEFAULT_BATCH_AI_PROFILE_KEY : DEFAULT_SINGLE_AI_PROFILE_KEY;
}

function normalizeAiGenerationProfile(profileKey, { scope = '' } = {}) {
  const rawKey = normalizeEnvString(profileKey);
  const defaultKey = getDefaultAiGenerationProfileKey(scope || 'single');
  const candidate = rawKey && AI_GENERATION_PROFILES[rawKey] ? rawKey : defaultKey;
  const profile = AI_GENERATION_PROFILES[candidate] || AI_GENERATION_PROFILES[defaultKey];

  if (scope && profile && profile.scope !== scope) {
    return getDefaultAiGenerationProfileKey(scope);
  }

  return profile ? profile.key : defaultKey;
}

function getAiGenerationProfileConfig(profileKey, { scope = '' } = {}) {
  return AI_GENERATION_PROFILES[normalizeAiGenerationProfile(profileKey, { scope })];
}

function getEnvValueFromKeys(keys = []) {
  for (const key of keys) {
    const value = normalizeEnvString(process.env[key]);
    if (value) return value;
  }
  return '';
}

function normalizeReasoningEffortValue(value, fallback = '') {
  const normalized = normalizeEnvString(value).toLowerCase();
  if (!normalized) return fallback;
  if (['none', 'low', 'medium', 'high', 'xhigh'].includes(normalized)) return normalized;
  return fallback;
}

function getAiGenerationProfileMeta(profileKey, { scope = '' } = {}) {
  const profile = getAiGenerationProfileConfig(profileKey, { scope });
  return {
    key: profile.key,
    scope: profile.scope,
    label: profile.label,
    description: profile.description,
    defaultModel: getModelName(profile.key),
  };
}

function getAiGenerationProfilesByScope(scope = '') {
  return Object.values(AI_GENERATION_PROFILES)
    .filter((profile) => !scope || profile.scope === scope)
    .map((profile) => getAiGenerationProfileMeta(profile.key, { scope: profile.scope }));
}

function slugify(value) {
  if (typeof value !== 'string') return '';
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .replace(/-+$/, '');
}

function normalizeLooseTextInput(value) {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return '';
}

function compactSpaces(value) {
  return normalizeLooseTextInput(value).replace(/[\r\n\t]+/g, ' ').replace(/\s{2,}/g, ' ').trim();
}

function stripMarkdownInline(value) {
  return normalizeLooseTextInput(value)
    .replace(/!?\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, '')
    .replace(/\(\s*(?:https?:\/\/|www\.)[^)]*\)/gi, '')
    .replace(/\bhttps?:\/\/\S+/gi, '')
    .replace(/\bwww\.[^\s)]+/gi, '')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\((?:\s*[,;:]\s*)+\)/g, '')
    .replace(/\(\s*\)/g, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function stripMarkdownMultiline(value) {
  return normalizeLooseTextInput(value)
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => String(line || '').trim())
    .map((line) => line.replace(/^#{1,6}\s+/g, ''))
    .map((line) => line.replace(/^>\s+/g, ''))
    .map((line) => line.replace(/^\d+[).]\s+/g, '- '))
    .filter((line) => !/^(source|sources|lien|liens|reference source|references sources)\s*[:\-]/i.test(line))
    .map((line) => stripMarkdownInline(line))
    .join('\n');
}

function normalizeText(value, { maxLength = 0 } = {}) {
  const text = compactSpaces(stripMarkdownInline(value));
  if (!maxLength || text.length <= maxLength) return text;
  return text.slice(0, Math.max(0, maxLength - 1)).trim() + '…';
}

function normalizeMultilineText(value, { maxLength = 0 } = {}) {
  const text = stripMarkdownMultiline(value)
    .replace(/\r/g, '')
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n\n')
    .trim();
  if (!maxLength || text.length <= maxLength) return text;
  return text.slice(0, Math.max(0, maxLength - 1)).trim() + '…';
}

function trimGeneratedDescriptionToMaxWords(text, maxWords) {
  const safeText = normalizeMultilineText(text);
  const words = safeText.split(/\s+/).filter(Boolean);
  if (!maxWords || words.length <= maxWords) return safeText;

  const tokens = safeText.match(/\S+\s*/g) || [];
  const rawCut = tokens.slice(0, maxWords).join('').trim();
  const tailWindow = safeText.slice(rawCut.length, Math.min(safeText.length, rawCut.length + 220));
  const sentenceEndMatch = tailWindow.match(/^[\s\S]*?[.!?](?=\s|$)/);

  if (sentenceEndMatch) {
    return `${rawCut}${sentenceEndMatch[0]}`.trim();
  }

  return `${rawCut}…`;
}

function trimGeneratedDescription(value, { minLength = GENERATED_DESCRIPTION_MIN_LENGTH, maxLength = GENERATED_DESCRIPTION_TARGET_LENGTH, maxWords = 0 } = {}) {
  let text = normalizeMultilineText(value);
  if (!text) return '';

  if (maxWords > 0) {
    text = trimGeneratedDescriptionToMaxWords(text, maxWords);
  }

  if (text.length <= maxLength) return text;

  const windowStart = Math.max(minLength, Math.floor(maxLength * 0.88));
  const candidateZone = text.slice(windowStart, maxLength + 1);
  const punctuationMatches = [...candidateZone.matchAll(/[.!?](?:\s|$)/g)];

  if (punctuationMatches.length) {
    const lastMatch = punctuationMatches[punctuationMatches.length - 1];
    const cutIndex = windowStart + lastMatch.index + 1;
    return text.slice(0, cutIndex).trim();
  }

  return `${text.slice(0, Math.max(0, maxLength - 1)).trim()}…`;
}

function normalizeArrayOfStrings(value, { maxItems = 20, maxLength = 180 } = {}) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => normalizeText(item, { maxLength }))
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeCompatibility(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const src = item && typeof item === 'object' ? item : {};
      return {
        make: normalizeText(src.make, { maxLength: 80 }),
        model: normalizeText(src.model, { maxLength: 120 }),
        years: normalizeText(src.years, { maxLength: 40 }),
        engine: normalizeText(src.engine, { maxLength: 120 }),
      };
    })
    .filter((item) => item.make || item.model || item.years || item.engine)
    .slice(0, 20);
}

function normalizeFaqs(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const src = item && typeof item === 'object' ? item : {};
      return {
        question: normalizeText(src.question, { maxLength: 220 }),
        answer: normalizeText(src.answer, { maxLength: 520 }),
      };
    })
    .filter((item) => item.question || item.answer)
    .slice(0, 12);
}

function normalizeSteps(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const src = item && typeof item === 'object' ? item : {};
      return {
        title: normalizeText(src.title, { maxLength: 80 }),
        description: normalizeText(src.description, { maxLength: 240 }),
      };
    })
    .filter((item) => item.title || item.description)
    .slice(0, 4);
}

function normalizeOptions(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((option, index) => {
      const src = option && typeof option === 'object' ? option : {};
      const label = normalizeText(src.label, { maxLength: 120 });
      const key = slugify(String(src.key || '').trim()) || slugify(label) || `option-${index + 1}`;
      const type = String(src.type || '').trim() === 'text' ? 'text' : 'choice';
      const normalized = {
        key,
        label: label || `Option ${index + 1}`,
        type,
        required: src.required === true,
        placeholder: normalizeText(src.placeholder, { maxLength: 160 }),
        helpText: normalizeText(src.helpText, { maxLength: 220 }),
        priceDeltaCents: Number.isFinite(Number(src.priceDeltaCents)) ? Math.max(0, Math.round(Number(src.priceDeltaCents))) : 0,
        choices: [],
      };

      if (type === 'choice') {
        normalized.choices = Array.isArray(src.choices)
          ? src.choices
              .map((choice, choiceIndex) => {
                const choiceSrc = choice && typeof choice === 'object' ? choice : {};
                const choiceLabel = normalizeText(choiceSrc.label, { maxLength: 120 });
                return {
                  key: slugify(String(choiceSrc.key || '').trim()) || slugify(choiceLabel) || `choix-${choiceIndex + 1}`,
                  label: choiceLabel,
                  priceDeltaCents: Number.isFinite(Number(choiceSrc.priceDeltaCents))
                    ? Math.max(0, Math.round(Number(choiceSrc.priceDeltaCents)))
                    : 0,
                };
              })
              .filter((choice) => choice.label)
              .slice(0, 12)
          : [];
        normalized.priceDeltaCents = 0;
      } else {
        normalized.choices = [];
      }

      if (type === 'choice' && !normalized.choices.length) return null;
      return normalized;
    })
    .filter(Boolean)
    .slice(0, 8);
}

const PRODUCT_SHEET_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    name: { type: 'string' },
    slug: { type: 'string' },
    brand: { type: 'string' },
    category: { type: 'string' },
    shippingDelayText: { type: 'string' },
    specType: { type: 'string' },
    specProgrammation: { type: 'string' },
    badgeTopLeft: { type: 'string' },
    badgeCondition: { type: 'string' },
    shortDescription: { type: 'string' },
    description: { type: 'string' },
    compatibleReferences: {
      type: 'array',
      items: { type: 'string' },
    },
    compatibility: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          make: { type: 'string' },
          model: { type: 'string' },
          years: { type: 'string' },
          engine: { type: 'string' },
        },
        required: ['make', 'model', 'years', 'engine'],
      },
    },
    faqs: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          question: { type: 'string' },
          answer: { type: 'string' },
        },
        required: ['question', 'answer'],
      },
    },
    reconditioningSteps: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          title: { type: 'string' },
          description: { type: 'string' },
        },
        required: ['title', 'description'],
      },
    },
    options: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          key: { type: 'string' },
          label: { type: 'string' },
          type: { type: 'string', enum: ['choice', 'text'] },
          required: { type: 'boolean' },
          placeholder: { type: 'string' },
          helpText: { type: 'string' },
          priceDeltaCents: { type: 'integer' },
          choices: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                key: { type: 'string' },
                label: { type: 'string' },
                priceDeltaCents: { type: 'integer' },
              },
              required: ['key', 'label', 'priceDeltaCents'],
            },
          },
        },
        required: ['key', 'label', 'type', 'required', 'placeholder', 'helpText', 'priceDeltaCents', 'choices'],
      },
    },
    metaTitle: { type: 'string' },
    metaDescription: { type: 'string' },
    warnings: {
      type: 'array',
      items: { type: 'string' },
    },
  },
  required: [
    'name',
    'slug',
    'brand',
    'category',
    'shippingDelayText',
    'specType',
    'specProgrammation',
    'badgeTopLeft',
    'badgeCondition',
    'shortDescription',
    'description',
    'compatibleReferences',
    'compatibility',
    'faqs',
    'reconditioningSteps',
    'options',
    'metaTitle',
    'metaDescription',
    'warnings',
  ],
};

const PRODUCT_SHEET_TOP_LEVEL_KEYS = new Set(PRODUCT_SHEET_SCHEMA.required);

function getModelName(profileKey = DEFAULT_SINGLE_AI_PROFILE_KEY) {
  const profile = getAiGenerationProfileConfig(profileKey);
  return getEnvValueFromKeys(profile.modelEnvKeys)
    || profile.defaultModel;
}

function getReasoningEffort(profileKey = DEFAULT_SINGLE_AI_PROFILE_KEY) {
  const profile = getAiGenerationProfileConfig(profileKey);
  return normalizeReasoningEffortValue(
    getEnvValueFromKeys(profile.reasoningEnvKeys),
    normalizeReasoningEffortValue(profile.defaultReasoning, '')
  );
}

function modelSupportsReasoningEffort(modelName) {
  const normalized = normalizeEnvString(modelName).toLowerCase();
  if (!normalized) return false;
  return normalized.startsWith('gpt-5')
    || normalized.startsWith('o1')
    || normalized.startsWith('o3')
    || normalized.startsWith('o4');
}

function getOpenAiApiKey() {
  return normalizeEnvString(process.env.OPENAI_API_KEY);
}

function sleep(ms) {
  const delay = Number.isFinite(Number(ms)) ? Math.max(0, Math.floor(Number(ms))) : 0;
  return new Promise((resolve) => setTimeout(resolve, delay));
}

function clampRetryDelayMs(value, fallback = OPENAI_RATE_LIMIT_FALLBACK_WAIT_MS) {
  const safeValue = Number.isFinite(Number(value)) ? Math.ceil(Number(value)) : fallback;
  return Math.min(OPENAI_RATE_LIMIT_MAX_WAIT_MS, Math.max(1000, safeValue));
}

function clampNetworkRetryDelayMs(value, fallback = OPENAI_NETWORK_RETRY_BASE_MS) {
  const safeValue = Number.isFinite(Number(value)) ? Math.ceil(Number(value)) : fallback;
  return Math.min(OPENAI_NETWORK_RETRY_MAX_WAIT_MS, Math.max(1000, safeValue));
}

function getNetworkRetryDelayMs(attempt = 0) {
  return clampNetworkRetryDelayMs(OPENAI_NETWORK_RETRY_BASE_MS * Math.pow(2, Math.max(0, attempt)));
}

function getErrorChain(error) {
  const chain = [];
  const seen = new Set();
  let current = error;

  while (current && typeof current === 'object' && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = current.cause;
  }

  return chain;
}

function getNetworkDiagnosticSummary(error) {
  const chain = getErrorChain(error);
  const parts = [];

  chain.forEach((item) => {
    if (!item || typeof item !== 'object') return;
    const code = typeof item.code === 'string' ? item.code.trim() : '';
    const name = typeof item.name === 'string' ? item.name.trim() : '';
    const message = typeof item.message === 'string' ? item.message.trim() : '';
    const values = [code, name, message].filter(Boolean);
    if (!values.length) return;
    const text = values.join(' | ');
    if (!parts.includes(text)) parts.push(text);
  });

  return parts.join(' -> ');
}

function buildOpenAiNetworkError(error, { attempts = 1 } = {}) {
  const diagnostic = getNetworkDiagnosticSummary(error);
  const suffix = diagnostic ? ` Détail technique : ${diagnostic}.` : '';
  const err = new Error(`Impossible de contacter OpenAI pour générer la fiche produit après ${attempts} tentative(s). Vérifie la connexion réseau et les paramètres du serveur.${suffix}`);
  err.code = 'OPENAI_NETWORK_ERROR';
  err.status = 502;
  err.cause = error;
  err.diagnostic = diagnostic;
  return err;
}

function formatDurationLabel(ms) {
  const totalMinutes = Number.isFinite(Number(ms)) ? Math.max(1, Math.ceil(Number(ms) / 60000)) : 1;
  return `${totalMinutes} min`;
}

function buildOpenAiTimeoutError(profile, { maxDurationMs = 0 } = {}) {
  const safeDurationMs = Number.isFinite(Number(maxDurationMs)) && Number(maxDurationMs) > 0
    ? Number(maxDurationMs)
    : profile.maxDurationMs;
  const err = new Error(`La génération IA en mode ${profile.label} a dépassé le temps maximum autorisé (${formatDurationLabel(safeDurationMs)}). Essaie un mode plus rapide ou ajoute une référence plus précise.`);
  err.code = 'OPENAI_TIMEOUT';
  err.status = 504;
  return err;
}

function isTransientNetworkError(error) {
  const chain = getErrorChain(error);
  const transientCodes = new Set([
    'ECONNRESET',
    'ECONNREFUSED',
    'ECONNABORTED',
    'ETIMEDOUT',
    'EAI_AGAIN',
    'ENETDOWN',
    'ENETUNREACH',
    'EHOSTUNREACH',
    'UND_ERR_CONNECT_TIMEOUT',
    'UND_ERR_HEADERS_TIMEOUT',
    'UND_ERR_BODY_TIMEOUT',
    'UND_ERR_SOCKET',
  ]);

  return chain.some((item) => {
    const code = item && typeof item.code === 'string' ? item.code.trim().toUpperCase() : '';
    const name = item && typeof item.name === 'string' ? item.name.trim().toLowerCase() : '';
    const message = item && typeof item.message === 'string' ? item.message.trim().toLowerCase() : '';

    return transientCodes.has(code)
      || name === 'aborterror'
      || /fetch failed/.test(message)
      || /network/.test(message)
      || /socket/.test(message)
      || /timeout/.test(message)
      || /timed out/.test(message)
      || /econnreset/.test(message)
      || /econnrefused/.test(message)
      || /eai_again/.test(message)
      || /headers timeout/.test(message)
      || /body timeout/.test(message);
  });
}

function parseRetryAfterHeaderToMs(value) {
  const raw = normalizeEnvString(value);
  if (!raw) return 0;

  const asNumber = Number(raw);
  if (Number.isFinite(asNumber)) {
    return Math.max(0, Math.ceil(asNumber * 1000));
  }

  const asDate = Date.parse(raw);
  if (Number.isFinite(asDate)) {
    return Math.max(0, asDate - Date.now());
  }

  return 0;
}

function parseRetryAfterMsHeader(value) {
  const asNumber = Number(normalizeEnvString(value));
  if (!Number.isFinite(asNumber)) return 0;
  return Math.max(0, Math.ceil(asNumber));
}

function extractRetryDelayMsFromMessage(message) {
  const raw = String(message || '').trim();
  if (!raw) return 0;

  const match = raw.match(/try again in\s+([0-9]+(?:\.[0-9]+)?)s/i);
  if (!match) return 0;

  const seconds = Number.parseFloat(match[1]);
  if (!Number.isFinite(seconds) || seconds <= 0) return 0;
  return Math.ceil(seconds * 1000);
}

function isRateLimitResponse(response, data) {
  const errorCode = data && data.error && typeof data.error.code === 'string'
    ? data.error.code.trim().toLowerCase()
    : '';
  const errorType = data && data.error && typeof data.error.type === 'string'
    ? data.error.type.trim().toLowerCase()
    : '';
  const errorMessage = data && data.error && typeof data.error.message === 'string'
    ? data.error.message.trim()
    : '';

  return (response && response.status === 429)
    || errorCode === 'rate_limit_exceeded'
    || errorType === 'rate_limit_exceeded'
    || /rate limit/i.test(errorMessage)
    || /tokens per min/i.test(errorMessage)
    || /requests per min/i.test(errorMessage);
}

function getRateLimitRetryDelayMs(response, data, attempt = 0) {
  const retryAfterMs = response && response.headers && typeof response.headers.get === 'function'
    ? parseRetryAfterMsHeader(response.headers.get('retry-after-ms'))
    : 0;
  if (retryAfterMs > 0) return clampRetryDelayMs(retryAfterMs);

  const retryAfterSeconds = response && response.headers && typeof response.headers.get === 'function'
    ? parseRetryAfterHeaderToMs(response.headers.get('retry-after'))
    : 0;
  if (retryAfterSeconds > 0) return clampRetryDelayMs(retryAfterSeconds);

  const messageDelay = extractRetryDelayMsFromMessage(data && data.error ? data.error.message : '');
  if (messageDelay > 0) return clampRetryDelayMs(messageDelay);

  return clampRetryDelayMs(OPENAI_RATE_LIMIT_FALLBACK_WAIT_MS * (attempt + 1));
}

function extractJsonCandidateStrings(node, out = []) {
  if (typeof node === 'string') {
    out.push(node);
    return out;
  }

  if (Array.isArray(node)) {
    node.forEach((item) => extractJsonCandidateStrings(item, out));
    return out;
  }

  if (!node || typeof node !== 'object') return out;

  Object.keys(node).forEach((key) => {
    const value = node[key];
    if (typeof value === 'string') out.push(value);
    else extractJsonCandidateStrings(value, out);
  });

  return out;
}

function tryParseJson(text) {
  const raw = String(text || '').trim();
  if (!raw) return null;

  try {
    return JSON.parse(raw);
  } catch (err) {}

  const firstBrace = raw.indexOf('{');
  const lastBrace = raw.lastIndexOf('}');
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    const snippet = raw.slice(firstBrace, lastBrace + 1);
    try {
      return JSON.parse(snippet);
    } catch (err) {}
  }

  return null;
}

function isStructuredProductSheetCandidate(node) {
  if (!node || typeof node !== 'object' || Array.isArray(node)) return false;
  const keys = Object.keys(node);
  if (!keys.length) return false;

  const looksLikeSchemaNode = typeof node.type === 'string'
    && ('properties' in node || 'required' in node || 'additionalProperties' in node);
  if (looksLikeSchemaNode) return false;

  let matchingKeys = 0;
  for (const key of keys) {
    if (PRODUCT_SHEET_TOP_LEVEL_KEYS.has(key)) matchingKeys += 1;
  }

  const hasStringContent = [
    'name',
    'slug',
    'brand',
    'category',
    'shippingDelayText',
    'specType',
    'specProgrammation',
    'badgeTopLeft',
    'badgeCondition',
    'shortDescription',
    'description',
    'metaTitle',
    'metaDescription',
  ].some((key) => typeof node[key] === 'string');

  const hasArrayContent = [
    'compatibleReferences',
    'compatibility',
    'faqs',
    'reconditioningSteps',
    'options',
    'warnings',
  ].some((key) => Array.isArray(node[key]));

  if (matchingKeys >= 5 && (hasStringContent || hasArrayContent)) return true;

  return matchingKeys >= 3
    && (typeof node.description === 'string'
      || Array.isArray(node.compatibility)
      || Array.isArray(node.faqs)
      || Array.isArray(node.warnings));
}

function extractStructuredObjectCandidates(node, out = [], seen = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (seen.has(node)) return out;
  seen.add(node);

  if (!Array.isArray(node) && isStructuredProductSheetCandidate(node)) {
    out.push(node);
  }

  if (Array.isArray(node)) {
    node.forEach((item) => extractStructuredObjectCandidates(item, out, seen));
    return out;
  }

  Object.values(node).forEach((value) => {
    if (value && typeof value === 'object') {
      extractStructuredObjectCandidates(value, out, seen);
    }
  });

  return out;
}

function extractRefusalMessages(node, out = [], seen = new Set()) {
  if (!node || typeof node !== 'object') return out;
  if (seen.has(node)) return out;
  seen.add(node);

  if (!Array.isArray(node) && normalizeEnvString(node.type).toLowerCase() === 'refusal') {
    const refusalText = normalizeLooseTextInput(node.refusal || node.text || node.reason);
    if (refusalText) out.push(refusalText);
  }

  if (Array.isArray(node)) {
    node.forEach((item) => extractRefusalMessages(item, out, seen));
    return out;
  }

  Object.values(node).forEach((value) => {
    if (value && typeof value === 'object') {
      extractRefusalMessages(value, out, seen);
    }
  });

  return out;
}

function getIncompleteResponseReason(data) {
  return normalizeEnvString(data && data.incomplete_details && data.incomplete_details.reason).toLowerCase();
}

function buildUnreadableOpenAiResponseMessage(data) {
  const refusalMessage = extractRefusalMessages(data, []).find(Boolean) || '';
  if (refusalMessage) {
    return `OpenAI a refusé de générer la fiche structurée. ${refusalMessage}`.trim();
  }

  const responseStatus = normalizeEnvString(data && data.status).toLowerCase();
  const incompleteReason = getIncompleteResponseReason(data);

  if (responseStatus === 'incomplete') {
    if (incompleteReason === 'max_output_tokens') {
      return 'OpenAI a coupé la réponse avant la fin car la limite de sortie a été atteinte. Réessaie ou choisis un mode plus court.';
    }
    if (incompleteReason === 'content_filter') {
      return 'OpenAI a interrompu la réponse à cause d’un filtre de sécurité sur le contenu retourné.';
    }
    if (incompleteReason) {
      return `OpenAI a renvoyé une réponse incomplète (${incompleteReason}).`;
    }
    return 'OpenAI a renvoyé une réponse incomplète avant la fin de la fiche produit.';
  }

  const outputText = normalizeLooseTextInput(data && data.output_text);
  if (outputText) {
    return 'OpenAI a répondu, mais pas dans le format structuré attendu par la fiche produit.';
  }

  return 'Réponse OpenAI impossible à lire.';
}

function extractStructuredOutput(data) {
  if (data && data.output_parsed && typeof data.output_parsed === 'object') {
    return data.output_parsed;
  }

  const objectCandidates = extractStructuredObjectCandidates(data, []);
  for (const candidate of objectCandidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      return candidate;
    }
  }

  const candidates = extractJsonCandidateStrings(data, []);
  for (const candidate of candidates) {
    const parsed = tryParseJson(candidate);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  }

  return null;
}

function parseOpenAiError(data, response) {
  const errorCode = data && data.error && typeof data.error.code === 'string'
    ? data.error.code.trim().toLowerCase()
    : '';
  const errorType = data && data.error && typeof data.error.type === 'string'
    ? data.error.type.trim().toLowerCase()
    : '';
  const errorMessage = data && data.error && typeof data.error.message === 'string'
    ? data.error.message.trim()
    : '';

  const quotaExceeded = errorCode === 'insufficient_quota'
    || errorType === 'insufficient_quota'
    || /quota/i.test(errorMessage)
    || /billing/i.test(errorMessage);

  if (quotaExceeded) {
    return 'Le compte OpenAI a dépassé son quota ou la facturation API n’est pas active. Va dans Platform OpenAI > Billing pour ajouter du crédit ou activer la facturation, puis réessaie.';
  }

  if (isRateLimitResponse(response, data)) {
    const retryDelayMs = getRateLimitRetryDelayMs(response, data);
    const retryDelaySeconds = Math.max(1, Math.ceil(retryDelayMs / 1000));
    return `OpenAI a temporairement atteint sa limite de débit sur les tokens/minute. Le serveur a déjà essayé de patienter automatiquement. Réessaie dans environ ${retryDelaySeconds} s.`;
  }

  if (errorMessage) {
    return errorMessage;
  }
  return `Erreur OpenAI (${response.status}).`;
}

function buildSystemInstruction(profile) {
  const lines = [
    `Tu es un expert e-commerce automobile B2C/B2B pour ${brand.NAME}.`,
    'Tu dois impérativement utiliser la recherche web disponible avant de rédiger la fiche.',
    'Tu travailles en français.',
    'Objectif : produire une fiche produit claire, crédible, utile pour le client et optimisée SEO.',
    'Règles strictes :',
    '- La compatibilité véhicule est prioritaire : tu dois chercher en premier la marque, le modèle, les années et la motorisation compatibles à partir du nom produit, de la référence, des références compatibles et des notes.',
    '- Pour trouver les compatibilités, croise en priorité les références OEM / équipementier, catalogues constructeurs, catalogues équipementiers et fiches techniques sérieuses.',
    '- Si tu trouves des compatibilités fiables, remplis le tableau compatibility avec un maximum d’entrées utiles et concrètes.',
    '- Si seules la marque et le modèle sont fiables mais pas les années ou le moteur, renseigne quand même make et model, et laisse years ou engine vides si nécessaire.',
    '- N’abandonne pas la recherche de compatibilité trop tôt : fais plusieurs tentatives de recherche autour de la référence, des synonymes du produit et des références compatibles.',
    '- Ne jamais inventer une donnée technique précise si elle n’est pas suffisamment confirmée.',
    '- Si une information est incertaine, laisse le champ vide ou ajoute un avertissement dans warnings.',
    '- Ne propose pas de prix, de stock, de SKU, de classe d’expédition ou de données internes non vérifiables.',
    '- Les meta title et meta description doivent être naturellement optimisés SEO, sans sur-optimisation.',
    '- La description doit être rédigée en texte simple, sans HTML complexe.',
    '- N’utilise jamais de syntaxe Markdown visible dans les champs texte : pas de **, pas de __, pas de #, pas de liens [texte](url).',
    '- N’insère jamais de source, d’URL, de lien, de citation, de nom de site ou de référence bibliographique dans les champs texte.',
    '- Les compatibilités véhicules doivent rester prudentes : seulement si des sources sérieuses permettent de les déduire.',
    '- Les FAQ doivent répondre à de vraies questions client.',
    '- Les options doivent rester sobres, réalistes et utiles pour un vendeur de pièces auto.',
  ];

  if (profile.promptStyle === 'premium') {
    lines.push('- Pour un produit complexe, prends le temps de croiser plusieurs sources sérieuses avant de conclure.');
  }

  if (profile.promptStyle === 'standard') {
    lines.push('- Reste efficace : privilégie quelques recherches ciblées et fiables plutôt qu’une recherche trop longue.');
    lines.push('- Ne t’arrête pas au premier véhicule trouvé : si la référence remonte sur plusieurs marques ou modèles fiables, liste les différentes compatibilités utiles.');
    lines.push('- Quand une même pièce couvre plusieurs marques ou plusieurs modèles, privilégie une compatibilité large mais prudente, en dédupliquant les doublons.');
    lines.push('- Même en mode standard, la compatibilité véhicule, la description et la FAQ restent prioritaires.');
  }

  if (profile.promptStyle === 'balanced') {
    lines.push('- Mode avancé : vise une meilleure précision qu’en standard, mais sans mener une recherche exhaustive comme en premium.');
    lines.push('- Vérifie plusieurs pistes de compatibilité utiles, surtout si la référence existe sur différentes marques ou modèles, puis retiens les compatibilités les plus solides.');
    lines.push('- Fournis une fiche soignée et crédible, mais garde un niveau d’approfondissement intermédiaire pour tenir un bon délai.');
  }

  if (profile.promptStyle === 'batch_fast') {
    lines.push('- Mode lot rapide : concentre-toi sur les informations les plus fiables et les plus utiles pour la vente.');
    lines.push('- Les champs secondaires comme les FAQ, les options et les étapes de reconditionnement sont facultatifs : laisse-les vides si cela évite une recherche longue.');
  }

  if (profile.promptStyle === 'batch_quality') {
    lines.push('- Mode lot qualité : vise une fiche solide mais garde un temps de recherche raisonnable.');
    lines.push('- Priorise les champs essentiels si une recherche exhaustive ralentit trop la réponse.');
  }

  return lines.join('\n');
}

function buildUserPrompt(payload, profile) {
  const sourceNotes = normalizeMultilineText(payload && payload.sourceNotes ? payload.sourceNotes : '', { maxLength: 4000 });
  const compatibleReferences = normalizeArrayOfStrings(payload && payload.compatibleReferences ? payload.compatibleReferences : [], { maxItems: 20, maxLength: 120 });
  const descriptionTargetWords = Number.isFinite(Number(profile && profile.descriptionTargetWords)) ? Math.max(0, Math.floor(Number(profile.descriptionTargetWords))) : 0;
  const descriptionMinWords = Number.isFinite(Number(profile && profile.descriptionMinWords)) ? Math.max(0, Math.floor(Number(profile.descriptionMinWords))) : 0;
  const descriptionMaxWords = Number.isFinite(Number(profile && profile.descriptionMaxWords)) ? Math.max(0, Math.floor(Number(profile.descriptionMaxWords))) : 0;

  const lines = [
    'Prépare une fiche produit complète en te basant sur une recherche web.',
    'Priorité absolue : identifier les véhicules compatibles et remplir la compatibilité véhicule de la façon la plus utile possible.',
    '',
    'Contexte fourni par l’utilisateur :',
    `- Nom du produit : ${normalizeText(payload && payload.name ? payload.name : '', { maxLength: 220 })}`,
    `- Référence / SKU principal : ${normalizeText(payload && payload.sku ? payload.sku : '', { maxLength: 120 })}`,
    `- Marque connue : ${normalizeText(payload && payload.brand ? payload.brand : '', { maxLength: 120 })}`,
    `- Catégorie connue : ${normalizeText(payload && payload.category ? payload.category : '', { maxLength: 120 })}`,
    `- Références compatibles déjà connues : ${compatibleReferences.length ? compatibleReferences.join(', ') : 'Aucune'}`,
    `- Notes libres : ${sourceNotes || 'Aucune'}`,
    '',
    'Consignes de rédaction :',
    '- Commence par rechercher la compatibilité véhicule via la référence, les références compatibles, le nom de la pièce et les variantes de cette pièce.',
    '- Dès que des compatibilités fiables sont trouvées, remplis compatibility avec des lignes concrètes de type marque / modèle / années / moteur.',
    '- Si seules la marque et le modèle sont fiables, renseigne-les quand même dans compatibility même si years ou engine restent vides.',
    '- Si aucune compatibilité sérieuse n’est trouvée, explique clairement dans warnings que la compatibilité n’a pas pu être confirmée.',
    '- Si la marque réelle du véhicule compatible est identifiable mais différente de la marque équipementier de la pièce, privilégie la vraie marque véhicule dans compatibility.',
    '- Produis un nom de produit vendable, propre et naturel.',
    '- Génère un slug SEO simple.',
    '- Génère un résumé court et une description détaillée orientée bénéfices + usages + vérifications utiles.',
    descriptionTargetWords > 0
      ? `- La description détaillée doit faire environ ${descriptionTargetWords} mots. Vise une fourchette de ${descriptionMinWords || descriptionTargetWords} à ${descriptionMaxWords || descriptionTargetWords} mots.`
      : `- La description détaillée doit faire environ ${GENERATED_DESCRIPTION_TARGET_LENGTH} caractères espaces compris, sans dépasser sensiblement cette longueur. Vise une fourchette de ${GENERATED_DESCRIPTION_MIN_LENGTH} à ${GENERATED_DESCRIPTION_TARGET_LENGTH} caractères.`,
    '- La description doit être directement lisible dans un textarea admin : texte clair, paragraphes simples, puces simples, sans Markdown.',
    '- N’ajoute aucune source, aucun lien, aucune URL et aucun nom de site dans la réponse finale.',
    '- Génère des champs Type, Programmation, Garantie et État cohérents.',
    '- Propose une meta title et une meta description solides pour Google.',
    '- Propose des FAQ utiles.',
    '- Propose jusqu’à 4 étapes de reconditionnement si cela a du sens.',
    '- Si tu n’es pas sûr d’une donnée, préfère un avertissement dans warnings.',
    '- Si aucune source fiable n’est trouvée, signale-le clairement dans warnings.',
  ];

  if (profile.promptStyle === 'standard') {
    lines.push('- Reste pragmatique : livre une bonne fiche sans chercher trop longtemps des détails secondaires.');
    lines.push('- Cherche activement les compatibilités multi-marques et multi-modèles quand une même référence est utilisée sur plusieurs véhicules différents.');
    lines.push('- Ne te limite pas à un seul exemple : essaie de faire ressortir plusieurs marques et plusieurs modèles distincts si les sources les confirment.');
    lines.push('- Génère au moins 4 FAQ concrètes avec des réponses complètes et rassurantes pour le client.');
    lines.push('- Dans la FAQ, couvre en priorité la compatibilité, la programmation/codage, l’état ou le reconditionnement, la garantie et les vérifications avant achat si pertinent.');
  }

  if (profile.promptStyle === 'balanced') {
    lines.push('- Mode avancé : vise une compatibilité véhicule plus solide qu’en standard, notamment quand la pièce couvre plusieurs marques ou plusieurs modèles.');
    lines.push('- Cherche plusieurs correspondances crédibles, mais arrête-toi dès que tu as assez d’éléments fiables pour une bonne fiche.');
    lines.push('- Génère au moins 4 FAQ utiles avec des réponses détaillées, sans aller dans un niveau d’exhaustivité premium.');
    lines.push('- La description doit être qualitative, rassurante et claire, avec un bon équilibre entre précision technique et rapidité de génération.');
  }

  if (profile.promptStyle === 'batch_fast') {
    lines.push('- Mode lot rapide : priorise name, shortDescription, description, compatibility, metaTitle, metaDescription et warnings.');
    lines.push('- Si une FAQ, une option ou une étape de reconditionnement n’est pas évidente, laisse le champ vide.');
  }

  if (profile.promptStyle === 'batch_quality') {
    lines.push('- Mode lot qualité : vise une fiche complète, mais garde une recherche ciblée et raisonnable.');
    lines.push('- Si une donnée reste floue après quelques recherches sérieuses, n’insiste pas inutilement.');
  }

  if (profile.promptStyle === 'premium') {
    lines.push('- Mode premium : privilégie la qualité finale, surtout sur la compatibilité véhicule et la clarté SEO.');
  }

  return lines.join('\n');
}

function normalizeGeneratedSheet(raw, payload, profile = null) {
  const sourceName = normalizeText(raw && raw.name ? raw.name : '', { maxLength: 220 })
    || normalizeText(payload && payload.name ? payload.name : '', { maxLength: 220 });
  const sourceBrand = normalizeText(raw && raw.brand ? raw.brand : '', { maxLength: 120 })
    || normalizeText(payload && payload.brand ? payload.brand : '', { maxLength: 120 });
  const sourceCategory = normalizeText(raw && raw.category ? raw.category : '', { maxLength: 120 })
    || normalizeText(payload && payload.category ? payload.category : '', { maxLength: 120 });
  const slug = slugify(raw && raw.slug ? raw.slug : sourceName);

  const compatibleReferencesFromPayload = normalizeArrayOfStrings(payload && payload.compatibleReferences ? payload.compatibleReferences : [], { maxItems: 20, maxLength: 120 });
  const compatibleReferences = Array.from(new Set([
    ...compatibleReferencesFromPayload,
    ...normalizeArrayOfStrings(raw && raw.compatibleReferences ? raw.compatibleReferences : [], { maxItems: 20, maxLength: 120 }),
  ]));

  return {
    name: sourceName,
    slug,
    brand: sourceBrand,
    category: sourceCategory,
    shippingDelayText: normalizeText(raw && raw.shippingDelayText ? raw.shippingDelayText : '', { maxLength: 120 }),
    specType: normalizeText(raw && raw.specType ? raw.specType : '', { maxLength: 120 }),
    specProgrammation: normalizeText(raw && raw.specProgrammation ? raw.specProgrammation : '', { maxLength: 120 }),
    badgeTopLeft: normalizeText(raw && raw.badgeTopLeft ? raw.badgeTopLeft : '', { maxLength: 120 }),
    badgeCondition: normalizeText(raw && raw.badgeCondition ? raw.badgeCondition : '', { maxLength: 120 }),
    shortDescription: normalizeText(raw && raw.shortDescription ? raw.shortDescription : '', { maxLength: 320 }),
    description: trimGeneratedDescription(raw && raw.description ? raw.description : '', {
      minLength: Number.isFinite(Number(profile && profile.descriptionMinLength)) ? Math.max(0, Math.floor(Number(profile.descriptionMinLength))) : GENERATED_DESCRIPTION_MIN_LENGTH,
      maxLength: Number.isFinite(Number(profile && profile.descriptionMaxLength)) ? Math.max(0, Math.floor(Number(profile.descriptionMaxLength))) : GENERATED_DESCRIPTION_TARGET_LENGTH,
      maxWords: Number.isFinite(Number(profile && profile.descriptionMaxWords)) ? Math.max(0, Math.floor(Number(profile.descriptionMaxWords))) : 0,
    }),
    compatibleReferences,
    compatibility: normalizeCompatibility(raw && raw.compatibility ? raw.compatibility : []),
    faqs: normalizeFaqs(raw && raw.faqs ? raw.faqs : []),
    reconditioningSteps: normalizeSteps(raw && raw.reconditioningSteps ? raw.reconditioningSteps : []),
    options: normalizeOptions(raw && raw.options ? raw.options : []),
    metaTitle: normalizeText(raw && raw.metaTitle ? raw.metaTitle : '', { maxLength: 70 }),
    metaDescription: normalizeText(raw && raw.metaDescription ? raw.metaDescription : '', { maxLength: 180 }),
    warnings: normalizeArrayOfStrings(raw && raw.warnings ? raw.warnings : [], { maxItems: 12, maxLength: 280 }),
  };
}

async function generateProductSheet(payload, options = {}) {
  const apiKey = getOpenAiApiKey();
  if (!apiKey) {
    const err = new Error('OPENAI_API_KEY manquante.');
    err.code = 'OPENAI_API_KEY_MISSING';
    throw err;
  }

  const requestedScope = normalizeEnvString(options && options.scope);
  const profile = getAiGenerationProfileConfig(options && options.profile, { scope: requestedScope || '' });
  const deadlineAt = Date.now() + profile.maxDurationMs;

  const safePayload = {
    name: normalizeText(payload && payload.name ? payload.name : '', { maxLength: 220 }),
    sku: normalizeText(payload && payload.sku ? payload.sku : '', { maxLength: 120 }),
    brand: normalizeText(payload && payload.brand ? payload.brand : '', { maxLength: 120 }),
    category: normalizeText(payload && payload.category ? payload.category : '', { maxLength: 120 }),
    compatibleReferences: normalizeArrayOfStrings(payload && payload.compatibleReferences ? payload.compatibleReferences : [], { maxItems: 20, maxLength: 120 }),
    sourceNotes: normalizeMultilineText(payload && payload.sourceNotes ? payload.sourceNotes : '', { maxLength: 4000 }),
  };

  const modelName = getModelName(profile.key);
  const body = {
    model: modelName,
    input: [
      {
        role: 'system',
        content: [
          {
            type: 'input_text',
            text: buildSystemInstruction(profile),
          },
        ],
      },
      {
        role: 'user',
        content: [
          {
            type: 'input_text',
            text: buildUserPrompt(safePayload, profile),
          },
        ],
      },
    ],
    text: {
      format: {
        type: 'json_schema',
        name: 'product_sheet',
        strict: true,
        schema: PRODUCT_SHEET_SCHEMA,
      },
    },
  };

  if (profile.useWebSearch) {
    body.tools = [
      {
        type: 'web_search_preview',
      },
    ];
  }

  if (profile.maxOutputTokens) {
    body.max_output_tokens = profile.maxOutputTokens;
  }

  const reasoningEffort = getReasoningEffort(profile.key);
  if (reasoningEffort && modelSupportsReasoningEffort(modelName)) {
    body.reasoning = {
      effort: reasoningEffort,
    };
  }

  const maxRateLimitRetries = Number.isFinite(Number(options && options.maxRateLimitRetries))
    ? Math.max(0, Math.floor(Number(options.maxRateLimitRetries)))
    : Math.min(OPENAI_RATE_LIMIT_MAX_RETRIES, profile.maxRateLimitRetries);
  const maxNetworkRetries = Number.isFinite(Number(options && options.maxNetworkRetries))
    ? Math.max(0, Math.floor(Number(options.maxNetworkRetries)))
    : Math.min(OPENAI_NETWORK_MAX_RETRIES, profile.maxNetworkRetries);
  const externalAbortSignal = options && options.abortSignal ? options.abortSignal : null;
  let networkAttempt = 0;
  let rateLimitAttempt = 0;
  let lastNetworkError = null;
  let structuredOutputRetryDone = false;

  while (true) {
    const remainingMs = deadlineAt - Date.now();
    if (remainingMs <= 0) {
      throw buildOpenAiTimeoutError(profile, { maxDurationMs: profile.maxDurationMs });
    }

    let response;
    const controller = new AbortController();
    let requestTimedOut = false;
    let requestCanceled = false;
    const requestTimeoutId = setTimeout(() => {
      requestTimedOut = true;
      controller.abort();
    }, remainingMs);
    const handleExternalAbort = () => {
      requestCanceled = true;
      controller.abort();
    };

    if (externalAbortSignal) {
      if (externalAbortSignal.aborted) {
        handleExternalAbort();
      } else {
        externalAbortSignal.addEventListener('abort', handleExternalAbort, { once: true });
      }
    }

    try {
      response = await fetch(OPENAI_RESPONSES_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
    } catch (error) {
      clearTimeout(requestTimeoutId);
      if (externalAbortSignal) {
        externalAbortSignal.removeEventListener('abort', handleExternalAbort);
      }
      lastNetworkError = error;
      if (requestCanceled) {
        const err = new Error('Génération IA arrêtée à la demande.');
        err.code = 'OPENAI_ABORTED';
        throw err;
      }
      if (requestTimedOut) {
        throw buildOpenAiTimeoutError(profile, { maxDurationMs: profile.maxDurationMs });
      }
      if (isTransientNetworkError(error) && networkAttempt < maxNetworkRetries) {
        const waitMs = getNetworkRetryDelayMs(networkAttempt);
        const remainingRetryBudgetMs = deadlineAt - Date.now();
        if (remainingRetryBudgetMs <= waitMs + 500) {
          throw buildOpenAiTimeoutError(profile, { maxDurationMs: profile.maxDurationMs });
        }
        console.warn('[openaiProductGenerator] tentative réseau échouée, nouvelle tentative prévue', {
          profile: profile.key,
          attempt: networkAttempt + 1,
          maxNetworkRetries,
          waitMs,
          diagnostic: getNetworkDiagnosticSummary(error),
        });
        networkAttempt += 1;
        await sleep(waitMs);
        continue;
      }

      const err = buildOpenAiNetworkError(error, { attempts: networkAttempt + 1 });
      console.error('[openaiProductGenerator] échec réseau OpenAI', {
        profile: profile.key,
        attempts: networkAttempt + 1,
        maxNetworkRetries,
        diagnostic: err.diagnostic || '',
      });
      throw err;
    } finally {
      clearTimeout(requestTimeoutId);
      if (externalAbortSignal) {
        externalAbortSignal.removeEventListener('abort', handleExternalAbort);
      }
    }

    const data = await response.json().catch(() => ({}));
    const isRateLimited = isRateLimitResponse(response, data);

    if (!response.ok) {
      if (isRateLimited && rateLimitAttempt < maxRateLimitRetries) {
        const waitMs = getRateLimitRetryDelayMs(response, data, rateLimitAttempt);
        const remainingRetryBudgetMs = deadlineAt - Date.now();
        if (remainingRetryBudgetMs <= waitMs + 500) {
          throw buildOpenAiTimeoutError(profile, { maxDurationMs: profile.maxDurationMs });
        }
        await sleep(waitMs);
        rateLimitAttempt += 1;
        continue;
      }

      const err = new Error(parseOpenAiError(data, response));
      err.code = isRateLimited ? 'OPENAI_RATE_LIMIT' : 'OPENAI_API_ERROR';
      err.status = response.status;
      err.details = data;
      throw err;
    }

    const parsed = extractStructuredOutput(data);
    if (!parsed) {
      const incompleteReason = getIncompleteResponseReason(data);
      if (!structuredOutputRetryDone && incompleteReason === 'max_output_tokens' && Number.isFinite(Number(body.max_output_tokens))) {
        const previousMaxOutputTokens = Number(body.max_output_tokens) || 0;
        const nextMaxOutputTokens = Math.min(9000, Math.max(
          Math.ceil(previousMaxOutputTokens * 1.35),
          previousMaxOutputTokens + 1200,
        ));
        const remainingRetryBudgetMs = deadlineAt - Date.now();
        if (nextMaxOutputTokens > previousMaxOutputTokens && remainingRetryBudgetMs > 15000) {
          structuredOutputRetryDone = true;
          body.max_output_tokens = nextMaxOutputTokens;
          console.warn('[openaiProductGenerator] réponse incomplète, nouvelle tentative avec plus de tokens', {
            profile: profile.key,
            previousMaxOutputTokens,
            nextMaxOutputTokens,
            reason: incompleteReason,
          });
          continue;
        }
      }

      const err = new Error(buildUnreadableOpenAiResponseMessage(data));
      err.code = 'OPENAI_INVALID_RESPONSE';
      err.details = data;
      throw err;
    }

    return {
      model: body.model,
      draft: normalizeGeneratedSheet(parsed, safePayload, profile),
      raw: data,
    };
  }

  throw buildOpenAiNetworkError(lastNetworkError, { attempts: networkAttempt + 1 });
}

module.exports = {
  generateProductSheet,
  getModelName,
  getAiGenerationProfileMeta,
  getAiGenerationProfilesByScope,
  getDefaultAiGenerationProfileKey,
  normalizeAiGenerationProfile,
};
