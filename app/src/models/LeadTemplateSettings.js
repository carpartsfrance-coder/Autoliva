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

/**
 * Modèles PERSONNALISÉS créés depuis le back-office (en plus des modèles
 * d'origine définis dans leadEmailTemplates.js). Contrairement aux overrides,
 * ils portent tout leur contenu et sont librement ajoutables / supprimables.
 *   - id      : identifiant stable, sert de `key` dans le sélecteur (préfixé `custom_`)
 *   - channel : sms | email
 *   - label   : nom affiché dans le sélecteur
 *   - subject : objet (email uniquement)
 *   - body    : texte du message (peut contenir les variables {prenom}, {telephone}…)
 *   - enabled : false → masqué du sélecteur (sans supprimer)
 */
const leadCustomTemplateSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, trim: true },
    channel: { type: String, enum: ['sms', 'email'], required: true },
    label: { type: String, default: '', trim: true },
    subject: { type: String, default: '' },
    body: { type: String, default: '' },
    enabled: { type: Boolean, default: true },
    createdByName: { type: String, default: '', trim: true },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: false }
);

const leadTemplateSettingsSchema = new mongoose.Schema(
  {
    singleton: { type: String, default: 'lead', unique: true, index: true },
    overrides: { type: [leadOverrideSchema], default: [] },
    custom: { type: [leadCustomTemplateSchema], default: [] },
    updatedAt: { type: Date, default: Date.now },
    updatedByName: { type: String, default: '', trim: true },
  },
  { collection: 'leadtemplatesettings' }
);

module.exports = mongoose.models.LeadTemplateSettings
  || mongoose.model('LeadTemplateSettings', leadTemplateSettingsSchema);
