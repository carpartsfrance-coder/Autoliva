/*
 * SAV — jobs CRON
 * - Toutes les heures : escalade SLA dépassé
 * - Tous les jours 09:00 : relances documents (J+2/J+5/J+8 → refus auto), relances paiement 149€ (J+3/J+7/J+15), pièces > J+90 → "disposable"
 */

const SavTicket = require('../models/SavTicket');
const notif = require('../services/savNotifications');

const STATUTS_SLA = ['en_analyse', 'en_attente_documents'];

async function checkSavSlaEscalation() {
  const now = new Date();
  // 1) Tickets avec SLA déjà dépassé → escalade complète une seule fois
  const expired = await SavTicket.find({
    statut: { $in: STATUTS_SLA },
    'sla.dateLimite': { $lt: now },
    'sla.escalade': { $ne: true },
  });
  for (const t of expired) {
    t.sla.escalade = true;
    t.sla.alertes = t.sla.alertes || [];
    t.sla.alertes.push({ date: now, type: 'sla_depasse', message: 'SLA dépassé — escalade auto' });
    t.slaAlerts = t.slaAlerts || {};
    t.slaAlerts.alertExpired = now;
    t.addMessage('systeme', 'interne', 'SLA dépassé — escalade interne déclenchée');
    await t.save();
    await notif.notifyInternalEscalation(t, 'SLA dépassé');
  }

  // 2) Pré-alertes 24h et 12h restantes (anti-doublon via slaAlerts.alertXXh)
  const in24h = new Date(now.getTime() + 24 * 60 * 60 * 1000);
  const in12h = new Date(now.getTime() + 12 * 60 * 60 * 1000);

  const upcoming = await SavTicket.find({
    statut: { $in: STATUTS_SLA },
    'sla.dateLimite': { $gte: now, $lte: in24h },
  });
  for (const t of upcoming) {
    const limit = new Date(t.sla.dateLimite).getTime();
    const remainingMs = limit - now.getTime();
    t.slaAlerts = t.slaAlerts || {};
    if (remainingMs <= 12 * 3600 * 1000 && !t.slaAlerts.alert12h) {
      t.slaAlerts.alert12h = now;
      await t.save();
      await notif.notifyInternalEscalation(t, 'SLA < 12h');
      try { require('../services/slackNotifier').notifySlaWarning(t, '< 12h'); } catch (_) {}
    } else if (remainingMs <= 24 * 3600 * 1000 && !t.slaAlerts.alert24h) {
      t.slaAlerts.alert24h = now;
      await t.save();
      await notif.notifyInternalEscalation(t, 'SLA < 24h');
      try { require('../services/slackNotifier').notifySlaWarning(t, '< 24h'); } catch (_) {}
    }
  }

  return { expired: expired.length, upcoming: upcoming.length };
}

// Lance les automatisations (relance_1, relance_2, clos_sans_reponse, echange_auto)
async function runSavAutomations() {
  try {
    const auto = require('../services/savAutomations');
    const summary = await auto.runRules();
    console.log('[sav-cron] automations', summary);
    return summary;
  } catch (e) {
    console.error('[sav-cron] automations failed', e && e.message);
    return null;
  }
}

function daysSince(date) {
  if (!date) return 0;
  return Math.floor((Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24));
}

async function runSavDailyReminders() {
  let docsRelances = 0;
  let docsRefus = 0;
  let payRelances = 0;
  let payDemeure = 0;
  let disposables = 0;

  // ---------- Documents manquants ----------
  const docTickets = await SavTicket.find({ statut: 'en_attente_documents' });
  for (const t of docTickets) {
    const age = daysSince(t.sla && t.sla.dateOuverture);
    if (age >= 8) {
      t.changerStatut('refuse', 'systeme');
      t.addMessage('systeme', 'interne', 'Refus auto : documents non fournis après J+8');
      await t.save();
      docsRefus += 1;
      continue;
    }
    if (age === 2 || age === 5) {
      await notif.notifyRelanceDocuments(t);
      docsRelances += 1;
    }
  }

  // ---------- Paiement 149€ impayé ----------
  const payTickets = await SavTicket.find({
    'paiements.facture149.status': { $in: ['a_facturer', 'impayee'] },
  });
  for (const t of payTickets) {
    const age = daysSince(t.paiements && t.paiements.facture149 && t.paiements.facture149.dateGeneration);
    if (age === 3 || age === 7) {
      await notif.notifyRelancePaiement(t, 7);
      payRelances += 1;
    } else if (age === 15) {
      await notif.notifyRelancePaiement(t, 15);
      payDemeure += 1;
      t.paiements.facture149.status = 'impayee';
      t.addMessage('systeme', 'interne', 'Mise en demeure J+15 envoyée (art. 2286 Code civil)');
      await t.save();
    } else if (age >= 90) {
      // Marquage manuel "disposable"
      t.sla.alertes = t.sla.alertes || [];
      t.sla.alertes.push({ date: new Date(), type: 'disposable', message: 'Pièce > J+90 impayée — à valider manuellement pour disposition' });
      t.addMessage('systeme', 'interne', 'Pièce > J+90 impayée — flag disposable (validation manuelle requise)');
      await t.save();
      disposables += 1;
    }
  }

  // ---------- Google Reviews J+7 ----------
  let reviewsSent = 0;
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const reviewCandidats = await SavTicket.find({
    statut: 'resolu_garantie',
    'reviewFeedback.sentAt': { $exists: false },
    updatedAt: { $lte: sevenDaysAgo },
  });
  for (const t of reviewCandidats) {
    try {
      const { sendEmail } = require('../services/emailService');
      const link = `${(process.env.SITE_URL || '').replace(/\/$/, '')}/sav/feedback/${encodeURIComponent(t.numero)}`;
      await sendEmail({
        toEmail: t.client && t.client.email,
        subject: `[SAV ${t.numero}] Comment s'est passée votre expérience ?`,
        html: `<p>Bonjour ${(t.client && t.client.nom) || ''},</p>
          <p>Votre dossier SAV <strong>${t.numero}</strong> a été traité il y a une semaine. Comment s'est passée votre expérience avec CarPartsFrance ?</p>
          <p style="text-align:center;margin:24px 0;">
            <a href="${link}" style="display:inline-block;padding:12px 22px;background:#ec1313;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;">Donner mon avis</a>
          </p>
          <p style="font-size:13px;color:#475569;">Cela nous prendra moins d'une minute et nous aide énormément à nous améliorer.</p>`,
        text: `Comment s'est passée votre expérience ? ${link}`,
      });
      t.reviewFeedback = t.reviewFeedback || {};
      t.reviewFeedback.sentAt = new Date();
      await t.save();
      reviewsSent++;
    } catch (e) { console.error('[sav-cron] reviewMail', e.message); }
  }

  console.log('[sav-cron] daily reminders', {
    docsRelances, docsRefus, payRelances, payDemeure, disposables, reviewsSent,
  });
}

module.exports = {
  checkSavSlaEscalation,
  runSavDailyReminders,
  runSavAutomations,
};
