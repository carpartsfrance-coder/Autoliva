'use strict';

// D'où vient une visite qui arrive SANS marqueur publicitaire (ni gclid, ni utm).
//
// Pourquoi ce module existe (diagnostic du 08/11/2026) : captureAttribution
// n'enregistrait une visite que si l'URL portait un gclid ou des utm_*. Une
// visite venue de Google gratuit n'en porte jamais : elle n'était ni comptée
// dans les visites, ni rattachée à la commande, qui tombait dans « Pré-tracking ».
// Search Console comptait 6 450 clics gratuits sur 28 jours ; l'outil, 1 visite
// organique sur 90 jours.
//
// Fonctions pures, sans I/O : testées dans tests/unit/source-visite.test.js.

// Référents « moteur de recherche ». Chaque nom d'hôte doit se terminer par un
// séparateur (/?#) ou la fin de chaîne ; TLD limitées à 2-4 caractères pour
// éviter « google.un-site-louche.com ». L'appli Google sur Android envoie
// android-app://com.google.android.googlequicksearchbox/.
const ORGANIC_REFERRER_REGEX = /^(?:https?:\/\/(?:[a-z0-9-]+\.)*(google\.[a-z]{2,4}(?:\.[a-z]{2})?|bing\.com|duckduckgo\.com|search\.brave\.com|brave\.com|qwant\.com|[a-z]+\.search\.yahoo\.com|search\.yahoo\.com|yahoo\.com|ecosia\.org|startpage\.com|search\.lilo\.org|lilo\.org|yandex\.[a-z]{2,4}(?:\.[a-z]{2})?|ya\.ru)|android-app:\/\/com\.google\.android\.googlequicksearchbox)(?:[\/?#]|$)/i;

// Assistants IA qui envoient des visiteurs (avec ou sans utm_source).
const AI_REFERRER_REGEX = /^https?:\/\/(?:[a-z0-9-]+\.)*(chatgpt\.com|openai\.com|perplexity\.ai|copilot\.microsoft\.com|copilot\.com|gemini\.google\.com|claude\.ai|you\.com|mistral\.ai)(?:[\/?#]|$)/i;

// Même liste, appliquée à un utm_source (ex. « chatgpt.com », « perplexity »).
const AI_SOURCE_REGEX = /(chatgpt|openai|perplexity|copilot|gemini|claude|mistral)/i;

// Moteurs de recherche, appliqué à un utm_source sans medium.
const SEARCH_SOURCE_REGEX = /^(google|bing|duckduckgo|qwant|yahoo|ecosia|startpage|brave|lilo|yandex)$/i;

// Retours de paiement et de 3-D Secure : ce ne sont pas des sources de visite.
const PAYMENT_HOST_REGEX = /(^|\.)(mollie\.com|stripe\.com|paypal\.com|paypal\.me|scalapay\.com|alma\.eu|getalma\.eu|oney\.(fr|com)|klarna\.com|payplug\.com|lyra\.com|systempay\.fr|sumup\.com|monext\.(fr|net)|payline\.com|cardinalcommerce\.com|wlp-acs\.com|3dsecure\.[a-z.]+|securecode\.[a-z.]+)$|(^|[.-])(acs|3ds|3dsecure)[.-]/i;

// Nos propres domaines (navigation interne, ancien domaine redirigé).
const OWN_HOST_REGEX = /(^|\.)autoliva\.(com|fr|de)$/i;

// Robots qui se déclarent. Les robots qui se font passer pour un navigateur
// passent ici — mais ils envoient rarement un référent, et on n'enregistre pas
// les visites sans référent (voir captureAttribution).
const BOT_UA_REGEX = /bot\b|bot\/|crawl|spider|slurp|facebookexternalhit|embedly|preview|headless|phantomjs|puppeteer|playwright|selenium|lighthouse|pagespeed|gtmetrix|pingdom|uptime|monitor|python|curl\/|wget|httpclient|okhttp|java\/|go-http|axios|node-fetch|undici|scrapy|ahrefs|semrush|mj12|dotbot|petalbot|bytespider|gptbot|ccbot|claudebot|perplexitybot|applebot|yandex|baiduspider|duckduckbot|bingpreview|google-inspectiontool|storebot|adsbot|mediapartners/i;

function isBotUserAgent(ua) {
  if (typeof ua !== 'string' || !ua.trim()) return true; // pas d'UA : pas un navigateur
  return BOT_UA_REGEX.test(ua);
}

function refererHost(referrer) {
  if (typeof referrer !== 'string' || !referrer) return '';
  try {
    return new URL(referrer).hostname.toLowerCase().replace(/^www\./, '');
  } catch (_) {
    return '';
  }
}

// Classe une visite d'après son référent seul.
// Retourne 'organic' | 'ai' | 'referral' | 'internal' | 'payment' | 'direct'.
//   - internal : clic depuis une page du site (pas une nouvelle visite) ;
//   - payment  : retour de Mollie, PayPal, 3-D Secure… (pas une source) ;
//   - direct   : aucun référent (URL tapée, favori, appli mail, robot…).
function classifyReferrer(referrer, selfHost = '') {
  const ref = typeof referrer === 'string' ? referrer.trim() : '';
  if (!ref) return 'direct';
  if (ORGANIC_REFERRER_REGEX.test(ref)) return 'organic';
  if (AI_REFERRER_REGEX.test(ref)) return 'ai';
  const host = refererHost(ref);
  if (!host) return 'direct';
  const self = String(selfHost || '').toLowerCase().replace(/^www\./, '');
  if (OWN_HOST_REGEX.test(host) || (self && (host === self || host.endsWith('.' + self)))) return 'internal';
  if (PAYMENT_HOST_REGEX.test(host)) return 'payment';
  return 'referral';
}

// Les visites qui comptent (filtre Mongo sur AttributionTouch) : celles qui
// portent un marqueur (gclid, utm…), comme avant, et les visites gratuites
// confirmées par le navigateur. Les visites gratuites enregistrées entre le
// 08/11/2026 vers 18 h et le correctif suivant (robots et préchargements
// compris, une centaine par heure) n'ont pas de confirmation : exclues.
const MARQUEURS = ['gclid', 'gbraid', 'wbraid', 'fbclid', 'msclkid', 'utmSource', 'utmMedium', 'utmCampaign', 'utmContent', 'utmTerm'];
const FILTRE_VISITES_COMPTEES = {
  $or: [
    { confirmedArrival: true },
    ...MARQUEURS.map((champ) => ({ [champ]: { $gt: '' } })),
  ],
};

module.exports = {
  FILTRE_VISITES_COMPTEES,
  ORGANIC_REFERRER_REGEX,
  AI_REFERRER_REGEX,
  AI_SOURCE_REGEX,
  SEARCH_SOURCE_REGEX,
  isBotUserAgent,
  refererHost,
  classifyReferrer,
};
