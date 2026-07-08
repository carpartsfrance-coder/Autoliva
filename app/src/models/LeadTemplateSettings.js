'use strict';

const mongoose = require('mongoose');

/**
 * Paramétrage back-office des MODÈLES DE MESSAGES « leads » (SMS + email),
 * éditables depuis /admin/parametres/modeles-messages. Document unique /
 * singleton, sur le même modèle que SmsSettings.
 *
 * Chaque override est repéré par (channel, key) — cf. leadEmailTemplates.js :
 *   - enabled : false → le modèle disparaît du sélecteur (on ne l'utilise plus)
 *   - subject : sujet email personnalisé ('' = on garde le défaut du code)
 *   - body    : texte personnalisé ('' = on garde le défaut du code)
 * Les clés absentes utilisent les valeurs par défaut (activées). Stocker '' quand
 * le texte est identique au défaut permet de profiter des évolutions du défaut.
 */
const leadOverrideSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    channel: { type: String, enum: ['sms', 'email'], required: true },
    enabled: { type: Boolean, default: true },
    subject: { type: String, default: '' },
    body: { type: String, default: '' },
  },
  { _id: false }
);

const leadTemplateSettingsSchema = new mongoose.Schema(
  {
    singleton: { type: String, default: 'lead', unique: true, index: true },
    overrides: { type: [leadOverrideSchema], default: [] },
    updatedAt: { type: Date, default: Date.now },
    updatedByName: { type: String, default: '', trim: true },
  },
  { collection: 'leadtemplatesettings' }
);

module.exports = mongoose.models.LeadTemplateSettings
  || mongoose.model('LeadTemplateSettings', leadTemplateSettingsSchema);
