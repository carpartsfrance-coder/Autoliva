'use strict';

/**
 * Marge d'une commande, en centimes, hors TVA — la valeur de conversion
 * envoyée à Google Ads.
 *
 * Pourquoi (08/11/2026) : Google recevait le prix TTC, TVA, port et consigne
 * compris, et une vente remboursée restait une vente. Les campagnes en
 * « Maximiser la valeur de conversion » cherchaient donc du chiffre
 * d'affaires, pas du bénéfice : une pièce vendue 1 500 € avec 200 € de marge
 * pesait plus lourd qu'une pièce vendue 900 € avec 450 €.
 *
 * Marge = ce qui reste à l'entreprise sur les pièces :
 *     prix encaissé
 *   − consigne (caution, rendue au retour de l'ancienne pièce)
 *   − TVA due, selon le régime réel de la vente (services/vatScheme.js) :
 *       normal → 20 % du prix ; marge (297 A) → 20 % de (vente − achat) ;
 *       autoliquidée → rien
 *   − port facturé (reversé au transporteur : considéré neutre)
 *   − remboursements hors consigne, hors TVA au prorata
 *   − prix d'achat de la pièce, dans cet ordre :
 *       1. celui saisi sur la commande (« Prix d'achat payé (TTC) »), sans sa
 *          TVA quand le fournisseur a facturé une TVA déductible ;
 *       2. sinon les prix d'achat HT des fiches produits (costCents), si
 *          TOUTES les lignes en ont un ;
 *       3. sinon une estimation : taux de marge par défaut × revenu des pièces
 *          (signalée `estimee`, et corrigée chez Google dès que le prix
 *          d'achat est saisi — voir googleAdsConversionSync).
 * Une commande remboursée, annulée ou impayée vaut 0. Jamais négatif (Google
 * n'accepte pas de valeur négative).
 *
 * Fonction pure, sans base : testée dans tests/unit/marge-commande.test.js.
 */

const vatScheme = require('./vatScheme');

/* Taux de marge brute quand le prix d'achat est inconnu. 50 % : marge
   mesurée sur les ventes Google Ads du 9 octobre au 7 novembre 2026 (pièces
   au prix d'achat connu : 9 515 € de marge pour 19 045 € HT). Réglable sans
   déploiement par GOOGLE_ADS_TAUX_MARGE_DEFAUT (ex. « 0.45 »). */
const TAUX_MARGE_DEFAUT = 0.5;

const STATUTS_SANS_VALEUR = new Set(['refunded', 'cancelled', 'draft', 'pending_payment']);

function tauxMargeParDefaut() {
  const v = Number(String(process.env.GOOGLE_ADS_TAUX_MARGE_DEFAUT || '').replace(',', '.'));
  return Number.isFinite(v) && v > 0 && v < 1 ? v : TAUX_MARGE_DEFAUT;
}

function entier(n) {
  const v = Number(n);
  return Number.isFinite(v) ? v : 0;
}

/**
 * @param {object} order commande (lean) : status, totalCents, consigne,
 *   shippingCostCents, vatScheme, vat, purchase, refunds, items, deletedAt
 * @param {object} [opts]
 * @param {Map<string, number|null>} [opts.couts] productId → prix d'achat HT
 *   en centimes (null = inconnu)
 * @param {number} [opts.tauxDefaut] taux de marge estimé (0 < t < 1)
 * @returns {{ margeCents:number, estimee:boolean, source:string,
 *   revenuPiecesCents:number, coutCents:number|null }}
 */
function margeCommande(order, opts = {}) {
  const o = order || {};
  const couts = opts.couts instanceof Map ? opts.couts : new Map();
  const taux = Number.isFinite(opts.tauxDefaut) && opts.tauxDefaut > 0 && opts.tauxDefaut < 1
    ? opts.tauxDefaut
    : tauxMargeParDefaut();
  const rien = (source) => ({ margeCents: 0, estimee: false, source, revenuPiecesCents: 0, coutCents: null });

  if (o.deletedAt || STATUTS_SANS_VALEUR.has(String(o.status || ''))) return rien('sans_valeur');

  const base = vatScheme.baseTaxableCents(o); // encaissé − consigne
  if (base <= 0) return rien('sans_valeur');

  const autoliquidee = !!(o.vat && o.vat.reverseCharge);
  const sousMarge = !autoliquidee && String(o.vatScheme || 'normal') === 'margin';
  const achatSaisi = o.purchase && Number.isFinite(o.purchase.priceCents) && o.purchase.priceCents > 0
    ? o.purchase.priceCents
    : null;

  const port = Math.max(0, entier(o.shippingCostCents));
  // Remboursements hors consigne : ce qui a été rendu au client.
  const rembourse = (Array.isArray(o.refunds) ? o.refunds : [])
    .filter((r) => r && r.kind !== 'consigne')
    .reduce((s, r) => s + Math.max(0, entier(r.amountCents)), 0);
  if (rembourse >= base) return rien('rembourse');

  // Ce que les pièces ont rapporté, hors TVA, hors port, hors remboursements.
  let revenuPieces;
  if (autoliquidee) {
    revenuPieces = base - port - rembourse;
  } else if (sousMarge) {
    const revenuNet = base - vatScheme.tvaMargeCents(o, achatSaisi || 0);
    revenuPieces = revenuNet
      - Math.round(port / (1 + vatScheme.TAUX_NORMAL))
      - Math.round(rembourse * (revenuNet / base));
  } else {
    revenuPieces = Math.round((base - port - rembourse) / (1 + vatScheme.TAUX_NORMAL));
  }
  revenuPieces = Math.max(0, revenuPieces);

  // Prix d'achat.
  let cout = null;
  let source = 'estimation';
  if (achatSaisi != null) {
    const regime = String((o.purchase && o.purchase.supplierRegime) || '');
    cout = regime === 'tva_deductible'
      ? Math.round(achatSaisi / (1 + vatScheme.TAUX_NORMAL))
      : achatSaisi;
    source = 'achat_commande';
  } else {
    const lignes = Array.isArray(o.items) ? o.items : [];
    let total = 0;
    let complet = lignes.length > 0;
    for (const it of lignes) {
      const id = it && it.productId ? String(it.productId) : '';
      const cu = id && couts.has(id) ? couts.get(id) : null;
      if (cu == null || !Number.isFinite(cu)) { complet = false; break; }
      total += Math.max(0, entier(it.quantity)) * Math.max(0, cu);
    }
    if (complet) {
      cout = total;
      source = 'catalogue';
    }
  }

  if (cout == null) {
    return {
      margeCents: Math.max(0, Math.round(revenuPieces * taux)),
      estimee: true,
      source: 'estimation',
      revenuPiecesCents: revenuPieces,
      coutCents: null,
    };
  }
  return {
    margeCents: Math.max(0, Math.round(revenuPieces - cout)),
    estimee: false,
    source,
    revenuPiecesCents: revenuPieces,
    coutCents: cout,
  };
}

// Les champs dont margeCommande a besoin (projection Mongo).
const CHAMPS_MARGE = 'status totalCents consigne.chargedTotalCents shippingCostCents vatScheme vat.reverseCharge '
  + 'purchase.priceCents purchase.supplierRegime refunds.amountCents refunds.kind items.productId items.quantity deletedAt';

module.exports = { margeCommande, tauxMargeParDefaut, TAUX_MARGE_DEFAUT, CHAMPS_MARGE };
