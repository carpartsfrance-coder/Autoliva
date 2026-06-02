'use strict';

/**
 * Relances automatiques pour les devis moteur envoyés et sans réponse.
 *
 *   J+3 → relance soft "On reste dispo"
 *   J+7 → relance "last chance" "Toujours intéressé ?"
 *   J+14 → marquage automatique 'lost'
 *
 * Anti-doublon : on persiste `engineQuote.remindersSent[]` avec le type
 * et la date d'envoi. Une relance d'un type donné n'est jamais envoyée 2x.
 *
 * Lancé via le scheduler (cron). Lit AbandonedCart en filtre :
 *   captureSource = 'landing_moteurs'
 *   engineQuote.status = 'quote_sent'
 */

const AbandonedCart = require('../models/AbandonedCart');
const emailService = require('../services/emailService');
const { buildReminderEmailHtml } = require('../services/engineQuoteEmail');
const brand = require('../config/brand');

const MS_DAY = 24 * 60 * 60 * 1000;

function hasReminder(eq, type) {
  return (eq.remindersSent || []).some(r => r.type === type);
}

function getLatestSentQuote(eq) {
  const arr = eq && eq.sentQuotes ? eq.sentQuotes : [];
  if (!arr.length) return null;
  return arr.slice().sort((a, b) => new Date(b.sentAt) - new Date(a.sentAt))[0];
}

async function sendReminder(cart, type) {
  const eq = cart.engineQuote || {};
  const lastSent = getLatestSentQuote(eq);
  if (!lastSent) return false;

  if (!cart.email) return false; // pas d'email, on ne peut pas relancer

  const quoteRef = (cart.requested && cart.requested.ref) || '';
  const plate = (cart.requested && cart.requested.plate) || '';
  const firstNameForEmail = (cart.firstName && cart.lastName) ? cart.firstName : '';

  const daysSince = Math.floor((Date.now() - new Date(lastSent.sentAt).getTime()) / MS_DAY);

  const html = buildReminderEmailHtml({
    type,
    quoteRef,
    firstName: firstNameForEmail,
    plate,
    sellTtc: lastSent.sellPriceTtc || 0,
    daysSince,
    brandPhone: brand.PHONE_MOTEUR,
    brandPhoneIntl: brand.PHONE_MOTEUR_INTL,
  });

  const subject = type === 'j7'
    ? `Votre devis ${quoteRef} est toujours actif`
    : `On reste dispo pour votre devis ${quoteRef}`;

  const text = `Bonjour,\n\nJe voulais m'assurer que vous avez bien reçu mon devis ${quoteRef} envoyé il y a ${daysSince} jour(s). Si vous avez la moindre question, n'hésitez pas.\n\nL'équipe Autoliva`;

  const result = await emailService.sendEmail({
    toEmail: cart.email,
    subject,
    html,
    text,
  });

  if (!result || result.ok === false) {
    console.error('[engineQuoteReminders] envoi échoué pour', cart._id, type);
    return false;
  }

  await AbandonedCart.updateOne(
    { _id: cart._id },
    {
      $push: { 'engineQuote.remindersSent': { type, sentAt: new Date() } },
      $set: { 'engineQuote.updatedAt': new Date() },
    }
  );
  console.log(`[engineQuoteReminders] ${type} envoyé pour ${quoteRef || cart._id}`);
  return true;
}

async function markAsLost(cart) {
  await AbandonedCart.updateOne(
    { _id: cart._id },
    {
      $push: {
        notes: {
          text: 'Auto-marqué "Perdu" après 14j sans réponse au devis envoyé.',
          addedByName: 'System (relance auto)',
          addedAt: new Date(),
        },
        'engineQuote.remindersSent': { type: 'j14_lost', sentAt: new Date() },
      },
      $set: {
        'engineQuote.status': 'lost',
        manualStatus: 'lost',
        manualStatusByName: 'System',
        manualStatusAt: new Date(),
        'engineQuote.updatedAt': new Date(),
      },
    }
  );
  console.log(`[engineQuoteReminders] auto-lost pour ${cart._id}`);
}

async function runEngineQuoteReminders() {
  const now = Date.now();
  const cutoff = new Date(now - 3 * MS_DAY); // candidats : envoi ≥ 3 jours

  // On cherche les leads avec status='quote_sent' et au moins un sentQuote
  const carts = await AbandonedCart.find({
    captureSource: 'landing_moteurs',
    'engineQuote.status': 'quote_sent',
    'engineQuote.sentQuotes.0': { $exists: true },
  }).limit(500);

  let countJ3 = 0, countJ7 = 0, countLost = 0;

  for (const cart of carts) {
    const eq = cart.engineQuote || {};
    const lastSent = getLatestSentQuote(eq);
    if (!lastSent) continue;
    const ageMs = now - new Date(lastSent.sentAt).getTime();
    const ageDays = ageMs / MS_DAY;

    // J+14 : marquage perdu
    if (ageDays >= 14 && !hasReminder(eq, 'j14_lost')) {
      await markAsLost(cart);
      countLost++;
      continue;
    }
    // J+7 : relance last-chance
    if (ageDays >= 7 && !hasReminder(eq, 'j7')) {
      const ok = await sendReminder(cart, 'j7');
      if (ok) countJ7++;
      continue;
    }
    // J+3 : relance soft
    if (ageDays >= 3 && !hasReminder(eq, 'j3')) {
      const ok = await sendReminder(cart, 'j3');
      if (ok) countJ3++;
      continue;
    }
  }

  console.log(`[engineQuoteReminders] J+3=${countJ3} J+7=${countJ7} lost=${countLost} sur ${carts.length} devis envoyés`);
  return { countJ3, countJ7, countLost, total: carts.length };
}

module.exports = { runEngineQuoteReminders };
