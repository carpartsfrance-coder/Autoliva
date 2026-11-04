const mongoose = require('mongoose');

const NewsletterSubscriber = require('../models/NewsletterSubscriber');
const { track: trackEvent, rememberEmail } = require('../services/eventTracker');
const { captureNewsletterLead } = require('../services/leadCapture');
const { suppress, verifyToken } = require('../services/emailSuppression');

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeEmail(value) {
  const email = getTrimmedString(value).toLowerCase();
  if (!email) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
  return email;
}

function getSafeReturnTo(value) {
  const input = getTrimmedString(value);
  if (!input) return '/';
  if (!input.startsWith('/')) return '/';
  if (input.startsWith('//')) return '/';
  return input;
}

async function postSubscribe(req, res, next) {
  try {
    const returnTo = getSafeReturnTo(req.body && req.body.returnTo);
    const email = normalizeEmail(req.body && req.body.email);
    const dbConnected = mongoose.connection.readyState === 1;

    if (!req.session || typeof req.session !== 'object') {
      return res.redirect(returnTo);
    }

    if (!email) {
      req.session.newsletterError = 'Merci de renseigner une adresse email valide.';
      return res.redirect(returnTo);
    }

    if (!dbConnected) {
      req.session.newsletterError = "L'inscription à la newsletter est temporairement indisponible.";
      return res.redirect(returnTo);
    }

    const existing = await NewsletterSubscriber.findOne({ email }).select('_id status').lean();

    if (existing) {
      if (existing.status === 'active') {
        req.session.newsletterSuccess = 'Cette adresse est déjà inscrite à la newsletter.';
        return res.redirect(returnTo);
      }

      await NewsletterSubscriber.updateOne(
        { _id: existing._id },
        {
          $set: {
            status: 'active',
            source: getTrimmedString(req.body && req.body.source) || 'footer',
            subscribedAt: new Date(),
            unsubscribedAt: null,
          },
        }
      );

      req.session.newsletterSuccess = 'Votre inscription à la newsletter a bien été réactivée.';
      return res.redirect(returnTo);
    }

    await NewsletterSubscriber.create({
      email,
      status: 'active',
      source: getTrimmedString(req.body && req.body.source) || 'footer',
      subscribedAt: new Date(),
      unsubscribedAt: null,
    });

    /* Visitor timeline : inscription newsletter + email hash */
    rememberEmail(req, email);
    trackEvent(req, 'newsletter_signup', {
      meta: { sourceForm: getTrimmedString(req.body && req.body.source) || 'footer' },
    });

    /* Lead capture (non-bloquant) : si la session a un panier, en faire un lead */
    captureNewsletterLead({
      req,
      email,
      source: getTrimmedString(req.body && req.body.source) || 'footer',
    }).catch(() => { /* non-bloquant */ });

    req.session.newsletterSuccess = 'Merci ! Votre email est bien inscrit à la newsletter.';
    return res.redirect(returnTo);
  } catch (err) {
    return next(err);
  }
}

/**
 * GET /newsletter/desinscription
 *  - avec ?e=<email>&t=<token> : désinscription en un clic (lien signé)
 *  - sans paramètres : formulaire de saisie de l'adresse
 */
async function getUnsubscribe(req, res, next) {
  try {
    const rawEmail = getTrimmedString(req.query && req.query.e);
    const token = getTrimmedString(req.query && req.query.t);
    const email = normalizeEmail(rawEmail);

    if (!email || !token) {
      return res.status(200).render('newsletter/desinscription', {
        title: 'Se désinscrire', state: 'form', email: email || rawEmail || '', message: '',
      });
    }
    if (!verifyToken(email, token)) {
      return res.status(200).render('newsletter/desinscription', {
        title: 'Se désinscrire', state: 'form', email,
        message: "Ce lien n'est plus valide. Confirmez votre adresse ci-dessous.",
      });
    }
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).render('newsletter/desinscription', {
        title: 'Se désinscrire', state: 'error', email,
        message: 'Service temporairement indisponible. Merci de réessayer dans quelques minutes.',
      });
    }
    const result = await suppress({ email, scope: 'marketing', reason: 'Lien de désinscription', source: 'email_link' });
    return res.status(200).render('newsletter/desinscription', {
      title: result.ok ? 'Désinscription confirmée' : 'Se désinscrire',
      state: result.ok ? 'done' : 'error', email,
      message: result.ok ? '' : "La désinscription n'a pas pu être enregistrée. Merci de réessayer.",
    });
  } catch (err) { return next(err); }
}

/** POST /newsletter/desinscription — formulaire manuel. */
async function postUnsubscribe(req, res, next) {
  try {
    const email = normalizeEmail(req.body && req.body.email);
    if (!email) {
      return res.status(200).render('newsletter/desinscription', {
        title: 'Se désinscrire', state: 'form',
        email: getTrimmedString(req.body && req.body.email),
        message: 'Merci de renseigner une adresse email valide.',
      });
    }
    if (mongoose.connection.readyState !== 1) {
      return res.status(503).render('newsletter/desinscription', {
        title: 'Se désinscrire', state: 'error', email,
        message: 'Service temporairement indisponible. Merci de réessayer dans quelques minutes.',
      });
    }
    const result = await suppress({ email, scope: 'marketing', reason: 'Formulaire de désinscription', source: 'web_form' });
    return res.status(200).render('newsletter/desinscription', {
      title: result.ok ? 'Désinscription confirmée' : 'Se désinscrire',
      state: result.ok ? 'done' : 'error', email,
      message: result.ok ? '' : "La désinscription n'a pas pu être enregistrée. Merci de réessayer.",
    });
  } catch (err) { return next(err); }
}

module.exports = {
  postSubscribe,
  getUnsubscribe,
  postUnsubscribe,
};
