const mongoose = require('mongoose');

const NewsletterSubscriber = require('../models/NewsletterSubscriber');

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

    req.session.newsletterSuccess = 'Merci ! Votre email est bien inscrit à la newsletter.';
    return res.redirect(returnTo);
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  postSubscribe,
};
