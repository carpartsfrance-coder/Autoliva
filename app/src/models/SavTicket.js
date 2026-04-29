const mongoose = require('mongoose');

const PIECE_TYPES = [
  // Catégories simplifiées côté client (nouvelles)
  'mecatronique',
  'boite_vitesses',
  'moteur',
  'arbre_transmission',
  'visco_coupleur',
  'turbo',
  'injecteur',
  // Catégories existantes
  'boite_transfert',
  'pont',
  'differentiel',
  'haldex',
  'reducteur',
  'cardan',
  'autre',
  // Legacy (anciens tickets — on les conserve pour compat)
  'mecatronique_dq200',
  'mecatronique_dq250',
  'mecatronique_dq381',
  'mecatronique_dq500',
];

const MOTIFS_SAV = [
  'piece_defectueuse',
  'retard_livraison',
  'colis_abime',
  'colis_non_recu',
  'erreur_preparation',
  'retractation',
  'non_compatible',
  'facture_document',
  'remboursement',
  'autre',
];

const TEAMS = ['atelier', 'logistique', 'commercial', 'compta', 'sav_general'];

const STATUTS = [
  'ouvert',
  'pre_qualification',
  'enquete_transporteur',
  'reserve_transporteur',
  'retractation_recue',
  'echange_en_cours',
  'remboursement_initie',
  'en_attente_documents',
  'relance_1',
  'relance_2',
  'clos_sans_reponse',
  'retour_demande',
  'en_transit_retour',
  'recu_atelier',
  'en_analyse',
  'analyse_terminee',
  'en_attente_decision_client',
  'en_attente_fournisseur',
  'resolu_garantie',
  'resolu_facture',
  'clos',
  'refuse',
];

const messageAttachmentSchema = new mongoose.Schema(
  {
    url: { type: String, required: true },
    originalName: { type: String, default: '' },
    size: { type: Number, default: 0 },
    mime: { type: String, default: '' },
    kind: { type: String, default: '' },
  },
  { _id: false }
);

const messageSchema = new mongoose.Schema(
  {
    date: { type: Date, default: Date.now },
    auteur: { type: String, required: true },
    canal: {
      type: String,
      enum: ['email', 'whatsapp', 'tel', 'interne', 'inapp'],
      required: true,
    },
    contenu: { type: String, required: true },
    attachments: { type: [messageAttachmentSchema], default: [] },
    // Modification admin (champs absents = jamais édité)
    editedAt: { type: Date },
    editedBy: { type: String },
  },
  { _id: true }
);

const savTicketSchema = new mongoose.Schema(
  {
    numero: { type: String, unique: true, index: true },

    // Motif du SAV (ajouté 2026-04, défaut rétro-compat)
    motifSav: { type: String, enum: MOTIFS_SAV, default: 'piece_defectueuse', index: true },
    // Équipe en charge (auto-routing par motif)
    assignedTeam: { type: String, enum: TEAMS, default: 'atelier', index: true },

    // Données spécifiques aux motifs livraison/colis
    livraison: {
      transporteur: { type: String, trim: true },
      numeroSuivi: { type: String, trim: true },
      dateReceptionPrevue: { type: Date },
      dateReceptionReelle: { type: Date },
      descriptionDommage: { type: String, trim: true },
    },

    pieceType: { type: String, enum: PIECE_TYPES },
    referencePiece: { type: String, trim: true },
    numeroSerie: { type: String, trim: true },
    dateAchat: { type: Date },
    numeroCommande: { type: String, trim: true, index: true },

    vehicule: {
      marque: { type: String, trim: true },
      modele: { type: String, trim: true },
      annee: { type: Number, min: 1980, max: 2100 },
      motorisation: { type: String, trim: true },
      boite: { type: String, trim: true },
      vin: { type: String, trim: true, uppercase: true, index: true },
      immatriculation: { type: String, trim: true, uppercase: true },
      kilometrage: { type: Number, min: 0 },
      // True si confirmé par lookup externe (skip pour l'instant — toujours false)
      verifie: { type: Boolean, default: false },
    },

    client: {
      nom: { type: String, trim: true, required: true },
      email: { type: String, trim: true, lowercase: true, required: true, index: true },
      telephone: { type: String, trim: true },
      adresse: { type: String, trim: true },
      type: { type: String, enum: ['B2C', 'B2B'], default: 'B2C' },
    },

    garage: {
      nom: { type: String, trim: true },
      adresse: { type: String, trim: true },
      telephone: { type: String, trim: true },
      factureMontage: { type: String, trim: true }, // URL doc
    },

    documents: {
      factureMontage: { type: String, trim: true },
      photosObd: [{ type: String, trim: true }],
      confirmationReglageBase: { type: String, trim: true },
      photosVisuelles: [{ type: String, trim: true }],
      photoCompteur: { type: String, trim: true },
      bonGarantie: { type: String, trim: true }, // optionnel
    },

    // Liste enrichie (nouveaux uploads). Conserve méta pour affichage admin.
    documentsList: [
      {
        kind: { type: String, trim: true },          // factureMontage|photoObd|photoPiece|autre
        url: { type: String, trim: true, required: true },
        originalName: { type: String, trim: true },
        size: { type: Number, min: 0 },              // octets
        mime: { type: String, trim: true },
        uploadedAt: { type: Date, default: Date.now },
      },
    ],

    diagnostic: {
      symptomes: [{ type: String, trim: true }],
      codesDefaut: [{ type: String, trim: true }],
      scoreRisque: { type: Number, min: 0, max: 100, default: 0 },
      redFlags: [{ type: String, trim: true }],
      description: { type: String, trim: true }, // texte libre client
    },

    montage: {
      date: { type: Date },
      reglageBase: { type: String, enum: ['oui', 'non', 'inconnu'] },
      momentPanne: { type: String, trim: true }, // ex: "montage", "100km", "500km", "1000km", "5000km", etc.
      huileQuantite: { type: String, trim: true }, // ex: "5.0", "5.2" (litres)
      huileType: { type: String, trim: true }, // ex: "DCTF-1", "G 052 182", "Fuchs Titan"
    },

    cgvAcceptance: {
      version: { type: String, trim: true }, // ex "cgv-sav-v2-2026-04"
      acceptedAt: { type: Date },
      ip: { type: String, trim: true },
      userAgent: { type: String, trim: true },
      pdfUrl: { type: String, trim: true }, // PDF horodaté de l'acceptation
    },

    rgpdAcceptance: {
      version: { type: String, trim: true },
      acceptedAt: { type: Date },
      ip: { type: String, trim: true },
      userAgent: { type: String, trim: true },
    },

    workflow: {
      track: {
        type: String,
        enum: ['red_flag', 'retour_systematique'],
        default: 'retour_systematique',
      },
      etape: { type: String, trim: true },
      statut: { type: String, trim: true },
    },

    statut: {
      type: String,
      enum: STATUTS,
      default: 'ouvert',
      index: true,
    },

    analyse: {
      rapport: { type: String, trim: true }, // PDF URL
      conclusion: {
        type: String,
        enum: ['defaut_produit', 'mauvais_montage', 'usure_normale', 'non_defectueux'],
      },
      facture149: {
        status: {
          type: String,
          enum: ['na', 'a_facturer', 'payee', 'impayee'],
          default: 'na',
        },
      },
      photosBanc: [{ type: String, trim: true }],
    },

    resolution: {
      type: {
        type: String,
        enum: [
          'echange',
          'reparation',
          'remboursement',
          'retour_pieces',
          'piece_conservee_impaye',
        ],
      },
      montant: { type: Number, min: 0 },
      dateResolution: { type: Date },
    },

    // ──────────────────────────────────────────────────────────
    // Checklist de clôture (qualité + reporting)
    // Rempli par l'agent juste avant de passer le ticket en clos /
    // resolu_garantie / resolu_facture / refuse. Les champs booleans
    // sont cochés dans la modale, et rootCause alimente le reporting
    // mensuel (catégorisation des causes récurrentes).
    // ──────────────────────────────────────────────────────────
    closure: {
      clientNotified: { type: Boolean, default: false },
      refundDone: { type: Boolean, default: false },
      docsArchived: { type: Boolean, default: false },
      rootCause: {
        type: String,
        enum: [
          '',
          'defaut_produit',
          'defaut_fournisseur',
          'erreur_preparation',
          'erreur_client',
          'dommage_transport',
          'incompatibilite',
          'rétractation_client',
          'autre',
        ],
        default: '',
      },
      rootCauseDetail: { type: String, trim: true, default: '' },
      closedBy: { type: String, trim: true },
      closedAt: { type: Date },
    },

    paiements: {
      facture149: {
        status: {
          type: String,
          enum: ['na', 'a_facturer', 'payee', 'impayee'],
          default: 'na',
        },
        mollieId: { type: String, trim: true },
        paymentUrl: { type: String, trim: true },
        qontoInvoiceId: { type: String, trim: true },
        qontoInvoiceUrl: { type: String, trim: true },
        qontoPdfUrl: { type: String, trim: true },
        dateGeneration: { type: Date },
        datePaiement: { type: Date },
      },
      remboursement: {
        status: { type: String, enum: ['na', 'effectue', 'echoue'], default: 'na' },
        mollieRefundId: { type: String, trim: true },
        amountCents: { type: Number },
        date: { type: Date },
        reason: { type: String, trim: true },
      },
    },

    // Feedback client (4.4 Google Reviews)
    reviewFeedback: {
      sentAt: { type: Date }, // mail J+7 envoyé
      completedAt: { type: Date }, // formulaire client rempli
      note: { type: Number, min: 1, max: 5 },
      comment: { type: String, trim: true },
      redirectedToGoogle: { type: Boolean, default: false },
    },

    sla: {
      dateOuverture: { type: Date, default: Date.now },
      dateLimite: { type: Date },
      alertes: [
        {
          date: { type: Date, default: Date.now },
          type: { type: String, trim: true },
          message: { type: String, trim: true },
        },
      ],
      escalade: { type: Boolean, default: false },
    },

    messages: [messageSchema],

    // Notes internes épinglées (résumé visible en haut du ticket admin)
    pinnedNotes: [
      {
        texte: { type: String, trim: true, required: true, maxlength: 500 },
        couleur: { type: String, enum: ['amber', 'rose', 'blue', 'emerald', 'slate'], default: 'amber' },
        auteur: { type: String, trim: true },
        createdAt: { type: Date, default: Date.now },
        updatedAt: { type: Date },
        expiresAt: { type: Date, default: null },
        mentions: [{ type: String, trim: true }],
      },
    ],
    // Historique des notes épinglées supprimées (audit visible en UI)
    deletedPinnedNotes: [
      {
        texte: { type: String, trim: true },
        couleur: { type: String, trim: true },
        auteur: { type: String, trim: true },
        createdAt: { type: Date },
        deletedAt: { type: Date, default: Date.now },
        deletedBy: { type: String, trim: true },
      },
    ],

    // Suivi lecture/écriture client ↔ admin (badges "nouvelle réponse")
    lastClientMessageAt: { type: Date, default: null },
    lastAdminMessageAt: { type: Date, default: null },
    lastClientReadAt: { type: Date, default: null },
    lastAdminReadAt: { type: Date, default: null },

    fournisseur: {
      contact: { type: String, trim: true },
      nom: { type: String, trim: true },
      rmaNumero: { type: String, trim: true },
      transporteur: { type: String, trim: true }, // chronopost|colissimo|ups|dhl|other
      colisNumero: { type: String, trim: true },
      trackingUrl: { type: String, trim: true },
      coutAnalyse: { type: Number, min: 0 }, // €
      coutRefacture: { type: Number, min: 0 }, // €
      rapportUrl: { type: String, trim: true },
      dateEnvoi: { type: Date },
      dateRetour: { type: Date },
      reponse: { type: String, trim: true },
    },

    // Assignation
    assignedToUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser', index: true },
    assignedToName: { type: String, trim: true }, // dénormalisé pour affichage rapide
    assignedAt: { type: Date },

    // Alertes SLA déjà envoyées (anti-doublons)
    slaAlerts: {
      alert24h: { type: Date },
      alert12h: { type: Date },
      alertExpired: { type: Date },
    },

    // Diagnostic enrichi (3.7)
    diagnosticEnrichi: {
      photosAvant: [{ url: String, legende: String }],
      photosPendant: [{ url: String, legende: String }],
      photosApres: [{ url: String, legende: String }],
      videoUrl: { type: String, trim: true },
      mesures: {
        pressionHydraulique: { type: Number },
        fuiteInterne: { type: String, trim: true },
        temperatureAvant: { type: Number },
        temperatureApres: { type: Number },
        codesAvantReset: [{ type: String, trim: true }],
        codesApresReset: [{ type: String, trim: true }],
      },
      courbeBancUrl: { type: String, trim: true },
      avis2eTechnicienUserId: { type: mongoose.Schema.Types.ObjectId, ref: 'AdminUser' },
      avis2eTechnicienTexte: { type: String, trim: true },
      scoreCalcule: { type: Number, min: 0, max: 100 },
      pdfUrl: { type: String, trim: true },
    },

    // Trace des actions automatisées
    automationLog: [{
      ruleKey: { type: String, trim: true },
      executedAt: { type: Date, default: Date.now },
      details: { type: String, trim: true },
    }],

    preuveQualite: {
      videoTest: { type: String, trim: true },
      screenshotBanc: { type: String, trim: true },
      certificatReconditionnement: { type: String, trim: true },
    },
  },
  { timestamps: true }
);

savTicketSchema.index({ numero: 1 });
savTicketSchema.index({ 'client.email': 1 });
savTicketSchema.index({ statut: 1 });
savTicketSchema.index({ 'vehicule.vin': 1 });

// ---------- Helpers ----------

function addBusinessDays(startDate, days) {
  const date = new Date(startDate);
  let added = 0;
  while (added < days) {
    date.setDate(date.getDate() + 1);
    const day = date.getDay(); // 0 dim, 6 sam
    if (day !== 0 && day !== 6) added += 1;
  }
  return date;
}

// ---------- Motif → team / SLA / statut initial ----------
const MOTIF_CONFIG = {
  piece_defectueuse:  { team: 'atelier',     slaDays: 5,   slaHours: null, statut: 'pre_qualification' },
  retard_livraison:   { team: 'logistique',  slaDays: null, slaHours: 24,  statut: 'enquete_transporteur' },
  colis_abime:        { team: 'logistique',  slaDays: null, slaHours: 48,  statut: 'reserve_transporteur' },
  colis_non_recu:     { team: 'logistique',  slaDays: null, slaHours: 72,  statut: 'enquete_transporteur' },
  erreur_preparation: { team: 'logistique',  slaDays: null, slaHours: 48,  statut: 'ouvert' },
  retractation:       { team: 'commercial',  slaDays: 14,  slaHours: null, statut: 'retractation_recue' },
  non_compatible:     { team: 'commercial',  slaDays: 5,   slaHours: null, statut: 'ouvert' },
  facture_document:   { team: 'compta',      slaDays: null, slaHours: 24,  statut: 'ouvert' },
  remboursement:      { team: 'compta',      slaDays: null, slaHours: 48,  statut: 'ouvert' },
  autre:              { team: 'sav_general', slaDays: null, slaHours: 48,  statut: 'ouvert' },
};
savTicketSchema.statics.MOTIFS_SAV = MOTIFS_SAV;
savTicketSchema.statics.MOTIF_CONFIG = MOTIF_CONFIG;
savTicketSchema.statics.getMotifConfig = function (motif) {
  return MOTIF_CONFIG[motif] || MOTIF_CONFIG.piece_defectueuse;
};

// ---------- Statics ----------

savTicketSchema.statics.generateNumero = async function generateNumero() {
  const year = new Date().getFullYear();
  const prefix = `SAV-${year}-`;
  const last = await this.findOne({ numero: new RegExp(`^${prefix}`) })
    .sort({ numero: -1 })
    .select('numero')
    .lean();
  let seq = 1;
  if (last && last.numero) {
    const parsed = parseInt(last.numero.slice(prefix.length), 10);
    if (!Number.isNaN(parsed)) seq = parsed + 1;
  }
  return `${prefix}${String(seq).padStart(4, '0')}`;
};

// ---------- Hooks ----------

savTicketSchema.pre('save', async function preSave(next) {
  try {
    if (this.isNew && !this.numero) {
      this.numero = await this.constructor.generateNumero();
    }
    if (!this.sla) this.sla = {};
    if (!this.sla.dateOuverture) this.sla.dateOuverture = new Date();
    if (!this.sla.dateLimite) {
      const cfg = MOTIF_CONFIG[this.motifSav] || MOTIF_CONFIG.piece_defectueuse;
      if (cfg.slaHours) {
        this.sla.dateLimite = new Date(this.sla.dateOuverture.getTime() + cfg.slaHours * 3600 * 1000);
      } else {
        this.sla.dateLimite = addBusinessDays(this.sla.dateOuverture, cfg.slaDays || 5);
      }
    }
    if (this.isNew && !this.assignedTeam) {
      const cfg = MOTIF_CONFIG[this.motifSav] || MOTIF_CONFIG.piece_defectueuse;
      this.assignedTeam = cfg.team;
    }
    next();
  } catch (err) {
    next(err);
  }
});

// ---------- Methods ----------

savTicketSchema.methods.addMessage = function addMessage(auteur, canal, contenu, attachments) {
  const date = new Date();
  const msg = { auteur, canal, contenu, date };
  if (Array.isArray(attachments) && attachments.length) {
    msg.attachments = attachments
      .filter((a) => a && a.url)
      .map((a) => ({
        url: String(a.url),
        originalName: a.originalName || a.filename || '',
        size: Number(a.size) || 0,
        mime: a.mime || a.mimeType || '',
        kind: a.kind || '',
      }));
  }
  this.messages.push(msg);
  if (auteur === 'client') this.lastClientMessageAt = date;
  else if (auteur && auteur !== 'systeme' && canal !== 'interne') this.lastAdminMessageAt = date;
  return this;
};

savTicketSchema.methods.changerStatut = function changerStatut(nouveauStatut, auteur, opts) {
  const ancien = this.statut;
  const options = opts || {};
  // Garde FSM : refuse les transitions illégales, sauf si opts.force === true
  try {
    const fsm = require('../config/savStateMachine');
    if (!options.force && ancien && ancien !== nouveauStatut) {
      fsm.assertTransition(ancien, nouveauStatut);
    }
  } catch (e) {
    // Propage l'erreur pour qu'elle soit catchée par la route API
    if (!options.force) throw e;
  }
  this.statut = nouveauStatut;
  this.addMessage(
    auteur || 'systeme',
    'interne',
    `Changement de statut : ${ancien} → ${nouveauStatut}`
  );
  // Hook notif (lazy require pour éviter cycle)
  try {
    const notif = require('../services/savNotifications');
    // fire-and-forget : ne bloque jamais le save
    Promise.resolve(notif.notifyStatusChange(this, nouveauStatut)).catch(() => {});
  } catch (_) {}
  return this;
};

module.exports = mongoose.model('SavTicket', savTicketSchema);
