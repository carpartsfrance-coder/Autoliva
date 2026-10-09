'use strict';

/**
 * Page publique de l'enquête de satisfaction — `/mon-avis/<token>`.
 *
 *   GET  /mon-avis/:token            la question « quelle note ? »
 *   POST /mon-avis/:token            la note → redirection Google, ou formulaire interne
 *   POST /mon-avis/:token/message    le détail du problème → remerciement
 *
 * Tout fonctionne SANS JavaScript : ces liens s'ouvrent dans le navigateur
 * intégré d'une application de messagerie, où un formulaire classique est le
 * seul mécanisme sur lequel on puisse compter. Le JS de la page ne fait
 * qu'envoyer le formulaire au clic sur une étoile.
 *
 * ⚠ La page est en `noindex` : un lien par commande, indexé, finirait dans les
 * résultats de recherche avec le numéro de commande d'un client.
 */

const mongoose = require('mongoose');
const reviewFeedback = require('../services/reviewFeedback');
const avis = require('../services/avisGoogle');
const emailService = require('../services/emailService');
const { buildAvisNegatifAlerteEmail, buildBonAvisEmail } = require('../services/emailTemplates');
const { getSiteUrlFromReq } = require('../services/siteUrl');
const brand = require('../config/brand');

function texte(v) { return typeof v === 'string' ? v : ''; }

/** Destinataire des alertes internes. */
function alerteToEmail() {
  return texte(process.env.AVIS_ALERTE_TO_EMAIL).trim() || brand.EMAIL_CONTACT;
}

/** Locals communs à toutes les étapes de la page. */
function base(req, { reglages, doc, etape }) {
  const vars = avis.variablesCommande({ order: { number: doc.orderNumber }, user: { firstName: doc.clientNom } });
  return {
    title: `Votre avis — ${brand.NAME}`,
    metaRobots: 'noindex, nofollow',
    canonicalUrl: null,
    etape,
    token: doc.token,
    orderNumber: doc.orderNumber,
    prenom: texte(doc.clientNom).split(/\s+/)[0] || '',
    question: avis.appliquerVariables(reglages.question, vars),
    messageContent: avis.appliquerVariables(reglages.messageContent, vars),
    messageMecontent: avis.appliquerVariables(reglages.messageMecontent, vars),
    remerciement: avis.appliquerVariables(reglages.remerciement, vars),
    seuil: reglages.seuil,
    note: doc.rating || null,
    /* Le bon vit sur le suivi : il réapparaît si le client rouvre son lien,
       ce qui évite « j'ai perdu mon code » au standard. */
    bon: (doc.bon && doc.bon.code) ? {
      code: doc.bon.code,
      montant: (doc.bon.montantCents / 100).toFixed(2).replace(/[.,]00$/, '').replace('.', ','),
      expireLe: doc.bon.expireLe,
    } : null,
    /* Pré-rempli avec le numéro de la commande : on l'a déjà, le redemander
       sur un téléphone est le genre de friction qui fait abandonner le
       formulaire — et c'est justement celui des clients mécontents. */
    telephoneConnu: texte(doc.rappelTelephone) || texte(doc.clientTelephone),
    lienAvis: '',
    erreur: null,
    avertissement: null,
  };
}

/** Charge le suivi, ou rend une page d'erreur lisible (jamais une 500 brute). */
async function charger(req, res) {
  if (mongoose.connection.readyState !== 1) {
    res.status(503).render('avis/indisponible', {
      title: `Votre avis — ${brand.NAME}`,
      metaRobots: 'noindex, nofollow',
      canonicalUrl: null,
    });
    return null;
  }
  const doc = await reviewFeedback.parToken(req.params.token);
  if (!doc) {
    /* 404 et un message franc : un lien périmé ou mal recopié est le cas
       normal ici, pas une anomalie. On ne dit pas « erreur », on propose le
       contact. */
    res.status(404).render('avis/introuvable', {
      title: `Lien introuvable — ${brand.NAME}`,
      metaRobots: 'noindex, nofollow',
      canonicalUrl: null,
    });
    return null;
  }
  return doc;
}

async function getEnquete(req, res, next) {
  try {
    const doc = await charger(req, res);
    if (!doc) return undefined;
    const reglages = await avis.enquete();

    /* Enquête coupée en cours de route alors que des liens sont déjà partis :
       on envoie directement sur Google plutôt que d'afficher une page morte. */
    if (!reglages.active) return res.redirect(302, await avis.getLien());

    /* Déjà noté : on ne redemande pas. Au-dessus du seuil on repropose le
       lien (le client a pu fermer l'onglet avant de publier), en dessous on
       montre le formulaire, pour qu'il puisse compléter son retour. */
    if (doc.rating) {
      const locals = base(req, { reglages, doc, etape: doc.rating >= reglages.seuil ? 'content' : 'probleme' });
      if (doc.rating >= reglages.seuil) locals.lienAvis = await avis.getLien();
      else if (doc.message) locals.etape = 'merci';
      return res.render('avis/enquete', locals);
    }

    return res.render('avis/enquete', base(req, { reglages, doc, etape: 'note' }));
  } catch (err) {
    return next(err);
  }
}

async function postNote(req, res, next) {
  try {
    const doc = await charger(req, res);
    if (!doc) return undefined;
    const reglages = await avis.enquete();
    if (!reglages.active) return res.redirect(302, await avis.getLien());

    const r = await reviewFeedback.enregistrerNote(doc, req.body && req.body.note);
    if (!r.ok) {
      const locals = base(req, { reglages, doc, etape: 'note' });
      locals.erreur = 'Choisissez une note de 1 à 5.';
      return res.status(400).render('avis/enquete', locals);
    }

    /* Le bon récompense la RÉPONSE : émis AVANT toute distinction sur la note,
       et sur ce chemin unique par lequel passent les 1/5 comme les 5/5.
       Ne jamais le déplacer dans l'une des deux branches ci-dessous. */
    const bon = await reviewFeedback.emettreBon(r.doc).catch((err) => {
      console.error('[avis] bon non émis :', err && err.message);
      return null;
    });
    if (bon) envoyerBonParEmail(req, r.doc).catch(() => {});

    /* Note haute SANS bon : droit sur Google, chaque écran de plus entre le
       clic et le formulaire est un client perdu. AVEC un bon, on doit d'abord
       le remettre — et cet écran-là n'est pas une friction, c'est ce que le
       client est venu chercher ; le bouton Google y est mieux placé qu'au
       bout d'une redirection.
       `r.publier` suit la note RETENUE, jamais celle qui vient d'arriver :
       rejouer la requête avec 5/5 après un 3/5 ne mène nulle part. */
    if (r.publier) {
      if (!bon) return res.redirect(302, r.lienAvis);
      const locals = base(req, { reglages, doc: r.doc, etape: 'content' });
      locals.lienAvis = r.lienAvis;
      return res.render('avis/enquete', locals);
    }

    /* Alerte immédiate, AVANT même que le client ait écrit quoi que ce soit :
       une note de 1 sans message reste une information qu'on veut avoir le
       jour même, et beaucoup s'arrêtent là. Seulement si la note a bougé —
       sinon un client qui recharge la page déclenche un e-mail par clic. */
    if (r.modifiee) envoyerAlerte(req, r.doc).catch(() => {});

    const locals = base(req, { reglages, doc: r.doc, etape: 'probleme' });
    if (r.ignoree) {
      /* On le DIT, plutôt que d'afficher sans explication une page qui ne
         correspond pas au clic. Un client qui s'est trompé d'étoile comprend
         alors qu'il doit nous l'écrire — et ça nous arrive dans le même
         formulaire. */
      locals.avertissement = `Votre note de ${r.retenue}/5 est déjà enregistrée : elle ne peut plus être remontée. Dites-le nous ci-dessous si vous vous êtes trompé.`;
    }
    /* Le lien Google reste accessible si le réglage le demande : c'est la
       version conforme à la politique Google (voir services/reviewFeedback). */
    if (reglages.proposerGoogleAuxMecontents) locals.lienAvis = r.lienAvis;
    return res.render('avis/enquete', locals);
  } catch (err) {
    return next(err);
  }
}

async function postMessage(req, res, next) {
  try {
    const doc = await charger(req, res);
    if (!doc) return undefined;
    const reglages = await avis.enquete();

    const r = await reviewFeedback.enregistrerMessage(doc, {
      message: req.body && req.body.message,
      telephone: req.body && req.body.telephone,
    });
    if (!r.ok) {
      const locals = base(req, { reglages, doc, etape: 'probleme' });
      locals.erreur = 'Dites-nous en deux mots ce qui ne va pas — sans ça, on ne peut rien faire.';
      if (reglages.proposerGoogleAuxMecontents) locals.lienAvis = await avis.getLien();
      return res.status(400).render('avis/enquete', locals);
    }

    /* Seconde alerte : la première (à la note) ne portait pas le message. */
    envoyerAlerte(req, r.doc).catch(() => {});
    return res.render('avis/enquete', base(req, { reglages, doc: r.doc, etape: 'merci' }));
  } catch (err) {
    return next(err);
  }
}

/**
 * Envoie le bon au client, best-effort.
 *
 * Doublon volontaire de l'affichage à l'écran : le client ferme l'onglet, le
 * code est perdu. Par e-mail il le retrouve le jour où il recommande — c'est
 * là que le bon sert à quelque chose.
 */
async function envoyerBonParEmail(req, doc) {
  const destinataire = texte(doc.clientEmail).trim();
  if (!destinataire || !doc.bon || !doc.bon.code) return;
  try {
    const baseUrl = getSiteUrlFromReq(req);
    const mail = buildBonAvisEmail({ feedback: doc, baseUrl });
    await emailService.sendEmail({
      toEmail: destinataire, subject: mail.subject, html: mail.html, text: mail.text,
      replyTo: brand.EMAIL_CONTACT ? { email: brand.EMAIL_CONTACT, name: brand.NAME } : null,
    });
  } catch (err) {
    console.error('[avis] bon non envoyé par e-mail :', err && err.message);
  }
}

/** Alerte interne, best-effort : elle ne doit jamais casser la page client. */
async function envoyerAlerte(req, doc) {
  try {
    const baseUrl = getSiteUrlFromReq(req);
    const mail = buildAvisNegatifAlerteEmail({
      feedback: doc,
      baseUrl,
      adminUrl: `${String(baseUrl).replace(/\/$/, '')}/admin/avis`,
    });
    await emailService.sendEmail({
      toEmail: alerteToEmail(),
      subject: mail.subject,
      html: mail.html,
      text: mail.text,
    });
  } catch (err) {
    console.error('[avis] alerte interne non envoyée :', err && err.message);
  }
}

module.exports = { getEnquete, postNote, postMessage, alerteToEmail };
