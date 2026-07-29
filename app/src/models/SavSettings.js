/*
 * SavSettings — singleton (key='global') stockant les paramètres
 * configurables du module SAV : SLA par type de pièce, règles
 * d'automatisation activables/désactivables.
 */
const mongoose = require('mongoose');

const slaPerPieceSchema = new mongoose.Schema(
  {
    pieceType: { type: String, required: true },
    days: { type: Number, min: 1, max: 60, default: 5 },
  },
  { _id: false }
);

const automationRuleSchema = new mongoose.Schema(
  {
    key: { type: String, required: true }, // 'relance_1', 'relance_2', 'clos_sans_reponse', 'echange_auto'
    enabled: { type: Boolean, default: true },
    daysThreshold: { type: Number, min: 0, max: 90, default: 7 },
    description: { type: String, trim: true },
  },
  { _id: false }
);

const savSettingsSchema = new mongoose.Schema(
  {
    key: { type: String, default: 'global', unique: true },
    slaPerPiece: { type: [slaPerPieceSchema], default: () => [
      { pieceType: 'mecatronique_dq200', days: 7 },
      { pieceType: 'mecatronique_dq250', days: 7 },
      { pieceType: 'mecatronique_dq381', days: 7 },
      { pieceType: 'mecatronique_dq500', days: 10 },
      { pieceType: 'boite_transfert', days: 8 },
      { pieceType: 'pont', days: 8 },
      { pieceType: 'differentiel', days: 8 },
      { pieceType: 'haldex', days: 6 },
      { pieceType: 'reducteur', days: 6 },
      { pieceType: 'cardan', days: 5 },
      { pieceType: 'autre', days: 5 },
    ] },
    integrations: {
      slackWebhookUrl: { type: String, trim: true, default: '' },
      slackChannel: { type: String, trim: true, default: '#sav' },
      googleReviewsUrl: { type: String, trim: true, default: '' },
      whatsappEnabled: { type: Boolean, default: false },
      qontoEnabled: { type: Boolean, default: false },
    },
    automationRules: { type: [automationRuleSchema], default: () => [
      { key: 'relance_1', enabled: true, daysThreshold: 7, description: "Si statut = en_attente_documents et derniere_communication > N jours → email de relance et passage en relance_1" },
      { key: 'relance_2', enabled: true, daysThreshold: 5, description: "Si statut = relance_1 sans réponse depuis N jours → email final et passage en relance_2" },
      { key: 'clos_sans_reponse', enabled: true, daysThreshold: 7, description: "Si statut = relance_2 sans réponse depuis N jours → clôture automatique avec email final" },
      { key: 'echange_auto', enabled: false, daysThreshold: 0, description: "Si analyse confirme défaut produit → créer une commande de remplacement avec remise 100% (désactivé par défaut)" },
    ] },
    // Coefficient appliqué au SLA des tickets de comptes PRO (B2B) : un garage a un
    // véhicule client immobilisé. 0,5 = deux fois plus rapide qu'un particulier,
    // 1 = pas de différence. Plancher appliqué à la pose : 1 h ou 1 jour ouvré.
    proSlaFactor: { type: Number, default: 0.5, min: 0.1, max: 1 },
  },
  { timestamps: true }
);

savSettingsSchema.statics.getSingleton = async function () {
  let s = await this.findOne({ key: 'global' });
  if (!s) s = await this.create({ key: 'global' });
  return s;
};

savSettingsSchema.statics.getSlaForPiece = async function (pieceType) {
  const s = await this.getSingleton();
  const found = (s.slaPerPiece || []).find((p) => p.pieceType === pieceType);
  return found ? found.days : 5;
};

/** Coefficient SLA des comptes pro. Tolérant : renvoie 0,5 si le réglage est absent/illisible. */
savSettingsSchema.statics.getProSlaFactor = async function () {
  try {
    const s = await this.getSingleton();
    const f = Number(s && s.proSlaFactor);
    return Number.isFinite(f) && f > 0 && f <= 1 ? f : 0.5;
  } catch (_) {
    return 0.5;
  }
};

module.exports = mongoose.model('SavSettings', savSettingsSchema);
