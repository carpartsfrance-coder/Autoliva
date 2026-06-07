'use strict';
/* Traduction d'une fiche produit (FR → DE d'abord) via l'API OpenAI.
 * Réutilisable + testable ; orchestré par scripts/translate-products-de.js.
 *
 * Principe : on traduit le contenu RÉDACTIONNEL, JAMAIS les codes/références/
 * valeurs techniques. Un GLOSSAIRE garantit la cohérence des termes métier DE.
 * La validation de structure (reconcile) garantit qu'on ne corrompt jamais une
 * fiche : si un tableau revient mal formé, on garde le FR pour CE champ. */

const nonEmptyStr = (v) => typeof v === 'string' && v.trim() !== '';
const nonEmptyArr = (v) => Array.isArray(v) && v.length > 0;

/* Glossaire FR → DE (termes métier moteurs/boîtes reconditionnés). */
const GLOSSARY = [
  ['moteur reconditionné', 'Austauschmotor / generalüberholter Motor'],
  ['boîte de vitesses reconditionnée', 'generalüberholtes Getriebe / Austauschgetriebe'],
  ['reconditionné(e)', 'generalüberholt'],
  ['échange standard', 'im Austausch (mit Altteilrückgabe)'],
  ['testé sur banc / banc d’essai', 'auf dem Prüfstand getestet / Prüfstand'],
  ['garantie 2 ans (ou 24 mois)', '2 Jahre Garantie'],
  ['pont avant', 'Vorderachsdifferenzial'],
  ['pont arrière', 'Hinterachsdifferenzial'],
  ['mécatronique', 'Mechatronik'],
  ['consigne (caution)', 'Pfand'],
  ['code boîte / code moteur', 'Getriebecode / Motorcode (laisser le CODE inchangé)'],
];

function glossaryText() {
  return GLOSSARY.map(([fr, de]) => `- « ${fr} » → ${de}`).join('\n');
}

function buildSystemPrompt() {
  return [
    'Tu es traducteur professionnel FR→DE spécialisé pièces auto et moteurs/boîtes reconditionnés,',
    'pour un site e-commerce destiné au marché ALLEMAND.',
    '',
    'RÈGLES STRICTES :',
    '1. Ne traduis ni ne modifie JAMAIS les valeurs techniques : codes moteur, codes boîte, références/OEM,',
    '   cylindrées, puissances en kW, dimensions, nombres, unités, prix, plaques, VIN. Recopie-les à l’identique.',
    '2. Convertis l’unité « ch » en « PS » (cheval allemand) en gardant le même nombre.',
    '3. Traduction FIDÈLE : n’invente aucune spec, n’en supprime aucune. Respecte l’accord en genre et la déclinaison allemande.',
    '4. Style commercial allemand naturel et SEO (emploie les termes réellement recherchés en Allemagne).',
    '5. Conserve la mise en forme (HTML, sauts de ligne, listes à puces) à l’identique.',
    '',
    'GLOSSAIRE (à respecter pour la cohérence d’un bout à l’autre) :',
    glossaryText(),
    '',
    'SORTIE : réponds UNIQUEMENT par un JSON valide, avec EXACTEMENT les mêmes clés que l’entrée et la',
    'MÊME longueur pour chaque tableau ; valeurs traduites en allemand.',
  ].join('\n');
}

const STR_FIELDS = ['name', 'shortDescription', 'description'];
const STR_ARRAYS = ['keyPoints', 'inclusions', 'exclusions'];

/** Extrait les champs FR traduisibles (en préservant la structure). */
function collectFields(product) {
  const out = {};
  for (const k of STR_FIELDS) if (nonEmptyStr(product[k])) out[k] = product[k];
  for (const k of STR_ARRAYS) if (nonEmptyArr(product[k])) out[k] = product[k].slice();
  if (nonEmptyArr(product.specs)) out.specs = product.specs.map((s) => ({ label: (s && s.label) || '', value: (s && s.value) || '' }));
  if (nonEmptyArr(product.reconditioningSteps)) out.reconditioningSteps = product.reconditioningSteps.map((s) => ({ title: (s && s.title) || '', description: (s && s.description) || '' }));
  if (nonEmptyArr(product.faqs)) out.faqs = product.faqs.map((f) => ({ question: (f && f.question) || '', answer: (f && f.answer) || '' }));
  if (product.seo && (nonEmptyStr(product.seo.metaTitle) || nonEmptyStr(product.seo.metaDescription))) {
    out.seo = { metaTitle: product.seo.metaTitle || '', metaDescription: product.seo.metaDescription || '' };
  }
  return out;
}

/** Appel OpenAI (indirection via `impl` pour la testabilité). */
async function callOpenAI(fields, { apiKey, model }) {
  const res = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      response_format: { type: 'json_object' },
      messages: [
        { role: 'system', content: buildSystemPrompt() },
        { role: 'user', content: 'Traduis en allemand les valeurs de ce JSON (garde EXACTEMENT les clés et la longueur des tableaux) :\n' + JSON.stringify(fields) },
      ],
    }),
  });
  if (!res.ok) throw new Error('OpenAI ' + res.status + ' ' + (await res.text()).slice(0, 300));
  const data = await res.json();
  return JSON.parse(data.choices[0].message.content);
}

const impl = { callOpenAI };

/**
 * Réconcilie la sortie DE avec l'entrée FR : ne garde un champ que si sa
 * structure est cohérente (mêmes longueurs de tableaux). En cas de doute, on
 * garde le FR pour CE champ → jamais de fiche corrompue / tronquée.
 */
function reconcile(fr, de) {
  de = de && typeof de === 'object' ? de : {};
  const out = {};
  for (const k of STR_FIELDS) if (nonEmptyStr(de[k])) out[k] = de[k];
  for (const k of STR_ARRAYS) {
    if (Array.isArray(de[k]) && Array.isArray(fr[k]) && de[k].length === fr[k].length) {
      out[k] = de[k].map((v, i) => (nonEmptyStr(v) ? v : fr[k][i]));
    }
  }
  if (Array.isArray(fr.specs) && Array.isArray(de.specs) && de.specs.length === fr.specs.length) {
    out.specs = de.specs.map((s, i) => ({
      label: nonEmptyStr(s && s.label) ? s.label : fr.specs[i].label,
      value: nonEmptyStr(s && s.value) ? s.value : fr.specs[i].value,
    }));
  }
  if (Array.isArray(fr.reconditioningSteps) && Array.isArray(de.reconditioningSteps) && de.reconditioningSteps.length === fr.reconditioningSteps.length) {
    out.reconditioningSteps = de.reconditioningSteps.map((s, i) => ({
      title: nonEmptyStr(s && s.title) ? s.title : fr.reconditioningSteps[i].title,
      description: nonEmptyStr(s && s.description) ? s.description : fr.reconditioningSteps[i].description,
    }));
  }
  if (Array.isArray(fr.faqs) && Array.isArray(de.faqs) && de.faqs.length === fr.faqs.length) {
    out.faqs = de.faqs.map((f, i) => ({
      question: nonEmptyStr(f && f.question) ? f.question : fr.faqs[i].question,
      answer: nonEmptyStr(f && f.answer) ? f.answer : fr.faqs[i].answer,
    }));
  }
  if (de.seo && typeof de.seo === 'object') {
    out.seo = {
      metaTitle: nonEmptyStr(de.seo.metaTitle) ? de.seo.metaTitle : (fr.seo ? fr.seo.metaTitle : ''),
      metaDescription: nonEmptyStr(de.seo.metaDescription) ? de.seo.metaDescription : (fr.seo ? fr.seo.metaDescription : ''),
    };
  }
  return out;
}

const UMLAUT = [[/ä/g, 'ae'], [/ö/g, 'oe'], [/ü/g, 'ue'], [/ß/g, 'ss'], [/Ä/g, 'ae'], [/Ö/g, 'oe'], [/Ü/g, 'ue']];

/** Slug allemand : translittère les umlauts puis réutilise le slugify du site. */
function germanSlug(name) {
  let s = String(name || '');
  for (const [re, r] of UMLAUT) s = s.replace(re, r);
  return require('./productPublic').slugify(s);
}

/**
 * Traduit une fiche → renvoie l'objet `localizations.de` prêt pour un $set
 * (champs traduits réconciliés + slug DE + gouvernance translatedAt/translatedBy).
 * `now` injectable pour les tests (sinon new Date()).
 */
async function translateProduct(product, { apiKey, model = 'gpt-4o-mini', now } = {}) {
  const fr = collectFields(product);
  if (Object.keys(fr).length === 0) throw new Error('Aucun champ à traduire');
  const deRaw = await impl.callOpenAI(fr, { apiKey, model });
  const de = reconcile(fr, deRaw);
  de.slug = germanSlug(de.name || product.name);
  de.translatedAt = now || new Date();
  de.translatedBy = 'openai:' + model;
  return de;
}

module.exports = {
  GLOSSARY,
  buildSystemPrompt,
  collectFields,
  reconcile,
  germanSlug,
  callOpenAI,
  translateProduct,
  _impl: impl, // pour injection en test
};
