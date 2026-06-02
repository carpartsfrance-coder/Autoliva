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
const { sendSms } = require('../services/smsService');
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

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
}

function getCommercialEmail() {
  const fromEnv = String(process.env.LEAD_FORM_TO_EMAIL || process.env.CONTACT_FORM_TO_EMAIL || '').trim();
  return fromEnv || brand.EMAIL_CONTACT;
}

function publicBase() {
  return (process.env.PUBLIC_BASE_URL || brand.SITE_URL || 'https://autoliva.com').replace(/\/$/, '');
}

/**
 * ALERTE SLA INTERNE — un lead moteur reçu mais TOUJOURS PAS deviser après X h.
 * Le commercial a eu la notif à T0 ; ici on le relance pour qu'il agisse (sinon
 * un lead chaud peut rester sans devis indéfiniment, aucune relance ne le
 * couvrant — les relances client ne ciblent que les devis déjà envoyés).
 *
 * 2 niveaux : 24h puis 48h. Anti-doublon via cart.slaAlertsSent (racine, car
 * engineQuote peut être null sur un lead jamais ouvert).
 */
async function alertUnquotedLeads() {
  const now = Date.now();
  const commercialEmail = getCommercialEmail();
  if (!commercialEmail) return { count24: 0, count48: 0 };

  const leads = await AbandonedCart.find({
    captureSource: 'landing_moteurs',
    manualStatus: null,
    $or: [
      { engineQuote: null },
      { 'engineQuote.status': { $in: ['new', 'analyzing'] } },
    ],
  }).limit(500);

  let count24 = 0, count48 = 0;

  for (const cart of leads) {
    const ageH = (now - new Date(cart.createdAt).getTime()) / (60 * 60 * 1000);
    const sent = cart.slaAlertsSent || [];
    let level = null;
    if (ageH >= 48 && !sent.includes('sla_48h')) level = 'sla_48h';
    else if (ageH >= 24 && !sent.includes('sla_24h')) level = 'sla_24h';
    if (!level) continue;

    const hours = level === 'sla_48h' ? 48 : 24;
    const urgent = hours >= 48;
    const quoteRef = (cart.requested && cart.requested.ref) || '';
    const displayName = ((cart.firstName || '') + ' ' + (cart.lastName || '')).trim() || cart.email || cart.phone || '—';
    const plate = (cart.requested && cart.requested.plate) || '';
    const adminUrl = publicBase() + '/admin/devis-moteurs/' + cart._id;

    const subject = `${urgent ? '🔴 URGENT — ' : '⏰ '}Lead moteur non deviser depuis ${hours}h — ${quoteRef || displayName}`;
    const html = `<div style="font-family:Arial,sans-serif;line-height:1.5;color:#111827;">
      <h2 style="margin:0 0 8px;">${urgent ? 'RELANCE — ' : ''}Lead moteur à traiter (${hours}h sans devis)</h2>
      <p style="margin:0 0 10px;">Demande reçue il y a <strong>${Math.floor(ageH)}h</strong>, toujours <strong>sans devis envoyé</strong>.</p>
      <p style="margin:0 0 6px;"><strong>Dossier :</strong> ${escapeHtml(quoteRef)}</p>
      <p style="margin:0 0 6px;"><strong>Client :</strong> ${escapeHtml(displayName)}</p>
      ${cart.email ? `<p style="margin:0 0 6px;"><strong>Email :</strong> <a href="mailto:${escapeHtml(cart.email)}">${escapeHtml(cart.email)}</a></p>` : ''}
      ${cart.phone ? `<p style="margin:0 0 6px;"><strong>Téléphone :</strong> <a href="tel:${escapeHtml(cart.phone)}">${escapeHtml(cart.phone)}</a></p>` : ''}
      ${plate ? `<p style="margin:0 0 6px;"><strong>Véhicule :</strong> ${escapeHtml(plate)}</p>` : ''}
      <p style="margin:16px 0 0;"><a href="${adminUrl}" style="display:inline-block;background:#0b2046;color:#fff;text-decoration:none;padding:10px 18px;border-radius:8px;font-weight:600;">Ouvrir le dossier →</a></p>
    </div>`;
    const text = `Lead moteur non deviser depuis ${hours}h\nDossier: ${quoteRef}\nClient: ${displayName}\nEmail: ${cart.email || '-'}\nTel: ${cart.phone || '-'}\nVehicule: ${plate || '-'}\n${adminUrl}`;

    try {
      const r = await emailService.sendEmail({ toEmail: commercialEmail, subject, html, text, replyTo: cart.email || undefined });
      if (r && r.ok !== false) {
        await AbandonedCart.updateOne({ _id: cart._id }, { $addToSet: { slaAlertsSent: level } });
        if (level === 'sla_48h') count48++; else count24++;
      }
    } catch (err) {
      console.error('[engineQuoteReminders] SLA alert échouée pour', cart._id, err && err.message);
    }
  }
  console.log(`[engineQuoteReminders] SLA alerts: 24h=${count24} 48h=${count48} (sur ${leads.length} leads à traiter)`);
  return { count24, count48 };
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

  // CTA tracké : "Revoir mon devis" passe par /track-pdf (enregistre la vue
  // puis redirige vers le PDF). "Réserver" → lien Mollie si dispo.
  const pdfUrl = publicBase() + '/api/devis-moteurs/track-pdf/' + cart._id + '/' + lastSent._id;
  const mollieUrl = lastSent.mollieUrl || '';

  const html = buildReminderEmailHtml({
    type,
    quoteRef,
    firstName: firstNameForEmail,
    plate,
    sellTtc: lastSent.sellPriceTtc || 0,
    daysSince,
    brandPhone: brand.PHONE_MOTEUR,
    brandPhoneIntl: brand.PHONE_MOTEUR_INTL,
    pdfUrl,
    mollieUrl,
  });

  const subject = type === 'j14'
    ? `Dernier rappel — votre devis ${quoteRef}`
    : type === 'j7'
      ? `Votre devis ${quoteRef} — je peux reconfirmer la dispo`
      : `On reste dispo pour votre devis ${quoteRef}`;

  const text = `Bonjour,\n\nJe reviens vers vous au sujet de mon devis ${quoteRef} (envoyé il y a ${daysSince} jour(s)). Un devis n'étant garanti que 24h (le moteur peut partir, les prix bougent), dites-moi si vous êtes toujours intéressé : je reconfirme la disponibilité et le prix du jour.\n\nL'équipe Autoliva\n${brand.PHONE_MOTEUR}`;

  const result = await emailService.sendEmail({
    toEmail: cart.email,
    subject,
    html,
    text,
    // Le mail invite à répondre → la réponse doit arriver dans une boîte
    // surveillée (et pas l'adresse d'envoi).
    replyTo: { email: brand.EMAIL_CONTACT, name: brand.NAME },
  });

  if (!result || result.ok === false) {
    console.error('[engineQuoteReminders] envoi échoué pour', cart._id, type);
    return false;
  }

  // SMS pour les relances chaudes (J+7 last-chance, J+14 dernier rappel).
  // ~98% de taux d'ouverture → fort levier sur un devis à plusieurs centaines €.
  if ((type === 'j7' || type === 'j14') && cart.phone) {
    try {
      const smsText = type === 'j14'
        ? `Autoliva : dernier rappel pour votre devis ${quoteRef}. Sans nouvelle on cloture le dossier. Toujours interesse ? Appelez ${brand.PHONE_MOTEUR}`
        : `Autoliva : votre devis ${quoteRef} (moteur) est toujours d'actualite. Une question ou reserver le moteur ? Appelez ${brand.PHONE_MOTEUR}`;
      await sendSms({ to: cart.phone, text: smsText });
    } catch (err) {
      console.warn('[engineQuoteReminders] SMS', type, 'échoué pour', cart._id, err && err.message);
    }
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
          text: 'Auto-marqué "Perdu" après 21j sans réponse au devis envoyé (relances J+3, J+7, J+14 sans retour).',
          addedByName: 'System (relance auto)',
          addedAt: new Date(),
        },
        'engineQuote.remindersSent': { type: 'j21_lost', sentAt: new Date() },
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

  // 0) Alerte interne SLA : leads reçus mais non deviser (24h / 48h).
  try {
    await alertUnquotedLeads();
  } catch (err) {
    console.error('[engineQuoteReminders] alertUnquotedLeads error:', err && err.message);
  }

  const cutoff = new Date(now - 3 * MS_DAY); // candidats : envoi ≥ 3 jours

  // On cherche les leads avec status='quote_sent' et au moins un sentQuote
  const carts = await AbandonedCart.find({
    captureSource: 'landing_moteurs',
    'engineQuote.status': 'quote_sent',
    'engineQuote.sentQuotes.0': { $exists: true },
  }).limit(500);

  let countJ3 = 0, countJ7 = 0, countJ14 = 0, countLost = 0;

  for (const cart of carts) {
    const eq = cart.engineQuote || {};
    const lastSent = getLatestSentQuote(eq);
    if (!lastSent) continue;
    const ageMs = now - new Date(lastSent.sentAt).getTime();
    const ageDays = ageMs / MS_DAY;

    // J+21 : marquage perdu (cadence allongée : un achat moteur se réfléchit)
    if (ageDays >= 21 && !hasReminder(eq, 'j21_lost') && !hasReminder(eq, 'j14_lost')) {
      await markAsLost(cart);
      countLost++;
      continue;
    }
    // J+14 : relance finale "dernier rappel" (+ SMS)
    if (ageDays >= 14 && !hasReminder(eq, 'j14')) {
      const ok = await sendReminder(cart, 'j14');
      if (ok) countJ14++;
      continue;
    }
    // J+7 : relance last-chance (+ SMS)
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

  console.log(`[engineQuoteReminders] J+3=${countJ3} J+7=${countJ7} J+14=${countJ14} lost=${countLost} sur ${carts.length} devis envoyés`);
  return { countJ3, countJ7, countJ14, countLost, total: carts.length };
}

module.exports = { runEngineQuoteReminders, alertUnquotedLeads };
