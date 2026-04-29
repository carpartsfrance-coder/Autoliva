const mongoose = require('mongoose');

const emailService = require('../services/emailService');
const { getPublicBaseUrlFromReq } = require('../services/productPublic');
const { buildHreflangSet } = require('../services/i18n');
const brand = require('../config/brand');

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : value ? String(value).trim() : '';
}

function normalizeEmail(value) {
  const input = getTrimmedString(value).toLowerCase();
  if (!input) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(input)) return '';
  return input;
}

function normalizePhone(value) {
  const input = getTrimmedString(value);
  if (!input) return '';
  const cleaned = input.replace(/[^+0-9]/g, '');
  return cleaned.slice(0, 24);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

const IP_BUCKETS = new Map();

function getClientIp(req) {
  const xfwd = req && req.headers ? req.headers['x-forwarded-for'] : null;
  const fromHeader = Array.isArray(xfwd) ? xfwd[0] : typeof xfwd === 'string' ? xfwd.split(',')[0] : '';
  const candidate = getTrimmedString(fromHeader) || (req && req.ip ? String(req.ip) : '');
  return candidate || 'unknown';
}

function isRateLimited(req) {
  const now = Date.now();
  const ip = getClientIp(req);
  const entry = IP_BUCKETS.get(ip);

  if (!entry || typeof entry.resetAt !== 'number' || now >= entry.resetAt) {
    IP_BUCKETS.set(ip, { count: 1, resetAt: now + 10 * 60 * 1000 });
    return false;
  }

  entry.count += 1;
  if (entry.count > 12) return true;
  return false;
}

function getContactToEmail() {
  const fromEnv = getTrimmedString(process.env.CONTACT_FORM_TO_EMAIL);
  if (fromEnv) return fromEnv;
  return brand.EMAIL_CONTACT;
}

function buildContactJsonLd({ baseUrl, mode } = {}) {
  const safeBase = getTrimmedString(baseUrl).replace(/\/$/, '');
  const path = mode === 'devis' ? '/devis' : '/contact';
  const url = safeBase ? `${safeBase}${path}` : path;
  const name = mode === 'devis' ? `Demande de devis - ${brand.NAME}` : `Contact - ${brand.NAME}`;

  return JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'ContactPage',
    url,
    name,
  });
}

function buildInitialForm({ req, mode } = {}) {
  const q = req && req.query && typeof req.query === 'object' ? req.query : {};

  const presetSubject = mode === 'devis'
    ? 'devis'
    : (getTrimmedString(q.subject) || 'question');

  return {
    subject: presetSubject,
    firstName: getTrimmedString(q.firstName),
    lastName: getTrimmedString(q.lastName),
    email: getTrimmedString(q.email),
    phone: getTrimmedString(q.phone),
    vin: getTrimmedString(q.vin),
    plate: getTrimmedString(q.plate),
    vehicle: getTrimmedString(q.vehicle),
    partRef: getTrimmedString(q.partRef),
    message: getTrimmedString(q.message),
    website: '',
  };
}

async function getContactPage(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const baseUrl = getPublicBaseUrlFromReq(req);
    const langPrefix = req.lang === 'en' ? '/en' : '';
    const pathWithoutLang = res.locals.currentPathWithoutLang || req.path;
    const hreflang = buildHreflangSet(baseUrl, pathWithoutLang);

    const rawMode = getTrimmedString(req.query && req.query.type);
    const mode = rawMode === 'devis' ? 'devis' : 'contact';

    if (req.session && typeof req.session === 'object') {
      req.session.contactFormTs = Date.now();
    }

    const title = mode === 'devis'
      ? `Demande de devis - ${brand.NAME}`
      : `Contact - ${brand.NAME}`;

    const metaDescription = mode === 'devis'
      ? 'Demande de devis : envoyez votre référence, votre VIN et vos besoins. Réponse rapide par email ou téléphone.'
      : `Contactez ${brand.NAME} : question, assistance, compatibilité. Réponse rapide par email ou téléphone.`;

    const canonicalPath = mode === 'devis' ? '/devis' : '/contact';
    const canonicalUrl = baseUrl ? `${baseUrl}${langPrefix}${canonicalPath}` : `${langPrefix}${canonicalPath}`;

    return res.render('contact/index', {
      title,
      metaDescription,
      canonicalUrl,
      ...hreflang,
      ogTitle: title,
      ogDescription: metaDescription,
      ogUrl: canonicalUrl,
      ogType: 'website',
      jsonLd: buildContactJsonLd({ baseUrl, mode }),
      dbConnected,
      mode,
      errorMessage: null,
      successMessage: null,
      form: buildInitialForm({ req, mode }),
    });
  } catch (err) {
    return next(err);
  }
}

async function postContact(req, res, next) {
  try {
    const dbConnected = mongoose.connection.readyState === 1;
    const baseUrl = getPublicBaseUrlFromReq(req);
    const langPrefix = req.lang === 'en' ? '/en' : '';
    const pathWithoutLang = res.locals.currentPathWithoutLang || req.path;
    const hreflang = buildHreflangSet(baseUrl, pathWithoutLang);

    const rawMode = getTrimmedString(req.body && req.body.mode);
    const mode = rawMode === 'devis' ? 'devis' : 'contact';

    const form = {
      subject: getTrimmedString(req.body && req.body.subject) || (mode === 'devis' ? 'devis' : 'question'),
      firstName: getTrimmedString(req.body && req.body.firstName),
      lastName: getTrimmedString(req.body && req.body.lastName),
      email: getTrimmedString(req.body && req.body.email),
      phone: getTrimmedString(req.body && req.body.phone),
      vin: getTrimmedString(req.body && req.body.vin),
      plate: getTrimmedString(req.body && req.body.plate),
      vehicle: getTrimmedString(req.body && req.body.vehicle),
      partRef: getTrimmedString(req.body && req.body.partRef),
      message: getTrimmedString(req.body && req.body.message),
      website: getTrimmedString(req.body && req.body.website),
    };

    const title = mode === 'devis'
      ? `Demande de devis - ${brand.NAME}`
      : `Contact - ${brand.NAME}`;

    const metaDescription = mode === 'devis'
      ? 'Demande de devis : envoyez votre référence, votre VIN et vos besoins. Réponse rapide par email ou téléphone.'
      : `Contactez ${brand.NAME} : question, assistance, compatibilité. Réponse rapide par email ou téléphone.`;

    const canonicalPath = mode === 'devis' ? '/devis' : '/contact';
    const canonicalUrl = baseUrl ? `${baseUrl}${langPrefix}${canonicalPath}` : `${langPrefix}${canonicalPath}`;

    if (form.website) {
      return res.render('contact/index', {
        title,
        metaDescription,
        canonicalUrl,
        ...hreflang,
        ogTitle: title,
        ogDescription: metaDescription,
        ogUrl: canonicalUrl,
        ogType: 'website',
        jsonLd: buildContactJsonLd({ baseUrl, mode }),
        dbConnected,
        mode,
        errorMessage: null,
        successMessage: 'Merci ! Votre message a bien été envoyé. Nous revenons vers vous rapidement.',
        form: buildInitialForm({ req: { query: {} }, mode }),
      });
    }

    if (isRateLimited(req)) {
      return res.status(429).render('contact/index', {
        title,
        metaDescription,
        canonicalUrl,
        ...hreflang,
        ogTitle: title,
        ogDescription: metaDescription,
        ogUrl: canonicalUrl,
        ogType: 'website',
        jsonLd: buildContactJsonLd({ baseUrl, mode }),
        dbConnected,
        mode,
        errorMessage: 'Trop de tentatives. Merci de réessayer dans quelques minutes.',
        successMessage: null,
        form,
      });
    }

    const sessionTs = req.session && typeof req.session.contactFormTs === 'number' ? req.session.contactFormTs : 0;
    if (sessionTs && Date.now() - sessionTs < 600) {
      return res.status(400).render('contact/index', {
        title,
        metaDescription,
        canonicalUrl,
        ...hreflang,
        ogTitle: title,
        ogDescription: metaDescription,
        ogUrl: canonicalUrl,
        ogType: 'website',
        jsonLd: buildContactJsonLd({ baseUrl, mode }),
        dbConnected,
        mode,
        errorMessage: 'Merci de patienter une seconde puis de renvoyer le formulaire.',
        successMessage: null,
        form,
      });
    }

    const email = normalizeEmail(form.email);
    if (!email) {
      return res.status(400).render('contact/index', {
        title,
        metaDescription,
        canonicalUrl,
        ...hreflang,
        ogTitle: title,
        ogDescription: metaDescription,
        ogUrl: canonicalUrl,
        ogType: 'website',
        jsonLd: buildContactJsonLd({ baseUrl, mode }),
        dbConnected,
        mode,
        errorMessage: 'Merci de renseigner un email valide.',
        successMessage: null,
        form,
      });
    }

    if (!form.message || form.message.length < 8) {
      return res.status(400).render('contact/index', {
        title,
        metaDescription,
        canonicalUrl,
        ...hreflang,
        ogTitle: title,
        ogDescription: metaDescription,
        ogUrl: canonicalUrl,
        ogType: 'website',
        jsonLd: buildContactJsonLd({ baseUrl, mode }),
        dbConnected,
        mode,
        errorMessage: 'Votre message est trop court. Merci de préciser un peu plus votre demande.',
        successMessage: null,
        form,
      });
    }

    const firstName = form.firstName;
    const lastName = form.lastName;
    const displayName = [firstName, lastName].filter(Boolean).join(' ').trim() || email;
    const phone = normalizePhone(form.phone);

    const safeSubjectType = form.subject || (mode === 'devis' ? 'devis' : 'question');

    const subjectLabelByValue = {
      question: 'Question',
      compatibilite: 'Compatibilité / Référence',
      commande: 'Commande / Livraison',
      devis: 'Demande de devis',
      autre: 'Autre',
    };

    const subjectLabel = subjectLabelByValue[safeSubjectType] || 'Message';

    const internalSubject = `${mode === 'devis' ? 'Demande de devis' : 'Contact'} - ${subjectLabel} - ${displayName}`.slice(0, 160);

    const safeMessage = escapeHtml(form.message).replace(/\r?\n/g, '<br/>');

    const html = `
      <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #111827;">
        <h2 style="margin:0 0 8px 0;">${mode === 'devis' ? 'Demande de devis' : 'Message contact'}</h2>
        <p style="margin:0 0 12px 0;"><strong>Sujet :</strong> ${escapeHtml(subjectLabel)}</p>
        <p style="margin:0 0 12px 0;"><strong>Nom :</strong> ${escapeHtml(displayName)}</p>
        <p style="margin:0 0 12px 0;"><strong>Email :</strong> ${escapeHtml(email)}</p>
        ${phone ? `<p style="margin:0 0 12px 0;"><strong>Téléphone :</strong> ${escapeHtml(phone)}</p>` : ''}
        ${form.vin ? `<p style="margin:0 0 12px 0;"><strong>VIN :</strong> ${escapeHtml(form.vin)}</p>` : ''}
        ${form.plate ? `<p style="margin:0 0 12px 0;"><strong>Immatriculation :</strong> ${escapeHtml(form.plate)}</p>` : ''}
        ${form.vehicle ? `<p style="margin:0 0 12px 0;"><strong>Véhicule :</strong> ${escapeHtml(form.vehicle)}</p>` : ''}
        ${form.partRef ? `<p style="margin:0 0 12px 0;"><strong>Référence pièce :</strong> ${escapeHtml(form.partRef)}</p>` : ''}
        <hr style="border:none;border-top:1px solid #e5e7eb;margin:16px 0;"/>
        <div style="font-size:14px;">
          ${safeMessage}
        </div>
      </div>
    `.trim();

    const textLines = [];
    textLines.push(mode === 'devis' ? 'Demande de devis' : 'Message contact');
    textLines.push(`Sujet: ${subjectLabel}`);
    textLines.push(`Nom: ${displayName}`);
    textLines.push(`Email: ${email}`);
    if (phone) textLines.push(`Téléphone: ${phone}`);
    if (form.vin) textLines.push(`VIN: ${form.vin}`);
    if (form.plate) textLines.push(`Immatriculation: ${form.plate}`);
    if (form.vehicle) textLines.push(`Véhicule: ${form.vehicle}`);
    if (form.partRef) textLines.push(`Référence pièce: ${form.partRef}`);
    textLines.push('');
    textLines.push(form.message);

    const sendResult = await emailService.sendEmail({
      toEmail: getContactToEmail(),
      subject: internalSubject,
      html,
      text: textLines.join('\n'),
    });

    if (!sendResult || !sendResult.ok) {
      const isProd = process.env.NODE_ENV === 'production';
      const message = isProd
        ? "Votre message n'a pas pu être envoyé. Réessayez plus tard ou contactez-nous par téléphone."
        : "Votre message n'a pas pu être envoyé (email pas configuré). Configurez MAILERSEND_API_KEY et MAIL_FROM_EMAIL dans Render.";

      return res.status(503).render('contact/index', {
        title,
        metaDescription,
        canonicalUrl,
        ...hreflang,
        ogTitle: title,
        ogDescription: metaDescription,
        ogUrl: canonicalUrl,
        ogType: 'website',
        jsonLd: buildContactJsonLd({ baseUrl, mode }),
        dbConnected,
        mode,
        errorMessage: message,
        successMessage: null,
        form,
      });
    }

    try {
      const ackSubject = `Nous avons bien reçu votre message - ${brand.NAME}`;
      const ackHtml = `
        <div style="font-family: Arial, sans-serif; line-height: 1.5; color: #111827;">
          <p style="margin:0 0 8px 0;"><strong>Bonjour${firstName ? ` ${escapeHtml(firstName)}` : ''},</strong></p>
          <p style="margin:0 0 12px 0;">Merci pour votre message. Notre équipe vous répond généralement sous 24h ouvrées.</p>
          <p style="margin:0 0 12px 0;">Si votre demande est urgente, vous pouvez aussi appeler le <strong>${brand.PHONE}</strong>.</p>
          <p style="margin:0;">${brand.NAME}</p>
        </div>
      `.trim();
      await emailService.sendEmail({ toEmail: email, subject: ackSubject, html: ackHtml, text: `Merci pour votre message. Nous vous répondons rapidement. ${brand.NAME}.` });
    } catch (err) {}

    if (req.session && typeof req.session === 'object') {
      req.session.contactFormTs = Date.now();
    }

    return res.render('contact/index', {
      title,
      metaDescription,
      canonicalUrl,
      ...hreflang,
      ogTitle: title,
      ogDescription: metaDescription,
      ogUrl: canonicalUrl,
      ogType: 'website',
      jsonLd: buildContactJsonLd({ baseUrl, mode }),
      dbConnected,
      mode,
      errorMessage: null,
      successMessage: 'Merci ! Votre message a bien été envoyé. Nous revenons vers vous rapidement.',
      form: buildInitialForm({ req: { query: {} }, mode }),
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = {
  getContactPage,
  postContact,
};
