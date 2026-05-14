const mongoose = require('mongoose');

/**
 * Charges/dépenses de l'entreprise — tout ce qui pèse sur le résultat net
 * et qui n'est PAS déjà capturé par Product.costCents (le COGS produit).
 *
 * Catégories (typées) :
 *   - payment_fees : frais Mollie / Scalapay / virement bancaire
 *                   (peut être créé automatiquement par capture webhook)
 *   - marketing    : pub & acquisition (Google Ads, Meta, Microsoft, influenceurs)
 *   - personnel    : salaires + charges sociales
 *   - premises     : loyer + charges locaux (atelier, bureau)
 *   - saas         : outils SaaS récurrents (Render, MongoDB Atlas, ChatGPT, etc.)
 *   - purchases    : achats non-COGS (outillage atelier, fournitures, matos)
 *   - logistics    : transporteurs, emballages, matos d'expédition
 *   - sav          : coûts SAV (remplacement pièce, MO, transport SAV)
 *   - taxes        : impôts & taxes (CFE, IS, taxe foncière…)
 *   - bank         : frais bancaires (commissions, virements internationaux)
 *   - other        : autre
 *
 * Récurrence : si recurring=true et date dans le passé, la charge est
 * considérée comme appliquée à TOUS les mois jusqu'à recurringEndDate
 * (incluse) ou indéfiniment si recurringEndDate=null. Pas de cron : on
 * projette à la volée lors des agrégations (cf. expenseService).
 *
 * Source : trace l'origine de la saisie (manual vs auto via webhook).
 * Permet de re-générer les charges auto si besoin sans toucher au manuel.
 */
const EXPENSE_CATEGORIES = [
  'payment_fees',
  'marketing',
  'personnel',
  'premises',
  'saas',
  'purchases',
  'logistics',
  'sav',
  'taxes',
  'bank',
  'other',
];

const expenseSchema = new mongoose.Schema(
  {
    category: {
      type: String,
      enum: EXPENSE_CATEGORIES,
      required: true,
      index: true,
    },
    amountCents: { type: Number, required: true, min: 1 },
    /* Date de la charge (mois imputable). Pour les charges récurrentes c'est
     * la date du PREMIER mois. Le pivot d'aggregation utilise cette date. */
    date: { type: Date, required: true, index: true },
    description: { type: String, default: '', trim: true, maxlength: 500 },

    /* Récurrence : la charge s'applique à TOUS les mois entre `date` et
     * `recurringEndDate` (incluse). Si recurringEndDate=null → indéfini. */
    recurring: { type: Boolean, default: false },
    recurringEndDate: { type: Date, default: null },

    /* Lien optionnel vers une commande (utile pour les coûts SAV ou frais
     * paiement par commande). */
    relatedOrderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', default: null, index: true },

    /* Origine de la saisie : manual = via UI, auto_mollie/auto_scalapay =
     * créé par le webhook de capture frais paiement. Permet de distinguer
     * les charges modifiables (manual) des charges en lecture seule (auto). */
    source: {
      type: String,
      enum: ['manual', 'auto_mollie', 'auto_scalapay'],
      default: 'manual',
    },

    /* Pour les charges auto : id externe (Mollie payment/settlement id, etc.)
     * Sert à l'idempotence — ne pas recréer la même charge 2 fois. */
    externalRef: { type: String, default: '', trim: true, index: true },

    /* URL d'un justificatif éventuel (facture PDF, capture banque…) */
    attachmentUrl: { type: String, default: '', trim: true },

    createdBy: { type: String, default: '', trim: true },
  },
  {
    timestamps: true,
  }
);

/* Idempotence sur les charges auto : un externalRef ne peut exister qu'une
 * seule fois pour une source donnée. Permet aux webhooks de relancer le
 * sync sans créer de doublons. */
expenseSchema.index(
  { source: 1, externalRef: 1 },
  { unique: true, partialFilterExpression: { externalRef: { $type: 'string', $ne: '' } } }
);

module.exports = mongoose.model('Expense', expenseSchema);
module.exports.EXPENSE_CATEGORIES = EXPENSE_CATEGORIES;
