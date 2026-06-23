'use strict';
/**
 * Décision d'autoliquidation TVA (reverse charge B2B UE) — garde-fous centralisés.
 *
 * Défauts retenus (À CONFIRMER PAR KEOBIZ) :
 *  - pays décisionnel = FACTURATION (billing)
 *  - validation VIES POSITIVE obligatoire (un format correct ne suffit pas)
 *  - HT uniquement sur les lignes vatRecoverable=true (les produits en TVA sur
 *    marge restent TTC, jamais autoliquidés)
 *  - frais de port : laissés TTC dans cette première version
 *
 * Aucune de ces fonctions n'encaisse ni ne modifie un montant : ce sont des
 * calculs purs, câblés en phase 2 dans pricing/checkout.
 */

const { isEuVatCountry } = require('../config/shippingZones');

const VAT_RATE = 0.20; // TVA FR 20 % (produits en régime normal)

const LEGAL_MENTION = 'Autoliquidation de la TVA par le preneur — art. 283-2 du CGI / art. 196 directive 2006/112/CE';

/**
 * L'autoliquidation s'applique-t-elle à cette commande ?
 * @param {{isPro:boolean, billingCountry:string, vatStatus:string, items:Array<{vatRecoverable:boolean}>}} p
 * @returns {boolean}
 */
function reverseChargeApplicable({ isPro, billingCountry, vatStatus, items }) {
  if (!isPro) return false;                          // particulier → TTC
  if (!isEuVatCountry(billingCountry)) return false; // France ou hors UE → TTC
  if (vatStatus !== 'valid') return false;           // VIES non positif / indispo → TTC
  // Au moins une ligne éligible (produit en TVA normale) ; sinon rien à autoliquider.
  return Array.isArray(items) && items.some((it) => it && it.vatRecoverable === true);
}

/**
 * Décompose la base HT des lignes éligibles (vatRecoverable=true). Les lignes en
 * marge (vatRecoverable=false) restent TTC, inchangées. Arrondi à la fin (1 seule
 * division) pour éviter les écarts de centimes cumulés.
 * @param {Array<{vatRecoverable:boolean, lineTotalCents:number}>} items
 * @returns {{eligibleTtcCents:number, eligibleHtCents:number, vatAmountCents:number}}
 */
function splitReverseChargeHt(items) {
  let eligibleTtcCents = 0;
  for (const it of (items || [])) {
    if (it && it.vatRecoverable === true) eligibleTtcCents += Number(it.lineTotalCents) || 0;
  }
  const eligibleHtCents = Math.round(eligibleTtcCents / (1 + VAT_RATE));
  return { eligibleTtcCents, eligibleHtCents, vatAmountCents: eligibleTtcCents - eligibleHtCents };
}

module.exports = { reverseChargeApplicable, splitReverseChargeHt, VAT_RATE, LEGAL_MENTION };
