'use strict';

/**
 * Régime de TVA d'une vente — décision au cas par cas.
 *
 * ── LE PROBLÈME QUE CE MODULE RÉSOUT ──────────────────────────────────────
 *
 * On vend des pièces achetées tantôt avec TVA déductible, tantôt sous le
 * régime de la marge, tantôt en autoliquidation intracommunautaire. Jusqu'ici
 * tout partait à 20 % : facture client, export comptable, tableau de bord.
 * Sur une pièce achetée sous marge, cela revenait à reverser au Trésor la TVA
 * sur le prix de vente ENTIER au lieu de la seule marge — l'écart part
 * directement du bénéfice.
 *
 * ── POURQUOI LA DÉCISION NE PEUT PAS ÊTRE AUTOMATIQUE ─────────────────────
 *
 * Le régime ne se déduit ni de la pièce, ni du fournisseur : un même
 * fournisseur facture sous marge une semaine et en intracommunautaire la
 * suivante. Il n'est connu qu'en lisant la facture d'achat — donc APRÈS la
 * vente, puisque la pièce est sourcée à la commande. D'où : tout est à 20 %
 * par défaut, et la marge se réclame à la main, vente par vente.
 *
 * Ce n'est pas un pis-aller. L'article 297 C du CGI autorise expressément le
 * revendeur à renoncer à la marge, opération par opération et sans formalisme.
 * Rester à 20 % est donc TOUJOURS régulier : ne rien décider ne coûte qu'une
 * économie manquée, jamais un redressement. L'inverse n'est pas vrai — d'où
 * les garde-fous ci-dessous.
 */

const TAUX_NORMAL = 0.20;

/**
 * Ce que porte la facture du fournisseur, et ce que ça autorise.
 *
 * `margeAutorisee` n'est pas une préférence : l'article 297 A II réserve le
 * régime de la marge aux biens achetés à quelqu'un qui n'a pas pu facturer de
 * TVA déductible (non-assujetti, particulier, ou revendeur lui-même sous
 * marge). Si le fournisseur nous a facturé une TVA que nous déduisons, la
 * revente est au taux normal — et l'article 256 bis I 2° bis exclut de la
 * marge tout bien acquis en autoliquidation intracommunautaire.
 */
const REGIMES_FOURNISSEUR = [
  {
    key: 'marge',
    label: 'Sous marge (aucune TVA sur la facture d\'achat)',
    margeAutorisee: true,
  },
  {
    key: 'non_assujetti',
    label: 'Particulier ou non-assujetti (pas de TVA)',
    margeAutorisee: true,
  },
  {
    key: 'tva_deductible',
    label: 'Avec TVA française déductible',
    margeAutorisee: false,
    pourquoi: 'La TVA de la facture d\'achat est déductible : la revente est au taux normal '
      + '(art. 297 A II du CGI — la marge suppose un achat sans TVA déductible).',
  },
  {
    key: 'intracom_autoliquidation',
    label: 'Intracommunautaire, autoliquidée par nous',
    margeAutorisee: false,
    pourquoi: 'Un achat intracommunautaire autoliquidé exclut la marge à la revente '
      + '(art. 256 bis I 2° bis du CGI).',
  },
];

const REGIME_FOURNISSEUR_KEYS = REGIMES_FOURNISSEUR.map((r) => r.key);

function regimeFournisseur(key) {
  return REGIMES_FOURNISSEUR.find((r) => r.key === String(key || '')) || null;
}

/** Base taxable de la commande : le prix encaissé, consigne exclue. */
function baseTaxableCents(order) {
  const total = Number(order && order.totalCents) || 0;
  const consigne = order && order.consigne && Number.isFinite(order.consigne.chargedTotalCents)
    ? order.consigne.chargedTotalCents
    : 0;
  return Math.max(0, total - consigne);
}

/** TVA due au taux normal, sur le prix entier. */
function tvaNormaleCents(order) {
  return Math.round(baseTaxableCents(order) * TAUX_NORMAL / (1 + TAUX_NORMAL));
}

/**
 * TVA due sous le régime de la marge : 20 % de (prix de vente − prix d'achat),
 * la marge étant elle-même TTC (art. 297 A).
 */
function tvaMargeCents(order, achatCents) {
  const achat = Number.isFinite(achatCents) ? Math.max(0, achatCents) : 0;
  const marge = Math.max(0, baseTaxableCents(order) - achat);
  return Math.round(marge * TAUX_NORMAL / (1 + TAUX_NORMAL));
}

/**
 * Peut-on réclamer la marge sur cette vente ?
 *
 * Retourne `{ ok: true }` ou `{ ok: false, raison }`. La raison est écrite
 * pour être affichée telle quelle : c'est elle qui évite de refaire la
 * vérification à la main dans six mois.
 *
 * @param {object} order commande (régime fournisseur et achat compris)
 * @param {object} candidat { purchaseCents, supplierRegime } valeurs proposées
 */
function verifierMarge(order, candidat) {
  const c = candidat || {};
  const achatCents = Number.isFinite(c.purchaseCents) ? c.purchaseCents : null;
  const fournisseurKey = c.supplierRegime != null
    ? String(c.supplierRegime)
    : String((order && order.purchase && order.purchase.supplierRegime) || '');

  if (order && order.vat && order.vat.reverseCharge) {
    return {
      ok: false,
      raison: 'Cette vente est autoliquidée : la TVA est due par le client professionnel UE. '
        + 'Le régime de la marge ne peut pas s\'y appliquer.',
    };
  }

  const rf = regimeFournisseur(fournisseurKey);
  if (rf && rf.margeAutorisee === false) {
    return { ok: false, raison: rf.pourquoi };
  }

  if (achatCents == null || achatCents <= 0) {
    return {
      ok: false,
      raison: 'Le prix d\'achat est obligatoire : la marge se calcule sur '
        + '(prix de vente − prix d\'achat). Sans lui, aucune base à déclarer.',
    };
  }

  const base = baseTaxableCents(order);
  if (achatCents > base) {
    return {
      ok: false,
      raison: 'Le prix d\'achat dépasse le prix de vente : la marge serait négative. '
        + 'Vérifie le montant saisi (HT ou TTC ?).',
    };
  }

  return { ok: true };
}

/**
 * Ce que la décision change concrètement, en euros.
 *
 * Sert à afficher le gain AU MOMENT DE LA SAISIE : c'est le seul instant où
 * la question « est-ce que ça vaut le coup de retrouver la facture
 * fournisseur ? » se pose vraiment.
 */
function apercu(order, candidat) {
  const c = candidat || {};
  const achatCents = Number.isFinite(c.purchaseCents)
    ? c.purchaseCents
    : (order && order.purchase && Number.isFinite(order.purchase.priceCents) ? order.purchase.priceCents : null);

  const base = baseTaxableCents(order);
  const normale = tvaNormaleCents(order);
  const marge = achatCents == null ? null : tvaMargeCents(order, achatCents);

  return {
    baseCents: base,
    achatCents,
    margeCommercialeCents: achatCents == null ? null : Math.max(0, base - achatCents),
    tvaNormaleCents: normale,
    tvaMargeCents: marge,
    /* L'économie vaut exactement 1/6 du prix d'achat (20/120), tant que la
       marge reste positive — la TVA cesse de porter sur ce qu'on a payé. */
    economieCents: marge == null ? null : Math.max(0, normale - marge),
  };
}

module.exports = {
  TAUX_NORMAL,
  REGIMES_FOURNISSEUR,
  REGIME_FOURNISSEUR_KEYS,
  regimeFournisseur,
  baseTaxableCents,
  tvaNormaleCents,
  tvaMargeCents,
  verifierMarge,
  apercu,
};
