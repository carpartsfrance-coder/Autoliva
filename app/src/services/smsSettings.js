'use strict';

const mongoose = require('mongoose');
const SmsSettings = require('../models/SmsSettings');
const { getCatalog, getEntry, isKnownKey, renderTemplate } = require('./smsCatalog');

// Cache court : les SMS partent rarement, mais on évite une lecture DB par envoi.
let cache = null;
let cacheAt = 0;
const TTL_MS = 30 * 1000;

async function loadOverridesMap() {
  const now = Date.now();
  if (cache && now - cacheAt < TTL_MS) return cache;
  const map = new Map();
  try {
    if (mongoose.connection.readyState === 1) {
      const doc = await SmsSettings.findOne({ singleton: 'sms' }).lean();
      if (doc && Array.isArray(doc.overrides)) {
        doc.overrides.forEach((o) => {
          if (o && o.key) map.set(o.key, { enabled: o.enabled !== false, template: o.template || '' });
        });
      }
    }
  } catch (err) {
    console.error('[smsSettings] load error:', err && err.message);
  }
  cache = map;
  cacheAt = now;
  return map;
}

function invalidateCache() { cache = null; cacheAt = 0; }

/**
 * Résout le SMS d'une clé donnée : applique l'override back-office
 * (activé/désactivé + texte personnalisé), sinon le défaut du catalogue.
 * Best-effort : ne jette jamais (en cas d'erreur, défaut + activé).
 *
 * @returns {Promise<{enabled:boolean, text:(string|null)}>}
 *   enabled=false → NE PAS envoyer. text=null → clé inconnue.
 */
async function resolveSms(key, vars) {
  const entry = getEntry(key);
  if (!entry) return { enabled: true, text: null };
  let override = null;
  try {
    override = (await loadOverridesMap()).get(key) || null;
  } catch (_) { override = null; }
  const enabled = override ? override.enabled !== false : true;
  if (!enabled) return { enabled: false, text: null };
  const tpl = override && override.template && override.template.trim() ? override.template : entry.defaultTemplate;
  return { enabled: true, text: renderTemplate(tpl, vars || {}) };
}

/** Pour l'admin : catalogue + override courant fusionnés (toutes les clés). */
async function getSettingsForAdmin() {
  const map = await loadOverridesMap();
  return getCatalog().map((e) => {
    const o = map.get(e.key);
    return {
      key: e.key, label: e.label, category: e.category,
      defaultTemplate: e.defaultTemplate, vars: e.vars, example: e.example,
      enabled: o ? o.enabled !== false : true,
      template: (o && o.template) || '',
    };
  });
}

/** Sauvegarde des overrides depuis l'admin. */
async function saveSettings(overrides, adminName) {
  const clean = (Array.isArray(overrides) ? overrides : [])
    .filter((o) => o && isKnownKey(o.key))
    .map((o) => ({ key: o.key, enabled: o.enabled !== false, template: String(o.template || '').slice(0, 1000) }));
  await SmsSettings.updateOne(
    { singleton: 'sms' },
    { $set: { overrides: clean, updatedAt: new Date(), updatedByName: adminName || '' } },
    { upsert: true }
  );
  invalidateCache();
}

module.exports = { resolveSms, getSettingsForAdmin, saveSettings, invalidateCache };
