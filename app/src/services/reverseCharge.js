'use strict';
/**
 * Décision d'autoliquidation TVA (reverse charge B2B UE) — garde-fous centralisés.
 *
 * Règles (validées Killian / Keobiz) :
 *  - pays décisionnel = FACTURATION (billing)
 *  - validation VIES POSITIVE obligatoire (un format correct ne suffit pas)
 *  - HT uniquement sur les lignes vatRecoverable=true (les produits en TVA sur
 *    marge restent TTC, jamais autoliquidés)
 *  - frais de PORT en HT (suivent le régime du bien en B2B intracommunautaire)
 *
 * Calculs purs, câblés dans checkout derrière le flag VAT_REVERSE_CHARGE_ENABLED.
 */

const { isEuVatCountry } = require('../config/shippingZones');

const VAT_RATE = 0.20; // TVA FR 20 % (produits en régime normal)

// Mention pour une LIVRAISON INTRACOMMUNAUTAIRE DE BIENS (pièces auto = biens).
// art. 262 ter I du CGI (≠ art. 283-2 qui vise les SERVICES) ; art. 138 directive
// 2006/112/CE. Le client réalise une acquisition intracommunautaire (autoliquidation
// chez lui). Le n° de TVA intracom. de l'acquéreur doit aussi figurer sur la facture.
const LEGAL_MENTION = 'Exonération de TVA — livraison intracommunautaire, art. 262 ter I du CGI (art. 138 directive 2006/112/CE). Autoliquidation par l\'acquéreur.';

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

/**
 * Décompose TVA d'une commande en autoliquidation. Opère sur les lignes FINALES
 * (lineTotalCents déjà net de remises) + les frais de port (HT aussi). Les lignes
 * en marge (vatRecoverable=false) restent TTC. La consigne (caution hors-TVA) est
 * passée à part et n'est jamais affectée.
 * @param {Array<{vatRecoverable:boolean, lineTotalCents:number}>} items
 * @param {number} shippingCostCents  frais de port saisis (TTC)
 * @returns {{eligibleTtcCents,eligibleHtCents,shippingTtcCents,shippingHtCents,
 *   htBaseCents,vatAmountCents}}
 *   - htBaseCents = base HT totale (produits éligibles + port) pour la facture
 *   - vatAmountCents = TVA retirée (= montant à soustraire du total TTC pour obtenir le total encaissé HT)
 */
function computeOrderVat(items, shippingCostCents) {
  const { eligibleTtcCents, eligibleHtCents } = splitReverseChargeHt(items);
  const shippingTtcCents = Math.max(0, Number(shippingCostCents) || 0);
  const shippingHtCents = Math.round(shippingTtcCents / (1 + VAT_RATE));
  const vatAmountCents = (eligibleTtcCents - eligibleHtCents) + (shippingTtcCents - shippingHtCents);
  return {
    eligibleTtcCents, eligibleHtCents,
    shippingTtcCents, shippingHtCents,
    htBaseCents: eligibleHtCents + shippingHtCents,
    vatAmountCents,
  };
}

/**
 * Transforme une commande en autoliquidation pour le PAIEMENT. Arrondit le HT
 * AU NIVEAU UNITAIRE (le prix de ligne = htUnit × qty) pour que la somme des
 * lignes envoyées à Scalapay colle EXACTEMENT au nouveau total (sinon Scalapay
 * rejette : il vérifie Σ(lignes) + port + taxe == total).
 *
 * Prérequis appelant : commande SANS consigne (consigneChargeCents===0) — garde-fou
 * en place côté checkout pour éviter l'interaction consigne/HT/Scalapay en v1.
 *
 * @param {Array<{unitPriceCents:number, quantity:number, vatRecoverable:boolean}>} items lignes APRÈS remise
 * @param {number} shippingCostCents frais de port (TTC)
 * @returns {{transformedItems:Array, itemsTotalHtCents:number, shippingHtCents:number,
 *   newTotalCents:number, htBaseCents:number, vatAmountCents:number}}
 *   - transformedItems : mêmes lignes, unitPriceCents/lineTotalCents passés en HT pour les éligibles
 *   - newTotalCents : Σ(lignes transformées) + port HT  → montant à débiter (Mollie + Scalapay)
 *   - htBaseCents : base HT (produits éligibles + port) pour la facture
 *   - vatAmountCents : TVA autoliquidée (non encaissée) = ancien total − newTotalCents
 */
function applyReverseCharge(items, shippingCostCents) {
  const list = Array.isArray(items) ? items : [];
  let eligibleTtcCents = 0;
  let eligibleHtCents = 0;
  const transformedItems = list.map((it) => {
    const unit = Math.max(0, Number(it && it.unitPriceCents) || 0);
    const qty = Math.max(1, Number(it && it.quantity) || 1);
    const isElig = it && it.vatRecoverable === true;
    const htUnit = isElig ? Math.round(unit / (1 + VAT_RATE)) : unit;
    if (isElig) { eligibleTtcCents += unit * qty; eligibleHtCents += htUnit * qty; }
    return { ...it, unitPriceCents: htUnit, lineTotalCents: htUnit * qty, ttcUnitPriceCents: unit };
  });
  const itemsTotalHtCents = transformedItems.reduce((s, it) => s + it.lineTotalCents, 0);
  const shippingTtcCents = Math.max(0, Number(shippingCostCents) || 0);
  const shippingHtCents = Math.round(shippingTtcCents / (1 + VAT_RATE));
  const newTotalCents = itemsTotalHtCents + shippingHtCents;
  const vatAmountCents = (eligibleTtcCents - eligibleHtCents) + (shippingTtcCents - shippingHtCents);
  return {
    transformedItems, itemsTotalHtCents, shippingHtCents, newTotalCents,
    htBaseCents: eligibleHtCents + shippingHtCents, vatAmountCents,
  };
}

module.exports = { reverseChargeApplicable, splitReverseChargeHt, computeOrderVat, applyReverseCharge, VAT_RATE, LEGAL_MENTION };
