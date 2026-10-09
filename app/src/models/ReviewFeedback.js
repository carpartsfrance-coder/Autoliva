'use strict';

const mongoose = require('mongoose');

/**
 * Suivi d'une demande d'avis, côté CLIENT : un document par commande.
 *
 * Le message envoyé (e-mail / SMS / WhatsApp) ne pointe pas directement sur
 * Google mais sur `/mon-avis/<token>` : une page qui demande d'abord une note
 * de 1 à 5. Au-dessus du seuil, on renvoie vers Google ; en dessous, on
 * recueille le problème en interne pour le régler.
 *
 * ⚠ Cette orientation selon la note (« review gating ») est CONTRAIRE à la
 * politique Google sur les avis, qui interdit de solliciter sélectivement les
 * avis positifs. C'est un choix assumé de Killian (08/10/2026), et il est
 * réversible sans redéploiement : le réglage « proposer quand même le lien
 * Google » (AvisSettings.enquete.proposerGoogleAuxMecontents) rend le lien
 * visible à tout le monde, ce qui remet le dispositif dans les clous.
 *
 * Ce qu'on garde ici, et pourquoi :
 *  - `token` : identifiant d'URL, non devinable, STABLE pour une commande. Le
 *    même lien part par e-mail, SMS et WhatsApp — il doit donc survivre aux
 *    trois envois, d'où un document par commande et non par message.
 *  - `rating` / `message` : la réponse du client. C'est la seule trace qu'on
 *    aura d'un mécontentement qui, sans cette page, serait parti direct en
 *    avis public.
 *  - `statut` : où en est le traitement. Un retour négatif non traité est un
 *    avis négatif en sursis.
 */

const traitementSchema = new mongoose.Schema(
  {
    note: { type: String, default: '', trim: true },
    par: { type: String, default: '', trim: true },
    at: { type: Date, default: null },
  },
  { _id: false }
);

const reviewFeedbackSchema = new mongoose.Schema(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: 'Order', required: true, unique: true },
    orderNumber: { type: String, default: '', trim: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
    /* Copiés au moment de la demande : le client peut changer d'adresse ou
       supprimer son compte, le retour doit rester exploitable. */
    clientNom: { type: String, default: '', trim: true },
    clientEmail: { type: String, default: '', trim: true },
    clientTelephone: { type: String, default: '', trim: true },

    token: { type: String, required: true, unique: true },

    rating: { type: Number, default: null, min: 1, max: 5 },
    ratedAt: { type: Date, default: null },
    message: { type: String, default: '', trim: true },
    /* Numéro laissé sur le formulaire interne, qui peut différer de celui de
       la commande — c'est celui sur lequel le client veut être rappelé. */
    rappelTelephone: { type: String, default: '', trim: true },

    /* A-t-on envoyé ce client vers Google ? Posé au moment de la redirection.
       On ne peut pas savoir s'il a publié, seulement qu'on l'y a mené. */
    redirigeGoogleAt: { type: Date, default: null },

    statut: {
      type: String,
      enum: ['en_attente', 'publie', 'a_traiter', 'resolu'],
      default: 'en_attente',
      index: true,
    },
    traitement: { type: traitementSchema, default: () => ({}) },

    createdAt: { type: Date, default: Date.now },
    updatedAt: { type: Date, default: Date.now },
  },
  { collection: 'reviewfeedbacks' }
);

reviewFeedbackSchema.index({ statut: 1, ratedAt: -1 });

module.exports = mongoose.models.ReviewFeedback
  || mongoose.model('ReviewFeedback', reviewFeedbackSchema);
