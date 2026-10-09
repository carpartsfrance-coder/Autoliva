'use strict';

/**
 * Enquête de satisfaction placée AVANT Google.
 *
 * Le lien envoyé au client ouvre `/mon-avis/<token>` : il note de 1 à 5.
 *  - note ≥ seuil → on l'envoie sur la fiche Google ;
 *  - note < seuil → on recueille le problème en interne, et personne n'est
 *    renvoyé vers Google (sauf si `proposerGoogleAuxMecontents` est activé).
 *
 * ⚠ RAPPEL DE CONFORMITÉ. Orienter selon la note est du « review gating », que
 * la politique Google sur les avis interdit (« ne découragez pas les avis
 * négatifs, ne sollicitez pas sélectivement les avis positifs »). C'est un
 * choix assumé, pris le 08/10/2026, et le réglage
 * `proposerGoogleAuxMecontents` suffit à revenir dans les clous sans toucher
 * au code : l'enquête sert alors à DÉTECTER le mécontentement et à le traiter,
 * sans jamais cacher le lien.
 */

const crypto = require('crypto');
const mongoose = require('mongoose');
const ReviewFeedback = require('../models/ReviewFeedback');
const avis = require('./avisGoogle');
const { getSiteUrlFromEnv } = require('./siteUrl');
const brand = require('../config/brand');

function texte(v) { return typeof v === 'string' ? v : ''; }

/**
 * 12 caractères base64url tirés du CSPRNG (72 bits).
 *
 * Deux contraintes qui tirent en sens inverse :
 *  - la page est publique et sans authentification, le jeton est la SEULE
 *    chose qui protège le retour d'un client. Un identifiant séquentiel ou un
 *    dérivé du n° de commande laisserait parcourir les avis des autres ;
 *  - le lien part par SMS, où chaque caractère compte : il décide à lui seul
 *    du passage à deux segments.
 *
 * 72 bits tranchent : il faudrait de l'ordre de 2^71 tentatives pour en
 * trouver un, et ce qu'on y gagnerait est le prénom et le n° de commande d'un
 * client. Passer à 144 bits doublerait le coût du SMS pour rien.
 *
 * Les jetons de 24 caractères émis avant le 09/10/2026 restent valides :
 * `parToken` n'impose pas de longueur.
 */
function nouveauToken() {
  return crypto.randomBytes(9).toString('base64url');
}

function baseUrl() {
  return (getSiteUrlFromEnv() || brand.SITE_URL || '').replace(/\/$/, '');
}

/** URL publique de l'enquête pour un jeton donné. */
function urlEnquete(token) {
  return `${baseUrl()}/mon-avis/${encodeURIComponent(token)}`;
}

/**
 * Récupère le suivi d'une commande, ou le crée. Le jeton est STABLE : le même
 * lien doit fonctionner qu'il soit parti par e-mail, par SMS ou par WhatsApp,
 * et après une relance.
 *
 * @param {Object} order commande (lean ou document)
 * @param {Object} user  client résolu depuis order.userId (peut être null)
 */
async function pourCommande(order, user) {
  if (!order || !order._id) return null;
  const existant = await ReviewFeedback.findOne({ orderId: order._id });
  if (existant) return existant;

  const nomLivraison = texte(order.shippingAddress && order.shippingAddress.fullName).trim();
  const telephone = texte(
    (order.shippingAddress && order.shippingAddress.phone)
    || (order.billingAddress && order.billingAddress.phone)
  ).trim();

  try {
    return await ReviewFeedback.create({
      orderId: order._id,
      orderNumber: texte(order.number),
      userId: order.userId || null,
      clientNom: [texte(user && user.firstName), texte(user && user.lastName)].join(' ').trim() || nomLivraison,
      clientEmail: texte(user && user.email).trim(),
      clientTelephone: telephone,
      token: nouveauToken(),
      statut: 'en_attente',
    });
  } catch (err) {
    /* Course entre deux envois simultanés (e-mail et SMS cliqués coup sur
       coup) : l'index unique sur orderId refuse le second. Le document de
       l'autre requête fait très bien l'affaire — surtout pas un second jeton,
       qui invaliderait le lien déjà parti. */
    if (err && err.code === 11000) {
      const r = await ReviewFeedback.findOne({ orderId: order._id });
      if (r) return r;
    }
    throw err;
  }
}

/** Lecture par jeton (page publique). */
async function parToken(token) {
  const t = texte(token).trim();
  if (!t || t.length > 64) return null;
  return ReviewFeedback.findOne({ token: t });
}

/**
 * Enregistre la note du client et décide de la suite.
 *
 * @returns {Promise<{ok:boolean, publier:boolean, lienAvis:string, doc:Object}>}
 *   publier=true → on redirige vers Google.
 */
async function enregistrerNote(doc, note) {
  const n = Math.round(Number(note));
  if (!Number.isFinite(n) || n < 1 || n > 5) return { ok: false, error: 'note invalide' };

  const reglages = await avis.enquete();
  const lienAvis = await avis.getLien();
  const publier = n >= reglages.seuil;

  doc.rating = n;
  doc.ratedAt = new Date();
  /* Une note déjà traitée ne retombe pas en « à traiter » parce que le client
     a rouvert le lien : on ne réécrit le statut que depuis l'attente, ou
     depuis un état qui n'a pas encore été pris en main. */
  if (doc.statut === 'en_attente' || doc.statut === 'publie') {
    doc.statut = publier ? 'publie' : 'a_traiter';
  }
  if (publier) doc.redirigeGoogleAt = new Date();
  doc.updatedAt = new Date();
  await doc.save();

  return { ok: true, publier, lienAvis, reglages, doc };
}

/**
 * Enregistre le détail d'un retour négatif. Renvoie le document pour que
 * l'appelant déclenche l'alerte interne.
 */
async function enregistrerMessage(doc, { message, telephone } = {}) {
  const m = texte(message).trim().slice(0, 4000);
  if (!m) return { ok: false, error: 'message vide' };
  doc.message = m;
  const tel = texte(telephone).trim().slice(0, 40);
  if (tel) doc.rappelTelephone = tel;
  if (doc.statut === 'en_attente' || doc.statut === 'publie') doc.statut = 'a_traiter';
  doc.updatedAt = new Date();
  await doc.save();
  return { ok: true, doc };
}

/** Marque un retour comme traité (ou le rouvre). */
async function traiter(id, { resolu, note, par } = {}) {
  if (!mongoose.Types.ObjectId.isValid(id)) return { ok: false, error: 'identifiant invalide' };
  const doc = await ReviewFeedback.findById(id);
  if (!doc) return { ok: false, error: 'retour introuvable' };
  doc.statut = resolu ? 'resolu' : 'a_traiter';
  doc.traitement = {
    note: texte(note).trim().slice(0, 2000),
    par: texte(par).slice(0, 120),
    at: new Date(),
  };
  doc.updatedAt = new Date();
  await doc.save();
  return { ok: true, doc };
}

/**
 * Liste pour le back-office. `filtre` ∈ 'a_traiter' | 'resolu' | 'publie' |
 * 'tous' (défaut : tout ce qui a une note, les demandes sans réponse n'ont
 * rien à montrer).
 */
async function lister({ filtre = 'repondus', limite = 200 } = {}) {
  const q = {};
  if (filtre === 'repondus') q.rating = { $ne: null };
  else if (filtre !== 'tous') q.statut = filtre;
  return ReviewFeedback.find(q)
    .sort({ ratedAt: -1, createdAt: -1 })
    .limit(Math.min(500, Math.max(1, limite)))
    .lean();
}

/**
 * Chiffres de la page d'admin. `moyenne` ne porte que sur les notes reçues :
 * compter les demandes sans réponse comme des 0 inventerait des mécontents.
 */
async function statistiques() {
  if (mongoose.connection.readyState !== 1) return null;
  const [parStatut, notes] = await Promise.all([
    ReviewFeedback.aggregate([{ $group: { _id: '$statut', n: { $sum: 1 } } }]),
    ReviewFeedback.aggregate([
      { $match: { rating: { $ne: null } } },
      { $group: { _id: null, n: { $sum: 1 }, somme: { $sum: '$rating' } } },
    ]),
  ]);
  const statuts = {};
  parStatut.forEach((r) => { statuts[r._id] = r.n; });
  const agg = notes[0] || { n: 0, somme: 0 };
  return {
    envoyees: Object.values(statuts).reduce((a, b) => a + b, 0),
    repondues: agg.n,
    moyenne: agg.n ? Math.round((agg.somme / agg.n) * 10) / 10 : null,
    aTraiter: statuts.a_traiter || 0,
    resolus: statuts.resolu || 0,
    publies: statuts.publie || 0,
    sansReponse: statuts.en_attente || 0,
  };
}

module.exports = {
  nouveauToken,
  urlEnquete,
  pourCommande,
  parToken,
  enregistrerNote,
  enregistrerMessage,
  traiter,
  lister,
  statistiques,
};
