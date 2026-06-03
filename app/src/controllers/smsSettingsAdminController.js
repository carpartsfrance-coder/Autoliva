'use strict';

/**
 * Back-office : paramétrage des SMS automatiques (/admin/parametres/sms).
 * Permet d'activer/désactiver et de personnaliser chaque SMS, de prévisualiser
 * avec des données d'exemple et d'envoyer un SMS de test.
 */

const { getCatalog, getEntry, renderTemplate } = require('../services/smsCatalog');
const { getSettingsForAdmin, saveSettings } = require('../services/smsSettings');
const { sendSms } = require('../services/smsService');

function adminName(req) {
  const a = req && req.session && req.session.admin ? req.session.admin : {};
  return a.displayName || a.email || 'Admin';
}

async function getSmsSettingsPage(req, res, next) {
  try {
    const items = await getSettingsForAdmin();
    const order = [];
    const groups = {};
    items.forEach((it) => {
      if (!groups[it.category]) { groups[it.category] = []; order.push(it.category); }
      groups[it.category].push(it);
    });
    return res.render('admin/sms-settings', {
      title: 'SMS automatiques · Paramètres',
      activeKey: 'settings',
      groups,
      categories: order,
      total: items.length,
      successMessage: req.query.saved ? 'Paramètres SMS enregistrés ✓' : null,
      smsTestTo: process.env.SMS_TEST_TO || '',
    });
  } catch (err) {
    return next(err);
  }
}

async function postSmsSettings(req, res, next) {
  try {
    const b = req.body || {};
    const overrides = getCatalog().map((e) => {
      const enabled = b['enabled_' + e.key] != null; // checkbox cochée => présente
      const tpl = String(b['template_' + e.key] || '').replace(/\r\n/g, '\n').trim();
      // Si le texte est vide ou identique au défaut → on stocke '' (suit le défaut,
      // pour profiter d'éventuelles évolutions du texte par défaut).
      const template = tpl && tpl !== e.defaultTemplate ? tpl : '';
      return { key: e.key, enabled, template };
    });
    await saveSettings(overrides, adminName(req));
    return res.redirect('/admin/parametres/sms?saved=1');
  } catch (err) {
    return next(err);
  }
}

/** Envoi d'un SMS de test (AJAX). Utilise le texte fourni (non encore sauvé) ou le défaut. */
async function postSmsTest(req, res) {
  try {
    const b = req.body || {};
    const key = String(b.key || '').trim();
    const phone = String(b.phone || '').trim();
    const entry = getEntry(key);
    if (!entry) return res.status(400).json({ ok: false, error: 'Type de SMS inconnu' });
    if (!phone) return res.status(400).json({ ok: false, error: 'Numéro de test requis' });

    const tpl = b.template && String(b.template).trim() ? String(b.template) : entry.defaultTemplate;
    const text = renderTemplate(tpl, entry.example);
    const r = await sendSms({ to: phone, text });
    if (r && r.ok) return res.json({ ok: true, text });
    // Remonte le message clair (ex. « Crédits SMS épuisés ») au lieu du code brut.
    return res.status(502).json({
      ok: false,
      error: (r && r.message) || (r && r.reason) || 'Échec de l’envoi',
      reason: r && r.reason,
      status: r && r.status,
      text,
    });
  } catch (err) {
    return res.status(500).json({ ok: false, error: (err && err.message) || 'Erreur' });
  }
}

module.exports = { getSmsSettingsPage, postSmsSettings, postSmsTest };
