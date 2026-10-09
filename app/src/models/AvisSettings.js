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
    /* E-MAIL UNIQUEMENT. true = texte brut, sans gabarit : pas de logo, pas de
       bouton, pas de pied de page. Le gabarit maison ressemble à une
       newsletter, et c'est précisément ce que l'onglet Promotions attrape.
       Une demande d'avis est une correspondance d'une personne à une autre :
       elle doit en avoir l'air. Défaut true — le gabarit reste disponible. */
    texteSimple: { type: Boolean, default: true },
  },
  { _id: false }
);

/**
 * Enquête de satisfaction placée AVANT Google : le client note de 1 à 5 sur
 * une page à nous, et n'est renvoyé vers Google qu'au-dessus du seuil.
 *
 * ⚠ Orienter ainsi selon la note (« review gating ») est contraire à la
 * politique Google sur les avis. `proposerGoogleAuxMecontents` remet le
 * dispositif dans les clous sans redéploiement : l'enquête sert alors à
 * détecter et traiter le problème, mais le lien reste offert à tout le monde.
 */
const enqueteSchema = new mongoose.Schema(
  {
    active: { type: Boolean, default: true },
    /* Note à partir de laquelle on renvoie vers Google. 4 par défaut :
       en dessous, un avis public coûte plus cher que ce qu'il rapporte. */
    seuil: { type: Number, default: 4, min: 1, max: 5 },
    proposerGoogleAuxMecontents: { type: Boolean, default: false },
    /* Textes de la page publique. '' = défaut du code (même convention que
       les messages : on suit les évolutions du défaut tant qu'on n'a pas
       écrit le sien). */
    question: { type: String, default: '' },
    messageContent: { type: String, default: '' },
    messageMecontent: { type: String, default: '' },
    remerciement: { type: String, default: '' },
  },
  { _id: false }
);

/**
 * Bon d'achat offert en échange d'une RÉPONSE à l'enquête.
 *
 * ⚠ LA FRONTIÈRE LÉGALE EST ICI, ET ELLE EST ÉTROITE. Rémunérer un AVIS est
 * interdit par Google et constitue une pratique commerciale trompeuse en
 * droit français. Rémunérer la réponse à une enquête de satisfaction est une
 * dépense marketing ordinaire.
 *
 * Ce qui fait la différence, et que le code doit garantir — pas seulement
 * l'intention :
 *   - le bon part pour TOUTE note de 1 à 5, jamais seulement les bonnes ;
 *   - il n'est jamais conditionné à la publication d'un avis Google ;
 *   - on ne demande aucune preuve d'avis publié.
 * Ne jamais ajouter de condition sur `rating` ni sur `redirigeGoogleAt` dans
 * l'émission du bon : ce serait exactement l'infraction qu'on évite.
 */
const bonSchema = new mongoose.Schema(
  {
    actif: { type: Boolean, default: false },
    montantCents: { type: Number, default: 3000, min: 0 },
    /* Montant minimum de commande pour l'utiliser. 0 = aucun — mais un bon de
       30 € sans plancher sur une pièce à 35 € se solde par une vente à perte. */
    minimumCents: { type: Number, default: 0, min: 0 },
    validiteJours: { type: Number, default: 180, min: 1 },
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
    enquete: { type: enqueteSchema, default: () => ({}) },
    bon: { type: bonSchema, default: () => ({}) },
    updatedAt: { type: Date, default: Date.now },
    updatedByName: { type: String, default: '', trim: true },
  },
  { collection: 'avissettings' }
);

module.exports = mongoose.models.AvisSettings
  || mongoose.model('AvisSettings', avisSettingsSchema);
