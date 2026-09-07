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
      // Réconciliation : plus de refus sec à J+8. Le dossier passe en pause
      // (clos_sans_reponse) et le client sait qu'il peut le réactiver en
      // répondant — un pro débordé 8 jours n'est pas un client perdu.
      t.changerStatut('clos_sans_reponse', 'systeme', { force: true });
      t.addMessage('systeme', 'interne', 'Pause auto J+8 : documents non fournis — dossier réactivable 90 j (ex-refus auto)');
      await t.save();
      try {
        const { sendEmail } = require('../services/emailService');
        if (t.client && t.client.email) {
          await sendEmail({
            toEmail: t.client.email,
            subject: `[SAV ${t.numero}] Votre dossier est mis en pause — réactivable à tout moment`,
            html: `<p>Bonjour ${(t.client && t.client.nom) || ''},</p>
              <p>Sans nouvelles de votre part, nous avons mis votre dossier SAV <strong>${t.numero}</strong> en pause — <strong>rien n'est perdu</strong> : il reste réactivable pendant 90 jours.</p>
              <p>Dès que vous avez les documents demandés, répondez simplement à cet email (ou appelez-nous) et nous reprenons le dossier là où il en était.</p>
              <p style="font-size:13px;color:#475569;">Nous savons que vous êtes occupé — prenez le temps qu'il faut.</p>`,
            text: `Votre dossier SAV ${t.numero} est en pause, réactivable 90 jours en répondant à cet email.`,
          });
        }
      } catch (e) { console.error('[sav-cron] pauseMail', e.message); }
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

  // ---------- « Tout fonctionne ? » + avis J+7 (résolutions positives) ----------
  let reviewsSent = 0;
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 3600 * 1000);
  const reviewCandidats = await SavTicket.find({
    statut: { $in: ['resolu_garantie', 'resolu_facture', 'clos'] },
    'reviewFeedback.sentAt': { $exists: false },
    updatedAt: { $lte: sevenDaysAgo },
  });
  for (const t of reviewCandidats) {
    try {
      const { sendEmail } = require('../services/emailService');
      const brand = require('../config/brand');
      const link = `${(process.env.SITE_URL || '').replace(/\/$/, '')}/sav/feedback/${encodeURIComponent(t.numero)}`;
      const isB2B = t.client && t.client.type === 'B2B';
      const referent = (t.closure && t.closure.closedBy) || '';
      // CTA avis Google : seulement si l'URL est configurée (GOOGLE_REVIEW_URL).
      const googleCta = brand.GOOGLE_REVIEW_URL
        ? `<p style="text-align:center;margin:8px 0 0;"><a href="${brand.GOOGLE_REVIEW_URL}" style="display:inline-block;padding:10px 18px;border:2px solid #ec1313;color:#ec1313;text-decoration:none;border-radius:10px;font-weight:700;">⭐ Laisser un avis Google</a></p>`
        : '';
      const b2bLine = isB2B
        ? `<p style="font-size:13px;color:#475569;">En tant que professionnel, vous avez un interlocuteur dédié${referent ? ` (${referent})` : ''} : pour toute prochaine commande ou question technique, répondez directement à cet email — vous êtes prioritaire.</p>`
        : '';
      await sendEmail({
        toEmail: t.client && t.client.email,
        subject: `[SAV ${t.numero}] Tout fonctionne bien ?`,
        html: `<p>Bonjour ${(t.client && t.client.nom) || ''},</p>
          <p>Votre dossier SAV <strong>${t.numero}</strong> a été résolu il y a une semaine. La pièce fonctionne bien ? Tout roule ?</p>
          <p>S'il y a le moindre souci, répondez à cet email — on s'en occupe en priorité.</p>
          <p style="text-align:center;margin:24px 0 0;">
            <a href="${link}" style="display:inline-block;padding:12px 22px;background:#ec1313;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;">Donner mon avis</a>
          </p>
          ${googleCta}
          ${b2bLine}
          <p style="font-size:13px;color:#475569;">Cela nous prend moins d'une minute et nous aide énormément.</p>`,
        text: `Votre dossier SAV ${t.numero} est résolu depuis une semaine — tout fonctionne ? ${link}`,
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

/*
 * ---------- Soin relationnel (anti-« froid ») ----------
 * Règle d'or : le client ne doit JAMAIS se demander « ils m'ont oublié ? ».
 *  1) HEARTBEAT — ticket actif sans message sortant depuis 48 h (24 h pour un
 *     pro B2B) → email « où en est votre dossier » avec l'étape en cours, la
 *     prochaine étape et le lien de suivi. Max 1 heartbeat / 48 h.
 *  2) RAPPEL GESTE J+14 — dossier refusé AVEC geste commercial → on revient
 *     vers le client : son bon d'achat / sa remise l'attend toujours.
 */
const HEARTBEAT_STATUTS = ['retour_demande', 'en_transit_retour', 'recu_atelier', 'en_analyse', 'analyse_terminee', 'en_attente_fournisseur'];
const HEARTBEAT_STEP_INFO = {
  retour_demande: { now: 'Nous attendons le retour de votre pièce', next: 'réception à l\'atelier puis analyse' },
  en_transit_retour: { now: 'Votre pièce est en transit vers notre atelier', next: 'réception puis passage en analyse' },
  recu_atelier: { now: 'Votre pièce est bien arrivée à l\'atelier', next: 'passage en analyse technique' },
  en_analyse: { now: 'Votre pièce est en cours d\'analyse technique', next: 'rapport d\'expertise et proposition de solution' },
  analyse_terminee: { now: 'L\'analyse technique est terminée', next: 'nous revenons vers vous avec la solution' },
  en_attente_fournisseur: { now: 'Nous attendons une réponse de notre fournisseur', next: 'proposition de solution dès sa réponse' },
};
const MS_H = 3600 * 1000;

function lastOutboundAt(t) {
  const msgs = Array.isArray(t.messages) ? t.messages : [];
  for (let i = msgs.length - 1; i >= 0; i -= 1) {
    if (msgs[i] && msgs[i].canal && msgs[i].canal !== 'interne') return new Date(msgs[i].date || 0);
  }
  return new Date((t.sla && t.sla.dateOuverture) || t.createdAt || 0);
}
function lastRelation(t, kind) {
  const arr = Array.isArray(t.relationSent) ? t.relationSent : [];
  const hits = arr.filter((r) => r && r.kind === kind).map((r) => new Date(r.at).getTime());
  return hits.length ? Math.max(...hits) : 0;
}

async function runSavRelationCare() {
  const { sendEmail } = require('../services/emailService');
  let heartbeats = 0, gestes = 0;

  // 1) Heartbeat
  const actifs = await SavTicket.find({ statut: { $in: HEARTBEAT_STATUTS } });
  const now = Date.now();
  for (const t of actifs) {
    try {
      if (!t.client || !t.client.email) continue;
      const isB2B = t.client.type === 'B2B';
      const silenceMs = now - lastOutboundAt(t).getTime();
      const threshold = (isB2B ? 24 : 48) * MS_H;
      if (silenceMs < threshold) continue;
      if (now - lastRelation(t, 'heartbeat') < 48 * MS_H) continue; // anti-spam

      let guestLink = `${(process.env.SITE_URL || '').replace(/\/$/, '')}/sav/suivi`;
      try {
        const { buildGuestLink } = require('../controllers/savGuestController');
        guestLink = buildGuestLink(t) || guestLink;
      } catch (_) {}
      const info = HEARTBEAT_STEP_INFO[t.statut] || { now: 'Votre dossier est en cours de traitement', next: 'nous revenons vers vous très vite' };

      await sendEmail({
        toEmail: t.client.email,
        subject: `[SAV ${t.numero}] Où en est votre dossier — point d'étape`,
        html: `<p>Bonjour ${(t.client && t.client.nom) || ''},</p>
          <p>Petit point d'étape sur votre dossier SAV <strong>${t.numero}</strong> — personne ne vous a oublié :</p>
          <p style="margin:16px 0;padding:14px 16px;background:#f8fafc;border-left:4px solid #ec1313;border-radius:6px;">
            <strong>En ce moment :</strong> ${info.now}.<br>
            <strong>Prochaine étape :</strong> ${info.next}.
          </p>
          <p style="text-align:center;margin:20px 0;">
            <a href="${guestLink}" style="display:inline-block;padding:12px 22px;background:#ec1313;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;">Suivre mon dossier</a>
          </p>
          <p style="font-size:13px;color:#475569;">Une question entre-temps ? Répondez simplement à cet email.</p>`,
        text: `Point d'étape SAV ${t.numero} : ${info.now}. Prochaine étape : ${info.next}. Suivi : ${guestLink}`,
      });
      t.relationSent = t.relationSent || [];
      t.relationSent.push({ kind: 'heartbeat', at: new Date() });
      t.addMessage('systeme', 'interne', 'Heartbeat relationnel envoyé (silence > ' + (isB2B ? '24' : '48') + ' h)');
      await t.save();
      heartbeats += 1;
    } catch (e) { console.error('[sav-cron] heartbeat', t && t.numero, e.message); }
  }

  // 2) Rappel geste commercial J+14 après refus
  const GESTE_LABELS = {
    bon_achat: (g) => `votre bon d'achat de ${g.montant || ''} €${g.code ? ` (code ${g.code})` : ''}`,
    remise_remplacement: (g) => `votre remise de ${g.montant || ''} % sur la pièce de remplacement${g.code ? ` (code ${g.code})` : ''}`,
    prix_preferentiel: () => 'votre tarif préférentiel sur la pièce de remplacement',
    analyse_offerte: () => 'le forfait d\'analyse offert sur votre prochaine commande',
  };
  const fourteenDaysAgo = new Date(Date.now() - 14 * 24 * MS_H);
  const refusesAvecGeste = await SavTicket.find({
    statut: 'refuse',
    'resolution.gesteCommercial.type': { $in: Object.keys(GESTE_LABELS) },
    updatedAt: { $lte: fourteenDaysAgo },
  });
  for (const t of refusesAvecGeste) {
    try {
      if (!t.client || !t.client.email) continue;
      if (lastRelation(t, 'j14_geste')) continue; // une seule fois
      const g = (t.resolution && t.resolution.gesteCommercial) || {};
      const label = (GESTE_LABELS[g.type] || (() => 'votre geste commercial'))(g);
      await sendEmail({
        toEmail: t.client.email,
        subject: `[SAV ${t.numero}] ${label.charAt(0).toUpperCase() + label.slice(1)} vous attend`,
        html: `<p>Bonjour ${(t.client && t.client.nom) || ''},</p>
          <p>Suite à l'expertise de votre pièce (dossier <strong>${t.numero}</strong>), nous vous avions proposé ${label} — il est toujours valable.</p>
          <p>Si vous cherchez une pièce de remplacement, répondez à cet email ou appelez-nous : on vous trouve la bonne référence et on applique le geste directement.</p>
          <p style="font-size:13px;color:#475569;">L'équipe Autoliva — on reste à vos côtés, même quand la garantie ne s'applique pas.</p>`,
        text: `Dossier ${t.numero} : ${label} est toujours valable. Répondez à cet email pour en profiter.`,
      });
      t.relationSent = t.relationSent || [];
      t.relationSent.push({ kind: 'j14_geste', at: new Date() });
      t.addMessage('systeme', 'interne', 'Rappel geste commercial J+14 envoyé');
      await t.save();
      gestes += 1;
    } catch (e) { console.error('[sav-cron] j14geste', t && t.numero, e.message); }
  }

  console.log('[sav-cron] relation care', { heartbeats, gestes });
  return { heartbeats, gestes };
}

module.exports = {
  checkSavSlaEscalation,
  runSavDailyReminders,
  runSavAutomations,
  runSavRelationCare,
};
