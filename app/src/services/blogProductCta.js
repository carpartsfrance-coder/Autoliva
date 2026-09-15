'use strict';

/**
 * Encadré « produit » inséré dans les articles de blog, en français et en
 * allemand.
 *
 * ── Pourquoi ce module (plan de reprise SEO du 14/09/2026, action A11) ──────
 *
 * L'encadré était écrit en dur, deux fois (blogController, blogDeController),
 * et annonçait sur CHAQUE article :
 *
 *   « Pièce reconditionnée — Garantie 2 ans », « Testé et garanti 24 mois »,
 *   « Paiement sécurisé en 3x sans frais »
 *
 * quelle que soit la pièce liée. Une pièce d'occasion garantie 6 ou 12 mois
 * héritait ainsi d'une promesse de pièce refaite garantie deux ans, et le
 * paiement en 3 fois restait annoncé en français alors que Scalapay est coupé
 * depuis le 05/08 (l'allemand avait déjà été corrigé, le français non).
 *
 * L'encadré ne dit plus que ce que la fiche dit elle-même : son état (la
 * pastille saisie dans l'admin), sa garantie (warranty.months), son délai
 * (shippingDelayText). Une donnée absente n'est pas remplacée par une
 * promesse : la ligne disparaît.
 */

const scalapay = require('./scalapay');

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function texte(v) {
  return typeof v === 'string' ? v.trim() : '';
}

/** Mois de garantie saisis sur la fiche, ou null s'il n'y en a pas. */
function moisGarantie(produit) {
  const m = produit && produit.warranty ? Number(produit.warranty.months) : NaN;
  return Number.isFinite(m) && m > 0 ? Math.round(m) : null;
}

/* La version allemande ne reprend un champ que s'il a été TRADUIT : une
   pastille « Occasion » en français au milieu d'un encadré allemand vaut moins
   qu'une pastille absente. */
function champDe(produit, chemin) {
  const de = produit && produit.localizations && produit.localizations.de;
  if (!de || !de.translatedAt) return '';
  return texte(chemin.split('.').reduce((o, k) => (o ? o[k] : undefined), de));
}

function etat(produit, lang) {
  return lang === 'de'
    ? champDe(produit, 'badges.condition')
    : texte(produit && produit.badges && produit.badges.condition);
}

function delai(produit, lang) {
  return lang === 'de'
    ? champDe(produit, 'shippingDelayText')
    : texte(produit && produit.shippingDelayText);
}

function prix(cents) {
  return (cents / 100).toFixed(2).replace('.', ',');
}

const LIBELLES = {
  fr: {
    garantie: (m) => `Garantie ${m} mois`,
    eyebrowParDefaut: 'Pièce auto',
    prix: (p) => `${p} € TTC`,
    troisFois: (p) => `soit 3x ${p} € sans frais`,
    support: 'Support technique dédié',
    paiement3x: 'Paiement sécurisé en 3x sans frais',
    paiement: 'Paiement sécurisé',
    voir: 'Voir la fiche produit',
    contactUrl: '/contact',
    contact: 'Contacter un technicien',
  },
  de: {
    garantie: (m) => `${m} Monate Garantie`,
    eyebrowParDefaut: 'Autoteil',
    prix: (p) => `${p} € inkl. MwSt.`,
    troisFois: (p) => `bzw. 3 Raten à ${p} € ohne Aufpreis`,
    support: 'Dedizierter Technik-Support',
    paiement3x: 'Sichere Zahlung in 3 Raten ohne Aufpreis',
    paiement: 'Sichere Zahlung',
    voir: 'Zum Produkt',
    contactUrl: '/de/contact',
    contact: 'Techniker kontaktieren',
  },
};

/**
 * @param {object} produit  fiche liée (badges, warranty, shippingDelayText,
 *                          priceCents, localizations.de…)
 * @param {object} options  { lang: 'fr'|'de', url, nom, scalapayActif? }
 */
function construireCta(produit, { lang = 'fr', url, nom, scalapayActif } = {}) {
  const L = LIBELLES[lang] || LIBELLES.fr;
  const actif = typeof scalapayActif === 'boolean' ? scalapayActif : scalapay.estActif();
  const cents = produit && Number.isFinite(produit.priceCents) ? produit.priceCents : 0;
  const mois = moisGarantie(produit);

  const eyebrow = [etat(produit, lang), mois ? L.garantie(mois) : '']
    .filter(Boolean).join(' — ') || L.eyebrowParDefaut;
  const sousPrix = (actif && cents > 50000) ? L.troisFois(prix(cents / 3)) : '';

  const lignes = [
    mois ? L.garantie(mois) : '',
    /* Pas de délai par défaut : « Lieferung 3-5 Werktage » ou « Expédition
       depuis la France » promettaient, faute de texte traduit ou saisi, ce
       que la fiche ne dit pas (pièces expédiées par un fournisseur étranger,
       « Délai selon disponibilité » sur 145 des 299 fiches liées). */
    delai(produit, lang),
    L.support,
    actif ? L.paiement3x : L.paiement,
  ].filter(Boolean);

  return `<div class="blog-product-cta" data-product-cta="1">`
    + `<span class="cta-eyebrow">${escapeHtml(eyebrow)}</span>`
    + `<h3 class="cta-title">${escapeHtml(nom || (produit && produit.name) || '')}</h3>`
    + (cents > 0 ? `<span class="cta-price">${escapeHtml(L.prix(prix(cents)))}</span>` : '')
    + (sousPrix ? `<span class="cta-price-sub">${escapeHtml(sousPrix)}</span>` : '')
    + `<ul class="cta-features">`
    + lignes.map((l) => `<li>${escapeHtml(l)}</li>`).join('')
    + `</ul>`
    + `<a class="cta-btn" href="${escapeHtml(url || '#')}">${escapeHtml(L.voir)}</a>`
    + `<a class="cta-btn-outline" href="${escapeHtml(L.contactUrl)}">${escapeHtml(L.contact)}</a>`
    + `</div>`;
}

/** Champs à charger sur la fiche liée pour que l'encadré dise vrai. */
const CHAMPS_FICHE = 'badges.condition warranty.months shippingDelayText '
  + 'localizations.de.badges.condition localizations.de.shippingDelayText';

module.exports = { construireCta, moisGarantie, CHAMPS_FICHE };
