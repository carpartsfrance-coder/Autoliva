'use strict';

/**
 * Désinscription des relances commerciales (panier abandonné, devis moteur,
 * newsletter, SMS marketing).
 *
 * Pourquoi ce service : le pied des emails de relance proposait un lien
 * « Se désinscrire des emails marketing » qui pointait vers une route
 * inexistante (/newsletter/desinscription). Le client cliquait, rien ne se
 * passait, et les relances continuaient jusqu'à expiration du panier.
 *
 * Périmètre : uniquement la prospection. Les emails liés à une commande
 * (confirmation, expédition, consigne, livraison, SAV, remboursement)
 * restent dus au client et ne sont jamais filtrés ici.
 */

const crypto = require('crypto');
const mongoose = require('mongoose');

const MarketingOptOut = require('../models/MarketingOptOut');
const AbandonedCart = require('../models/AbandonedCart');
const NewsletterSubscriber = require('../models/NewsletterSubscriber');

const TOKEN_SECRET = process.env.UNSUBSCRIBE_TOKEN_SECRET
  || process.env.SESSION_SECRET
  || 'cpf-unsubscribe-default-secret';

/** Statuts de relance auto encore « vivants » sur un lead. */
const ACTIVE_CART_STATUSES = ['abandoned', 'reminded_1', 'reminded_2', 'reminded_3'];

function normalizeEmail(value) {
  const email = typeof value === 'string' ? value.trim().toLowerCase() : '';
  if (!email) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
  return email;
}

function dbConnected() {
  return mongoose.connection && mongoose.connection.readyState === 1;
}

/**
 * Token déterministe lié à l'adresse : permet un lien de désinscription en
 * un clic depuis l'email, sans exposer d'identifiant interne.
 */
function buildUnsubscribeToken(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return '';
  return crypto.createHmac('sha256', TOKEN_SECRET).update(`unsub:${normalized}`).digest('hex').slice(0, 32);
}

function verifyUnsubscribeToken(token, email) {
  const expected = buildUnsubscribeToken(email);
  const provided = typeof token === 'string' ? token.trim() : '';
  if (!expected || !provided || provided.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(provided, 'utf8'), Buffer.from(expected, 'utf8'));
  } catch (_) {
    return false;
  }
}

/** URL complète de désinscription en un clic à mettre dans les emails. */
function buildUnsubscribeUrl(email, baseUrl) {
  const normalized = normalizeEmail(email);
  const base = typeof baseUrl === 'string' ? baseUrl.replace(/\/$/, '') : '';
  if (!base) return '';
  if (!normalized) return `${base}/desinscription`;
  const token = buildUnsubscribeToken(normalized);
  return `${base}/desinscription?e=${encodeURIComponent(normalized)}&tk=${token}`;
}

/**
 * true si cette adresse ne doit plus recevoir de relance commerciale.
 * En cas d'erreur base, on renvoie true (on s'abstient plutôt que de
 * risquer un envoi non souhaité).
 */
async function isOptedOut(email) {
  const normalized = normalizeEmail(email);
  if (!normalized) return false;
  if (!dbConnected()) return false;
  try {
    const found = await MarketingOptOut.findOne({ email: normalized }).select('_id').lean();
    return Boolean(found);
  } catch (err) {
    console.error('[marketing-optout] Erreur lecture, envoi suspendu par précaution :', err && err.message ? err.message : err);
    return true;
  }
}

/**
 * Enregistre la désinscription et coupe immédiatement ce qui est en cours :
 * leads encore en relance auto + abonnement newsletter.
 */
async function optOut({ email, source = '', reason = '' } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized) return { ok: false, reason: 'invalid_email' };
  if (!dbConnected()) return { ok: false, reason: 'db_unavailable' };

  const now = new Date();

  try {
    await MarketingOptOut.updateOne(
      { email: normalized },
      {
        $set: { source, reason },
        $setOnInsert: { email: normalized, optedOutAt: now },
      },
      { upsert: true }
    );
  } catch (err) {
    // 11000 : une autre requête a inséré la même adresse entre-temps → déjà désinscrit
    if (!err || err.code !== 11000) {
      console.error('[marketing-optout] Erreur enregistrement :', err && err.message ? err.message : err);
      return { ok: false, reason: 'write_failed' };
    }
  }

  let cartsStopped = 0;
  try {
    const res = await AbandonedCart.updateMany(
      { email: normalized, status: { $in: ACTIVE_CART_STATUSES } },
      { $set: { status: 'expired' } }
    );
    cartsStopped = (res && res.modifiedCount) || 0;
  } catch (err) {
    console.error('[marketing-optout] Erreur arrêt des leads :', err && err.message ? err.message : err);
  }

  let newsletterStopped = 0;
  try {
    const res = await NewsletterSubscriber.updateOne(
      { email: normalized, status: 'active' },
      { $set: { status: 'unsubscribed', unsubscribedAt: now } }
    );
    newsletterStopped = (res && res.modifiedCount) || 0;
  } catch (err) {
    console.error('[marketing-optout] Erreur désabonnement newsletter :', err && err.message ? err.message : err);
  }

  console.log(`[marketing-optout] ${normalized} désinscrit (source=${source || 'n/a'}) — ${cartsStopped} lead(s) stoppé(s), ${newsletterStopped} newsletter(s) stoppée(s)`);

  return { ok: true, email: normalized, cartsStopped, newsletterStopped };
}

/** Réinscription (le client s'est désinscrit par erreur). */
async function optIn({ email } = {}) {
  const normalized = normalizeEmail(email);
  if (!normalized) return { ok: false, reason: 'invalid_email' };
  if (!dbConnected()) return { ok: false, reason: 'db_unavailable' };
  try {
    await MarketingOptOut.deleteOne({ email: normalized });
    return { ok: true, email: normalized };
  } catch (err) {
    console.error('[marketing-optout] Erreur réinscription :', err && err.message ? err.message : err);
    return { ok: false, reason: 'write_failed' };
  }
}

module.exports = {
  ACTIVE_CART_STATUSES,
  normalizeEmail,
  buildUnsubscribeToken,
  verifyUnsubscribeToken,
  buildUnsubscribeUrl,
  isOptedOut,
  optOut,
  optIn,
};
