'use strict';

/**
 * Page publique de désinscription des relances commerciales.
 *
 * - GET /desinscription?e=<email>&tk=<token> → désinscrit en un clic
 *   (lien mis dans le pied des emails de relance).
 * - GET /desinscription → formulaire de saisie (lien sans token, demande
 *   par téléphone, ou email de relance déjà parti avec l'ancien lien mort).
 * - POST /desinscription → désinscrit l'adresse saisie.
 * - POST /desinscription/reinscription → annule la désinscription.
 */

const mongoose = require('mongoose');

const marketingOptOut = require('../services/marketingOptOut');
const { getSiteUrlFromReq } = require('../services/siteUrl');
const brand = require('../config/brand');

function render(res, state, extra = {}) {
  return res.render('unsubscribe', {
    title: `Désinscription des emails commerciaux — ${brand.NAME}`,
    metaRobots: 'noindex, nofollow',
    state,
    email: '',
    token: '',
    errorMessage: '',
    ...extra,
  });
}

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

async function getUnsubscribe(req, res, next) {
  try {
    const rawEmail = getTrimmedString(req.query && req.query.e);
    const token = getTrimmedString(req.query && req.query.tk);
    const email = marketingOptOut.normalizeEmail(rawEmail);

    // Pas de lien signé → on affiche le formulaire
    if (!email || !token) {
      return render(res, 'form', { email: email || '' });
    }

    if (!marketingOptOut.verifyUnsubscribeToken(token, email)) {
      return render(res, 'form', {
        email,
        errorMessage: 'Ce lien de désinscription n’est plus valide. Confirmez votre adresse ci-dessous.',
      });
    }

    if (mongoose.connection.readyState !== 1) {
      return render(res, 'form', {
        email,
        errorMessage: 'Service temporairement indisponible. Merci de réessayer dans quelques minutes.',
      });
    }

    const result = await marketingOptOut.optOut({ email, source: 'email_link' });
    if (!result.ok) {
      return render(res, 'form', {
        email,
        errorMessage: 'La désinscription n’a pas pu être enregistrée. Merci de réessayer.',
      });
    }

    return render(res, 'done', { email, token });
  } catch (err) {
    return next(err);
  }
}

async function postUnsubscribe(req, res, next) {
  try {
    const email = marketingOptOut.normalizeEmail(req.body && req.body.email);

    if (!email) {
      return render(res, 'form', {
        email: getTrimmedString(req.body && req.body.email),
        errorMessage: 'Merci de renseigner une adresse email valide.',
      });
    }

    if (mongoose.connection.readyState !== 1) {
      return render(res, 'form', {
        email,
        errorMessage: 'Service temporairement indisponible. Merci de réessayer dans quelques minutes.',
      });
    }

    const result = await marketingOptOut.optOut({ email, source: 'form' });
    if (!result.ok) {
      return render(res, 'form', {
        email,
        errorMessage: 'La désinscription n’a pas pu être enregistrée. Merci de réessayer.',
      });
    }

    return render(res, 'done', {
      email,
      token: marketingOptOut.buildUnsubscribeToken(email),
    });
  } catch (err) {
    return next(err);
  }
}

async function postResubscribe(req, res, next) {
  try {
    const email = marketingOptOut.normalizeEmail(req.body && req.body.email);
    const token = getTrimmedString(req.body && req.body.token);

    if (!email || !marketingOptOut.verifyUnsubscribeToken(token, email)) {
      return render(res, 'form', {
        email,
        errorMessage: 'Lien invalide. Vous restez désinscrit des emails commerciaux.',
      });
    }

    const result = await marketingOptOut.optIn({ email });
    if (!result.ok) {
      return render(res, 'done', {
        email,
        token,
        errorMessage: 'La réinscription n’a pas pu être enregistrée. Merci de réessayer.',
      });
    }

    return render(res, 'resubscribed', { email });
  } catch (err) {
    return next(err);
  }
}

/** Ancien lien présent dans les emails déjà partis : /newsletter/desinscription */
function getLegacyNewsletterUnsubscribe(req, res, next) {
  const base = getSiteUrlFromReq(req) || '';
  const email = marketingOptOut.normalizeEmail(req.query && req.query.e);
  const target = email
    ? `/desinscription?e=${encodeURIComponent(email)}`
    : '/desinscription';
  return res.redirect(302, base ? `${base.replace(/\/$/, '')}${target}` : target);
}

module.exports = {
  getUnsubscribe,
  postUnsubscribe,
  postResubscribe,
  getLegacyNewsletterUnsubscribe,
};
