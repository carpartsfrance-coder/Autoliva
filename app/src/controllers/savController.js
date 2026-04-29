const Order = require('../models/Order');
const User = require('../models/User');
const SavTicket = require('../models/SavTicket');
const brand = require('../config/brand');

const baseLocals = (req) => ({
  title: `Service Après-Vente — ${brand.NAME}`,
  metaDescription:
    "Ouvrez votre demande SAV en quelques minutes. Pré-qualification rapide, retour offert, analyse banc.",
  canonicalUrl: `${brand.SITE_URL}/sav`,
  metaRobots: 'index, follow',
});

exports.getSavHome = async (req, res) => {
  const sessionUser = req.session && req.session.user;
  let eligibleOrders = [];
  if (sessionUser) {
    try {
      const cutoff = new Date(Date.now() - 24 * 30.44 * 24 * 60 * 60 * 1000);
      const orders = await Order.find({
        userId: sessionUser._id,
        createdAt: { $gte: cutoff },
        status: { $in: ['paid', 'processing', 'shipped', 'delivered', 'completed'] },
      })
        .sort({ createdAt: -1 })
        .limit(30)
        .select('number createdAt items totalCents status')
        .lean();
      eligibleOrders = orders.map((o) => {
        const items = Array.isArray(o.items) ? o.items : [];
        const first = items[0] || {};
        return {
          number: o.number,
          date: o.createdAt,
          label: items.slice(0, 2).map((i) => i.name).join(', ').slice(0, 120),
          firstItemName: first.name || '',
          firstItemImage: first.image || first.imageUrl || (Array.isArray(first.images) && first.images[0]) || '',
          itemsCount: items.length,
          totalCents: o.totalCents || 0,
          status: o.status,
        };
      });
    } catch (_) {}
  }
  res.render('sav/index', {
    ...baseLocals(req),
    currentUser: sessionUser || null,
    eligibleOrders,
  });
};

// POST /sav/check-commande — vérification d'éligibilité (étape 1)
exports.postCheckCommande = async (req, res) => {
  try {
    const email = String((req.body && req.body.email) || '').trim().toLowerCase();
    const numero = String((req.body && req.body.numeroCommande) || '').trim();
    if (!email || !numero) {
      return res.status(400).json({
        success: false,
        error: 'Email et numéro de commande sont nécessaires pour démarrer.',
      });
    }
    const user = await User.findOne({ email }).select('_id').lean();
    const order = user
      ? await Order.findOne({ number: numero, userId: user._id }).lean()
      : null;

    if (!order) {
      return res.status(404).json({
        success: false,
        error:
          `Nous n'avons pas trouvé de commande à cet email avec ce numéro. Vérifiez vos informations ou contactez-nous à ${brand.EMAIL_SAV}.`,
      });
    }

    const dateCommande = new Date(order.createdAt || order.date || Date.now());
    const ageMois = (Date.now() - dateCommande.getTime()) / (1000 * 60 * 60 * 24 * 30.44);
    if (ageMois > 24) {
      return res.status(403).json({
        success: false,
        error:
          "Cette commande dépasse la garantie légale de 24 mois. Contactez-nous directement pour étudier votre dossier.",
      });
    }

    return res.json({
      success: true,
      data: {
        numero: order.number || numero,
        dateCommande,
        ageMois: Math.round(ageMois * 10) / 10,
      },
    });
  } catch (err) {
    return res.status(500).json({
      success: false,
      error:
        `Notre service est momentanément indisponible. Réessayez dans une minute, ou écrivez-nous à ${brand.EMAIL_SAV}.`,
    });
  }
};

// ============================================================
// SÉLECTION DU MOTIF SAV (entrée principale /sav)
// ============================================================
const MOTIFS = [
  { key: 'piece_defectueuse',  icon: 'build_circle',     title: 'Pièce défectueuse',           desc: "La pièce reçue ne fonctionne pas correctement après montage.",                  legal: null,                                                            redirect: '/sav/piece-defectueuse' },
  { key: 'retard_livraison',   icon: 'schedule',         title: 'Retard de livraison',         desc: "Votre commande n'est pas arrivée dans les délais annoncés.",                    legal: null,                                                            redirect: null },
  { key: 'colis_abime',        icon: 'broken_image',     title: 'Colis reçu abîmé',            desc: "Carton ou pièce endommagés à la réception.",                                    legal: 'ℹ️ Nous sommes responsables de la livraison en bon état (art. L216-4). Signalez-nous le dommage dès que possible.', redirect: null },
  { key: 'colis_non_recu',     icon: 'local_shipping',   title: 'Colis non reçu',              desc: "Le colis est marqué livré mais introuvable, ou bloqué chez le transporteur.",  legal: null,                                                            redirect: null },
  { key: 'erreur_preparation', icon: 'swap_horiz',       title: 'Erreur de préparation',       desc: "Vous avez reçu une pièce différente de celle commandée.",                       legal: null,                                                            redirect: null },
  { key: 'retractation',       icon: 'undo',             title: 'Rétractation 14 jours',       desc: "Vous souhaitez retourner la pièce sans motif (droit légal).",                   legal: 'ℹ️ Vous avez 14 jours à compter de la réception (art. L221-18).',  redirect: null },
  { key: 'non_compatible',     icon: 'block',            title: 'Pièce non compatible',        desc: "La pièce ne correspond pas à votre véhicule.",                                  legal: null,                                                            redirect: null },
  { key: 'facture_document',   icon: 'description',      title: 'Facture / document',          desc: "Demande de facture, duplicata ou document manquant.",                            legal: null,                                                            redirect: null },
  { key: 'remboursement',      icon: 'payments',         title: 'Remboursement non reçu',      desc: "Un remboursement promis n'a pas été crédité sur votre compte.",                  legal: null,                                                            redirect: null },
  { key: 'autre',              icon: 'help',             title: 'Autre demande',               desc: "Toute autre demande qui ne rentre pas dans les catégories ci-dessus.",          legal: null,                                                            redirect: null },
];

exports.MOTIFS = MOTIFS;

exports.getMotifSelect = async (req, res) => {
  res.render('sav/motif-select', {
    ...baseLocals(req),
    title: `Quel est votre problème ? — SAV ${brand.NAME}`,
    motifs: MOTIFS,
    currentUser: req.session && req.session.user,
  });
};

exports.getSimpleForm = async (req, res) => {
  const motifKey = req.params.motif;
  const motif = MOTIFS.find((m) => m.key === motifKey);
  if (!motif) return res.redirect('/sav');
  // Pièce défectueuse → wizard complet
  if (motif.redirect) return res.redirect(motif.redirect);

  // Charger commandes éligibles si user connecté
  const sessionUser = req.session && req.session.user;
  let eligibleOrders = [];
  if (sessionUser) {
    try {
      const cutoff = new Date(Date.now() - 24 * 30.44 * 24 * 60 * 60 * 1000);
      const orders = await Order.find({
        userId: sessionUser._id,
        createdAt: { $gte: cutoff },
        status: { $in: ['paid', 'processing', 'shipped', 'delivered', 'completed'] },
      }).sort({ createdAt: -1 }).limit(30).select('number createdAt items totalCents status').lean();
      eligibleOrders = orders.map((o) => {
        const items = Array.isArray(o.items) ? o.items : [];
        return {
          number: o.number,
          date: o.createdAt,
          label: items.slice(0, 2).map((i) => i.name).join(', ').slice(0, 120),
          itemsCount: items.length,
        };
      });
    } catch (_) {}
  }

  res.render('sav/demande', {
    ...baseLocals(req),
    title: motif.title + ` — SAV ${brand.NAME}`,
    motif,
    motifKey,
    currentUser: sessionUser || null,
    eligibleOrders,
  });
};

exports.postSimpleForm = async (req, res) => {
  try {
    const b = req.body || {};
    const motifKey = String(b.motifSav || '').trim();
    const motif = MOTIFS.find((m) => m.key === motifKey);
    if (!motif || motif.key === 'piece_defectueuse') {
      return res.status(400).json({ success: false, error: 'Motif invalide.' });
    }
    const email = String(b.email || '').trim().toLowerCase();
    const nom = String(b.clientNom || '').trim() || (email ? email.split('@')[0] : '');
    const description = String(b.description || '').trim();
    const numeroCommande = String(b.numeroCommande || '').trim();
    if (!email) return res.status(400).json({ success: false, error: 'Email requis.' });
    if (!description || description.length < 10) return res.status(400).json({ success: false, error: 'Merci de décrire le problème (min. 10 caractères).' });

    const livraison = {
      transporteur: String(b.transporteur || '').trim() || undefined,
      numeroSuivi: String(b.numeroSuivi || '').trim() || undefined,
      dateReceptionPrevue: b.dateReceptionPrevue ? new Date(b.dateReceptionPrevue) : undefined,
      dateReceptionReelle: b.dateReceptionReelle ? new Date(b.dateReceptionReelle) : undefined,
      descriptionDommage: ['colis_abime', 'colis_non_recu', 'erreur_preparation'].includes(motifKey) ? description.slice(0, 2000) : undefined,
    };

    const clientIp = (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() || req.ip || '';
    const userAgent = (req.headers['user-agent'] || '').toString().slice(0, 500);

    const ticket = new SavTicket({
      motifSav: motifKey,
      numeroCommande: numeroCommande || undefined,
      client: { nom, email, telephone: String(b.telephone || '').trim() || undefined, type: 'B2C' },
      diagnostic: { description: description.slice(0, 5000) },
      livraison,
      cgvAcceptance: b.cgvAccepted ? { version: 'cgv-sav-v2-2026-04', acceptedAt: new Date(), ip: clientIp, userAgent } : undefined,
      rgpdAcceptance: b.rgpdAccepted ? { version: 'rgpd-v1-2026-04', acceptedAt: new Date(), ip: clientIp, userAgent } : undefined,
      // statut sera défini par le hook pre-save via MOTIF_CONFIG
    });
    // Définir statut initial selon motif
    const cfg = SavTicket.getMotifConfig(motifKey);
    ticket.statut = cfg.statut;
    ticket.workflow = { track: 'retour_systematique', etape: cfg.statut };

    // Note interne technique (audit) — invisible côté client
    ticket.addMessage('systeme', 'interne', `Ticket créé via formulaire court (motif : ${motif.title})`);

    // Upload des pièces jointes en MongoDB (GridFS) — aucun fichier sur disque
    const clientAttachments = [];
    if (Array.isArray(req.files) && req.files.length) {
      try {
        const savFileStorage = require('../services/savFileStorage');
        ticket.documentsList = ticket.documentsList || [];
        for (const f of req.files) {
          const stored = await savFileStorage.saveBuffer({
            buffer: f.buffer,
            filename: f.originalname,
            mime: f.mimetype,
            metadata: {
              ticketNumero: ticket.numero,
              kind: 'client_upload',
              uploadedBy: 'client',
            },
          });
          const att = {
            kind: 'client_upload',
            url: stored.url,
            originalName: f.originalname,
            size: f.size,
            mime: f.mimetype,
          };
          ticket.documentsList.push(att);
          clientAttachments.push(att);
        }
      } catch (e) {
        console.error('[sav] simple upload error', e && e.message);
      }
    }

    // Message client visible dans la conversation (motif + PJ rattachées)
    ticket.addMessage('client', 'inapp', description, clientAttachments);

    await ticket.save();

    try { require('../services/slackNotifier').notifyTicketCreated(ticket); } catch (_) {}
    try {
      const notif = require('../services/savNotifications');
      if (typeof notif.sendConfirmationToClient === 'function') {
        notif.sendConfirmationToClient(ticket).catch(() => {});
      }
    } catch (_) {}

    return res.json({ success: true, data: { numero: ticket.numero, redirect: `/sav/confirmation/${ticket.numero}` } });
  } catch (err) {
    console.error('[sav] postSimpleForm', err);
    return res.status(500).json({ success: false, error: err.message || 'Erreur serveur.' });
  }
};

// GET /sav/suivi/:numero — page de suivi
exports.getSuivi = async (req, res) => {
  const numero = req.params.numero;
  res.render('sav/suivi', {
    ...baseLocals(req),
    title: `Suivi de votre demande ${numero} — ${brand.NAME}`,
    numero,
  });
};

// GET /sav/feedback/:numero — formulaire de feedback post-résolution
exports.getFeedback = async (req, res) => {
  const numero = req.params.numero;
  const ticket = await SavTicket.findOne({ numero }).lean().catch(() => null);
  if (!ticket) {
    return res.status(404).render('sav/feedback', { ...baseLocals(req), title: 'Feedback', numero, ticket: null, completed: false, sent: false });
  }
  return res.render('sav/feedback', {
    ...baseLocals(req),
    title: `Votre avis sur le SAV ${numero}`,
    metaRobots: 'noindex, nofollow',
    numero,
    ticket,
    completed: !!(ticket.reviewFeedback && ticket.reviewFeedback.completedAt),
    sent: false,
  });
};

// POST /sav/feedback/:numero
exports.postFeedback = async (req, res) => {
  const numero = req.params.numero;
  const note = parseInt((req.body && req.body.note) || '0', 10);
  const comment = String((req.body && req.body.comment) || '').slice(0, 2000);
  const ticket = await SavTicket.findOne({ numero });
  if (!ticket) return res.status(404).redirect('/');
  ticket.reviewFeedback = ticket.reviewFeedback || {};
  ticket.reviewFeedback.note = isNaN(note) ? 0 : Math.max(0, Math.min(5, note));
  ticket.reviewFeedback.comment = comment;
  ticket.reviewFeedback.completedAt = new Date();

  let redirectGoogle = false;
  if (ticket.reviewFeedback.note >= 4) {
    redirectGoogle = true;
    ticket.reviewFeedback.redirectedToGoogle = true;
  }
  await ticket.save();

  if (redirectGoogle) {
    const SavSettings = require('../models/SavSettings');
    const s = await SavSettings.getSingleton().catch(() => null);
    const url = (s && s.integrations && s.integrations.googleReviewsUrl) || process.env.GOOGLE_REVIEWS_URL || 'https://www.google.com/search?q=carpartsfrance+avis';
    return res.redirect(url);
  }
  return res.render('sav/feedback', {
    ...baseLocals(req),
    title: 'Merci pour votre retour',
    metaRobots: 'noindex, nofollow',
    numero,
    ticket: ticket.toObject(),
    completed: true,
    sent: true,
  });
};

// Contenu de la page de confirmation par motif SAV
const MOTIF_STEPS = {
  piece_defectueuse: {
    steps: [
      "Notre équipe pré-qualifie votre dossier sous <strong>48 h ouvrées</strong>.",
      "Vous recevez un <strong>bon de retour prépayé</strong> pour nous expédier la pièce — aucun frais de votre côté.",
      "Une fois en atelier, l'analyse sur banc démarre sous 5 jours ouvrés.",
      "Vous recevez le rapport et la décision : <strong>remplacement ou remboursement gratuit</strong> si défaut confirmé.",
    ],
    faq: [
      { q: "Combien de temps dure l'analyse&nbsp;?", a: "5 jours ouvrés à compter de la réception de votre pièce à notre atelier." },
      { q: "Vais-je payer quelque chose&nbsp;?", a: "Si un défaut de conformité est confirmé : <strong>non, tout est pris en charge</strong> (garantie légale, Art. L217-11). Si l'analyse conclut à l'absence de défaut (usure, mauvaise installation) et que votre pièce est hors de la garantie légale de 2 ans : un forfait de 149 € TTC peut s'appliquer." },
      { q: "Puis-je choisir entre réparation et remplacement&nbsp;?", a: "Oui, conformément à l'Art. L217-9, vous avez le choix entre le remplacement de la pièce et le remboursement." },
    ],
  },
  colis_abime: {
    steps: [
      "Nous prenons immédiatement en charge votre dossier — <strong>nous sommes responsables de la livraison</strong> (art. L216-4).",
      "Conservez le colis et l'emballage si possible — les photos nous aident pour notre recours transporteur.",
      "Notre équipe logistique revient vers vous sous <strong>48 h ouvrées</strong> avec une proposition : remplacement ou remboursement.",
    ],
    faq: [
      { q: "Dois-je faire des réserves auprès du transporteur&nbsp;?", a: "Ce n'est pas obligatoire pour vous. Nous sommes responsables de la bonne livraison (art. L216-4). Si vous avez émis des réserves, c'est un plus pour notre dossier, mais ce n'est pas une condition." },
      { q: "Vais-je payer quelque chose&nbsp;?", a: "Non. <strong>Aucun frais n'est à votre charge</strong> pour un colis endommagé durant le transport." },
      { q: "Dois-je déposer plainte ou contacter le transporteur&nbsp;?", a: "Non, c'est <strong>notre responsabilité</strong>. Nous gérons l'enquête transporteur de notre côté." },
    ],
  },
  colis_non_recu: {
    steps: [
      "Nous ouvrons une <strong>enquête transporteur</strong> immédiatement.",
      "L'enquête prend généralement 24 à 72 h ouvrées.",
      "Dès retour du transporteur, nous vous proposons un renvoi ou un remboursement.",
    ],
    faq: [
      { q: "Combien de temps dure l'enquête&nbsp;?", a: "En moyenne 72 h ouvrées selon le transporteur." },
    ],
  },
  retard_livraison: {
    steps: [
      "Nous interrogeons le transporteur pour localiser votre colis.",
      "Vous recevez un retour sous <strong>24 h ouvrées</strong>.",
    ],
    faq: [
      { q: "Serai-je remboursé&nbsp;?", a: "Si le colis est perdu, oui. S'il est en retard mais livrable, nous patientons." },
    ],
  },
  erreur_preparation: {
    steps: [
      "Nous vérifions votre commande et la pièce reçue.",
      "Nous revenons vers vous sous <strong>48 h ouvrées</strong> avec la solution (renvoi de la bonne pièce, retour gratuit).",
      "Aucun frais n'est à votre charge.",
    ],
    faq: [
      { q: "Qui paie le retour&nbsp;?", a: "Nous. Un bon de retour prépayé vous sera envoyé." },
    ],
  },
  retractation: {
    steps: [
      "Votre rétractation est enregistrée (délai légal : <strong>14 jours</strong> à compter de la réception, art. L221-18).",
      "Vous recevez les instructions de retour sous 24 h ouvrées.",
      "Le <strong>remboursement</strong> (prix de la pièce + frais de livraison initiale au tarif standard) est effectué sous <strong>14 jours</strong> après réception de la pièce en retour.",
    ],
    faq: [
      { q: "Qui paie le retour&nbsp;?", a: "Conformément à l'art. L221-23 et comme indiqué dans nos CGV, les frais de retour sont à la charge du client en cas de rétractation." },
      { q: "La pièce doit-elle être dans son emballage d'origine&nbsp;?", a: "La pièce doit être non montée et en bon état. L'emballage d'origine n'est pas obligatoire, mais nous vous demandons un emballage protecteur." },
      { q: "Que se passe-t-il si la pièce a été montée&nbsp;?", a: "Nous acceptons le retour, mais une dépréciation proportionnelle à l'utilisation pourra être déduite du remboursement (art. L221-23)." },
    ],
  },
  non_compatible: {
    steps: [
      "Notre équipe vérifie la compatibilité avec votre véhicule (VIN + référence constructeur).",
      "Vous recevez un retour sous <strong>5 jours ouvrés</strong> avec la solution : échange ou remboursement.",
    ],
    faq: [
      { q: "Que se passe-t-il si la pièce n'est pas compatible&nbsp;?", a: "Si l'erreur vient de notre fiche produit : <strong>retour gratuit + échange ou remboursement</strong> (défaut de conformité). Si l'erreur vient de votre sélection : retour possible dans le cadre de la rétractation 14 jours." },
      { q: "Qui paie le retour&nbsp;?", a: "Si l'incompatibilité est de notre fait : nous. Si c'est une erreur de commande de votre part : frais à votre charge (rétractation)." },
    ],
  },
  facture_document: {
    steps: [
      "Notre service compta traite votre demande sous <strong>24 h ouvrées</strong>.",
      "Vous recevez le document par email.",
    ],
    faq: [],
  },
  remboursement: {
    steps: [
      "Notre service compta étudie votre demande sous <strong>48 h ouvrées</strong>.",
      "Vous êtes informé par email de la suite donnée.",
    ],
    faq: [],
  },
  autre: {
    steps: [
      "Notre équipe SAV prend connaissance de votre message.",
      "Vous recevez une réponse sous <strong>48 h ouvrées</strong>.",
    ],
    faq: [],
  },
};

const STATUT_LABELS = {
  ouvert: 'Ouvert',
  pre_qualification: 'En pré-qualification',
  en_attente_documents: 'En attente de vos documents',
  retour_demande: 'Retour demandé',
  en_transit_retour: 'En transit retour',
  recu_atelier: 'Reçu à l\'atelier',
  en_analyse: 'En analyse',
  analyse_terminee: 'Analyse terminée',
  en_attente_decision_client: 'En attente de votre décision',
  en_attente_fournisseur: 'En attente fournisseur',
  remboursement_initie: 'Remboursement initié',
  resolu_garantie: 'Résolu (garantie)',
  resolu_facture: 'Résolu (facturé)',
  clos: 'Clos',
  refuse: 'Refusé',
  reserve_transporteur: 'Réserve transporteur enregistrée',
  enquete_transporteur: 'Enquête transporteur en cours',
  retractation_recue: 'Rétractation reçue',
};

// GET /sav/confirmation/:numero — page de confirmation post-création
exports.getConfirmation = async (req, res) => {
  const numero = req.params.numero;
  let ticket = null;
  try {
    ticket = await SavTicket.findOne({ numero }).lean();
  } catch (_) {}
  if (!ticket) {
    return res.status(404).render('sav/confirmation', {
      ...baseLocals(req),
      title: 'Confirmation introuvable',
      numero,
      ticket: null,
      currentUser: req.session && req.session.user,
    });
  }
  const motifKey = ticket.motifSav || 'autre';
  const motifSteps = MOTIF_STEPS[motifKey] || MOTIF_STEPS.autre;
  const statutLabel = STATUT_LABELS[ticket.statut] || ticket.statut;
  res.render('sav/confirmation', {
    ...baseLocals(req),
    title: `Confirmation de votre demande ${numero} — ${brand.NAME}`,
    metaRobots: 'noindex, nofollow',
    numero,
    ticket,
    motifSteps,
    statutLabel,
    currentUser: req.session && req.session.user,
  });
};
