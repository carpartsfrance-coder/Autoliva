'use strict';

const mongoose = require('mongoose');

/**
 * Paramétrage back-office des SMS automatiques (document unique / singleton).
 * Chaque override est repéré par `key` (cf. services/smsCatalog.js) :
 *   - enabled  : false coupe l'envoi de ce SMS
 *   - template : texte personnalisé ('' = on garde le texte par défaut du catalogue)
 * Les clés absentes du tableau utilisent les valeurs par défaut (activé).
 */
const smsOverrideSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, trim: true },
    enabled: { type: Boolean, default: true },
    template: { type: String, default: '', trim: false },
  },
  { _id: false }
);

const smsSettingsSchema = new mongoose.Schema(
  {
    singleton: { type: String, default: 'sms', unique: true, index: true },
    overrides: { type: [smsOverrideSchema], default: [] },
    updatedAt: { type: Date, default: Date.now },
    updatedByName: { type: String, default: '', trim: true },
  },
  { collection: 'smssettings' }
);

module.exports = mongoose.models.SmsSettings || mongoose.model('SmsSettings', smsSettingsSchema);
