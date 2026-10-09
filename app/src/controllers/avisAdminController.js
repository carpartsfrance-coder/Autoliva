'use strict';

/**
 * Demande d'avis GOOGLE (admin) — réglages + envoi par commande.
 *
 *   GET  /admin/parametres/avis                   page de réglages
 *   POST /admin/parametres/avis                   enregistrement
 *   GET  /admin/commandes/:orderId/avis           contenu prérempli (composeur)
 *   POST /admin/commandes/:orderId/avis/email     envoi e-mail
 *   POST /admin/commandes/:orderId/avis/sms       envoi SMS
 *   POST /admin/commandes/:orderId/avis/whatsapp  lien wa.me (envoi manuel)
 *
 * Remplace Skeepers / Avis Vérifiés. Trois différences qui comptent :
 *  - l'envoi est le NÔTRE, donc constatable (plus de « acceptée par le
 *    prestataire, envoi à une date qu'on déduit ») ;
 *  - le texte est modifiable avant chaque envoi, en plus des modèles ;
 *  - tout est journalisé sur la commande (emailsSent / smsSent / notifications).
 */

const mongoose = require('mongoose');
const Order = require('../models/Order');
const User = require('../models/User');
const avis = require('../services/avisGoogle');
const reviewFeedback = require('../services/reviewFeedback');
/* Importés comme MODULES et non déconstruits : les tests d'intégration
   remplacent `emailService.sendEmail` / `smsService.sendSms` pour compter ce
   qui PARTIRAIT sans rien envoyer, ce qu'une déconstruction au chargement
   rendrait impossible. */
const emailService = require('../services/emailService');
const smsService = require('../services/smsService');
const { resolvePhoneFromOrder } = smsService;
const { buildAvisGoogleEmail } = require('../services/emailTemplates');
const { getSiteUrlFromEnv } = require('../services/siteUrl');
const brand = require('../config/brand');

/* Longueurs retenues : un SMS au-delà de 480 caractères coûte 4 segments et
   se fait tronquer par certains opérateurs ; WhatsApp n'a pas cette limite
   mais un message de plus de 1000 caractères n'est plus lu. */
const MAX_SMS = 480;
const MAX_WHATSAPP = 1000;
const MAX_EMAIL = 5000;

/* Statuts sur lesquels une demande d'avis a un sens : le client a payé et sa
   commande n'est pas annulée. Demander un avis sur un panier impayé ou une
   commande annulée, c'est au mieux inutile, au pire une invitation à un avis
   négatif. */
const STATUTS_ELIGIBLES = new Set(['paid', 'processing', 'label_created', 'shipped', 'delivered', 'completed']);

function adminName(req) {
  const a = (req && req.session && req.session.admin) || {};
  return a.displayName || a.name || a.email || 'Admin';
}

function texte(v) { return typeof v === 'string' ? v : ''; }

/** Charge la commande + le client, et dit pourquoi une demande est impossible. */
async function chargerCommande(id) {
  if (!mongoose.Types.ObjectId.isValid(id)) return { error: 'Commande invalide.' };
  if (mongoose.connection.readyState !== 1) return { error: 'Base de données indisponible.' };
  const order = await Order.findById(id).lean();
  if (!order) return { error: 'Commande introuvable.' };
  if (order.deletedAt) return { error: 'Commande dans la corbeille.' };
  if (!STATUTS_ELIGIBLES.has(order.status)) {
    return { error: `Statut « ${order.status} » : pas de demande d'avis sur une commande non payée ou annulée.` };
  }
  const user = order.userId
    ? await User.findById(order.userId).select('email firstName lastName smsOptIn').lean()
    : null;
  return { order, user };
}

/** Pose la trace de l'envoi sur la commande (date + canal, sans doublon). */
async function marquerDemande(orderId, canal) {
  try {
    await Order.updateOne(
      { _id: orderId },
      {
        $set: { 'notifications.googleReviewRequestedAt': new Date() },
        $addToSet: { 'notifications.googleReviewChannels': canal },
      }
    );
  } catch (err) {
    /* La trace ne doit jamais faire échouer un envoi déjà parti : le message
       est chez le client, le signaler comme un échec serait un mensonge. */
    console.error('[avis] trace non posée sur la commande :', err && err.message);
  }
}

// ─── Page de réglages ───────────────────────────────────────────────────────

async function getAvisSettingsPage(req, res, next) {
  try {
    const reglages = await avis.reglagesPourAdmin();
    return res.render('admin/avis-settings', {
      title: "Demande d'avis Google · Paramètres",
      activeKey: 'settings',
      reglages,
      successMessage: req.query.saved ? "Demande d'avis enregistrée ✓" : null,
      errorMessage: req.query.erreur ? String(req.query.erreur).slice(0, 300) : null,
    });
  } catch (err) {
    return next(err);
  }
}

async function postAvisSettings(req, res, next) {
  try {
    const b = req.body || {};
    const payload = { lienAvis: texte(b.lienAvis) };
    avis.CANAUX.forEach((canal) => {
      payload[canal] = {
        // checkbox cochée => la clé est présente
        enabled: b['enabled_' + canal] != null,
        sujet: texte(b['sujet_' + canal]),
        corps: texte(b['corps_' + canal]),
      };
    });
    payload.enquete = {
      active: b.enquete_active != null,
      seuil: b.enquete_seuil,
      proposerGoogleAuxMecontents: b.enquete_proposerGoogle != null,
      question: texte(b.enquete_question),
      messageContent: texte(b.enquete_messageContent),
      messageMecontent: texte(b.enquete_messageMecontent),
      remerciement: texte(b.enquete_remerciement),
    };
    const r = await avis.enregistrer(payload, adminName(req));
    if (!r.ok) return res.redirect('/admin/parametres/avis?erreur=' + encodeURIComponent(r.error));
    return res.redirect('/admin/parametres/avis?saved=1');
  } catch (err) {
    return next(err);
  }
}

/**
 * Résout les trois messages d'une commande, enquête comprise.
 *
 * Le jeton est créé ICI, au moment où on prépare un message — pas à la
 * livraison ni par un cron : on ne veut pas semer des liens d'enquête pour
 * des commandes qu'on ne sollicitera jamais. Et comme il est stable, le lien
 * reste le même que la demande parte par e-mail, SMS ou WhatsApp.
 *
 * Enquête coupée → `lienEnquete` vaut undefined et les modèles retombent sur
 * le lien Google (cf. avisGoogle.variablesCommande).
 */
async function resoudreCanaux(order, user) {
  const reglages = await avis.enquete();
  let lienEnquete;
  if (reglages.active) {
    const suivi = await reviewFeedback.pourCommande(order, user);
    if (suivi) lienEnquete = reviewFeedback.urlEnquete(suivi.token);
  }
  const [email, sms, whatsapp] = await Promise.all([
    avis.resoudre('email', { order, user, lienEnquete }),
    avis.resoudre('sms', { order, user, lienEnquete }),
    avis.resoudre('whatsapp', { order, user, lienEnquete }),
  ]);
  return { email, sms, whatsapp, lienEnquete, enquete: reglages };
}

// ─── Composeur sur une commande ─────────────────────────────────────────────

/**
 * GET /admin/commandes/:orderId/avis
 * Renvoie les trois messages préremplis pour CETTE commande, les
 * destinataires, et ce qui est déjà parti. Le front n'invente rien.
 */
async function getAvisCommande(req, res) {
  try {
    const { order, user, error } = await chargerCommande(req.params.orderId);
    if (error) return res.status(400).json({ ok: false, error });

    const { email, sms, whatsapp, lienEnquete, enquete } = await resoudreCanaux(order, user);
    const telephone = resolvePhoneFromOrder(order);
    const notif = order.notifications || {};

    return res.json({
      ok: true,
      numero: order.number || '',
      lienAvis: email.lienAvis,
      /* Ce sur quoi le client va VRAIMENT tomber. L'afficher évite de croire
         qu'on l'envoie direct sur Google alors que l'enquête est en place. */
      lienEnquete: lienEnquete || email.lienAvis,
      enquete: {
        active: enquete.active,
        seuil: enquete.seuil,
        proposerGoogleAuxMecontents: enquete.proposerGoogleAuxMecontents,
      },
      deja: {
        at: notif.googleReviewRequestedAt || null,
        canaux: Array.isArray(notif.googleReviewChannels) ? notif.googleReviewChannels : [],
      },
      canaux: {
        email: {
          enabled: email.enabled,
          sujet: email.sujet,
          corps: email.corps,
          destinataire: (user && user.email) || '',
        },
        sms: {
          enabled: sms.enabled,
          corps: sms.corps,
          destinataire: telephone,
          /* On AFFICHE l'opt-in sans bloquer : c'est une relance ponctuelle
             sur une commande livrée, décidée au cas par cas, pas une campagne.
             Bloquer silencieusement aurait rendu le bouton inerte pour la
             majorité des clients sans dire pourquoi. */
          optIn: !!(user && user.smsOptIn),
        },
        whatsapp: {
          enabled: whatsapp.enabled,
          corps: whatsapp.corps,
          destinataire: telephone,
        },
      },
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String((err && err.message) || err).slice(0, 300) });
  }
}

/** POST …/avis/email — body { sujet, corps } (texte déjà relu par l'admin). */
async function postAvisEmail(req, res) {
  try {
    const { order, user, error } = await chargerCommande(req.params.orderId);
    if (error) return res.status(400).json({ ok: false, error });
    const destinataire = texte(user && user.email).trim();
    if (!destinataire) return res.status(400).json({ ok: false, error: 'Pas d’adresse e-mail sur ce client.' });

    const resolu = (await resoudreCanaux(order, user)).email;
    if (!resolu.enabled) return res.status(400).json({ ok: false, error: 'Canal e-mail désactivé dans les paramètres.' });

    const sujet = (texte(req.body && req.body.sujet).trim() || resolu.sujet).slice(0, 200);
    const corps = (texte(req.body && req.body.corps).trim() || resolu.corps).slice(0, MAX_EMAIL);

    const mail = buildAvisGoogleEmail({
      order, user, baseUrl: getSiteUrlFromEnv() || brand.SITE_URL,
      sujet, corps, lienAvis: resolu.lienAvis,
    });
    const r = await emailService.sendEmail({
      toEmail: destinataire,
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
      replyTo: brand.EMAIL_CONTACT ? { email: brand.EMAIL_CONTACT, name: brand.NAME } : null,
    });
    await emailService.logEmailSent({ orderId: order._id, emailType: 'avis_google', recipientEmail: destinataire, result: r });
    if (!r || !r.ok) {
      return res.status(502).json({ ok: false, error: `Échec de l'envoi : ${(r && r.reason) || 'inconnu'}` });
    }
    await marquerDemande(order._id, 'email');
    return res.json({ ok: true, message: `Demande d'avis envoyée à ${destinataire}.` });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String((err && err.message) || err).slice(0, 300) });
  }
}

/** POST …/avis/sms — body { corps }. */
async function postAvisSms(req, res) {
  try {
    const { order, user, error } = await chargerCommande(req.params.orderId);
    if (error) return res.status(400).json({ ok: false, error });
    const telephone = resolvePhoneFromOrder(order);
    if (!telephone) return res.status(400).json({ ok: false, error: 'Pas de numéro français exploitable sur cette commande.' });

    const resolu = (await resoudreCanaux(order, user)).sms;
    if (!resolu.enabled) return res.status(400).json({ ok: false, error: 'Canal SMS désactivé dans les paramètres.' });

    const corps = (texte(req.body && req.body.corps).trim() || resolu.corps).slice(0, MAX_SMS);
    if (!corps) return res.status(400).json({ ok: false, error: 'Message vide.' });

    const r = await smsService.sendSms({ to: telephone, text: corps });
    smsService.logSmsSent({ orderId: order._id, smsType: 'avis_google', recipientPhone: telephone, result: r }).catch(() => {});
    if (!r || !r.ok) {
      return res.status(502).json({ ok: false, error: (r && r.message) || `Échec de l'envoi : ${(r && r.reason) || 'inconnu'}` });
    }
    await marquerDemande(order._id, 'sms');
    /* ⚠ L'expéditeur SMS est alphanumérique (« CarParts ») et les opérateurs
       français jettent SILENCIEUSEMENT une partie des SMS contenant une URL :
       Brevo répond « envoyé » dans tous les cas. On le dit à l'admin plutôt
       que de laisser croire à une remise garantie. */
    return res.json({
      ok: true,
      message: `SMS envoyé au ${telephone}.`,
      avertissement: /https?:\/\//i.test(corps)
        ? "Le SMS contient un lien : avec un expéditeur alphanumérique, certains opérateurs le filtrent sans le signaler. L'e-mail et WhatsApp restent les canaux sûrs pour le lien."
        : null,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String((err && err.message) || err).slice(0, 300) });
  }
}

/**
 * POST …/avis/whatsapp — body { corps } → URL wa.me à ouvrir.
 * Le message part du téléphone du commercial : on enregistre une INTENTION
 * d'envoi, jamais une remise (même convention que le composeur des leads).
 */
async function postAvisWhatsapp(req, res) {
  try {
    const { order, user, error } = await chargerCommande(req.params.orderId);
    if (error) return res.status(400).json({ ok: false, error });
    const telephone = resolvePhoneFromOrder(order);
    if (!telephone) return res.status(400).json({ ok: false, error: 'Pas de numéro français exploitable sur cette commande.' });

    const resolu = (await resoudreCanaux(order, user)).whatsapp;
    if (!resolu.enabled) return res.status(400).json({ ok: false, error: 'Canal WhatsApp désactivé dans les paramètres.' });

    const corps = (texte(req.body && req.body.corps).trim() || resolu.corps).slice(0, MAX_WHATSAPP);
    if (!corps) return res.status(400).json({ ok: false, error: 'Message vide.' });

    const waUrl = 'https://wa.me/' + telephone.replace(/\D/g, '') + '?text=' + encodeURIComponent(corps);
    await marquerDemande(order._id, 'whatsapp');
    return res.json({ ok: true, waUrl, destinataire: telephone });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String((err && err.message) || err).slice(0, 300) });
  }
}

// ─── Retours de l'enquête (liste back-office) ───────────────────────────────

const FILTRES = new Set(['repondus', 'a_traiter', 'resolu', 'publie', 'en_attente', 'tous']);

async function getAvisRetoursPage(req, res, next) {
  try {
    const filtre = FILTRES.has(String(req.query.filtre || '')) ? String(req.query.filtre) : 'repondus';
    const [retours, stats, reglages] = await Promise.all([
      mongoose.connection.readyState === 1 ? reviewFeedback.lister({ filtre }) : [],
      reviewFeedback.statistiques(),
      avis.enquete(),
    ]);
    return res.render('admin/avis-retours', {
      title: "Retours clients · Avis",
      activeKey: 'avis-retours',
      retours,
      stats,
      reglages,
      filtre,
      dbConnected: mongoose.connection.readyState === 1,
      successMessage: req.query.traite ? 'Retour mis à jour ✓' : null,
    });
  } catch (err) {
    return next(err);
  }
}

/** POST /admin/avis/:id/traiter — body { resolu, note }. */
async function postTraiterRetour(req, res, next) {
  try {
    const b = req.body || {};
    const r = await reviewFeedback.traiter(req.params.id, {
      resolu: b.resolu === 'on' || b.resolu === 'true' || b.resolu === true,
      note: texte(b.note),
      par: adminName(req),
    });
    if (!r.ok) return res.status(400).redirect('/admin/avis?filtre=a_traiter');
    return res.redirect('/admin/avis?traite=1&filtre=' + encodeURIComponent(texte(b.filtre) || 'a_traiter'));
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getAvisRetoursPage,
  postTraiterRetour,
  getAvisSettingsPage,
  postAvisSettings,
  getAvisCommande,
  postAvisEmail,
  postAvisSms,
  postAvisWhatsapp,
};
