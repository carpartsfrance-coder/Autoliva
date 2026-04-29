/*
 * SAV — Service de notifications
 * Templates : views/emails/sav/*.ejs
 * Envoi : réutilise emailService.sendEmail (MailerSend)
 * Hook : déclenché depuis SavTicket via savNotifications.notifyStatusChange()
 * Logs : logs/sav-emails.log
 */

const fs = require('fs');
const path = require('path');
const ejs = require('ejs');

const { sendEmail } = require('./emailService');
const { buildGuestLink } = require('../controllers/savGuestController');
const brand = require('../config/brand');

const LOG_DIR = path.join(__dirname, '..', '..', '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'sav-emails.log');
const TEMPLATES_DIR = path.join(__dirname, '..', 'views', 'emails', 'sav');
const INTERNAL_NOTIFY = process.env.SAV_INTERNAL_EMAIL || 'carparts.france@gmail.com';

function ensureLogDir() {
  try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}
}
ensureLogDir();

function savReplyTo() {
  return brand.EMAIL_SAV ? { email: brand.EMAIL_SAV, name: brand.NAME } : null;
}

function log(line) {
  try {
    fs.appendFile(LOG_FILE, `${new Date().toISOString()} ${line}\n`, () => {});
  } catch (_) {}
}

async function renderTemplate(name, data) {
  const file = path.join(TEMPLATES_DIR, `${name}.ejs`);
  if (!fs.existsSync(file)) {
    throw new Error(`Template SAV introuvable : ${name}`);
  }
  return ejs.renderFile(file, { brand, ...(data || {}) });
}

// ============================================================
// Mapping statut → template + sujet
// ============================================================

// Contenu générique (template statut_update.ejs) pour les statuts
// logistique / commercial / compta qui ne passent pas par le flow DSG.
function genericExtra(heading, intro, bullets) {
  return { heading, intro, bullets: bullets || [] };
}

const STATUT_TO_TEMPLATE = {
  // ----- Flow DSG / mécatronique (templates dédiés) -----
  // `ouvert` est utilisé par plusieurs motifs non-DSG → template générique neutre.
  ouvert: {
    template: 'statut_update',
    subject: (t) => `Votre demande SAV ${t.numero} est enregistrée`,
    extra: () => genericExtra(
      'Votre demande SAV est bien enregistrée.',
      "Notre équipe prend votre dossier en charge et revient vers vous rapidement.",
      ["Vous serez notifié à chaque évolution de votre dossier."]
    ),
  },
  // `pre_qualification` = flow DSG uniquement (pièce défectueuse sur banc).
  pre_qualification: { template: 'ticket_cree', subject: (t) => `Votre demande SAV ${t.numero} est enregistrée` },
  en_attente_documents: { template: 'documents_recus', subject: () => 'Documents bien reçus' },
  recu_atelier: { template: 'piece_recue_atelier', subject: () => 'Votre pièce est arrivée à notre atelier' },
  en_analyse: { template: 'analyse_en_cours', subject: () => 'Votre pièce est sur notre banc d\'analyse' },
  resolu_garantie: { template: 'analyse_defaut_produit', subject: () => 'Bonne nouvelle : défaut produit confirmé' },
  resolu_facture: { template: 'analyse_pas_de_defaut', subject: () => 'Rapport d\'analyse de votre pièce' },

  // ----- Flow logistique / transporteur -----
  reserve_transporteur: {
    template: 'statut_update',
    subject: (t) => `Réserve transporteur enregistrée — ${t.numero}`,
    extra: () => genericExtra(
      'Votre réserve transporteur est bien enregistrée.',
      "Nous avons pris en compte votre déclaration de colis endommagé. Une enquête est ouverte auprès du transporteur.",
      [
        "Conservez le colis, l'emballage et les photos — nous pouvons vous les redemander.",
        "Notre équipe logistique revient vers vous sous <strong>48 h ouvrées</strong>.",
        "Aucun frais n'est à votre charge pour un colis endommagé au transport.",
      ]
    ),
  },
  enquete_transporteur: {
    template: 'statut_update',
    subject: (t) => `Enquête transporteur en cours — ${t.numero}`,
    extra: () => genericExtra(
      'Enquête transporteur ouverte.',
      "Nous avons interrogé le transporteur pour localiser votre colis.",
      [
        "L'enquête prend généralement <strong>24 à 72 h ouvrées</strong>.",
        "Dès son retour, nous vous proposerons un renvoi ou un remboursement.",
        "Aucun frais à votre charge.",
      ]
    ),
  },

  // ----- Flow commercial -----
  retractation_recue: {
    template: 'statut_update',
    subject: (t) => `Rétractation enregistrée — ${t.numero}`,
    extra: () => genericExtra(
      'Votre rétractation est enregistrée.',
      "Vous disposez de 14 jours pour nous retourner la pièce dans son emballage d'origine.",
      [
        "Vous recevez les instructions de retour sous <strong>24 h ouvrées</strong>.",
        "Les frais de retour sont à la charge du client en cas de rétractation.",
        "Le remboursement intervient sous 14 jours après réception.",
      ]
    ),
  },

  // ----- Flow générique de transition -----
  retour_demande: {
    template: 'statut_update',
    subject: (t) => `Retour demandé — ${t.numero}`,
    extra: () => genericExtra(
      'Nous vous invitons à nous retourner la pièce.',
      "Vous allez recevoir (ou avez déjà reçu) un bon de retour prépayé par email.",
      [
        "Imprimez l'étiquette et collez-la sur le colis.",
        "Déposez le colis au point relais indiqué.",
        "Suivez l'acheminement depuis votre espace suivi.",
      ]
    ),
  },
  en_transit_retour: {
    template: 'statut_update',
    subject: (t) => `Votre colis est en transit — ${t.numero}`,
    extra: () => genericExtra(
      'Votre retour est en cours d\'acheminement.',
      "Nous attendons la réception de votre colis par nos équipes.",
      ["Vous serez notifié dès l'arrivée à destination."]
    ),
  },
  analyse_terminee: {
    template: 'statut_update',
    subject: (t) => `Analyse terminée — ${t.numero}`,
    extra: () => genericExtra(
      'Votre dossier a été analysé.',
      "Notre équipe revient vers vous très prochainement avec la conclusion et les options possibles.",
      []
    ),
  },
  en_attente_decision_client: {
    template: 'statut_update',
    subject: (t) => `Votre décision est attendue — ${t.numero}`,
    extra: () => genericExtra(
      'Nous attendons votre décision.',
      "Plusieurs options vous ont été proposées pour votre dossier. Merci de nous confirmer votre choix.",
      ["Connectez-vous à votre espace client pour valider votre choix."]
    ),
  },
  en_attente_fournisseur: {
    template: 'statut_update',
    subject: (t) => `En attente de notre fournisseur — ${t.numero}`,
    extra: () => genericExtra(
      'Nous avons interpellé notre fournisseur.',
      "Votre dossier est transmis à notre fournisseur. Nous revenons vers vous dès sa réponse.",
      []
    ),
  },
  remboursement_initie: {
    template: 'statut_update',
    subject: (t) => `Votre remboursement est lancé — ${t.numero}`,
    extra: () => genericExtra(
      'Votre remboursement a été initié.',
      "Le virement est en cours de traitement par notre service comptabilité.",
      [
        "Délai habituel : <strong>3 à 5 jours ouvrés</strong> selon votre banque.",
        "Vous recevrez un avis de remboursement dès finalisation.",
      ]
    ),
  },
  clos: {
    template: 'statut_update',
    subject: (t) => `Votre dossier ${t.numero} est clos`,
    extra: () => genericExtra(
      'Votre dossier SAV est désormais clôturé.',
      "Merci de votre confiance. Si vous avez des questions, connectez-vous à votre espace client.",
      []
    ),
  },
  refuse: {
    template: 'statut_update',
    subject: (t) => `Votre demande ${t.numero} n'a pas pu être retenue`,
    extra: () => genericExtra(
      'Votre demande n\'a pas pu être retenue.',
      "Vous recevrez les motifs détaillés dans un email de notre équipe.",
      []
    ),
  },
};

// ============================================================
// Send helpers
// ============================================================

async function sendForTicket(ticket, templateKey, extra) {
  if (!ticket || !ticket.client || !ticket.client.email) {
    log(`SKIP ${templateKey} ${ticket && ticket.numero} (pas d'email client)`);
    return { ok: false, reason: 'no_email' };
  }
  const cfg = STATUT_TO_TEMPLATE[templateKey] || { template: templateKey, subject: () => 'Suivi de votre demande SAV' };
  try {
    const cfgExtra = (typeof cfg.extra === 'function') ? (cfg.extra(ticket) || {}) : (cfg.extra || {});
    const guestLink = buildGuestLink(ticket) || ((brand.SITE_URL).replace(/\/$/, '') + '/sav/suivi');
    const html = await renderTemplate(cfg.template, { ticket, guestLink, ...cfgExtra, ...(extra || {}) });
    const subject = typeof cfg.subject === 'function' ? cfg.subject(ticket) : cfg.subject;
    const res = await sendEmail({ toEmail: ticket.client.email, subject, html, text: stripHtml(html), replyTo: savReplyTo() });
    log(`SEND ${cfg.template} → ${ticket.client.email} ticket=${ticket.numero} ok=${!!(res && res.ok)}`);
    return res;
  } catch (err) {
    log(`ERROR ${templateKey} ticket=${ticket && ticket.numero} ${err.message}`);
    return { ok: false, reason: 'render_error', error: err.message };
  }
}

function stripHtml(html) {
  return String(html || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

// ============================================================
// API publique
// ============================================================

async function notifyTicketCreated(ticket) {
  return sendForTicket(ticket, 'pre_qualification');
}

async function notifyStatusChange(ticket, nouveauStatut) {
  // Hook satisfaction : à la clôture, marque sentAt et envoie l'email NPS
  const CLOTURE = ['clos', 'resolu_garantie', 'resolu_facture'];
  if (CLOTURE.includes(nouveauStatut) && ticket && (!ticket.reviewFeedback || !ticket.reviewFeedback.sentAt)) {
    try {
      ticket.reviewFeedback = ticket.reviewFeedback || {};
      ticket.reviewFeedback.sentAt = new Date();
      const subject = `Votre avis sur le SAV ${brand.NAME} — ${ticket.numero}`;
      const baseUrl = process.env.PUBLIC_URL || brand.SITE_URL;
      const link = (n) => `${baseUrl}/sav/satisfaction/${ticket.numero}?note=${n}`;
      const html = `
        <p>Bonjour ${(ticket.client && ticket.client.nom) || ''},</p>
        <p>Votre dossier SAV <strong>${ticket.numero}</strong> est désormais clôturé.</p>
        <p>Comment évalueriez-vous notre prise en charge ?</p>
        <p style="text-align:center;font-size:24px;">
          <a href="${link(1)}">😞</a> &nbsp;
          <a href="${link(2)}">😕</a> &nbsp;
          <a href="${link(3)}">😐</a> &nbsp;
          <a href="${link(4)}">🙂</a> &nbsp;
          <a href="${link(5)}">😄</a>
        </p>
        <p style="text-align:center;color:#64748b;font-size:12px;">1 = Très insatisfait · 5 = Très satisfait</p>
        <p>Merci pour votre retour, il nous aide à progresser.</p>
        <p>L'équipe SAV ${brand.NAME}</p>
      `;
      sendEmail({ toEmail: ticket.client && ticket.client.email, subject, html, text: stripHtml(html), replyTo: savReplyTo() }).catch(() => {});
      log(`SEND satisfaction → ${ticket.client && ticket.client.email} ticket=${ticket.numero}`);
    } catch (e) {
      log(`ERROR satisfaction ticket=${ticket && ticket.numero} ${e.message}`);
    }
  }
  if (!STATUT_TO_TEMPLATE[nouveauStatut]) {
    log(`NOOP statut=${nouveauStatut} ticket=${ticket && ticket.numero} (pas de template)`);
    return { ok: false, reason: 'no_template' };
  }
  return sendForTicket(ticket, nouveauStatut);
}

async function notifyRelancePaiement(ticket, jour) {
  const map = { 7: 'relance_paiement_j7', 15: 'mise_en_demeure_j15' };
  const tpl = map[jour] || 'relance_paiement_j7';
  try {
    const html = await renderTemplate(tpl, { ticket });
    const subject = jour === 15
      ? `Mise en demeure — Facture ${ticket.numero}`
      : `Relance — Facture analyse ${ticket.numero}`;
    const res = await sendEmail({ toEmail: ticket.client.email, subject, html, text: stripHtml(html), replyTo: savReplyTo() });
    log(`SEND ${tpl} → ${ticket.client.email} ticket=${ticket.numero}`);
    return res;
  } catch (err) {
    log(`ERROR ${tpl} ticket=${ticket && ticket.numero} ${err.message}`);
    return { ok: false, error: err.message };
  }
}

async function notifyRelanceDocuments(ticket) {
  try {
    const html = await renderTemplate('relance_documents', { ticket });
    const res = await sendEmail({
      toEmail: ticket.client.email,
      subject: `Documents manquants — Demande ${ticket.numero}`,
      html, text: stripHtml(html),
      replyTo: savReplyTo(),
    });
    log(`SEND relance_documents → ${ticket.client.email} ticket=${ticket.numero}`);
    return res;
  } catch (err) {
    log(`ERROR relance_documents ticket=${ticket && ticket.numero} ${err.message}`);
    return { ok: false, error: err.message };
  }
}

async function notifyInternalEscalation(ticket, motif) {
  try {
    const html = `
      <p>Escalade automatique SAV.</p>
      <ul>
        <li><strong>Ticket :</strong> ${ticket.numero}</li>
        <li><strong>Statut :</strong> ${ticket.statut}</li>
        <li><strong>Client :</strong> ${ticket.client && ticket.client.email}</li>
        <li><strong>Motif :</strong> ${motif}</li>
        <li><strong>SLA limite :</strong> ${ticket.sla && ticket.sla.dateLimite}</li>
      </ul>
      <p><a href="${process.env.SITE_URL || ''}/admin/sav/tickets/${ticket.numero}">Ouvrir le ticket</a></p>
    `;
    const res = await sendEmail({
      toEmail: INTERNAL_NOTIFY,
      subject: `[SAV escalade] ${ticket.numero} — ${motif}`,
      html, text: stripHtml(html),
    });
    log(`SEND escalade → ${INTERNAL_NOTIFY} ticket=${ticket.numero} motif=${motif}`);
    return res;
  } catch (err) {
    log(`ERROR escalade ticket=${ticket && ticket.numero} ${err.message}`);
    return { ok: false, error: err.message };
  }
}

// ============================================================
// Confirmation client (post-création) avec PDF CGV horodaté joint
// ============================================================
// Sujet + intro adaptés selon motifSav
const MOTIF_SUBJECTS = {
  piece_defectueuse:  { subject: 'Votre demande SAV {n} est enregistrée — Pièce défectueuse', sla: 'Notre atelier vous répondra sous 5 jours ouvrés.' },
  retard_livraison:   { subject: 'Demande {n} reçue — Retard de livraison',                   sla: 'Notre équipe logistique vous répond sous 24 h.' },
  colis_abime:        { subject: '⚠️ Demande {n} reçue — Réserve colis abîmé',                sla: 'Réserve enregistrée. Notre équipe logistique vous répond sous 48 h.' },
  colis_non_recu:     { subject: 'Demande {n} reçue — Colis non reçu',                        sla: 'Une enquête transporteur est ouverte. Réponse sous 72 h.' },
  erreur_preparation: { subject: 'Demande {n} reçue — Erreur de préparation',                 sla: "Désolé pour l'erreur. Réponse logistique sous 48 h." },
  retractation:       { subject: 'Demande {n} reçue — Rétractation 14 jours',                 sla: 'Votre demande de rétractation est enregistrée. Réponse sous 14 jours.' },
  non_compatible:     { subject: 'Demande {n} reçue — Pièce non compatible',                  sla: 'Notre équipe commerciale vous répond sous 5 jours ouvrés.' },
  facture_document:   { subject: 'Demande {n} reçue — Facture / document',                    sla: 'Notre service comptabilité vous répond sous 24 h.' },
  remboursement:      { subject: 'Demande {n} reçue — Remboursement',                         sla: 'Notre service comptabilité vous répond sous 48 h.' },
  autre:              { subject: 'Votre demande SAV {n} est enregistrée',                     sla: 'Notre équipe SAV vous répond sous 48 h.' },
};

async function sendConfirmationToClient(ticket) {
  if (!ticket || !ticket.client || !ticket.client.email) {
    return { ok: false, reason: 'no_email' };
  }
  try {
    const motifInfo = MOTIF_SUBJECTS[ticket.motifSav] || MOTIF_SUBJECTS.piece_defectueuse;
    const guestLink = buildGuestLink(ticket) || ((brand.SITE_URL).replace(/\/$/, '') + '/sav/suivi');
    const html = await renderTemplate('confirmation_client', { ticket, guestLink, motifIntro: motifInfo.sla });
    const subject = motifInfo.subject.replace('{n}', ticket.numero);
    const attachments = [];
    // Joindre le PDF d'acceptation CGV s'il existe (créé juste avant l'envoi)
    try {
      const cgvPdf = require('./savCgvPdf');
      const buf = await cgvPdf.getCgvAcceptanceBuffer(ticket);
      if (buf && buf.length) {
        attachments.push({
          filename: `Acceptation-CGV-SAV-${ticket.numero}.pdf`,
          content: buf.toString('base64'),
          disposition: 'attachment',
        });
      }
    } catch (e) {
      log(`WARN cgv pdf attach ticket=${ticket.numero} ${e.message}`);
    }
    const res = await sendEmail({
      toEmail: ticket.client.email,
      subject,
      html,
      text: stripHtml(html),
      attachments,
      replyTo: savReplyTo(),
    });
    log(`SEND confirmation_client → ${ticket.client.email} ticket=${ticket.numero} ok=${!!(res && res.ok)} attach=${attachments.length}`);
    return res;
  } catch (err) {
    log(`ERROR confirmation_client ticket=${ticket && ticket.numero} ${err.message}`);
    return { ok: false, error: err.message };
  }
}

module.exports = {
  notifyTicketCreated,
  notifyStatusChange,
  notifyRelancePaiement,
  notifyRelanceDocuments,
  notifyInternalEscalation,
  sendConfirmationToClient,
  STATUT_TO_TEMPLATE,
};
