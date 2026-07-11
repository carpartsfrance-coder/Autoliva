'use strict';

/**
 * Couche « paramétrage » des modèles de messages leads :
 *   - OVERRIDES : activent/désactivent et personnalisent le texte des modèles
 *     D'ORIGINE (définis dans leadEmailTemplates.js). Même archi que smsSettings.
 *   - CUSTOM : modèles PERSONNALISÉS créés depuis le back-office, librement
 *     ajoutables / supprimables, qui viennent s'ajouter aux modèles d'origine.
 * Le tout est fusionné pour le sélecteur du composer (page Leads) et pour la
 * page d'édition (/admin/parametres/modeles-messages).
 */

const crypto = require('crypto');
const mongoose = require('mongoose');
const LeadTemplateSettings = require('../models/LeadTemplateSettings');
const { SMS_TEMPLATES, EMAIL_TEMPLATES } = require('./leadEmailTemplates');

// Cache court : ces modèles changent rarement, on évite une lecture DB par affichage.
let cache = null;
let cacheAt = 0;
const TTL_MS = 30 * 1000;

/** Charge overrides (map) + modèles custom (liste) depuis le singleton, caché. */
async function loadSettings() {
  const now = Date.now();
  if (cache && now - cacheAt < TTL_MS) return cache;
  const overridesMap = new Map();
  let custom = [];
  try {
    if (mongoose.connection.readyState === 1) {
      const doc = await LeadTemplateSettings.findOne({ singleton: 'lead' }).lean();
      if (doc) {
        if (Array.isArray(doc.overrides)) {
          doc.overrides.forEach((o) => {
            if (o && o.key && o.channel) overridesMap.set(o.channel + ':' + o.key, o);
          });
        }
        if (Array.isArray(doc.custom)) {
          custom = doc.custom.filter((c) => c && c.id && (c.channel === 'sms' || c.channel === 'email'));
        }
      }
    }
  } catch (err) {
    console.error('[leadTemplateSettings] load error:', err && err.message);
  }
  cache = { overridesMap, custom };
  cacheAt = now;
  return cache;
}

function invalidateCache() { cache = null; cacheAt = 0; }

function isFilled(v) { return typeof v === 'string' && v.trim() !== ''; }

/** Fusionne un défaut (modèle d'origine) avec son override éventuel. */
function mergeOne(def, channel, ov) {
  const enabled = ov ? ov.enabled !== false : true;
  const out = {
    key: def.key,
    label: def.label,
    body: ov && isFilled(ov.body) ? ov.body : def.body,
    forSource: def.forSource || [],
    enabled,
    isCustom: false,
  };
  if (channel === 'email') {
    out.subject = ov && isFilled(ov.subject) ? ov.subject : def.subject;
    out.defaultIncludeCta = def.defaultIncludeCta !== false;
  }
  return out;
}

/** Transforme un modèle custom (stocké) en entrée « composer », comme mergeOne. */
function customToComposer(c) {
  const out = {
    key: c.id,
    label: c.label || '(sans titre)',
    body: c.body || '',
    forSource: [],
    enabled: c.enabled !== false,
    isCustom: true,
  };
  if (c.channel === 'email') {
    out.subject = c.subject || '';
    // CTA panier proposé par défaut seulement si le modèle référence le lien.
    out.defaultIncludeCta = /\{lien_panier\}/.test(c.body || '');
  }
  return out;
}

/**
 * Modèles fusionnés, ACTIVÉS uniquement (origine + custom) — c'est ce que voit
 * le commercial dans le sélecteur SMS / email de la page leads.
 */
async function getMergedTemplates() {
  const { overridesMap, custom } = await loadSettings();
  const customSms = custom.filter((c) => c.channel === 'sms').map(customToComposer);
  const customEmail = custom.filter((c) => c.channel === 'email').map(customToComposer);
  const sms = SMS_TEMPLATES
    .map((d) => mergeOne(d, 'sms', overridesMap.get('sms:' + d.key)))
    .concat(customSms)
    .filter((t) => t.enabled);
  const email = EMAIL_TEMPLATES
    .map((d) => mergeOne(d, 'email', overridesMap.get('email:' + d.key)))
    .concat(customEmail)
    .filter((t) => t.enabled);
  return { sms, email };
}

/**
 * TOUS les modèles (activés ou non) pour la page d'édition. Chaque entrée porte
 * `isCustom` : les modèles d'origine ont un `defaultBody`/`defaultSubject` (bouton
 * « Réinitialiser ») ; les modèles custom ont un `id` (bouton « Supprimer »).
 */
async function getTemplatesForAdmin() {
  const { overridesMap, custom } = await loadSettings();
  const buildBuiltin = (defs, channel) => defs.map((d) => {
    const ov = overridesMap.get(channel + ':' + d.key) || null;
    return {
      key: d.key,
      channel,
      label: d.label,
      isCustom: false,
      enabled: ov ? ov.enabled !== false : true,
      subject: channel === 'email' && ov && typeof ov.subject === 'string' ? ov.subject : '',
      defaultSubject: channel === 'email' ? (d.subject || '') : '',
      body: ov && typeof ov.body === 'string' ? ov.body : '',
      defaultBody: d.body || '',
    };
  });
  const buildCustom = (channel) => custom.filter((c) => c.channel === channel).map((c) => ({
    id: c.id,
    key: c.id,
    channel,
    label: c.label || '',
    isCustom: true,
    enabled: c.enabled !== false,
    subject: channel === 'email' ? (c.subject || '') : '',
    defaultSubject: '',
    body: c.body || '',
    defaultBody: '',
    createdByName: c.createdByName || '',
  }));
  return {
    sms: buildBuiltin(SMS_TEMPLATES, 'sms').concat(buildCustom('sms')),
    email: buildBuiltin(EMAIL_TEMPLATES, 'email').concat(buildCustom('email')),
  };
}

/** Enregistre les overrides des modèles d'origine (sans toucher aux custom). */
async function saveOverrides(overrides, adminName) {
  await LeadTemplateSettings.findOneAndUpdate(
    { singleton: 'lead' },
    { $set: { overrides: Array.isArray(overrides) ? overrides : [], updatedAt: new Date(), updatedByName: adminName || '' } },
    { upsert: true, new: true }
  );
  invalidateCache();
}

/**
 * Sauvegarde combinée du formulaire d'édition : overrides des modèles d'origine
 * + édition en place des modèles custom (label / objet / corps / activé).
 * @param {object} p
 * @param {Array}  p.overrides    - overrides modèles d'origine
 * @param {Array}  p.customEdits  - [{ id, label, subject, body, enabled }]
 * @param {string} p.adminName
 */
async function saveTemplates({ overrides, customEdits, adminName }) {
  const doc = await LeadTemplateSettings.findOne({ singleton: 'lead' })
    || new LeadTemplateSettings({ singleton: 'lead' });
  doc.overrides = Array.isArray(overrides) ? overrides : [];
  if (Array.isArray(customEdits) && Array.isArray(doc.custom)) {
    const byId = new Map(customEdits.map((e) => [String(e.id), e]));
    doc.custom.forEach((c) => {
      const e = byId.get(String(c.id));
      if (!e) return;
      if (typeof e.label === 'string') c.label = e.label.trim().slice(0, 120);
      if (c.channel === 'email' && typeof e.subject === 'string') c.subject = e.subject.slice(0, 200);
      if (typeof e.body === 'string') c.body = e.body.slice(0, 8000);
      c.enabled = e.enabled !== false;
    });
  }
  doc.updatedAt = new Date();
  doc.updatedByName = adminName || '';
  await doc.save();
  invalidateCache();
}

/** Crée un modèle personnalisé. Retourne l'id généré. */
async function addCustomTemplate({ channel, label, subject, body, adminName }) {
  const ch = channel === 'sms' ? 'sms' : 'email';
  const id = 'custom_' + crypto.randomBytes(6).toString('hex');
  const entry = {
    id,
    channel: ch,
    label: String(label || '').trim().slice(0, 120) || 'Nouveau modèle',
    subject: ch === 'email' ? String(subject || '').slice(0, 200) : '',
    body: String(body || '').slice(0, 8000),
    enabled: true,
    createdByName: adminName || '',
    createdAt: new Date(),
  };
  await LeadTemplateSettings.findOneAndUpdate(
    { singleton: 'lead' },
    { $push: { custom: entry }, $set: { updatedAt: new Date(), updatedByName: adminName || '' } },
    { upsert: true, new: true }
  );
  invalidateCache();
  return id;
}

/** Supprime un modèle personnalisé par id. */
async function deleteCustomTemplate(id, adminName) {
  const cleanId = String(id || '').trim();
  if (!cleanId) return;
  await LeadTemplateSettings.updateOne(
    { singleton: 'lead' },
    { $pull: { custom: { id: cleanId } }, $set: { updatedAt: new Date(), updatedByName: adminName || '' } }
  );
  invalidateCache();
}

/** Variables disponibles dans les modèles (aide à l'édition). */
const LEAD_TEMPLATE_VARS = [
  ['prenom', 'Prénom du client (ou « Bonjour » si inconnu)'],
  ['nom_produit', 'Produit / demande du client'],
  ['prix_total', 'Montant total'],
  ['telephone', 'Ta ligne directe (selon le commercial connecté)'],
  ['nom_commercial', 'Ton nom (selon le commercial connecté)'],
  ['brand', 'Nom de la marque (Autoliva)'],
  ['vehicule', 'Véhicule du client (si connu)'],
  ['immatriculation', 'Plaque du client (si connue)'],
  ['lien_panier', 'Lien de reprise du panier (email uniquement — jamais en SMS)'],
];

module.exports = {
  getMergedTemplates,
  getTemplatesForAdmin,
  saveOverrides,
  saveTemplates,
  addCustomTemplate,
  deleteCustomTemplate,
  invalidateCache,
  LEAD_TEMPLATE_VARS,
};
