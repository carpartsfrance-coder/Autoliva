/* ── Verrou d'envoi par lead ─────────────────────────────────────────────
   Les boutons « Envoyer » sont déjà bloqués dans la page, mais deux onglets
   (ou deux collègues) restent possibles : chacun lirait le même lead et le
   client recevrait deux fois le même e-mail / SMS / devis (ou la relance
   n° 1 puis la n° 2 dans la même seconde).

   Le verrou est posé de façon atomique en base (AbandonedCart.envoiEnCoursAt) ;
   il expire seul si le serveur s'arrête en plein envoi, et chaque requête ne
   retire que SON verrou (repéré par sa date exacte). */

const mongoose = require('mongoose');
const AbandonedCart = require('../models/AbandonedCart');

const DUREE_PAR_DEFAUT_MS = 60 * 1000;

async function prendreVerrouEnvoi(id, dureeMs = DUREE_PAR_DEFAUT_MS) {
  const marque = new Date();
  const limite = new Date(marque.getTime() - dureeMs);
  const r = await AbandonedCart.updateOne(
    { _id: id, $or: [{ envoiEnCoursAt: null }, { envoiEnCoursAt: { $lt: limite } }] },
    { $set: { envoiEnCoursAt: marque } },
  );
  return r && r.modifiedCount === 1 ? marque : null;
}

async function relacherVerrouEnvoi(id, marque) {
  try {
    await AbandonedCart.updateOne({ _id: id, envoiEnCoursAt: marque }, { $unset: { envoiEnCoursAt: 1 } });
  } catch (_) { /* le verrou expirera seul */ }
}

/**
 * Enveloppe un handler Express d'envoi.
 * opts.dureeMs : durée max d'un envoi (au-delà, le verrou est considéré abandonné).
 * opts.texte   : true → réponse 409 en texte (formulaire classique), sinon JSON.
 */
function avecVerrouEnvoi(handler, opts = {}) {
  const dureeMs = opts.dureeMs || DUREE_PAR_DEFAUT_MS;
  return async function envoiVerrouille(req, res, next) {
    const id = req.params.cartId || req.params.id;
    if (mongoose.connection.readyState !== 1 || !id || !mongoose.Types.ObjectId.isValid(id)) {
      return handler(req, res, next); // le handler renvoie lui-même l'erreur adaptée
    }
    let marque;
    try {
      marque = await prendreVerrouEnvoi(id, dureeMs);
      if (!marque && !(await AbandonedCart.exists({ _id: id }))) return handler(req, res, next); // → 404
    } catch (err) {
      return next(err);
    }
    if (!marque) {
      const message = 'Un envoi est déjà en cours pour ce client (autre onglet ou collègue). '
        + 'Attends quelques secondes et regarde l’historique avant de renvoyer.';
      if (opts.texte) return res.status(409).send(message);
      return res.status(409).json({ ok: false, error: message });
    }
    try {
      return await handler(req, res, next);
    } finally {
      await relacherVerrouEnvoi(id, marque);
    }
  };
}

module.exports = { avecVerrouEnvoi, prendreVerrouEnvoi, relacherVerrouEnvoi };
