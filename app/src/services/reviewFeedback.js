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
const PromoCode = require('../models/PromoCode');
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
 * ── UNE NOTE NE PEUT QUE BAISSER ────────────────────────────────────────────
 *
 * Sans cette règle, le filtre ne filtre rien : le client met 3/5, tombe sur le
 * formulaire interne, revient en arrière dans son navigateur — la page aux
 * étoiles est encore dans le cache — clique 5/5, et il est sur Google. La
 * protection ne peut pas vivre dans la page : elle doit être ICI, puisque
 * n'importe qui peut rejouer la requête.
 *
 * Pourquoi « ne peut que baisser » plutôt que « la première note est
 * définitive » : la porte ne doit jamais pouvoir s'OUVRIR après coup, mais un
 * client qui redescend sa note nous dit quelque chose qu'on veut entendre —
 * et il ne peut pas s'en servir pour atteindre Google. La seule direction
 * interdite est celle qui mène au formulaire d'avis public.
 *
 * @returns {Promise<{ok:boolean, publier:boolean, retenue:number,
 *                    ignoree:boolean, modifiee:boolean, lienAvis:string, doc:Object}>}
 *   publier=true → on redirige vers Google, et c'est la note RETENUE qui en
 *   décide, jamais celle qui vient d'être soumise.
 *   ignoree=true → on a reçu une note plus haute et on l'a laissée de côté.
 *   modifiee=true → la note enregistrée a changé (première note comprise).
 */
async function enregistrerNote(doc, note) {
  const n = Math.round(Number(note));
  if (!Number.isFinite(n) || n < 1 || n > 5) return { ok: false, error: 'note invalide' };

  const reglages = await avis.enquete();
  const lienAvis = await avis.getLien();

  const ancienne = Number.isFinite(doc.rating) ? doc.rating : null;
  const ignoree = ancienne != null && n > ancienne;
  const retenue = ignoree ? ancienne : n;
  const modifiee = !ignoree && retenue !== ancienne;
  const publier = retenue >= reglages.seuil;

  if (modifiee) {
    doc.rating = retenue;
    doc.ratedAt = new Date();
    /* Une note déjà traitée ne retombe pas en « à traiter » parce que le
       client a rouvert le lien : on ne réécrit le statut que depuis l'attente,
       ou depuis un état qui n'a pas encore été pris en main. */
    if (doc.statut === 'en_attente' || doc.statut === 'publie') {
      doc.statut = publier ? 'publie' : 'a_traiter';
    }
    doc.updatedAt = new Date();
  }
  /* Posé même sans changement de note : c'est un fait (on l'a envoyé chez
     Google), et il vaut pour chaque passage, pas seulement le premier. */
  if (publier) {
    doc.redirigeGoogleAt = new Date();
    doc.updatedAt = new Date();
  }
  if (doc.isModified()) await doc.save();

  return { ok: true, publier, retenue, ignoree, modifiee, lienAvis, reglages, doc };
}

/* Alphabet sans caractère ambigu : le code est recopié à la main depuis un
   SMS ou un e-mail, et un O pris pour un 0 fait un client qui appelle. */
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function codeAleatoire() {
  const buf = crypto.randomBytes(6);
  let out = '';
  for (let i = 0; i < 6; i += 1) out += ALPHABET[buf[i] % ALPHABET.length];
  return `AVIS-${out}`;
}

/**
 * Émet le bon d'achat qui récompense la RÉPONSE à l'enquête.
 *
 * ⚠ AUCUNE CONDITION SUR LA NOTE, ET IL NE FAUT JAMAIS EN AJOUTER.
 * Récompenser un AVIS est interdit par Google et constitue une pratique
 * commerciale trompeuse en droit français ; récompenser la réponse à une
 * enquête de satisfaction est une dépense marketing ordinaire. Toute la
 * différence tient à ces trois propriétés, qui vivent ici :
 *   - appelé pour toute note de 1 à 5 ;
 *   - jamais conditionné à `redirigeGoogleAt` ni à quoi que ce soit de public ;
 *   - aucune preuve d'avis demandée.
 * Un `if (doc.rating >= …)` dans cette fonction ferait basculer le dispositif
 * du côté interdit.
 *
 * Un seul bon par commande : l'appel est idempotent.
 * @returns {Promise<Object|null>} le bon, ou null si désactivé.
 */
async function emettreBon(doc) {
  if (!doc) return null;
  if (doc.bon && doc.bon.code) return doc.bon; // déjà émis

  const reglages = await avis.bon();
  if (!reglages.actif || !(reglages.montantCents > 0)) return null;

  const expireLe = new Date(Date.now() + reglages.validiteJours * 86400000);

  /* Quelques essais : l'unicité est garantie par l'index de PromoCode, pas
     par l'espoir que 32^6 suffise. */
  let code = '';
  for (let essai = 0; essai < 5 && !code; essai += 1) {
    const candidat = codeAleatoire();
    try {
      await PromoCode.create({
        code: candidat,
        label: `Réponse à l'enquête de satisfaction — commande ${doc.orderNumber || ''}`.trim(),
        isActive: true,
        discountType: 'fixed',
        discountAmountCents: reglages.montantCents,
        minSubtotalCents: reglages.minimumCents,
        endsAt: expireLe,
        maxTotalUses: 1,
      });
      code = candidat;
    } catch (err) {
      if (!err || err.code !== 11000) throw err; // collision → on retente
    }
  }
  if (!code) {
    console.error('[avis] bon non émis : 5 collisions de code d\'affilée');
    return null;
  }

  doc.bon = { code, montantCents: reglages.montantCents, emisLe: new Date(), expireLe };
  doc.updatedAt = new Date();
  await doc.save();
  return doc.bon;
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
  emettreBon,
  urlEnquete,
  pourCommande,
  parToken,
  enregistrerNote,
  enregistrerMessage,
  traiter,
  lister,
  statistiques,
};
