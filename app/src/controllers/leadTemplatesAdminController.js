'use strict';

/**
 * Back-office : gestion des modèles de messages leads
 * (/admin/parametres/modeles-messages).
 *   - Modèles D'ORIGINE : activer/désactiver + personnaliser le texte.
 *   - Modèles PERSO : ajouter / éditer / supprimer.
 *   - Reformulation IA (ChatGPT, comme le SAV) des modèles ET des messages
 *     réels envoyés depuis « Leads à relancer ».
 * On stocke '' pour un override quand le texte est identique au défaut (pour
 * suivre les évolutions futures du défaut).
 */

const {
  getTemplatesForAdmin,
  saveTemplates,
  addCustomTemplate,
  deleteCustomTemplate,
  LEAD_TEMPLATE_VARS,
} = require('../services/leadTemplateSettings');
const { SMS_TEMPLATES, EMAIL_TEMPLATES } = require('../services/leadEmailTemplates');

function adminName(req) {
  const a = req && req.session && req.session.admin ? req.session.admin : {};
  return ((a.firstName || '') + ' ' + (a.lastName || '')).trim() || a.displayName || a.email || 'Admin';
}

const FLASH = {
  1: 'Modèles enregistrés ✓',
  created: 'Modèle ajouté ✓',
  deleted: 'Modèle supprimé ✓',
};

async function getLeadTemplatesPage(req, res, next) {
  try {
    const templates = await getTemplatesForAdmin();
    const q = req.query || {};
    let successMessage = null;
    if (q.saved) successMessage = FLASH[1];
    else if (q.created) successMessage = FLASH.created;
    else if (q.deleted) successMessage = FLASH.deleted;
    return res.render('admin/lead-templates', {
      title: 'Modèles de messages · Paramètres',
      activeKey: 'settings',
      sms: templates.sms,
      email: templates.email,
      vars: LEAD_TEMPLATE_VARS,
      total: templates.sms.length + templates.email.length,
      successMessage,
      errorMessage: q.err === 'missing' ? 'Titre et message sont requis pour créer un modèle.' : null,
    });
  } catch (err) {
    return next(err);
  }
}

async function postLeadTemplates(req, res, next) {
  try {
    const b = req.body || {};
    const overrides = [];
    const collectBuiltin = (defs, channel) => {
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
    collectBuiltin(SMS_TEMPLATES, 'sms');
    collectBuiltin(EMAIL_TEMPLATES, 'email');

    // Édition en place des modèles perso (label / objet / corps / activé).
    const current = await getTemplatesForAdmin();
    const customEdits = [];
    current.sms.concat(current.email).filter((t) => t.isCustom).forEach((t) => {
      const ch = t.channel;
      // Ne toucher qu'aux modèles réellement présents dans le formulaire soumis
      // (évite de vider un modèle ajouté depuis un autre onglet entre-temps).
      if (!Object.prototype.hasOwnProperty.call(b, 'body_' + ch + '_' + t.id)) return;
      const edit = {
        id: t.id,
        label: String(b['label_' + ch + '_' + t.id] || '').trim(),
        body: String(b['body_' + ch + '_' + t.id] || '').replace(/\r\n/g, '\n'),
        enabled: b['enabled_' + ch + '_' + t.id] != null,
      };
      if (ch === 'email') edit.subject = String(b['subject_' + ch + '_' + t.id] || '');
      customEdits.push(edit);
    });

    await saveTemplates({ overrides, customEdits, adminName: adminName(req) });
    return res.redirect('/admin/parametres/modeles-messages?saved=1');
  } catch (err) {
    return next(err);
  }
}

async function postCreateLeadTemplate(req, res, next) {
  try {
    const b = req.body || {};
    const channel = b.channel === 'sms' ? 'sms' : 'email';
    const label = String(b.label || '').trim();
    const subject = String(b.subject || '').trim();
    const body = String(b.body || '').replace(/\r\n/g, '\n').trim();
    if (!label || !body) return res.redirect('/admin/parametres/modeles-messages?err=missing#ajouter');
    await addCustomTemplate({ channel, label, subject, body, adminName: adminName(req) });
    return res.redirect('/admin/parametres/modeles-messages?created=1');
  } catch (err) {
    return next(err);
  }
}

async function postDeleteLeadTemplate(req, res, next) {
  try {
    const id = String((req.params && req.params.id) || (req.body && req.body.id) || '').trim();
    await deleteCustomTemplate(id, adminName(req));
    return res.redirect('/admin/parametres/modeles-messages?deleted=1');
  } catch (err) {
    return next(err);
  }
}

// ---------------------------------------------------------------------------
// Reformulation IA (partagée entre l'éditeur de modèles et le composer leads).
// POST /admin/api/messages/reformulate  { draft, channel, clientName? }
// Rate-limit : 80 reformulations / heure / admin (mémoire process).
// ---------------------------------------------------------------------------
const REFORMULATE_RATE_MAX = 80;
const REFORMULATE_RATE_WINDOW_MS = 60 * 60 * 1000;
const reformulateUsage = new Map();

function checkReformulateRate(key) {
  const now = Date.now();
  const cur = reformulateUsage.get(key);
  if (!cur || now - cur.windowStart > REFORMULATE_RATE_WINDOW_MS) {
    reformulateUsage.set(key, { count: 1, windowStart: now });
    return { allowed: true, remaining: REFORMULATE_RATE_MAX - 1 };
  }
  if (cur.count >= REFORMULATE_RATE_MAX) {
    const resetIn = Math.ceil((REFORMULATE_RATE_WINDOW_MS - (now - cur.windowStart)) / 1000);
    return { allowed: false, remaining: 0, resetIn };
  }
  cur.count += 1;
  return { allowed: true, remaining: REFORMULATE_RATE_MAX - cur.count };
}

async function postReformulateMessage(req, res) {
  try {
    const reformulator = require('../services/openaiLeadReformulate');
    const draft = (req.body && typeof req.body.draft === 'string') ? req.body.draft : '';
    const channel = (req.body && req.body.channel === 'sms') ? 'sms' : 'email';
    if (!draft.trim()) return res.status(400).json({ ok: false, error: 'Texte requis.' });
    if (draft.length > reformulator.MAX_INPUT_CHARS) {
      return res.status(413).json({ ok: false, error: `Message trop long (max ${reformulator.MAX_INPUT_CHARS} caractères).` });
    }

    const a = req.session && req.session.admin ? req.session.admin : {};
    const rateKey = String(a.id || a._id || a.email || req.ip || 'anon');
    const rate = checkReformulateRate(rateKey);
    if (!rate.allowed) {
      res.set('Retry-After', String(rate.resetIn));
      return res.status(429).json({ ok: false, error: `Quota de reformulation atteint (${REFORMULATE_RATE_MAX}/h). Réessayez dans ${rate.resetIn}s.` });
    }

    const clientName = String((req.body && req.body.clientName) || '').trim().slice(0, 120);
    const result = await reformulator.reformulate(draft, { channel, clientName: clientName || undefined });
    res.set('X-RateLimit-Remaining', String(rate.remaining));
    return res.json({ ok: true, reformulated: result.reformulated, model: result.model });
  } catch (err) {
    const status = err.code === 'OPENAI_KEY_MISSING' ? 503
      : err.code === 'INPUT_TOO_LONG' ? 413
      : err.code === 'EMPTY_DRAFT' ? 400
      : 502;
    const msg = err.code === 'OPENAI_KEY_MISSING'
      ? "L'IA n'est pas configurée (clé OpenAI absente). Contacte l'admin."
      : (err.message || 'Erreur de reformulation.');
    return res.status(status).json({ ok: false, error: msg });
  }
}

module.exports = {
  getLeadTemplatesPage,
  postLeadTemplates,
  postCreateLeadTemplate,
  postDeleteLeadTemplate,
  postReformulateMessage,
};
