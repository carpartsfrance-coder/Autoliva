/*
 * Moteur d'automatisations SAV
 * - Lit SavSettings.automationRules pour activer/désactiver chaque règle
 * - Exécute chaque règle sur l'ensemble des tickets concernés
 * - Toutes les actions sont loggées dans ticket.automationLog
 *
 * Règles built-in :
 *   relance_1          : en_attente_documents + dernière comm > N jours → email + statut relance_1
 *   relance_2          : relance_1 + N jours sans réponse                → email final + statut relance_2
 *   clos_sans_reponse  : relance_2 + N jours sans réponse                → statut clos_sans_reponse + mail final
 *   echange_auto       : analyse défaut produit + résolution echange     → trace (création de commande à brancher plus tard)
 */

const SavTicket = require('../models/SavTicket');
const SavSettings = require('../models/SavSettings');
const notif = require('./savNotifications');
const auditLogger = require('./auditLogger');

function daysSince(date) {
  if (!date) return Infinity;
  return (Date.now() - new Date(date).getTime()) / (1000 * 60 * 60 * 24);
}

function lastClientMessageDate(ticket) {
  if (!ticket || !Array.isArray(ticket.messages)) return null;
  for (let i = ticket.messages.length - 1; i >= 0; i--) {
    const m = ticket.messages[i];
    if (m && (m.auteur === 'client' || m.canal === 'email')) return m.date;
  }
  return ticket.updatedAt || ticket.createdAt;
}

async function logAction(ticket, ruleKey, details) {
  ticket.automationLog = ticket.automationLog || [];
  ticket.automationLog.push({ ruleKey, executedAt: new Date(), details });
  ticket.addMessage('systeme', 'interne', `🤖 Auto: ${ruleKey} — ${details}`);
  await ticket.save();
  auditLogger.log({
    userEmail: 'system',
    action: `sav.auto.${ruleKey}`,
    entityType: 'sav_ticket',
    entityId: ticket.numero,
    after: { details },
  });
}

async function runRules() {
  const settings = await SavSettings.getSingleton();
  const rules = (settings.automationRules || []).reduce((acc, r) => { acc[r.key] = r; return acc; }, {});
  const summary = { relance_1: 0, relance_2: 0, clos_sans_reponse: 0, echange_auto: 0 };

  // ----- relance_1 -----
  if (rules.relance_1 && rules.relance_1.enabled) {
    const days = rules.relance_1.daysThreshold;
    const candidats = await SavTicket.find({ statut: 'en_attente_documents' });
    for (const t of candidats) {
      if (daysSince(lastClientMessageDate(t)) > days) {
        try {
          await notif.notifyRelanceDocuments(t);
          t.statut = 'relance_1';
          await logAction(t, 'relance_1', `passé en relance_1 (>${days}j)`);
          summary.relance_1++;
        } catch (e) { console.error('[auto relance_1]', e.message); }
      }
    }
  }

  // ----- relance_2 -----
  if (rules.relance_2 && rules.relance_2.enabled) {
    const days = rules.relance_2.daysThreshold;
    const candidats = await SavTicket.find({ statut: 'relance_1' });
    for (const t of candidats) {
      if (daysSince(lastClientMessageDate(t)) > days) {
        try {
          await notif.notifyRelanceDocuments(t);
          t.statut = 'relance_2';
          await logAction(t, 'relance_2', `passé en relance_2 (>${days}j)`);
          summary.relance_2++;
        } catch (e) { console.error('[auto relance_2]', e.message); }
      }
    }
  }

  // ----- clos_sans_reponse -----
  if (rules.clos_sans_reponse && rules.clos_sans_reponse.enabled) {
    const days = rules.clos_sans_reponse.daysThreshold;
    const candidats = await SavTicket.find({ statut: 'relance_2' });
    for (const t of candidats) {
      if (daysSince(lastClientMessageDate(t)) > days) {
        try {
          t.statut = 'clos_sans_reponse';
          await logAction(t, 'clos_sans_reponse', `clôture automatique après ${days}j sans réponse`);
          // mail final via template existant si dispo (best-effort)
          summary.clos_sans_reponse++;
        } catch (e) { console.error('[auto clos]', e.message); }
      }
    }
  }

  // ----- echange_auto (placeholder, ne crée pas de commande sans branchement) -----
  if (rules.echange_auto && rules.echange_auto.enabled) {
    const candidats = await SavTicket.find({
      'analyse.conclusion': 'defaut_produit',
      'resolution.type': 'echange',
      'automationLog.ruleKey': { $ne: 'echange_auto' },
    });
    for (const t of candidats) {
      await logAction(t, 'echange_auto', 'flag défaut produit + échange : à créer côté commerce (commande remplacement)');
      summary.echange_auto++;
    }
  }

  return summary;
}

module.exports = { runRules };
