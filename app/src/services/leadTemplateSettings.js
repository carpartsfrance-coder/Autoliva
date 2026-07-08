'use strict';

/**
 * Couche « override » des modèles de messages leads : applique le paramétrage
 * back-office (activé/désactivé + texte perso) par-dessus les modèles par défaut
 * définis dans leadEmailTemplates.js. Même architecture que services/smsSettings.
 */

const mongoose = require('mongoose');
const LeadTemplateSettings = require('../models/LeadTemplateSettings');
const { SMS_TEMPLATES, EMAIL_TEMPLATES } = require('./leadEmailTemplates');

// Cache court : ces modèles changent rarement, on évite une lecture DB par affichage.
let cache = null;
let cacheAt = 0;
const TTL_MS = 30 * 1000;

async function loadOverridesMap() {
  const now = Date.now();
  if (cache && now - cacheAt < TTL_MS) return cache;
  const map = new Map();
  try {
    if (mongoose.connection.readyState === 1) {
      const doc = await LeadTemplateSettings.findOne({ singleton: 'lead' }).lean();
      if (doc && Array.isArray(doc.overrides)) {
        doc.overrides.forEach((o) => {
          if (o && o.key && o.channel) map.set(o.channel + ':' + o.key, o);
        });
      }
    }
  } catch (err) {
    console.error('[leadTemplateSettings] load error:', err && err.message);
  }
  cache = map;
  cacheAt = now;
  return map;
}

function invalidateCache() { cache = null; cacheAt = 0; }

function isFilled(v) { return typeof v === 'string' && v.trim() !== ''; }

/** Fusionne un défaut avec son override éventuel (texte perso > défaut). */
function mergeOne(def, channel, ov) {
  const enabled = ov ? ov.enabled !== false : true;
  const out = {
    key: def.key,
    label: def.label,
    body: ov && isFilled(ov.body) ? ov.body : def.body,
    forSource: def.forSource || [],
    enabled,
  };
  if (channel === 'email') {
    out.subject = ov && isFilled(ov.subject) ? ov.subject : def.subject;
    out.defaultIncludeCta = def.defaultIncludeCta !== false;
  }
  return out;
}

/**
 * Modèles fusionnés, ACTIVÉS uniquement — c'est ce que voit le commercial dans
 * le composer (sélecteur SMS / email de la page leads).
 */
async function getMergedTemplates() {
  const map = await loadOverridesMap();
  const sms = SMS_TEMPLATES
    .map((d) => mergeOne(d, 'sms', map.get('sms:' + d.key)))
    .filter((t) => t.enabled);
  const email = EMAIL_TEMPLATES
    .map((d) => mergeOne(d, 'email', map.get('email:' + d.key)))
    .filter((t) => t.enabled);
  return { sms, email };
}

/**
 * TOUS les modèles (activés ou non) avec texte effectif + défaut — pour la page
 * d'édition. `body`/`subject` = override courant ('' si aucun) ; `defaultBody`/
 * `defaultSubject` = valeur du code (pour le bouton « Réinitialiser »).
 */
async function getTemplatesForAdmin() {
  const map = await loadOverridesMap();
  const build = (defs, channel) => defs.map((d) => {
    const ov = map.get(channel + ':' + d.key) || null;
    return {
      key: d.key,
      channel,
      label: d.label,
      enabled: ov ? ov.enabled !== false : true,
      subject: channel === 'email' && ov && typeof ov.subject === 'string' ? ov.subject : '',
      defaultSubject: channel === 'email' ? (d.subject || '') : '',
      body: ov && typeof ov.body === 'string' ? ov.body : '',
      defaultBody: d.body || '',
    };
  });
  return { sms: build(SMS_TEMPLATES, 'sms'), email: build(EMAIL_TEMPLATES, 'email') };
}

/** Enregistre le tableau d'overrides (upsert singleton) et vide le cache. */
async function saveOverrides(overrides, adminName) {
  await LeadTemplateSettings.findOneAndUpdate(
    { singleton: 'lead' },
    { $set: { overrides: Array.isArray(overrides) ? overrides : [], updatedAt: new Date(), updatedByName: adminName || '' } },
    { upsert: true, new: true }
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
  invalidateCache,
  LEAD_TEMPLATE_VARS,
};
