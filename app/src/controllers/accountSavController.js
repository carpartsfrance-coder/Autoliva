/*
 * /compte/sav* — Pages SAV pour le client connecté.
 * - Liste des dossiers SAV liés à l'email du compte
 * - Détail timeline en lecture seule (style suivi colis)
 * - Ajout de message public
 * - Export et suppression RGPD
 */

const SavTicket = require('../models/SavTicket');
const savFileStorage = require('../services/savFileStorage');
const brand = require('../config/brand');

async function saveAttachments(numero, files) {
  if (!files || !files.length) return [];
  const out = [];
  for (const f of files) {
    try {
      const stored = await savFileStorage.saveBuffer({
        buffer: f.buffer,
        filename: f.originalname,
        mime: f.mimetype,
        metadata: { ticketNumero: numero, kind: 'client_message', uploadedBy: 'client' },
      });
      out.push({
        kind: 'client_message',
        url: stored.url,
        originalName: f.originalname,
        size: f.size,
        mime: f.mimetype,
      });
    } catch (e) {
      console.error('[compte/sav] saveAttachments', e && e.message);
    }
  }
  return out;
}

const STATUTS_LABELS = {
  ouvert: ['Ouvert', 'bg-sky-100 text-sky-800'],
  pre_qualification: ['En pré-qualification', 'bg-sky-100 text-sky-800'],
  en_attente_documents: ['Documents attendus', 'bg-amber-100 text-amber-800'],
  retour_demande: ['Retour demandé', 'bg-violet-100 text-violet-800'],
  en_transit_retour: ['En transit', 'bg-violet-100 text-violet-800'],
  recu_atelier: ['Reçu atelier', 'bg-violet-100 text-violet-800'],
  en_analyse: ['En analyse', 'bg-violet-100 text-violet-800'],
  analyse_terminee: ['Analyse terminée', 'bg-emerald-100 text-emerald-800'],
  en_attente_decision_client: ['Décision attendue', 'bg-amber-100 text-amber-800'],
  resolu_garantie: ['Résolu (garantie)', 'bg-emerald-100 text-emerald-800'],
  resolu_facture: ['Résolu (facturé)', 'bg-emerald-100 text-emerald-800'],
  clos: ['Clos', 'bg-slate-100 text-slate-700'],
  refuse: ['Refusé', 'bg-red-100 text-red-700'],
};

exports.STATUTS_LABELS = STATUTS_LABELS;

const STATUS_GROUPS = {
  ouverts: ['ouvert', 'pre_qualification', 'en_attente_documents', 'retour_demande', 'en_transit_retour', 'recu_atelier', 'en_analyse', 'en_attente_decision_client'],
  clos: ['clos', 'clos_sans_reponse', 'refuse', 'resolu_garantie', 'resolu_facture'],
};

exports.getSavList = async (req, res) => {
  const user = req.session.user;
  const filter = String(req.query.filter || 'tous');
  const q = { 'client.email': (user.email || '').toLowerCase() };
  if (STATUS_GROUPS[filter]) q.statut = { $in: STATUS_GROUPS[filter] };
  let tickets = [];
  try {
    tickets = await SavTicket.find(q).sort({ createdAt: -1 }).limit(50).lean();
  } catch (e) {
    console.error('[compte/sav] list', e.message);
  }
  res.render('account/sav', {
    title: `Mes demandes SAV — ${brand.NAME}`,
    metaRobots: 'noindex, nofollow',
    currentUser: user,
    tickets,
    STATUTS_LABELS,
    filter,
  });
};

exports.getSavDetail = async (req, res) => {
  const user = req.session.user;
  const numero = req.params.numero;
  let ticket = null;
  try {
    ticket = await SavTicket.findOne({
      numero,
      'client.email': (user.email || '').toLowerCase(),
    }).lean();
    if (ticket) {
      SavTicket.updateOne({ _id: ticket._id }, { $set: { lastClientReadAt: new Date() } }).catch(() => {});
    }
  } catch (e) {
    console.error('[compte/sav] detail', e.message);
  }
  res.render('account/sav-detail', {
    title: ticket ? `SAV ${ticket.numero} — ${brand.NAME}` : 'SAV introuvable',
    metaRobots: 'noindex, nofollow',
    currentUser: user,
    ticket,
    STATUTS_LABELS,
    sent: req.query.sent === '1',
    error: req.query.error || null,
  });
};

// POST /compte/sav/:numero/messages — message client (canal email, marqué public)
exports.postSavMessage = async (req, res) => {
  const user = req.session.user;
  const numero = req.params.numero;
  const contenu = String((req.body && req.body.contenu) || '').trim();
  if (!contenu) return res.redirect(`/compte/sav/${encodeURIComponent(numero)}?error=empty`);
  try {
    const ticket = await SavTicket.findOne({
      numero,
      'client.email': (user.email || '').toLowerCase(),
    });
    if (!ticket) return res.status(404).redirect('/compte/sav?error=notfound');
    // Pièces jointes
    const saved = await saveAttachments(numero, req.files || []);
    if (saved.length) {
      ticket.documentsList = ticket.documentsList || [];
      saved.forEach((d) => ticket.documentsList.push(d));
    }
    const finalContenu = saved.length
      ? `${contenu}\n\n📎 ${saved.length} pièce(s) jointe(s) :\n${saved.map((d) => '• ' + d.originalName).join('\n')}`
      : contenu;
    ticket.addMessage('client', 'inapp', finalContenu);
    await ticket.save();

    // Notif équipe SAV (fire-and-forget)
    try {
      const { sendEmail } = require('../services/emailService');
      const to = process.env.SAV_INTERNAL_EMAIL || 'carparts.france@gmail.com';
      const link = `${process.env.PUBLIC_URL || brand.SITE_URL}/admin/sav/tickets/${ticket.numero}`;
      sendEmail({
        toEmail: to,
        subject: `[SAV] Nouvelle réponse client — ${ticket.numero}`,
        html: `<p>Nouvelle réponse de <strong>${user.email}</strong> sur le ticket <strong>${ticket.numero}</strong>.</p><blockquote>${contenu.replace(/</g, '&lt;')}</blockquote><p><a href="${link}">Ouvrir le ticket</a></p>`,
        text: `Nouvelle réponse client sur ${ticket.numero} : ${contenu}`,
      }).catch(() => {});
    } catch (_) {}

    return res.redirect(`/compte/sav/${encodeURIComponent(numero)}?sent=1`);
  } catch (e) {
    console.error('[compte/sav] postMessage', e.message);
    return res.redirect(`/compte/sav/${encodeURIComponent(numero)}?error=server`);
  }
};

// GET /compte/rgpd — page d'information RGPD + actions export/suppression
exports.getRgpdPage = async (req, res) => {
  const user = req.session.user;
  let count = 0;
  try { count = await SavTicket.countDocuments({ 'client.email': (user.email || '').toLowerCase() }); }
  catch (_) {}
  res.render('account/rgpd', {
    title: `Mes données personnelles (RGPD) — ${brand.NAME}`,
    metaRobots: 'noindex, nofollow',
    currentUser: user,
    savCount: count,
    exportedAt: req.query.exported || null,
    deleted: req.query.deleted || null,
  });
};

// GET /compte/rgpd/export.json — export JSON de toutes les données SAV du client
exports.getRgpdExport = async (req, res) => {
  const user = req.session.user;
  try {
    const tickets = await SavTicket.find({ 'client.email': (user.email || '').toLowerCase() }).lean();
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename="export-rgpd-sav-${(user.email || 'user').replace(/[^a-z0-9.]/gi, '_')}.json"`
    );
    return res.end(JSON.stringify({
      generatedAt: new Date().toISOString(),
      account: { email: user.email, firstName: user.firstName, lastName: user.lastName },
      sav: tickets,
    }, null, 2));
  } catch (e) {
    console.error('[compte/rgpd] export', e.message);
    return res.status(500).send('Erreur export RGPD');
  }
};

// POST /compte/rgpd/supprimer-sav — anonymise les données SAV du client
exports.postRgpdDeleteSav = async (req, res) => {
  const user = req.session.user;
  const confirm = String((req.body && req.body.confirm) || '').trim().toLowerCase();
  if (confirm !== 'supprimer') return res.redirect('/compte/rgpd?error=confirm');
  try {
    // Anonymisation : on garde le ticket pour comptabilité mais on retire les PII
    await SavTicket.updateMany(
      { 'client.email': (user.email || '').toLowerCase() },
      {
        $set: {
          'client.nom': 'Anonyme',
          'client.email': `anonymise+${Date.now()}@local`,
          'client.telephone': '',
          'client.adresse': '',
          'cgvAcceptance.ip': '',
          'cgvAcceptance.userAgent': '',
          'rgpdAcceptance.ip': '',
          'rgpdAcceptance.userAgent': '',
        },
      }
    );
    return res.redirect('/compte/rgpd?deleted=1');
  } catch (e) {
    console.error('[compte/rgpd] delete', e.message);
    return res.redirect('/compte/rgpd?error=server');
  }
};
