'use strict';

const mongoose = require('mongoose');

/**
 * Paramétrage back-office de la DEMANDE D'AVIS GOOGLE (/admin/parametres/avis).
 * Document unique / singleton, sur le même modèle que SmsSettings.
 *
 * Remplace Skeepers / Avis Vérifiés (retiré en octobre 2026) : les demandes
 * partent désormais de NOS propres canaux (e-mail MailerSend, SMS Brevo,
 * WhatsApp click-to-chat) et pointent vers la fiche Google d'Autoliva.
 *
 * Chaque canal porte :
 *   - enabled : false → le canal disparaît du composeur (on ne l'utilise plus)
 *   - sujet   : objet de l'e-mail ('' = on garde le défaut du code)
 *   - corps   : texte du message ('' = on garde le défaut du code)
 *
 * Stocker '' quand le texte est identique au défaut permet de profiter des
 * évolutions du défaut sans réécrire le réglage (même convention que
 * smsSettings / leadTemplateSettings).
 */
const canalSchema = new mongoose.Schema(
  {
    enabled: { type: Boolean, default: true },
    sujet: { type: String, default: '' },
    corps: { type: String, default: '' },
  },
  { _id: false }
);

const avisSettingsSchema = new mongoose.Schema(
  {
    singleton: { type: String, default: 'avis', unique: true, index: true },
    /* Lien vers lequel on envoie le client. '' → LIEN_PAR_DEFAUT du service.
       Un lien « écrire un avis » direct (search.google.com/local/writereview…)
       est accepté tel quel : rien ici ne suppose un domaine particulier. */
    lienAvis: { type: String, default: '', trim: true },
    email: { type: canalSchema, default: () => ({}) },
    sms: { type: canalSchema, default: () => ({}) },
    whatsapp: { type: canalSchema, default: () => ({}) },
    updatedAt: { type: Date, default: Date.now },
    updatedByName: { type: String, default: '', trim: true },
  },
  { collection: 'avissettings' }
);

module.exports = mongoose.models.AvisSettings
  || mongoose.model('AvisSettings', avisSettingsSchema);
