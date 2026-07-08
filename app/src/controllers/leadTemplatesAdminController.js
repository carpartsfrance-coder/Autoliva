'use strict';

/**
 * Back-office : édition des modèles de messages leads
 * (/admin/parametres/modeles-messages). Active/désactive et personnalise le
 * texte des SMS + emails envoyés depuis « Leads à relancer », avec aperçu.
 * Même logique que smsSettingsAdminController : on stocke '' quand le texte est
 * identique au défaut (pour suivre les évolutions futures du défaut).
 */

const { getTemplatesForAdmin, saveOverrides, LEAD_TEMPLATE_VARS } = require('../services/leadTemplateSettings');
const { SMS_TEMPLATES, EMAIL_TEMPLATES } = require('../services/leadEmailTemplates');

function adminName(req) {
  const a = req && req.session && req.session.admin ? req.session.admin : {};
  return ((a.firstName || '') + ' ' + (a.lastName || '')).trim() || a.displayName || a.email || 'Admin';
}

async function getLeadTemplatesPage(req, res, next) {
  try {
    const templates = await getTemplatesForAdmin();
    return res.render('admin/lead-templates', {
      title: 'Modèles de messages · Paramètres',
      activeKey: 'settings',
      sms: templates.sms,
      email: templates.email,
      vars: LEAD_TEMPLATE_VARS,
      total: templates.sms.length + templates.email.length,
      successMessage: req.query.saved ? 'Modèles enregistrés ✓' : null,
    });
  } catch (err) {
    return next(err);
  }
}

async function postLeadTemplates(req, res, next) {
  try {
    const b = req.body || {};
    const overrides = [];
    const collect = (defs, channel) => {
      defs.forEach((d) => {
        const enabled = b['enabled_' + channel + '_' + d.key] != null; // checkbox cochée => présente
        const rawBody = String(b['body_' + channel + '_' + d.key] || '').replace(/\r\n/g, '\n').trim();
        const body = rawBody && rawBody !== d.body ? rawBody : '';
        const entry = { key: d.key, channel, enabled, body };
        if (channel === 'email') {
          const rawSubject = String(b['subject_' + channel + '_' + d.key] || '').trim();
          entry.subject = rawSubject && rawSubject !== d.subject ? rawSubject : '';
        }
        // On ne stocke l'override que s'il apporte quelque chose : désactivé,
        // corps perso, ou sujet perso. Sinon la clé suit le défaut du code.
        if (!enabled || entry.body || entry.subject) overrides.push(entry);
      });
    };
    collect(SMS_TEMPLATES, 'sms');
    collect(EMAIL_TEMPLATES, 'email');
    await saveOverrides(overrides, adminName(req));
    return res.redirect('/admin/parametres/modeles-messages?saved=1');
  } catch (err) {
    return next(err);
  }
}

module.exports = { getLeadTemplatesPage, postLeadTemplates };
