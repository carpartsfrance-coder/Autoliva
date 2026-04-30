const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const SavTicket = require('../../models/SavTicket');
const SavSettings = require('../../models/SavSettings');
const AdminUser = require('../../models/AdminUser');
const Order = require('../../models/Order');
const SavProcedure = require('../../models/SavProcedure');
const AuditLog = require('../../models/AuditLog');
const audit = require('../../services/auditLogger');
const savFileStorage = require('../../services/savFileStorage');
const brand = require('../../config/brand');

const router = express.Router();

// ---------- Logger ----------

const LOG_DIR = path.join(__dirname, '..', '..', '..', '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'sav-api.log');

function ensureLogDir() {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
  } catch (_) {}
}
ensureLogDir();

function logApi(req, res) {
  const line = `${new Date().toISOString()} ${req.method} ${req.originalUrl} ${res.statusCode}\n`;
  try {
    fs.appendFile(LOG_FILE, line, () => {});
  } catch (_) {}
}

router.use((req, res, next) => {
  res.on('finish', () => logApi(req, res));
  next();
});

// ---------- Helpers ----------

function ok(res, data, status = 200) {
  return res.status(status).json({ success: true, data });
}
function fail(res, error, status = 400) {
  return res.status(status).json({ success: false, error });
}

// ---------- Auth admin (Bearer) ----------

function requireAdminToken(req, res, next) {
  const header = req.headers.authorization || '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  const expected = (process.env.SAV_API_TOKEN || '').trim();
  if (!expected) return fail(res, 'SAV_API_TOKEN non configuré côté serveur', 500);
  if (!token || token !== expected) return fail(res, 'Non autorisé', 401);
  return next();
}

// ---------- Upload (multer mémoire) ----------

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 15 * 1024 * 1024 },
});

// ============================================================
// PUBLIC (client)
// ============================================================

const publicRouter = express.Router();

// GET /api/sav/stats-publiques — chiffres anonymes pour la page engagement
publicRouter.get('/stats-publiques', async (req, res) => {
  try {
    const STATUTS_ACTIFS = ['ouvert','pre_qualification','en_attente_documents','retour_demande','en_transit_retour','recu_atelier','en_analyse','analyse_terminee','en_attente_decision_client'];
    const [ouverts, total, defaut] = await Promise.all([
      SavTicket.countDocuments({ statut: { $in: STATUTS_ACTIFS } }),
      SavTicket.countDocuments({ 'analyse.conclusion': { $exists: true } }),
      SavTicket.countDocuments({ 'analyse.conclusion': 'defaut_produit' }),
    ]);
    const taux = total > 0 ? Math.round((defaut / total) * 100) : 0;
    return ok(res, { ouverts, taux_defaut_produit: taux });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// POST /api/sav/mollie-webhook — Mollie ping (form-encoded body { id })
publicRouter.post('/mollie-webhook', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    const mollieService = require('../../services/mollieService');
    const id = (req.body && req.body.id) || (req.query && req.query.id);
    if (!id) return res.status(200).end(); // Mollie attend toujours 200
    await mollieService.handleWebhook(id);
    return res.status(200).end();
  } catch (err) {
    console.error('[sav-mollie-webhook]', err.message);
    return res.status(200).end(); // ne JAMAIS renvoyer 5xx à Mollie sinon il retry en boucle
  }
});

// POST /api/sav/inbound-email — MailerSend inbound webhook (NO AUTH)
publicRouter.post('/inbound-email', express.json({ limit: '10mb' }), async (req, res) => {
  try {
    const { processInboundEmail } = require('../../services/savInboundEmail');
    const result = await processInboundEmail(req);
    console.log('[sav-inbound]', JSON.stringify(result));
    // Always return 200 to prevent MailerSend retries
    return res.status(200).json({ ok: true, result });
  } catch (err) {
    console.error('[sav-inbound] ERROR', err.message);
    // Always return 200 even on error to prevent retries
    return res.status(200).json({ ok: false, error: err.message });
  }
});

// POST /api/sav/tickets — création
// GET /api/sav/verify-report/:numero — vérification signature PDF (QR code)
publicRouter.get('/verify-report/:numero', async (req, res) => {
  try {
    const ticket = await SavTicket.findOne({ numero: req.params.numero }).lean();
    if (!ticket) return fail(res, 'Ticket introuvable', 404);
    const reportPdf = require('../../services/savReportPdf');
    const expected = reportPdf.reportSignature
      ? reportPdf.reportSignature(ticket, req.query.t || 'client')
      : null;
    const valid = expected && req.query.h && req.query.h === expected;
    return ok(res, {
      numero: ticket.numero,
      valid,
      template: req.query.t || 'client',
      conclusion: ticket.analyse && ticket.analyse.conclusion,
      generatedFor: ticket.client && ticket.client.nom,
      verifiedAt: new Date().toISOString(),
    });
  } catch (err) { return fail(res, err.message, 500); }
});

// GET /api/sav/satisfaction/:numero — page publique de notation post-clôture (NPS/CSAT)
publicRouter.get('/satisfaction/:numero', async (req, res) => {
  try {
    const ticket = await SavTicket.findOne({ numero: req.params.numero }).select('numero reviewFeedback client.nom');
    if (!ticket) return fail(res, 'Ticket introuvable', 404);
    const note = parseInt(req.query.note, 10);
    if (note >= 1 && note <= 5) {
      ticket.reviewFeedback = ticket.reviewFeedback || {};
      ticket.reviewFeedback.note = note;
      ticket.reviewFeedback.completedAt = new Date();
      if (note >= 4) ticket.reviewFeedback.redirectedToGoogle = true;
      await ticket.save();
    }
    return ok(res, { numero: ticket.numero, note: ticket.reviewFeedback && ticket.reviewFeedback.note });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

publicRouter.post('/tickets', async (req, res) => {
  try {
    const body = req.body || {};
    if (!body.client || !body.client.email) {
      return fail(res, 'client.email requis');
    }
    if (!body.client.nom) body.client.nom = body.client.email.split('@')[0];
    // motifSav par défaut = piece_defectueuse (rétro-compat avec wizard existant)
    const motifSav = body.motifSav || 'piece_defectueuse';
    if (motifSav === 'piece_defectueuse' && !body.pieceType) return fail(res, 'pieceType requis');

    // Détection de doublon : même commande + même email + ticket non clôturé
    if (body.numeroCommande && !body.forceNew) {
      const CLOSED_STATUSES = ['clos', 'clos_sans_reponse', 'refuse', 'resolu_garantie', 'resolu_facture'];
      const existing = await SavTicket.findOne({
        numeroCommande: body.numeroCommande,
        'client.email': body.client.email,
        statut: { $nin: CLOSED_STATUSES },
      })
        .select('numero statut motifSav createdAt')
        .lean();
      if (existing) {
        return res.status(409).json({
          success: false,
          error: 'duplicate',
          message: 'Un ticket existe déjà sur cette commande.',
          data: {
            existingTicket: {
              numero: existing.numero,
              statut: existing.statut,
              motifSav: existing.motifSav,
              createdAt: existing.createdAt,
            },
          },
        });
      }
    }

    const clientIp =
      (req.headers['x-forwarded-for'] || '').toString().split(',')[0].trim() ||
      req.ip ||
      (req.connection && req.connection.remoteAddress) ||
      '';
    const userAgent = (req.headers['user-agent'] || '').toString().slice(0, 500);

    const ticket = new SavTicket({
      motifSav,
      pieceType: body.pieceType,
      referencePiece: body.referencePiece,
      numeroSerie: body.numeroSerie,
      dateAchat: body.dateAchat,
      numeroCommande: body.numeroCommande,
      vehicule: body.vehicule || {},
      client: body.client,
      garage: body.garage || {},
      diagnostic: body.diagnostic || {},
      montage: body.montage || {},
      cgvAcceptance: body.cgvAcceptance
        ? {
            version: body.cgvAcceptance.version || 'cgv-sav-v2-2026-04',
            acceptedAt: body.cgvAcceptance.acceptedAt
              ? new Date(body.cgvAcceptance.acceptedAt)
              : new Date(),
            ip: clientIp,
            userAgent,
          }
        : undefined,
      rgpdAcceptance: body.rgpdAcceptance
        ? {
            version: body.rgpdAcceptance.version || 'rgpd-v1-2026-04',
            acceptedAt: body.rgpdAcceptance.acceptedAt
              ? new Date(body.rgpdAcceptance.acceptedAt)
              : new Date(),
            ip: clientIp,
            userAgent,
          }
        : undefined,
      statut: 'pre_qualification',
      workflow: { track: body.track || 'retour_systematique', etape: 'pre_qualification' },
    });
    // Note interne technique (audit) — invisible côté client
    ticket.addMessage('systeme', 'interne', 'Ticket créé via formulaire public (wizard)');
    // Message client visible dans la conversation (description = demande initiale)
    const initialDescription = (body.diagnostic && typeof body.diagnostic.description === 'string')
      ? body.diagnostic.description.trim()
      : '';
    ticket.addMessage(
      'client',
      'inapp',
      initialDescription || 'Demande SAV créée via le formulaire en ligne.',
    );
    await ticket.save();

    // 4.3 Slack : nouveau ticket
    try { require('../../services/slackNotifier').notifyTicketCreated(ticket); } catch (_) {}

    // Génère le PDF d'acceptation CGV horodaté + envoie le mail de confirmation
    // (best-effort, n'échoue jamais le ticket si le mail/PDF plante)
    try {
      const cgvPdf = require('../../services/savCgvPdf');
      const url = await cgvPdf.generateCgvAcceptance(ticket);
      ticket.cgvAcceptance = ticket.cgvAcceptance || {};
      ticket.cgvAcceptance.pdfUrl = url;
      await ticket.save();
    } catch (e) {
      console.error('[sav] CGV PDF échec', e && e.message);
    }
    try {
      const notif = require('../../services/savNotifications');
      if (typeof notif.sendConfirmationToClient === 'function') {
        notif.sendConfirmationToClient(ticket).catch((e) => {
          console.error('[sav] mail confirmation échec', e && e.message);
        });
      }
    } catch (e) {
      console.error('[sav] notif require échec', e && e.message);
    }

    return ok(res, { numero: ticket.numero, statut: ticket.statut, sla: ticket.sla }, 201);
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// GET /api/sav/tickets/:numero?email=
publicRouter.get('/tickets/:numero', async (req, res) => {
  try {
    const email = (req.query.email || '').toLowerCase().trim();
    if (!email) return fail(res, 'email requis', 401);
    const ticket = await SavTicket.findOne({
      numero: req.params.numero,
      'client.email': email,
    }).lean();
    if (!ticket) return fail(res, 'Ticket introuvable', 404);
    // Vue client : on masque les champs internes
    const publicView = {
      numero: ticket.numero,
      statut: ticket.statut,
      pieceType: ticket.pieceType,
      vehicule: ticket.vehicule,
      sla: ticket.sla,
      messages: (ticket.messages || []).filter((m) => m.canal !== 'interne'),
      analyse: ticket.analyse
        ? { conclusion: ticket.analyse.conclusion, rapport: ticket.analyse.rapport }
        : null,
      resolution: ticket.resolution,
    };
    return ok(res, publicView);
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// POST /api/sav/tickets/:numero/documents — upload doc
publicRouter.post(
  '/tickets/:numero/documents',
  upload.single('document'),
  async (req, res) => {
    try {
      const email = (req.body.email || '').toLowerCase().trim();
      if (!email) return fail(res, 'email requis', 401);
      const ticket = await SavTicket.findOne({
        numero: req.params.numero,
        'client.email': email,
      });
      if (!ticket) return fail(res, 'Ticket introuvable', 404);
      if (!req.file) return fail(res, 'Aucun fichier fourni');

      const kind = (req.body.kind || 'autre').trim();
      // Persistance MongoDB (GridFS) — plus aucun fichier sur disque local
      const stored = await savFileStorage.saveBuffer({
        buffer: req.file.buffer,
        filename: req.file.originalname,
        mime: req.file.mimetype,
        metadata: {
          ticketNumero: ticket.numero,
          kind,
          uploadedBy: 'client',
        },
      });
      const url = stored.url;
      if (!ticket.documents) ticket.documents = {};
      if (kind === 'factureMontage') ticket.documents.factureMontage = url;
      else if (kind === 'photoObd') {
        ticket.documents.photosObd = ticket.documents.photosObd || [];
        ticket.documents.photosObd.push(url);
      } else if (kind === 'confirmationReglageBase') {
        ticket.documents.confirmationReglageBase = url;
      } else {
        ticket.documents.photosVisuelles = ticket.documents.photosVisuelles || [];
        ticket.documents.photosVisuelles.push(url);
      }

      ticket.documentsList = ticket.documentsList || [];
      ticket.documentsList.push({
        kind,
        url,
        originalName: req.file.originalname,
        size: req.file.size,
        mime: req.file.mimetype,
        uploadedAt: new Date(),
      });

      // Rattacher la PJ au premier message client inapp (la "demande initiale")
      // pour qu'elle apparaisse dans la conversation. Si aucun message client
      // n'existe encore (rétro-compat), on log en interne.
      const attachment = {
        url,
        originalName: req.file.originalname,
        size: req.file.size,
        mime: req.file.mimetype,
        kind,
      };
      const initialClientMsg = (ticket.messages || []).find((m) => m.auteur === 'client' && m.canal === 'inapp');
      if (initialClientMsg) {
        if (!Array.isArray(initialClientMsg.attachments)) initialClientMsg.attachments = [];
        initialClientMsg.attachments.push(attachment);
      } else {
        ticket.addMessage('systeme', 'interne', `Document uploadé (${kind}) : ${req.file.originalname} (${req.file.size} octets)`);
      }
      await ticket.save();
      return ok(res, { url, kind });
    } catch (err) {
      return fail(res, err.message, 500);
    }
  }
);

// POST /api/sav/tickets/:numero/messages — message client
publicRouter.post('/tickets/:numero/messages', async (req, res) => {
  try {
    const email = (req.body.email || '').toLowerCase().trim();
    const contenu = (req.body.contenu || '').trim();
    if (!email) return fail(res, 'email requis', 401);
    if (!contenu) return fail(res, 'contenu requis');
    const ticket = await SavTicket.findOne({
      numero: req.params.numero,
      'client.email': email,
    });
    if (!ticket) return fail(res, 'Ticket introuvable', 404);
    ticket.addMessage('client', 'email', contenu);
    await ticket.save();
    return ok(res, { ok: true });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// ============================================================
// ADMIN (Bearer)
// ============================================================

const adminRouter = express.Router();
adminRouter.use(requireAdminToken);

// GET /admin/api/sav/tickets — liste filtrable, paginée, triée
adminRouter.get('/tickets', async (req, res) => {
  try {
    const q = {};
    if (req.query.statut) {
      const arr = String(req.query.statut).split(',').filter(Boolean);
      q.statut = arr.length > 1 ? { $in: arr } : arr[0];
    }
    if (req.query.pieceType) {
      const arr = String(req.query.pieceType).split(',').filter(Boolean);
      q.pieceType = arr.length > 1 ? { $in: arr } : arr[0];
    }
    if (req.query.motifSav) {
      const arr = String(req.query.motifSav).split(',').filter(Boolean);
      q.motifSav = arr.length > 1 ? { $in: arr } : arr[0];
    }
    if (req.query.assignedTeam) {
      q.assignedTeam = req.query.assignedTeam;
    }
    if (req.query.assignedToUserId) {
      if (req.query.assignedToUserId === '__none__') {
        q.assignedToUserId = { $in: [null, undefined] };
      } else {
        q.assignedToUserId = req.query.assignedToUserId;
      }
    }
    if (req.query.sla_depasse === 'true') {
      q['sla.dateLimite'] = { $lt: new Date() };
      q.statut = q.statut || { $nin: ['clos', 'refuse', 'resolu_garantie', 'resolu_facture', 'clos_sans_reponse'] };
    }
    // Réponse client en attente : un message client posté après la dernière lecture admin
    if (req.query.awaitingClient === 'true') {
      q.$expr = {
        $and: [
          { $ne: ['$lastClientMessageAt', null] },
          { $or: [
            { $eq: ['$lastAdminReadAt', null] },
            { $gt: ['$lastClientMessageAt', '$lastAdminReadAt'] },
          ] },
        ],
      };
    }
    if (req.query.search) {
      const s = String(req.query.search).trim();
      if (s) {
        q.$or = [
          { numero: new RegExp(s, 'i') },
          { 'client.email': new RegExp(s, 'i') },
          { 'client.nom': new RegExp(s, 'i') },
          { 'vehicule.vin': new RegExp(s, 'i') },
          { 'messages.contenu': new RegExp(s, 'i') },
          { 'diagnostic.description': new RegExp(s, 'i') },
          { 'vehicule.immatriculation': new RegExp(s, 'i') },
          { numeroCommande: new RegExp(s, 'i') },
        ];
      }
    }

    // Raccourci "mine" : tickets assignés au user courant
    if (req.query.mine === 'true' && req.session && req.session.user) {
      q.assignedToUserId = String(req.session.user._id || req.session.user.id || '');
    }

    // Tri
    const sortField = String(req.query.sort || 'createdAt');
    const sortDir = String(req.query.dir || 'desc') === 'asc' ? 1 : -1;
    const sortMap = {
      numero: 'numero',
      client: 'client.email',
      pieceType: 'pieceType',
      statut: 'statut',
      sla: 'sla.dateLimite',
      createdAt: 'createdAt',
      assignedTo: 'assignedToName',
    };

    // Pagination
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const perPage = Math.min(100, Math.max(1, parseInt(req.query.perPage, 10) || 20));
    const skip = (page - 1) * perPage;

    // Tri spécial "priority" : calcul applicatif (car dépend du temps courant)
    if (sortField === 'priority') {
      // Exclut les statuts terminaux sauf si explicitement filtrés
      if (!q.statut) {
        q.statut = { $nin: ['clos', 'refuse', 'resolu_garantie', 'resolu_facture'] };
      }
      // On charge un périmètre raisonnable puis on trie en mémoire
      const LIMIT_PRIORITY = 500;
      const [allMatching, total] = await Promise.all([
        SavTicket.find(q).limit(LIMIT_PRIORITY).lean(),
        SavTicket.countDocuments(q),
      ]);
      const priority = require('../../config/savPriority');
      const sorted = priority.sortByPriority(allMatching);
      // Enrichit chaque ticket avec l'explain score pour debug UI
      sorted.forEach((t) => { t._priorityExplain = priority.explainScore(t); });
      const sliced = sorted.slice(skip, skip + perPage);
      return ok(res, {
        count: sliced.length, total, page, perPage,
        totalPages: Math.ceil(total / perPage),
        tickets: sliced,
        sortMode: 'priority',
      });
    }

    const sort = { [sortMap[sortField] || 'createdAt']: sortDir };
    const [tickets, total] = await Promise.all([
      SavTicket.find(q).sort(sort).skip(skip).limit(perPage).lean(),
      SavTicket.countDocuments(q),
    ]);
    return ok(res, { count: tickets.length, total, page, perPage, totalPages: Math.ceil(total / perPage), tickets });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// GET /admin/api/sav/tickets.csv — export CSV (filtré, sans pagination)
adminRouter.get('/tickets.csv', async (req, res) => {
  try {
    const q = {};
    if (req.query.statut) {
      const arr = String(req.query.statut).split(',').filter(Boolean);
      q.statut = arr.length > 1 ? { $in: arr } : arr[0];
    }
    if (req.query.pieceType) {
      const arr = String(req.query.pieceType).split(',').filter(Boolean);
      q.pieceType = arr.length > 1 ? { $in: arr } : arr[0];
    }
    if (req.query.assignedToUserId) q.assignedToUserId = req.query.assignedToUserId;
    if (req.query.sla_depasse === 'true') q['sla.dateLimite'] = { $lt: new Date() };
    const tickets = await SavTicket.find(q).sort({ createdAt: -1 }).limit(5000).lean();
    const head = ['numero','createdAt','statut','pieceType','client_email','client_nom','vin','immatriculation','vehicule','assigne','sla_limite'];
    const rows = tickets.map((t) => [
      t.numero,
      new Date(t.createdAt).toISOString(),
      t.statut,
      t.pieceType,
      (t.client && t.client.email) || '',
      (t.client && t.client.nom) || '',
      (t.vehicule && t.vehicule.vin) || '',
      (t.vehicule && t.vehicule.immatriculation) || '',
      [(t.vehicule && t.vehicule.marque) || '', (t.vehicule && t.vehicule.modele) || '', (t.vehicule && t.vehicule.annee) || ''].filter(Boolean).join(' '),
      t.assignedToName || '',
      (t.sla && t.sla.dateLimite) ? new Date(t.sla.dateLimite).toISOString() : '',
    ]);
    function csvCell(v) {
      const s = String(v == null ? '' : v).replace(/"/g, '""');
      return /[",\n;]/.test(s) ? '"' + s + '"' : s;
    }
    const csv = [head.join(';'), ...rows.map((r) => r.map(csvCell).join(';'))].join('\n');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="sav-tickets-${Date.now()}.csv"`);
    return res.end('\ufeff' + csv);
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// GET /admin/api/sav/team — liste des admins (pour assignation)
adminRouter.get('/team', async (req, res) => {
  try {
    const users = await AdminUser.find({ isActive: true })
      .select('firstName lastName email role')
      .sort({ firstName: 1 })
      .lean();
    return ok(res, { users });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// GET /admin/api/sav/tickets/:numero/order-context — détails commande liée
adminRouter.get('/tickets/:numero/order-context', async (req, res) => {
  try {
    const ticket = await SavTicket.findOne({ numero: req.params.numero }).select('numeroCommande').lean();
    if (!ticket || !ticket.numeroCommande) return ok(res, { order: null });
    const order = await Order.findOne({ number: ticket.numeroCommande }).lean();
    if (!order) return ok(res, { order: null, numeroCommande: ticket.numeroCommande });
    return ok(res, {
      order: {
        number: order.number,
        status: order.status,
        createdAt: order.createdAt,
        totalCents: order.totalCents,
        customer: order.customer || null,
        shippingAddress: order.shippingAddress || null,
        items: (order.items || []).map(it => ({
          name: it.name, sku: it.sku, optionsSummary: it.optionsSummary,
          unitPriceCents: it.unitPriceCents, quantity: it.quantity,
        })),
        shipments: (order.shipments || []).map(s => ({
          label: s.label, carrier: s.carrier, trackingNumber: s.trackingNumber,
          document: s.document, createdAt: s.createdAt,
        })),
        cloningTracking: order.cloningTracking || null,
      },
    });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// POST /admin/api/sav/tickets/:numero/assign — assigner ticket
adminRouter.post('/tickets/:numero/assign', async (req, res) => {
  try {
    const ticket = await SavTicket.findOne({ numero: req.params.numero });
    if (!ticket) return fail(res, 'Ticket introuvable', 404);
    const before = { assignedToUserId: ticket.assignedToUserId, assignedToName: ticket.assignedToName };
    const userId = (req.body && req.body.userId) || null;
    if (!userId) {
      ticket.assignedToUserId = null;
      ticket.assignedToName = null;
      ticket.assignedAt = null;
      ticket.addMessage('admin', 'interne', 'Ticket désassigné');
    } else {
      const user = await AdminUser.findById(userId).lean();
      if (!user) return fail(res, 'Utilisateur inconnu', 404);
      ticket.assignedToUserId = user._id;
      ticket.assignedToName = `${user.firstName || ''} ${user.lastName || ''}`.trim() || user.email;
      ticket.assignedAt = new Date();
      ticket.addMessage('admin', 'interne', `Ticket assigné à ${ticket.assignedToName}`);
      // Mail à l'assigné (best-effort)
      try {
        const { sendEmail } = require('../../services/emailService');
        sendEmail({
          toEmail: user.email,
          subject: `[SAV] Ticket ${ticket.numero} vous est assigné`,
          html: `<p>Bonjour ${user.firstName || ''},</p><p>Le ticket SAV <strong>${ticket.numero}</strong> vous a été assigné.</p><p><a href="${process.env.SITE_URL || ''}/admin/sav/tickets/${ticket.numero}">Ouvrir le ticket</a></p>`,
          text: `Le ticket ${ticket.numero} vous a été assigné. ${process.env.SITE_URL || ''}/admin/sav/tickets/${ticket.numero}`,
        }).catch(() => {});
      } catch (_) {}
    }
    await ticket.save();
    audit.log({ req, action: 'sav.assign', entityType: 'sav_ticket', entityId: ticket.numero, before, after: { assignedToUserId: ticket.assignedToUserId, assignedToName: ticket.assignedToName } });
    if (ticket.assignedToName) {
      try { require('../../services/slackNotifier').notifyTicketAssigned(ticket); } catch (_) {}
    }
    return ok(res, { numero: ticket.numero, assignedToName: ticket.assignedToName });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// GET /admin/api/sav/tickets/:numero/whatsapp-fournisseur/preview
// → renvoie le texte WhatsApp prêt + URL wa.me + script client final
adminRouter.get('/tickets/:numero/whatsapp-fournisseur/preview', async (req, res) => {
  try {
    const ticket = await SavTicket.findOne({ numero: req.params.numero }).lean();
    if (!ticket) return fail(res, 'Ticket introuvable', 404);
    const wa = require('../../services/whatsappFournisseur');
    const phone = (req.query.phone || (ticket.fournisseur && ticket.fournisseur.contact) || '').toString();
    return ok(res, wa.preview(ticket, phone));
  } catch (err) { return fail(res, err.message, 500); }
});

// POST /admin/api/sav/tickets/:numero/whatsapp-fournisseur/send
// body { phone, parsedReply (facultatif) }
adminRouter.post('/tickets/:numero/whatsapp-fournisseur/send', async (req, res) => {
  try {
    const ticket = await SavTicket.findOne({ numero: req.params.numero });
    if (!ticket) return fail(res, 'Ticket introuvable', 404);
    const wa = require('../../services/whatsappFournisseur');
    const phone = (req.body.phone || (ticket.fournisseur && ticket.fournisseur.contact) || '').toString();
    let result = { sent: false };
    if (wa.isConfigured()) {
      result = await wa.sendReal(ticket, phone);
    } else {
      // Mode dev : on ne peut pas envoyer, on retourne juste le wa.me
      result = wa.preview(ticket, phone);
    }
    ticket.fournisseur = ticket.fournisseur || {};
    if (!ticket.fournisseur.dateEnvoi) ticket.fournisseur.dateEnvoi = new Date();
    if (req.body.parsedReply) {
      ticket.fournisseur.reponse = String(req.body.parsedReply).slice(0, 4000);
      ticket.fournisseur.dateRetour = new Date();
    }
    ticket.addMessage('admin', 'interne', `Dossier WhatsApp envoyé au fournisseur (${phone || '—'})`);
    await ticket.save();
    audit.log({ req, action: 'sav.whatsapp_fournisseur', entityType: 'sav_ticket', entityId: ticket.numero, after: { phone } });
    return ok(res, { result, fournisseur: ticket.fournisseur });
  } catch (err) { return fail(res, err.message, 500); }
});

// POST /admin/api/sav/tickets/:numero/fournisseur — mettre à jour fournisseur
adminRouter.post('/tickets/:numero/fournisseur', async (req, res) => {
  try {
    const ticket = await SavTicket.findOne({ numero: req.params.numero });
    if (!ticket) return fail(res, 'Ticket introuvable', 404);
    const before = JSON.parse(JSON.stringify(ticket.fournisseur || {}));
    const f = req.body || {};
    ticket.fournisseur = ticket.fournisseur || {};
    ['nom','contact','rmaNumero','transporteur','colisNumero','trackingUrl','rapportUrl','reponse'].forEach((k) => {
      if (f[k] != null) ticket.fournisseur[k] = String(f[k]);
    });
    if (f.coutAnalyse != null) ticket.fournisseur.coutAnalyse = Number(f.coutAnalyse) || 0;
    if (f.coutRefacture != null) ticket.fournisseur.coutRefacture = Number(f.coutRefacture) || 0;
    if (f.dateEnvoi) ticket.fournisseur.dateEnvoi = new Date(f.dateEnvoi);
    if (f.dateRetour) ticket.fournisseur.dateRetour = new Date(f.dateRetour);
    if (f.changeStatutToEnAttente) ticket.changerStatut('en_attente_fournisseur', 'admin', { force: true });
    await ticket.save();
    audit.log({ req, action: 'sav.fournisseur', entityType: 'sav_ticket', entityId: ticket.numero, before, after: ticket.fournisseur });
    return ok(res, { numero: ticket.numero, fournisseur: ticket.fournisseur });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// POST /admin/api/sav/tickets/:numero/diagnostic-enrichi — diagnostic banc enrichi
adminRouter.post('/tickets/:numero/diagnostic-enrichi', async (req, res) => {
  try {
    const ticket = await SavTicket.findOne({ numero: req.params.numero });
    if (!ticket) return fail(res, 'Ticket introuvable', 404);
    const body = req.body || {};
    ticket.diagnosticEnrichi = ticket.diagnosticEnrichi || {};
    if (body.mesures) ticket.diagnosticEnrichi.mesures = Object.assign(ticket.diagnosticEnrichi.mesures || {}, body.mesures);
    if (body.avis2eTechnicienTexte != null) ticket.diagnosticEnrichi.avis2eTechnicienTexte = String(body.avis2eTechnicienTexte);
    if (body.videoUrl) ticket.diagnosticEnrichi.videoUrl = String(body.videoUrl);
    if (body.courbeBancUrl) ticket.diagnosticEnrichi.courbeBancUrl = String(body.courbeBancUrl);

    // Score risque calculé : symptômes (5pts/symptome, max 40) + mesures (jusqu'à 60)
    const sympts = (ticket.diagnostic && ticket.diagnostic.symptomes) || [];
    let score = Math.min(40, sympts.length * 5);
    const m = ticket.diagnosticEnrichi.mesures || {};
    if (typeof m.pressionHydraulique === 'number' && m.pressionHydraulique < 5) score += 20;
    if (m.fuiteInterne && m.fuiteInterne.toLowerCase() !== 'non') score += 15;
    if ((m.codesAvantReset || []).length > 0) score += 10;
    if ((m.codesApresReset || []).length > 0) score += 15;
    ticket.diagnosticEnrichi.scoreCalcule = Math.min(100, score);

    await ticket.save();
    audit.log({ req, action: 'sav.diag.enrichi', entityType: 'sav_ticket', entityId: ticket.numero, after: { score: ticket.diagnosticEnrichi.scoreCalcule } });
    return ok(res, { numero: ticket.numero, diagnosticEnrichi: ticket.diagnosticEnrichi });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// POST /admin/api/sav/tickets/:numero/diagnostic-complet — wizard 4 étapes en un seul payload
adminRouter.post('/tickets/:numero/diagnostic-complet', async (req, res) => {
  try {
    const ticket = await SavTicket.findOne({ numero: req.params.numero });
    if (!ticket) return fail(res, 'Ticket introuvable', 404);
    const b = req.body || {};

    // Étape 1 — Mesures
    ticket.diagnosticEnrichi = ticket.diagnosticEnrichi || {};
    ticket.diagnosticEnrichi.mesures = Object.assign(ticket.diagnosticEnrichi.mesures || {}, {
      pressionHydraulique: b.pressionHydraulique != null ? Number(b.pressionHydraulique) : undefined,
      temperatureAvant: b.temperatureAvant != null ? Number(b.temperatureAvant) : undefined,
      temperatureApres: b.temperatureApres != null ? Number(b.temperatureApres) : undefined,
      fuiteInterne: b.fuiteInterne || undefined,
      codesAvantReset: Array.isArray(b.codesAvantReset) ? b.codesAvantReset : (b.codesAvantReset || '').toString().split(/[,\s]+/).filter(Boolean),
      codesApresReset: Array.isArray(b.codesApresReset) ? b.codesApresReset : (b.codesApresReset || '').toString().split(/[,\s]+/).filter(Boolean),
    });

    // Étape 2 — Codes défaut généraux
    ticket.diagnostic = ticket.diagnostic || {};
    if (b.codesDefaut) {
      ticket.diagnostic.codesDefaut = Array.isArray(b.codesDefaut) ? b.codesDefaut : (b.codesDefaut || '').toString().split(/[,\s]+/).filter(Boolean);
    }

    // Étape 3 — Médias
    if (b.videoUrl) ticket.diagnosticEnrichi.videoUrl = String(b.videoUrl);
    if (b.courbeBancUrl) ticket.diagnosticEnrichi.courbeBancUrl = String(b.courbeBancUrl);

    // Étape 4 — Conclusion
    ticket.analyse = ticket.analyse || {};
    if (b.conclusion) ticket.analyse.conclusion = b.conclusion;
    if (b.rapport) ticket.analyse.rapport = b.rapport;
    if (b.avis2eTechnicienTexte != null) ticket.diagnosticEnrichi.avis2eTechnicienTexte = String(b.avis2eTechnicienTexte);

    // Score calculé serveur-side
    const sympts = (ticket.diagnostic && ticket.diagnostic.symptomes) || [];
    let score = Math.min(40, sympts.length * 5);
    const m = ticket.diagnosticEnrichi.mesures || {};
    if (typeof m.pressionHydraulique === 'number' && m.pressionHydraulique < 5) score += 20;
    if (m.fuiteInterne && String(m.fuiteInterne).toLowerCase() !== 'non') score += 15;
    if ((m.codesAvantReset || []).length > 0) score += 10;
    if ((m.codesApresReset || []).length > 0) score += 15;
    score = Math.min(100, score);
    ticket.diagnosticEnrichi.scoreCalcule = score;
    ticket.diagnostic.scoreRisque = score;

    if (b.conclusion) {
      ticket.analyse.facture149 = { status: b.conclusion === 'defaut_produit' ? 'na' : 'a_facturer' };
      ticket.changerStatut('analyse_terminee', 'admin', { force: true });
    }

    await ticket.save();
    audit.log({ req, action: 'sav.diagnostic.complet', entityType: 'sav_ticket', entityId: ticket.numero, after: { conclusion: ticket.analyse && ticket.analyse.conclusion, score } });
    return ok(res, { numero: ticket.numero, scoreCalcule: score, diagnosticEnrichi: ticket.diagnosticEnrichi, analyse: ticket.analyse });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// POST /admin/api/sav/tickets/:numero/communication — envoyer un message client (email/whatsapp/interne)
// Note : WhatsApp non câblé dans cette release, le canal whatsapp est loggé "envoyé" uniquement
adminRouter.post('/tickets/:numero/communication', upload.array('attachments', 5), async (req, res) => {
  try {
    const ticket = await SavTicket.findOne({ numero: req.params.numero });
    if (!ticket) return fail(res, 'Ticket introuvable', 404);
    const { canal: canalRaw, sujet, contenu, html, isReturnLabel } = req.body || {};
    if (!canalRaw || !contenu) return fail(res, 'canal et contenu requis');
    // Compatibilité ascendante : ancien canal "email" est désormais traité comme "inapp"
    // (toute communication client passe par l'app — l'email n'est utilisé que pour notifier)
    const canal = canalRaw === 'email' ? 'inapp' : canalRaw;
    const ALLOWED_CANAUX = ['inapp', 'interne', 'whatsapp', 'tel'];
    if (!ALLOWED_CANAUX.includes(canal)) return fail(res, `canal invalide (attendu : ${ALLOWED_CANAUX.join('|')})`, 400);

    // Persister les PJ en MongoDB (GridFS) — aucun fichier sur disque.
    // Les PJ sont consultables via l'espace client (jamais envoyées par email puisque la
    // doctrine impose que toute conversation se passe in-app).
    const savedAttachments = [];
    if (Array.isArray(req.files) && req.files.length) {
      for (const f of req.files) {
        const kind = isReturnLabel ? 'etiquette_retour' : 'admin_message';
        const stored = await savFileStorage.saveBuffer({
          buffer: f.buffer,
          filename: f.originalname,
          mime: f.mimetype,
          metadata: {
            ticketNumero: ticket.numero,
            kind,
            uploadedBy: 'admin',
          },
        });
        const url = stored.url;
        ticket.documentsList = ticket.documentsList || [];
        ticket.documentsList.push({
          kind,
          url,
          originalName: f.originalname,
          size: f.size,
          mime: f.mimetype,
        });
        savedAttachments.push({ url, name: f.originalname });
      }
    }

    // Pour le canal "inapp" : on persiste le message dans le ticket (visible dans l'espace
    // client/invité) puis on envoie une notification email COURTE — sans le contenu — pour
    // signaler au client qu'il a une nouvelle réponse à consulter dans son espace SAV.
    // L'email sert uniquement de notification (pas de canal de conversation).
    let notificationResult = null;
    if (canal === 'inapp') {
      try {
        const { sendEmail } = require('../../services/emailService');
        const { buildGuestLink } = require('../../controllers/savGuestController');
        const ejs = require('ejs');
        const guestLink = buildGuestLink(ticket) || `${process.env.SITE_URL || 'https://carpartsfrance.fr'}/sav/suivi`;
        const tplPath = path.join(__dirname, '..', '..', 'views', 'emails', 'sav', 'reponse_agent.ejs');
        // contenu n'est PAS passé au template (notification only)
        const emailHtml = await ejs.renderFile(tplPath, { ticket, guestLink, brand });
        const stripped = emailHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        notificationResult = await sendEmail({
          toEmail: ticket.client && ticket.client.email,
          subject: `Nouvelle réponse SAV — ${ticket.numero}`,
          html: emailHtml,
          text: stripped,
          // Pas de PJ dans la notification : elles sont consultables dans l'espace SAV
        });
      } catch (e) {
        console.error('[sav-comm notif]', e.message);
        notificationResult = { ok: false, reason: 'exception', message: e.message };
      }
      // L'échec de la notification ne bloque PAS la persistance du message :
      // on log mais on continue (le client verra le message en se connectant manuellement).
      if (!notificationResult || notificationResult.ok !== true) {
        console.warn(`[sav-comm] notification email non envoyée pour ${ticket.numero}: ${notificationResult && notificationResult.reason}`);
      }
    }

    let logContenu = contenu;
    if (savedAttachments.length) {
      logContenu += '\n\n— Pièces jointes : ' + savedAttachments.map((a) => a.name).join(', ');
    }
    ticket.addMessage('admin', canal, logContenu);
    await ticket.save();
    audit.log({ req, action: 'sav.comm.' + canal, entityType: 'sav_ticket', entityId: ticket.numero, after: { attachments: savedAttachments.length } });
    return ok(res, { numero: ticket.numero, attachments: savedAttachments });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// ----------------------------------------------------------------------
// POST /admin/api/sav/tickets/:numero/reformulate
// Reformule un brouillon de réponse SAV via OpenAI (ton CarParts France).
// Body: { draft: string, audience?: 'client'|'interne' }
// Réponse: { reformulated: string, model: string }
// Rate-limit : 60 reformulations / heure / token admin (en mémoire process).
// ----------------------------------------------------------------------
const REFORMULATE_RATE_MAX = 60;
const REFORMULATE_RATE_WINDOW_MS = 60 * 60 * 1000;
const reformulateUsage = new Map(); // key (token) -> { count, windowStart }

function checkReformulateRate(key) {
  const now = Date.now();
  const cur = reformulateUsage.get(key);
  if (!cur || now - cur.windowStart > REFORMULATE_RATE_WINDOW_MS) {
    reformulateUsage.set(key, { count: 1, windowStart: now });
    return { allowed: true, remaining: REFORMULATE_RATE_MAX - 1 };
  }
  if (cur.count >= REFORMULATE_RATE_MAX) {
    const resetIn = Math.ceil((REFORMULATE_RATE_WINDOW_MS - (now - cur.windowStart)) / 1000);
    return { allowed: false, remaining: 0, resetIn };
  }
  cur.count += 1;
  return { allowed: true, remaining: REFORMULATE_RATE_MAX - cur.count };
}

adminRouter.post('/tickets/:numero/reformulate', express.json({ limit: '32kb' }), async (req, res) => {
  try {
    const reformulator = require('../../services/openaiSavReformulate');
    const draft = (req.body && typeof req.body.draft === 'string') ? req.body.draft : '';
    if (!draft.trim()) return fail(res, 'draft requis', 400);
    if (draft.length > reformulator.MAX_INPUT_CHARS) {
      return fail(res, `Brouillon trop long (max ${reformulator.MAX_INPUT_CHARS} caractères)`, 413);
    }

    // Rate-limit par token admin (le token Bearer fait office d'identifiant)
    const rateKey = (req.headers.authorization || '').slice(0, 80) || req.ip || 'anon';
    const rate = checkReformulateRate(rateKey);
    if (!rate.allowed) {
      res.set('Retry-After', String(rate.resetIn));
      return fail(res, `Quota de reformulation atteint (${REFORMULATE_RATE_MAX}/h). Réessayez dans ${rate.resetIn}s.`, 429);
    }

    // Contexte : nom client + numéro ticket pour personnalisation
    const ticket = await SavTicket
      .findOne({ numero: req.params.numero })
      .select('numero client.nom')
      .lean();
    const opts = {};
    if (ticket && ticket.client && ticket.client.nom) opts.clientName = ticket.client.nom;
    if (ticket) opts.ticketNumero = ticket.numero;

    const result = await reformulator.reformulate(draft, opts);
    res.set('X-RateLimit-Remaining', String(rate.remaining));
    return ok(res, { reformulated: result.reformulated, model: result.model });
  } catch (err) {
    const status = err.code === 'OPENAI_KEY_MISSING' ? 503
      : err.code === 'INPUT_TOO_LONG' ? 413
      : err.code === 'EMPTY_DRAFT' ? 400
      : 500;
    return fail(res, err.message || 'Erreur reformulation', status);
  }
});

// GET /admin/api/sav/settings — récupérer paramètres
adminRouter.get('/settings', async (req, res) => {
  try {
    const s = await SavSettings.getSingleton();
    return ok(res, s.toObject());
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// POST /admin/api/sav/settings — sauver paramètres
adminRouter.post('/settings', async (req, res) => {
  try {
    const s = await SavSettings.getSingleton();
    const before = s.toObject();
    if (Array.isArray(req.body.slaPerPiece)) s.slaPerPiece = req.body.slaPerPiece;
    if (Array.isArray(req.body.automationRules)) s.automationRules = req.body.automationRules;
    if (req.body.integrations && typeof req.body.integrations === 'object') {
      s.integrations = Object.assign(s.integrations || {}, req.body.integrations);
    }
    await s.save();
    audit.log({ req, action: 'sav.settings.update', entityType: 'sav_settings', entityId: 'global', before, after: s.toObject() });
    return ok(res, s.toObject());
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// Slash command Slack : POST publique (pas d'auth Bearer)
// Format Slack : application/x-www-form-urlencoded { command, text, user_id, user_name, response_url, ... }
publicRouter.post('/slack/command', express.urlencoded({ extended: false }), async (req, res) => {
  try {
    // Validation simple : un secret partagé optionnel
    const expected = (process.env.SLACK_COMMAND_SECRET || '').trim();
    if (expected && (req.headers['x-slack-secret'] || '') !== expected) {
      return res.status(401).json({ text: 'Non autorisé' });
    }
    const { command, text, user_name } = req.body || {};
    // /sav-prendre <numero>
    if (!text) return res.json({ text: 'Usage : /sav-prendre <numero>' });
    const numero = String(text).trim().split(/\s+/)[0];
    const ticket = await SavTicket.findOne({ numero });
    if (!ticket) return res.json({ text: `Ticket ${numero} introuvable.` });
    ticket.assignedToName = user_name || 'slack';
    ticket.assignedAt = new Date();
    ticket.addMessage('admin', 'interne', `Ticket pris en charge depuis Slack par ${user_name || 'inconnu'}`);
    await ticket.save();
    audit.log({ action: 'sav.assign.slack', userEmail: 'slack:' + (user_name || ''), entityType: 'sav_ticket', entityId: ticket.numero });
    return res.json({
      response_type: 'in_channel',
      text: `✅ ${user_name || 'Vous'} a pris en charge le ticket *${numero}*`,
    });
  } catch (err) {
    return res.json({ text: 'Erreur serveur : ' + err.message });
  }
});

// POST /admin/api/sav/automations/run — déclencher manuellement le moteur
adminRouter.post('/automations/run', async (req, res) => {
  try {
    const auto = require('../../services/savAutomations');
    const summary = await auto.runRules();
    audit.log({ req, action: 'sav.automations.run', entityType: 'sav_settings', entityId: 'global', after: summary });
    return ok(res, summary);
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// ============================================================
// 4.5 ANALYTICS SAV
// ============================================================

// GET /admin/api/sav/analytics
adminRouter.get('/analytics', async (req, res) => {
  try {
    const STATUTS_CLOS = ['clos', 'refuse', 'resolu_garantie', 'resolu_facture', 'clos_sans_reponse'];

    // 1) Nb SAV par mois sur 12 mois
    const start12 = new Date(); start12.setMonth(start12.getMonth() - 11); start12.setDate(1); start12.setHours(0,0,0,0);
    const monthly = await SavTicket.aggregate([
      { $match: { createdAt: { $gte: start12 } } },
      { $group: { _id: { y: { $year: '$createdAt' }, m: { $month: '$createdAt' } }, count: { $sum: 1 } } },
      { $sort: { '_id.y': 1, '_id.m': 1 } },
    ]);
    const monthLabels = []; const monthCounts = [];
    for (let i = 0; i < 12; i++) {
      const d = new Date(start12); d.setMonth(start12.getMonth() + i);
      const y = d.getFullYear(); const m = d.getMonth() + 1;
      monthLabels.push(`${String(m).padStart(2,'0')}/${String(y).slice(2)}`);
      const f = monthly.find((x) => x._id.y === y && x._id.m === m);
      monthCounts.push(f ? f.count : 0);
    }

    // 2) Top 5 pièces SAV
    const topPieces = await SavTicket.aggregate([
      { $group: { _id: '$pieceType', count: { $sum: 1 } } },
      { $sort: { count: -1 } },
      { $limit: 5 },
    ]);

    // 3) Taux défaut produit par fournisseur (camembert)
    const fournisseurStats = await SavTicket.aggregate([
      { $match: { 'fournisseur.nom': { $exists: true, $ne: '' }, 'analyse.conclusion': { $exists: true } } },
      {
        $group: {
          _id: '$fournisseur.nom',
          total: { $sum: 1 },
          defauts: { $sum: { $cond: [{ $eq: ['$analyse.conclusion', 'defaut_produit'] }, 1, 0] } },
        },
      },
    ]);
    const fournisseurChart = fournisseurStats.map((f) => ({
      nom: f._id,
      total: f.total,
      defauts: f.defauts,
      taux: f.total > 0 ? Math.round((f.defauts / f.total) * 100) : 0,
    })).sort((a, b) => b.total - a.total);

    // 4) Temps moyen résolution par type de pièce
    const tousResolus = await SavTicket.find({ statut: { $in: STATUTS_CLOS } })
      .select('pieceType createdAt updatedAt').lean();
    const sumByType = {};
    tousResolus.forEach((t) => {
      const days = (new Date(t.updatedAt || t.createdAt) - new Date(t.createdAt)) / (1000 * 60 * 60 * 24);
      sumByType[t.pieceType] = sumByType[t.pieceType] || { sum: 0, count: 0 };
      sumByType[t.pieceType].sum += Math.max(0, days);
      sumByType[t.pieceType].count += 1;
    });
    const avgByType = Object.keys(sumByType).map((k) => ({
      pieceType: k,
      avgDays: Math.round((sumByType[k].sum / sumByType[k].count) * 10) / 10,
      count: sumByType[k].count,
    })).sort((a, b) => b.count - a.count);

    // 5) Coûts SAV (garantie + remboursement) vs CA récupéré (149€)
    const [paid149, resolus] = await Promise.all([
      SavTicket.countDocuments({ 'paiements.facture149.status': 'payee' }),
      SavTicket.find({ statut: 'resolu_garantie', 'resolution.montant': { $gt: 0 } }).select('resolution.montant').lean(),
    ]);
    const caRecupere = paid149 * 149;
    const coutGarantie = resolus.reduce((acc, t) => acc + (t.resolution && t.resolution.montant || 0), 0);

    // 6) Taux de récidive (clients ayant > 1 ticket)
    const clientGroups = await SavTicket.aggregate([
      { $match: { 'client.email': { $exists: true, $ne: '' } } },
      { $group: { _id: '$client.email', count: { $sum: 1 } } },
    ]);
    const totalClients = clientGroups.length;
    const recidivistes = clientGroups.filter((c) => c.count > 1).length;
    const tauxRecidive = totalClients > 0 ? Math.round((recidivistes / totalClients) * 100) : 0;

    // 7) Map France : agrégation par département depuis le code postal du garage adresse (best effort)
    // → on prend les 2 premiers chiffres de la portion numérique trouvée dans garage.adresse
    const allTickets = await SavTicket.find({ 'garage.adresse': { $exists: true, $ne: '' } }).select('garage.adresse').lean();
    const deptCounts = {};
    allTickets.forEach((t) => {
      const m = (t.garage && t.garage.adresse || '').match(/\b(\d{5})\b/);
      if (m) {
        const dept = m[1].slice(0, 2);
        deptCounts[dept] = (deptCounts[dept] || 0) + 1;
      }
    });
    const departments = Object.entries(deptCounts)
      .map(([dept, count]) => ({ dept, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 30);

    return ok(res, {
      monthly: { labels: monthLabels, counts: monthCounts },
      topPieces,
      fournisseur: fournisseurChart,
      avgByType,
      financier: { caRecupere, coutGarantie, balance: caRecupere - coutGarantie, paid149, garantieCount: resolus.length },
      recidive: { totalClients, recidivistes, tauxRecidive },
      departments,
    });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// GET /admin/api/sav/analytics.csv — export Excel-friendly (CSV BOM UTF-8)
adminRouter.get('/analytics.csv', async (req, res) => {
  try {
    const tickets = await SavTicket.find({}).sort({ createdAt: -1 }).limit(10000).lean();
    const head = [
      'numero','createdAt','statut','pieceType','client_email','client_nom',
      'vin','immatriculation','marque','modele','annee','kilometrage',
      'assigne','sla_limite','conclusion_analyse','facture149_status','facture149_montant',
      'fournisseur_nom','fournisseur_rma','reviewNote',
    ];
    const rows = tickets.map((t) => {
      const v = t.vehicule || {}; const f = t.fournisseur || {}; const r = t.reviewFeedback || {};
      const p149 = (t.paiements && t.paiements.facture149) || {};
      return [
        t.numero,
        new Date(t.createdAt).toISOString(),
        t.statut, t.pieceType,
        (t.client && t.client.email) || '',
        (t.client && t.client.nom) || '',
        v.vin || '', v.immatriculation || '', v.marque || '', v.modele || '', v.annee || '', v.kilometrage || '',
        t.assignedToName || '',
        (t.sla && t.sla.dateLimite) ? new Date(t.sla.dateLimite).toISOString() : '',
        (t.analyse && t.analyse.conclusion) || '',
        p149.status || '',
        p149.status === 'payee' ? '149' : '',
        f.nom || '', f.rmaNumero || '',
        r.note || '',
      ];
    });
    function csvCell(v) {
      const s = String(v == null ? '' : v).replace(/"/g, '""');
      return /[",\n;]/.test(s) ? '"' + s + '"' : s;
    }
    const csv = [head.join(';'), ...rows.map((r) => r.map(csvCell).join(';'))].join('\n');
    res.setHeader('Content-Type', 'application/vnd.ms-excel; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="sav-analytics-${Date.now()}.csv"`);
    return res.end('\ufeff' + csv);
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// GET /admin/api/sav/reputation — KPIs feedback + liste privée
adminRouter.get('/reputation', async (req, res) => {
  try {
    const [sent, completed, redirected, allCompleted, privateOnes] = await Promise.all([
      SavTicket.countDocuments({ 'reviewFeedback.sentAt': { $exists: true } }),
      SavTicket.countDocuments({ 'reviewFeedback.completedAt': { $exists: true } }),
      SavTicket.countDocuments({ 'reviewFeedback.redirectedToGoogle': true }),
      SavTicket.find({ 'reviewFeedback.note': { $exists: true, $gt: 0 } }).select('reviewFeedback').lean(),
      SavTicket.find({ 'reviewFeedback.completedAt': { $exists: true }, 'reviewFeedback.note': { $lt: 4 } })
        .sort({ 'reviewFeedback.completedAt': -1 }).limit(50).select('numero reviewFeedback').lean(),
    ]);
    const sumNote = allCompleted.reduce((a, t) => a + (t.reviewFeedback && t.reviewFeedback.note || 0), 0);
    const avgNote = allCompleted.length ? Math.round((sumNote / allCompleted.length) * 10) / 10 : 0;
    return ok(res, { sent, completed, redirected, avgNote, privateFeedbacks: privateOnes });
  } catch (err) { return fail(res, err.message, 500); }
});

// GET /admin/api/sav/audit — consultation logs filtrable
adminRouter.get('/audit', async (req, res) => {
  try {
    const q = {};
    if (req.query.action) q.action = new RegExp(req.query.action, 'i');
    if (req.query.userEmail) q.userEmail = new RegExp(req.query.userEmail, 'i');
    if (req.query.entityId) q.entityId = req.query.entityId;
    const limit = Math.min(500, parseInt(req.query.limit, 10) || 100);
    const items = await AuditLog.find(q).sort({ createdAt: -1 }).limit(limit).lean();
    return ok(res, { items });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// GET /admin/api/sav/tickets/:numero — détail
adminRouter.get('/tickets/:numero', async (req, res) => {
  try {
    const ticket = await SavTicket.findOne({ numero: req.params.numero }).lean();
    if (!ticket) return fail(res, 'Ticket introuvable', 404);
    // Marque comme lu côté admin (ne bloque pas la réponse)
    SavTicket.updateOne({ _id: ticket._id }, { $set: { lastAdminReadAt: new Date() } }).catch(() => {});
    return ok(res, ticket);
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// PATCH /admin/api/sav/tickets/:numero/statut
adminRouter.patch('/tickets/:numero/statut', async (req, res) => {
  try {
    const { statut, auteur, force } = req.body || {};
    if (!statut) return fail(res, 'statut requis');
    const ticket = await SavTicket.findOne({ numero: req.params.numero });
    if (!ticket) return fail(res, 'Ticket introuvable', 404);
    const before = { statut: ticket.statut };
    try {
      ticket.changerStatut(statut, auteur || 'admin', { force: !!force });
    } catch (fsmErr) {
      // Erreur FSM → 409 Conflict (transition refusée)
      return fail(res, fsmErr.message, 409);
    }
    await ticket.save();
    audit.log({ req, action: 'sav.statut', entityType: 'sav_ticket', entityId: ticket.numero, before, after: { statut: ticket.statut } });
    return ok(res, { numero: ticket.numero, statut: ticket.statut });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// POST /admin/api/sav/tickets/bulk-delete — supprimer plusieurs tickets
adminRouter.post('/tickets/bulk-delete', async (req, res) => {
  try {
    const raw = (req.body && req.body.numeros) || [];
    const list = Array.isArray(raw) ? raw : [raw];
    const unique = Array.from(new Set(list.map((v) => String(v).trim()).filter(Boolean)));
    if (!unique.length) return fail(res, 'Aucun ticket sélectionné.');

    const tickets = await SavTicket.find({ numero: { $in: unique } }).select('numero').lean();
    if (!tickets.length) return fail(res, 'Aucun ticket trouvé.', 404);

    const found = tickets.map((t) => t.numero);
    const result = await SavTicket.deleteMany({ numero: { $in: found } });
    const deletedCount = Number.isFinite(result && result.deletedCount) ? result.deletedCount : 0;

    audit.log({ req, action: 'sav.bulk_delete', entityType: 'sav_ticket', entityId: found.join(','), before: { count: found.length }, after: { deletedCount } });
    return ok(res, { deletedCount, deletedNumeros: found });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// DELETE /admin/api/sav/tickets/:numero — supprimer un ticket
adminRouter.delete('/tickets/:numero', async (req, res) => {
  try {
    const ticket = await SavTicket.findOne({ numero: req.params.numero }).select('numero');
    if (!ticket) return fail(res, 'Ticket introuvable', 404);
    await SavTicket.deleteOne({ _id: ticket._id });
    audit.log({ req, action: 'sav.delete', entityType: 'sav_ticket', entityId: ticket.numero, before: { numero: ticket.numero }, after: null });
    return ok(res, { numero: ticket.numero });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// GET /admin/api/sav/tickets/:numero/playbook
// Retourne le playbook sérialisé pour le ticket (stepper + macros + templates).
adminRouter.get('/tickets/:numero/playbook', async (req, res) => {
  try {
    const ticket = await SavTicket.findOne({ numero: req.params.numero }).lean();
    if (!ticket) return fail(res, 'Ticket introuvable', 404);
    const pbEngine = require('../../config/savPlaybooks');
    return ok(res, pbEngine.playbookForTicket(ticket));
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// POST /admin/api/sav/tickets/:numero/close
// Clôture qualifiée : valide la checklist puis passe le ticket dans un
// statut terminal. Exige rootCause renseigné pour alimenter le reporting.
adminRouter.post('/tickets/:numero/close', async (req, res) => {
  try {
    const {
      targetStatut,        // 'clos' | 'resolu_garantie' | 'resolu_facture' | 'refuse'
      clientNotified,
      refundDone,
      docsArchived,
      rootCause,
      rootCauseDetail,
    } = req.body || {};
    const ALLOWED = ['clos', 'resolu_garantie', 'resolu_facture', 'refuse'];
    if (!ALLOWED.includes(targetStatut)) {
      return fail(res, 'targetStatut invalide (clos|resolu_garantie|resolu_facture|refuse)');
    }
    if (!rootCause) {
      return fail(res, 'rootCause requise (sélectionnez la cause racine)');
    }
    if (!clientNotified || !docsArchived) {
      return fail(res, 'La checklist n\'est pas complète : client notifié + documents archivés sont obligatoires.');
    }
    const ticket = await SavTicket.findOne({ numero: req.params.numero });
    if (!ticket) return fail(res, 'Ticket introuvable', 404);

    const before = { statut: ticket.statut };
    ticket.closure = ticket.closure || {};
    ticket.closure.clientNotified = !!clientNotified;
    ticket.closure.refundDone = !!refundDone;
    ticket.closure.docsArchived = !!docsArchived;
    ticket.closure.rootCause = rootCause;
    ticket.closure.rootCauseDetail = rootCauseDetail || '';
    ticket.closure.closedBy = (req.session && req.session.user && req.session.user.email) || 'admin';
    ticket.closure.closedAt = new Date();

    try {
      ticket.changerStatut(targetStatut, ticket.closure.closedBy, { force: true });
    } catch (fsmErr) {
      return fail(res, fsmErr.message, 409);
    }
    ticket.addMessage('systeme', 'interne',
      `Clôture qualifiée — ${targetStatut} · cause: ${rootCause}` + (rootCauseDetail ? ` (${rootCauseDetail})` : ''));
    await ticket.save();
    audit.log({ req, action: 'sav.close', entityType: 'sav_ticket', entityId: ticket.numero,
      before, after: { statut: ticket.statut, rootCause, closedBy: ticket.closure.closedBy } });
    return ok(res, { numero: ticket.numero, statut: ticket.statut, closure: ticket.closure });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// GET /admin/api/sav/kpi
// Dashboard : calcule les 4 KPIs essentiels sur une fenêtre glissante.
//   - FRT  (First Response Time)  : médiane des délais de première
//                                    réponse admin, en heures.
//   - RT   (Resolution Time)       : médiane des délais de résolution.
//   - breachRate : % de tickets clos avec SLA dépassé.
//   - backlog    : pyramide des âges des tickets ouverts.
adminRouter.get('/kpi', async (req, res) => {
  try {
    const days = Math.min(365, Math.max(1, parseInt(req.query.days, 10) || 30));
    const since = new Date(Date.now() - days * 86400000);
    const TERMINAL = ['clos', 'resolu_garantie', 'resolu_facture', 'refuse'];

    const [allTickets, openTickets] = await Promise.all([
      SavTicket.find({ createdAt: { $gte: since } })
        .select('numero createdAt statut messages sla updatedAt')
        .lean(),
      SavTicket.find({ statut: { $nin: TERMINAL } })
        .select('numero createdAt statut sla')
        .lean(),
    ]);

    // FRT : temps entre createdAt et premier message admin non-système
    const frtSamples = [];
    const rtSamples = [];
    let breached = 0;
    let resolved = 0;
    for (const t of allTickets) {
      // FRT
      const firstAdminMsg = (t.messages || []).find((m) =>
        m && m.auteur === 'admin' && !/^(Statut|Document|Assignation|Macro|Clôture)/i.test(m.contenu || ''));
      if (firstAdminMsg && firstAdminMsg.createdAt && t.createdAt) {
        const h = (new Date(firstAdminMsg.createdAt) - new Date(t.createdAt)) / 3600000;
        if (h >= 0) frtSamples.push(h);
      }
      // Resolution time + breach rate
      if (TERMINAL.includes(t.statut)) {
        resolved++;
        if (t.updatedAt && t.createdAt) {
          const h = (new Date(t.updatedAt) - new Date(t.createdAt)) / 3600000;
          if (h >= 0) rtSamples.push(h);
        }
        if (t.sla && t.sla.dateLimite && t.updatedAt && new Date(t.updatedAt) > new Date(t.sla.dateLimite)) {
          breached++;
        }
      }
    }

    const median = (arr) => {
      if (!arr.length) return null;
      const s = arr.slice().sort((a, b) => a - b);
      const mid = Math.floor(s.length / 2);
      return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
    };

    // Backlog aging
    const buckets = { lt1: 0, '1-3': 0, '3-7': 0, '7-14': 0, '14plus': 0 };
    for (const t of openTickets) {
      if (!t.createdAt) continue;
      const d = (Date.now() - new Date(t.createdAt).getTime()) / 86400000;
      if (d < 1) buckets.lt1++;
      else if (d < 3) buckets['1-3']++;
      else if (d < 7) buckets['3-7']++;
      else if (d < 14) buckets['7-14']++;
      else buckets['14plus']++;
    }

    return ok(res, {
      windowDays: days,
      totals: {
        created: allTickets.length,
        resolved,
        openNow: openTickets.length,
      },
      frtHoursMedian: median(frtSamples),
      rtHoursMedian: median(rtSamples),
      breachRate: resolved ? Math.round((breached / resolved) * 1000) / 10 : 0,
      backlogAging: buckets,
    });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// POST /admin/api/sav/tickets/:numero/macro
// Exécute une macro du playbook (action 1-clic) :
//   { macroId }
// La macro décrit côté config : subject, body, nextStatut, action.
// On se contente ici de changer le statut + logger la timeline interne.
// Les envois email restent gérés par l'endpoint /communication existant,
// que le frontend appelle après avoir récupéré le payload pré-rempli.
adminRouter.post('/tickets/:numero/macro', async (req, res) => {
  try {
    const { macroId, forceStatut } = req.body || {};
    if (!macroId) return fail(res, 'macroId requis');
    const ticket = await SavTicket.findOne({ numero: req.params.numero });
    if (!ticket) return fail(res, 'Ticket introuvable', 404);
    const pbEngine = require('../../config/savPlaybooks');
    const pb = pbEngine.getPlaybook(ticket.motifSav || 'autre');
    const macro = (pb.macros || []).find((m) => m.id === macroId);
    if (!macro) return fail(res, 'Macro inconnue pour ce motif', 404);
    // Changement de statut (si la macro en déclare un)
    const target = forceStatut || macro.nextStatut;
    if (target && target !== ticket.statut) {
      try {
        ticket.changerStatut(target, 'admin');
      } catch (fsmErr) {
        return fail(res, fsmErr.message, 409);
      }
    }
    ticket.addMessage('systeme', 'interne', `Macro exécutée : ${macro.label}`);
    await ticket.save();
    audit.log({ req, action: 'sav.macro', entityType: 'sav_ticket', entityId: ticket.numero, after: { macroId, statut: ticket.statut } });
    return ok(res, { numero: ticket.numero, statut: ticket.statut, macroId });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// POST /admin/api/sav/tickets/:numero/diagnostic
adminRouter.post('/tickets/:numero/diagnostic', async (req, res) => {
  try {
    const ticket = await SavTicket.findOne({ numero: req.params.numero });
    if (!ticket) return fail(res, 'Ticket introuvable', 404);
    const { conclusion, rapport, photosBanc, symptomes, codesDefaut, scoreRisque, redFlags } =
      req.body || {};
    if (!conclusion) return fail(res, 'conclusion requise');
    ticket.analyse = ticket.analyse || {};
    ticket.analyse.conclusion = conclusion;
    if (rapport) ticket.analyse.rapport = rapport;
    if (Array.isArray(photosBanc)) ticket.analyse.photosBanc = photosBanc;
    if (symptomes || codesDefaut || scoreRisque != null || redFlags) {
      ticket.diagnostic = ticket.diagnostic || {};
      if (symptomes) ticket.diagnostic.symptomes = symptomes;
      if (codesDefaut) ticket.diagnostic.codesDefaut = codesDefaut;
      if (scoreRisque != null) ticket.diagnostic.scoreRisque = scoreRisque;
      if (redFlags) ticket.diagnostic.redFlags = redFlags;
    }
    // Si conclusion ≠ defaut_produit → 149€ à facturer
    if (conclusion !== 'defaut_produit') {
      ticket.analyse.facture149 = { status: 'a_facturer' };
    } else {
      ticket.analyse.facture149 = { status: 'na' };
    }
    ticket.changerStatut('analyse_terminee', 'admin', { force: true });
    await ticket.save();
    audit.log({ req, action: 'sav.diagnostic', entityType: 'sav_ticket', entityId: ticket.numero, after: { conclusion: ticket.analyse.conclusion } });

    // 4.1 — Si conclusion ≠ défaut produit, déclencher facturation Qonto + Mollie + mail client
    if (conclusion !== 'defaut_produit') {
      try {
        const ms = require('../../services/mollieService');
        ms.createQontoAndMollieAndNotify(ticket.numero).catch((e) => {
          console.error('[sav-api] facturation auto fail', e.message);
        });
      } catch (e) {
        console.error('[sav-api] facturation require fail', e.message);
      }
    } else {
      // 4.3 — Notif Slack défaut produit
      try { require('../../services/slackNotifier').notifyDefautProduit(ticket); } catch (_) {}
    }

    return ok(res, { numero: ticket.numero, analyse: ticket.analyse });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// POST /admin/api/sav/tickets/:numero/resolution
adminRouter.post('/tickets/:numero/resolution', async (req, res) => {
  try {
    const ticket = await SavTicket.findOne({ numero: req.params.numero });
    if (!ticket) return fail(res, 'Ticket introuvable', 404);
    const { type, montant } = req.body || {};
    if (!type) return fail(res, 'type requis');
    ticket.resolution = { type, montant: montant || 0, dateResolution: new Date() };
    const nouveauStatut =
      ticket.analyse && ticket.analyse.conclusion === 'defaut_produit'
        ? 'resolu_garantie'
        : 'resolu_facture';
    ticket.changerStatut(nouveauStatut, 'admin', { force: true });
    await ticket.save();
    audit.log({ req, action: 'sav.resolution', entityType: 'sav_ticket', entityId: ticket.numero, after: ticket.resolution });
    return ok(res, { numero: ticket.numero, resolution: ticket.resolution, statut: ticket.statut });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// POST /admin/api/sav/tickets/:numero/messages
adminRouter.post('/tickets/:numero/messages', async (req, res) => {
  try {
    const ticket = await SavTicket.findOne({ numero: req.params.numero });
    if (!ticket) return fail(res, 'Ticket introuvable', 404);
    const { auteur, canal: canalRaw, contenu } = req.body || {};
    if (!canalRaw || !contenu) return fail(res, 'canal et contenu requis');
    // Doctrine : tout passe par l'app — l'ancien canal "email" est traité comme "inapp".
    const canal = canalRaw === 'email' ? 'inapp' : canalRaw;
    ticket.addMessage(auteur || 'admin', canal, contenu);
    await ticket.save();

    // Notifie le client par email à chaque message public d'un agent (notification only,
    // sans le contenu — il doit consulter son espace SAV pour voir la réponse).
    const messageAuteur = auteur || 'admin';
    if (canal === 'inapp' && messageAuteur !== 'client' && ticket.client && ticket.client.email) {
      try {
        const { sendEmail } = require('../../services/emailService');
        const { buildGuestLink } = require('../../controllers/savGuestController');
        const ejs = require('ejs');
        const guestLink = buildGuestLink(ticket) || `${process.env.SITE_URL || 'https://carpartsfrance.fr'}/sav/suivi`;
        const tplPath = path.join(__dirname, '..', '..', 'views', 'emails', 'sav', 'reponse_agent.ejs');
        // contenu absent : notification only
        const emailHtml = await ejs.renderFile(tplPath, { ticket, guestLink, brand });
        const stripped = emailHtml.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
        sendEmail({
          toEmail: ticket.client.email,
          subject: `Nouvelle réponse SAV — ${ticket.numero}`,
          html: emailHtml,
          text: stripped,
        }).catch(() => {});
      } catch (e) {
        console.error('[sav-msg-notif]', e.message);
      }
    }
    return ok(res, { ok: true, count: ticket.messages.length });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// PATCH /admin/api/sav/tickets/:numero/messages/:messageId — modifier le contenu d'un message
adminRouter.patch('/tickets/:numero/messages/:messageId', express.json({ limit: '64kb' }), async (req, res) => {
  try {
    const ticket = await SavTicket.findOne({ numero: req.params.numero });
    if (!ticket) return fail(res, 'Ticket introuvable', 404);
    const msg = ticket.messages.id(req.params.messageId);
    if (!msg) return fail(res, 'Message introuvable', 404);
    const newContenu = (req.body && typeof req.body.contenu === 'string') ? req.body.contenu.trim() : '';
    if (!newContenu) return fail(res, 'Contenu vide', 400);
    if (newContenu.length > 20000) return fail(res, 'Contenu trop long (>20000 caractères)', 400);

    const before = { contenu: msg.contenu, editedAt: msg.editedAt || null };
    const editor = (req.headers['x-admin-user'] || 'admin').toString().slice(0, 80);
    msg.contenu = newContenu;
    msg.editedAt = new Date();
    msg.editedBy = editor;
    await ticket.save();

    audit.log({
      req,
      action: 'sav.message.edit',
      entityType: 'sav_ticket',
      entityId: ticket.numero,
      before,
      after: { contenu: msg.contenu, editedAt: msg.editedAt, editedBy: msg.editedBy, messageId: String(msg._id) },
    });

    return ok(res, {
      messageId: String(msg._id),
      contenu: msg.contenu,
      editedAt: msg.editedAt,
      editedBy: msg.editedBy,
    });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// DELETE /admin/api/sav/tickets/:numero/messages/:messageId — supprimer définitivement un message
adminRouter.delete('/tickets/:numero/messages/:messageId', async (req, res) => {
  try {
    const ticket = await SavTicket.findOne({ numero: req.params.numero });
    if (!ticket) return fail(res, 'Ticket introuvable', 404);
    const msg = ticket.messages.id(req.params.messageId);
    if (!msg) return fail(res, 'Message introuvable', 404);

    const snapshot = {
      messageId: String(msg._id),
      auteur: msg.auteur,
      canal: msg.canal,
      contenu: msg.contenu,
      date: msg.date,
      attachments: (msg.attachments || []).map((a) => ({
        url: a.url, originalName: a.originalName, size: a.size, mime: a.mime, kind: a.kind,
      })),
    };

    // Nettoie les pièces jointes en GridFS
    const attachmentIds = (msg.attachments || [])
      .map((a) => savFileStorage.extractIdFromUrl(a && a.url))
      .filter(Boolean);
    for (const id of attachmentIds) {
      try { await savFileStorage.deleteFile(id); } catch (e) {
        console.error('[sav-msg-delete] gridfs', id, e.message);
      }
    }

    // Supprime aussi les références correspondantes dans documentsList du ticket
    if (Array.isArray(ticket.documentsList) && ticket.documentsList.length) {
      const urlsToRemove = new Set((msg.attachments || []).map((a) => a && a.url).filter(Boolean));
      ticket.documentsList = ticket.documentsList.filter((d) => !urlsToRemove.has(d && d.url));
    }

    msg.deleteOne();
    await ticket.save();

    audit.log({
      req,
      action: 'sav.message.delete',
      entityType: 'sav_ticket',
      entityId: ticket.numero,
      before: snapshot,
      after: null,
    });

    return ok(res, { messageId: snapshot.messageId, count: ticket.messages.length });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// POST /admin/api/sav/tickets/:numero/facturer-149
adminRouter.post('/tickets/:numero/facturer-149', async (req, res) => {
  try {
    const mollieService = require('../../services/mollieService');
    const result = await mollieService.createPayment149(req.params.numero);
    audit.log({ req, action: 'sav.facturer149', entityType: 'sav_ticket', entityId: req.params.numero, after: { mollieId: result && result.mollieId } });
    return ok(res, { numero: req.params.numero, ...result });
  } catch (err) {
    const code = /interdite/.test(err.message) ? 409 : 500;
    return fail(res, err.message, code);
  }
});

// POST /admin/api/sav/tickets/:numero/refund — remboursement Mollie sur la commande liée
adminRouter.post('/tickets/:numero/refund', async (req, res) => {
  try {
    const ticket = await SavTicket.findOne({ numero: req.params.numero });
    if (!ticket) return fail(res, 'Ticket introuvable', 404);
    if (!ticket.numeroCommande) return fail(res, 'Aucune commande liée au ticket', 400);

    const order = await Order.findOne({ number: ticket.numeroCommande });
    if (!order) return fail(res, 'Commande introuvable', 404);
    if (!order.molliePaymentId) return fail(res, 'Aucun paiement Mollie sur cette commande', 400);

    const amountCents = parseInt(req.body && req.body.amountCents, 10);
    if (!Number.isFinite(amountCents) || amountCents <= 0) return fail(res, 'Montant invalide', 400);
    if (order.totalCents && amountCents > order.totalCents) return fail(res, 'Montant supérieur au total commande', 400);

    const reason = (req.body && req.body.reason) || `SAV ${ticket.numero}`;
    const mollie = require('../../services/mollie');
    const refund = await mollie.createRefund({
      paymentId: order.molliePaymentId,
      amountCents,
      description: reason,
    });

    ticket.paiements = ticket.paiements || {};
    ticket.paiements.remboursement = {
      status: 'effectue',
      mollieRefundId: refund && refund.id,
      amountCents,
      date: new Date(),
      reason,
    };
    ticket.addMessage('admin', 'interne', `Remboursement Mollie ${(amountCents / 100).toFixed(2)}€ effectué (${refund && refund.id || '-'})`);
    await ticket.save();

    audit.log({ req, action: 'sav.refund', entityType: 'sav_ticket', entityId: ticket.numero, after: { amountCents, mollieRefundId: refund && refund.id } });
    return ok(res, { numero: ticket.numero, refund: { id: refund && refund.id, amountCents } });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// POST /admin/api/sav/tickets/:numero/rapport-pdf
adminRouter.post('/tickets/:numero/rapport-pdf', async (req, res) => {
  try {
    const reportPdf = require('../../services/savReportPdf');
    const ticket = await SavTicket.findOne({ numero: req.params.numero });
    if (!ticket) return fail(res, 'Ticket introuvable', 404);
    const template = (req.body && req.body.template) || (req.query && req.query.template) || 'client';
    const url = await reportPdf.generateAnalysisReport(ticket, { template });
    ticket.analyse = ticket.analyse || {};
    if (template === 'client') ticket.analyse.rapport = url;
    ticket.addMessage('admin', 'interne', `Rapport PDF (${template}) généré : ${url}`);
    await ticket.save();
    return ok(res, { url, template });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// Helpers pinned notes
const PIN_COLORS_VALID = ['amber', 'rose', 'blue', 'emerald', 'slate'];
function extractMentions(t) {
  const out = [];
  const re = /@([a-zA-Z0-9_.-]{2,40})/g;
  let m;
  while ((m = re.exec(t)) !== null) out.push(m[1]);
  return out;
}

// POST /admin/api/sav/tickets/:numero/pinned-notes — ajouter note épinglée
adminRouter.post('/tickets/:numero/pinned-notes', async (req, res) => {
  try {
    const ticket = await SavTicket.findOne({ numero: req.params.numero });
    if (!ticket) return fail(res, 'Ticket introuvable', 404);
    const texte = (req.body && req.body.texte || '').trim();
    if (!texte) return fail(res, 'texte requis');
    const couleur = PIN_COLORS_VALID.includes(req.body.couleur) ? req.body.couleur : 'amber';
    const auteur = (req.user && (req.user.name || req.user.email)) || 'admin';
    let expiresAt = null;
    if (req.body.expiresAt) {
      const d = new Date(req.body.expiresAt);
      if (!isNaN(d.getTime())) expiresAt = d;
    }
    const mentions = extractMentions(texte);
    ticket.pinnedNotes.push({ texte: texte.slice(0, 500), couleur, auteur, createdAt: new Date(), expiresAt, mentions });
    await ticket.save();
    audit.log({ req, action: 'sav.pinnedNote.add', entityType: 'sav_ticket', entityId: ticket.numero, after: { texte, couleur, mentions } });
    // TODO: notifier les mentions via savNotifications si besoin
    return ok(res, { pinnedNotes: ticket.pinnedNotes, deletedPinnedNotes: ticket.deletedPinnedNotes || [] });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// PATCH /admin/api/sav/tickets/:numero/pinned-notes/:noteId — éditer note
adminRouter.patch('/tickets/:numero/pinned-notes/:noteId', async (req, res) => {
  try {
    const ticket = await SavTicket.findOne({ numero: req.params.numero });
    if (!ticket) return fail(res, 'Ticket introuvable', 404);
    const note = ticket.pinnedNotes.id(req.params.noteId);
    if (!note) return fail(res, 'Note introuvable', 404);
    if (typeof req.body.texte === 'string') {
      const t = req.body.texte.trim();
      if (!t) return fail(res, 'texte requis');
      note.texte = t.slice(0, 500);
      note.mentions = extractMentions(t);
    }
    if (req.body.couleur && PIN_COLORS_VALID.includes(req.body.couleur)) note.couleur = req.body.couleur;
    if (req.body.expiresAt !== undefined) {
      if (!req.body.expiresAt) note.expiresAt = null;
      else { const d = new Date(req.body.expiresAt); if (!isNaN(d.getTime())) note.expiresAt = d; }
    }
    note.updatedAt = new Date();
    await ticket.save();
    audit.log({ req, action: 'sav.pinnedNote.edit', entityType: 'sav_ticket', entityId: ticket.numero, after: { noteId: req.params.noteId, texte: note.texte, couleur: note.couleur } });
    return ok(res, { pinnedNotes: ticket.pinnedNotes });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// DELETE /admin/api/sav/tickets/:numero/pinned-notes/:noteId
adminRouter.delete('/tickets/:numero/pinned-notes/:noteId', async (req, res) => {
  try {
    const ticket = await SavTicket.findOne({ numero: req.params.numero });
    if (!ticket) return fail(res, 'Ticket introuvable', 404);
    const note = ticket.pinnedNotes.id(req.params.noteId);
    if (!note) return fail(res, 'Note introuvable', 404);
    const deletedBy = (req.user && (req.user.name || req.user.email)) || 'admin';
    ticket.deletedPinnedNotes = ticket.deletedPinnedNotes || [];
    ticket.deletedPinnedNotes.push({
      texte: note.texte, couleur: note.couleur, auteur: note.auteur,
      createdAt: note.createdAt, deletedAt: new Date(), deletedBy,
    });
    // Cap historique à 50 pour ne pas exploser le doc
    if (ticket.deletedPinnedNotes.length > 50) {
      ticket.deletedPinnedNotes = ticket.deletedPinnedNotes.slice(-50);
    }
    ticket.pinnedNotes.pull(req.params.noteId);
    await ticket.save();
    audit.log({ req, action: 'sav.pinnedNote.delete', entityType: 'sav_ticket', entityId: ticket.numero, before: { noteId: req.params.noteId } });
    return ok(res, { pinnedNotes: ticket.pinnedNotes, deletedPinnedNotes: ticket.deletedPinnedNotes });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// POST /admin/api/sav/tickets/:numero/pinned-notes/:noteId/restore — restaurer
adminRouter.post('/tickets/:numero/pinned-notes/:noteId/restore', async (req, res) => {
  try {
    const ticket = await SavTicket.findOne({ numero: req.params.numero });
    if (!ticket) return fail(res, 'Ticket introuvable', 404);
    const b = req.body || {};
    const texte = (b.texte || '').trim();
    if (!texte) return fail(res, 'texte requis');
    const couleur = PIN_COLORS_VALID.includes(b.couleur) ? b.couleur : 'amber';
    const auteur = (req.user && (req.user.name || req.user.email)) || 'admin';
    ticket.pinnedNotes.push({ texte: texte.slice(0, 500), couleur, auteur, createdAt: new Date(), mentions: extractMentions(texte) });
    await ticket.save();
    return ok(res, { pinnedNotes: ticket.pinnedNotes });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// POST /admin/api/sav/tickets — création interne (commercial au téléphone, etc.)
adminRouter.post('/tickets', async (req, res) => {
  try {
    const b = req.body || {};
    if (!b.pieceType) return fail(res, 'pieceType requis');
    if (!b.client || !b.client.email) return fail(res, 'client.email requis');
    if (!b.client.nom) b.client.nom = b.client.email.split('@')[0];
    const ticket = new SavTicket({
      pieceType: b.pieceType,
      referencePiece: b.referencePiece,
      numeroCommande: b.numeroCommande,
      vehicule: b.vehicule || {},
      client: b.client,
      diagnostic: { description: b.description || '' },
      statut: 'pre_qualification',
      workflow: { track: 'retour_systematique', etape: 'pre_qualification' },
    });
    ticket.addMessage('admin', 'interne', 'Ticket créé depuis le back-office par un agent');
    await ticket.save();
    return ok(res, { numero: ticket.numero, statut: ticket.statut }, 201);
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// POST /admin/api/sav/tickets/:numero/upload — upload doc/annotation depuis le back-office
adminRouter.post('/tickets/:numero/upload', upload.single('file'), async (req, res) => {
  try {
    const ticket = await SavTicket.findOne({ numero: req.params.numero });
    if (!ticket) return fail(res, 'Ticket introuvable', 404);
    if (!req.file) return fail(res, 'Aucun fichier fourni');
    const kind = req.body.kind || 'autre';
    const stored = await savFileStorage.saveBuffer({
      buffer: req.file.buffer,
      filename: req.file.originalname,
      mime: req.file.mimetype,
      metadata: { ticketNumero: ticket.numero, kind, uploadedBy: 'admin' },
    });
    const url = stored.url;
    ticket.documentsList = ticket.documentsList || [];
    ticket.documentsList.push({
      kind,
      url,
      originalName: req.file.originalname,
      size: req.file.size,
      mime: req.file.mimetype,
    });
    ticket.addMessage('admin', 'interne', `Document ajouté (${kind}) : ${url}`);
    await ticket.save();
    return ok(res, { url });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// ========== Bibliothèque de procédures ==========

// GET /admin/api/sav/procedures?q=… — liste avec recherche optionnelle
adminRouter.get('/procedures', async (req, res) => {
  try {
    const q = (req.query.q || '').trim();
    const filter = {};
    if (q) {
      var rx = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
      filter.$or = [{ title: rx }, { description: rx }, { tags: rx }];
    }
    const items = await SavProcedure.find(filter).sort({ updatedAt: -1 }).lean();
    return ok(res, { procedures: items });
  } catch (err) { return fail(res, err.message, 500); }
});

// POST /admin/api/sav/procedures — upload (multipart)
adminRouter.post('/procedures', upload.single('file'), async (req, res) => {
  try {
    if (!req.file) return fail(res, 'Aucun fichier fourni');
    var title = (req.body && req.body.title || '').trim();
    if (!title) return fail(res, 'Titre requis');
    var stored = await savFileStorage.saveBuffer({
      buffer: req.file.buffer,
      filename: req.file.originalname || 'procedure.pdf',
      mime: req.file.mimetype,
      metadata: {
        ticketNumero: null,
        kind: 'procedure',
        uploadedBy: 'admin',
      },
    });
    var url = stored.url;
    var tags = (req.body.tags || '').split(',').map(function (t) { return t.trim(); }).filter(Boolean);
    var doc = await SavProcedure.create({
      title: title,
      description: (req.body.description || '').trim(),
      tags: tags,
      fileUrl: url,
      originalName: req.file.originalname,
      sizeBytes: req.file.size,
      mime: req.file.mimetype,
      createdByEmail: (req.session && req.session.admin && req.session.admin.email) || '',
    });
    audit.log({ req, action: 'sav.procedure.create', entityType: 'sav_procedure', entityId: String(doc._id), after: { title: title, url: url } });
    return ok(res, { procedure: doc });
  } catch (err) { return fail(res, err.message, 500); }
});

// DELETE /admin/api/sav/procedures/:id
adminRouter.delete('/procedures/:id', async (req, res) => {
  try {
    var doc = await SavProcedure.findById(req.params.id);
    if (!doc) return fail(res, 'Procédure introuvable', 404);
    try {
      var fileId = savFileStorage.extractIdFromUrl(doc.fileUrl);
      if (fileId) await savFileStorage.deleteFile(fileId);
    } catch (_) {}
    await doc.deleteOne();
    audit.log({ req, action: 'sav.procedure.delete', entityType: 'sav_procedure', entityId: String(doc._id), before: { title: doc.title } });
    return ok(res, { id: req.params.id });
  } catch (err) { return fail(res, err.message, 500); }
});

// POST /admin/api/sav/tickets/:numero/send-procedure — envoie une procédure au client par email + log dans le ticket
adminRouter.post('/tickets/:numero/send-procedure', async (req, res) => {
  try {
    var ticket = await SavTicket.findOne({ numero: req.params.numero });
    if (!ticket) return fail(res, 'Ticket introuvable', 404);
    var clientEmail = ticket.client && ticket.client.email;
    if (!clientEmail) return fail(res, 'Aucun email client', 400);
    var procedureId = req.body && req.body.procedureId;
    if (!procedureId) return fail(res, 'procedureId requis');
    var proc = await SavProcedure.findById(procedureId);
    if (!proc) return fail(res, 'Procédure introuvable', 404);

    var customMessage = (req.body && req.body.message || '').trim();
    var bodyText = customMessage
      || `Bonjour,\n\nVeuillez trouver ci-joint la procédure « ${proc.title} » concernant votre dossier SAV ${ticket.numero}.\n\nN'hésitez pas à nous contacter en cas de question.\n\nCordialement,\nL'équipe ${brand.NAME}`;
    var html = '<p>' + bodyText.replace(/\n/g, '<br>') + '</p>';

    var attachments = [];
    try {
      var fileId = savFileStorage.extractIdFromUrl(proc.fileUrl);
      if (fileId) {
        var buf = await savFileStorage.readBuffer(fileId);
        if (buf && buf.length) {
          attachments.push({
            filename: proc.originalName || 'procedure.pdf',
            content: buf.toString('base64'),
            disposition: 'attachment',
          });
        }
      } else {
        // Legacy : fichier encore sur disque (avant migration)
        var legacyPath = path.join(__dirname, '..', '..', '..', '..', proc.fileUrl.replace(/^\//, ''));
        if (fs.existsSync(legacyPath)) {
          attachments.push({
            filename: proc.originalName || 'procedure.pdf',
            content: fs.readFileSync(legacyPath).toString('base64'),
            disposition: 'attachment',
          });
        }
      }
    } catch (_) {}

    try {
      const { sendEmail } = require('../../services/emailService');
      await sendEmail({
        toEmail: clientEmail,
        subject: '[SAV ' + ticket.numero + '] Procédure : ' + proc.title,
        html: html,
        text: bodyText,
        attachments: attachments,
      });
    } catch (e) {
      console.error('[sav-send-procedure]', e.message);
      return fail(res, 'Échec envoi email : ' + e.message, 500);
    }

    ticket.addMessage('admin', 'email', 'Procédure envoyée : ' + proc.title + ' (' + proc.fileUrl + ')');
    await ticket.save();

    proc.downloads = (proc.downloads || 0) + 1;
    await proc.save();

    audit.log({ req, action: 'sav.procedure.send', entityType: 'sav_ticket', entityId: ticket.numero, after: { procedureId: String(proc._id), title: proc.title } });
    return ok(res, { numero: ticket.numero, procedure: { id: proc._id, title: proc.title } });
  } catch (err) { return fail(res, err.message, 500); }
});

// GET /admin/api/sav/personal-templates?userId=… — favoris de l'agent
adminRouter.get('/personal-templates', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return ok(res, { templates: [] });
    const AdminUser = require('../../models/AdminUser');
    const u = await AdminUser.findById(userId).select('savTemplates').lean();
    return ok(res, { templates: (u && u.savTemplates) || [] });
  } catch (err) { return fail(res, err.message, 500); }
});

// POST /admin/api/sav/personal-templates — ajouter un favori
adminRouter.post('/personal-templates', async (req, res) => {
  try {
    const { userId, title, body, icon } = req.body || {};
    if (!userId || !title || !body) return fail(res, 'userId, title, body requis');
    const AdminUser = require('../../models/AdminUser');
    const u = await AdminUser.findById(userId);
    if (!u) return fail(res, 'Utilisateur introuvable', 404);
    const key = 'perso_' + Date.now();
    u.savTemplates = u.savTemplates || [];
    u.savTemplates.push({ key, title, body, icon: icon || 'star' });
    await u.save();
    return ok(res, { key });
  } catch (err) { return fail(res, err.message, 500); }
});

// DELETE /admin/api/sav/personal-templates/:key
adminRouter.delete('/personal-templates/:key', async (req, res) => {
  try {
    const userId = req.query.userId;
    if (!userId) return fail(res, 'userId requis');
    const AdminUser = require('../../models/AdminUser');
    const u = await AdminUser.findById(userId);
    if (!u) return fail(res, 'Utilisateur introuvable', 404);
    u.savTemplates = (u.savTemplates || []).filter((t) => t.key !== req.params.key);
    await u.save();
    return ok(res, { deleted: true });
  } catch (err) { return fail(res, err.message, 500); }
});

// GET /admin/api/sav/message-templates — bibliothèque de modèles de réponse
adminRouter.get('/message-templates', (_req, res) => {
  const templates = [
    { key: 'piece_recue', title: 'Pièce reçue atelier', icon: 'inventory_2', body: `Bonjour {client_prenom},\n\nNous avons bien reçu votre pièce à l'atelier. Notre équipe technique va procéder au diagnostic sur banc dans les prochains jours ouvrés.\n\nNous reviendrons vers vous dès que l'analyse sera terminée.\n\nCordialement,\nL'équipe SAV ${brand.NAME}` },
    { key: 'diag_positif', title: 'Diagnostic positif (garantie)', icon: 'verified', body: `Bonjour {client_prenom},\n\nL'analyse de votre {piece_type} est terminée. Nous avons effectivement constaté un défaut produit pris en charge au titre de notre garantie.\n\nNous procédons à un échange standard, expédition sous 48h ouvrées.\n\nVous recevrez un numéro de suivi dès expédition.\n\nCordialement,\nL'équipe SAV ${brand.NAME}` },
    { key: 'diag_negatif', title: 'Diagnostic négatif (non défectueux)', icon: 'cancel', body: `Bonjour {client_prenom},\n\nL'analyse de votre {piece_type} est terminée. Après tests complets sur banc dédié, votre pièce est conforme aux valeurs constructeur et ne présente pas de défaut.\n\nConformément à nos CGV SAV, le forfait d'analyse de 149 € TTC est dû. Un lien de paiement sécurisé vous sera envoyé séparément.\n\nVous trouverez en pièce jointe le rapport d'analyse complet.\n\nCordialement,\nL'équipe SAV ${brand.NAME}` },
    { key: 'mauvais_montage', title: 'Mauvais montage détecté', icon: 'build', body: `Bonjour {client_prenom},\n\nL'analyse de votre {piece_type} est terminée. Les tests ont révélé des traces de mauvais montage (absence de réglage base, serrages non conformes) qui excluent la prise en charge sous garantie.\n\nConformément à nos CGV SAV, le forfait d'analyse de 149 € TTC est dû. Un lien de paiement sécurisé vous sera envoyé séparément.\n\nLe rapport détaillé est joint à ce message.\n\nCordialement,\nL'équipe SAV ${brand.NAME}` },
    { key: 'relance_docs', title: 'Relance documents manquants', icon: 'campaign', body: `Bonjour {client_prenom},\n\nAfin de pouvoir traiter votre dossier SAV n° {numero}, nous vous invitons à nous transmettre les documents suivants :\n\n• Facture de montage du garage\n• Photos du compteur kilométrique\n• Confirmation du réglage de base effectué\n\nSans ces éléments, nous ne pourrons pas poursuivre la prise en charge.\n\nMerci pour votre retour rapide,\nL'équipe SAV ${brand.NAME}` },
    { key: 'etiquette_retour', title: 'Étiquette de retour envoyée', icon: 'local_shipping', body: `Bonjour {client_prenom},\n\nVous trouverez ci-joint l'étiquette prépayée pour nous retourner votre {piece_type}.\n\nMerci de :\n• Emballer soigneusement la pièce (carton + calage)\n• Coller l'étiquette bien visible\n• Déposer le colis en point relais ou bureau de poste\n\nDès réception à l'atelier, nous démarrerons l'analyse.\n\nCordialement,\nL'équipe SAV ${brand.NAME}` },
  ];
  return ok(res, { templates });
});

// GET /admin/api/sav/report-templates — liste + summary de chaque template
adminRouter.get('/report-templates', (_req, res) => {
  try {
    const reportPdf = require('../../services/savReportPdf');
    const list = Object.keys(reportPdf.TEMPLATES).map((key) => ({
      key,
      ...reportPdf.getTemplateSummary(key),
    }));
    return ok(res, { templates: list });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

// GET /admin/api/sav/dashboard — KPI étendus + chart 12 mois
adminRouter.get('/dashboard', async (req, res) => {
  try {
    const now = new Date();
    const STATUTS_ACTIFS = [
      'ouvert',
      'pre_qualification',
      'en_attente_documents',
      'relance_1',
      'relance_2',
      'retour_demande',
      'en_transit_retour',
      'recu_atelier',
      'en_analyse',
      'analyse_terminee',
      'en_attente_decision_client',
      'en_attente_fournisseur',
    ];
    const STATUTS_CLOS = ['clos', 'refuse', 'resolu_garantie', 'resolu_facture', 'clos_sans_reponse'];

    const [
      ouverts,
      enAttenteDoc,
      enAnalyse,
      slaDepasse,
      total,
      defautProduit,
      facturesPayees,
      facturesImpayees,
      mesTickets,
      tousResolus,
      awaitingClient,
    ] = await Promise.all([
      SavTicket.countDocuments({ statut: { $in: STATUTS_ACTIFS } }),
      SavTicket.countDocuments({ statut: { $in: ['en_attente_documents', 'relance_1', 'relance_2'] } }),
      SavTicket.countDocuments({ statut: 'en_analyse' }),
      SavTicket.countDocuments({
        statut: { $in: STATUTS_ACTIFS },
        'sla.dateLimite': { $lt: now },
      }),
      SavTicket.countDocuments({ 'analyse.conclusion': { $exists: true, $ne: null } }),
      SavTicket.countDocuments({ 'analyse.conclusion': 'defaut_produit' }),
      SavTicket.countDocuments({ 'paiements.facture149.status': 'payee' }),
      SavTicket.countDocuments({ 'paiements.facture149.status': 'impayee' }),
      // Mes tickets : on regarde le query param userId si fourni
      req.query.userId ? SavTicket.countDocuments({ assignedToUserId: req.query.userId, statut: { $in: STATUTS_ACTIFS } }) : Promise.resolve(0),
      SavTicket.find({ statut: { $in: STATUTS_CLOS }, createdAt: { $gte: new Date(Date.now() - 365 * 24 * 3600 * 1000) } })
        .select('createdAt updatedAt statut')
        .lean(),
      SavTicket.countDocuments({
        $expr: { $and: [ { $ne: ['$lastClientMessageAt', null] }, { $or: [ { $eq: ['$lastAdminReadAt', null] }, { $gt: ['$lastClientMessageAt', '$lastAdminReadAt'] } ] } ] },
      }),
    ]);

    // Temps moyen de résolution (jours) sur les tickets clos cette année
    let avgResolutionDays = 0;
    if (tousResolus.length) {
      const sum = tousResolus.reduce((acc, t) => {
        const start = new Date(t.createdAt).getTime();
        const end = new Date(t.updatedAt || t.createdAt).getTime();
        return acc + Math.max(0, (end - start) / (1000 * 60 * 60 * 24));
      }, 0);
      avgResolutionDays = Math.round((sum / tousResolus.length) * 10) / 10;
    }
    const tauxDefautProduit = total > 0 ? Math.round((defautProduit / total) * 100) : 0;
    const caRecupere = facturesPayees * 149;
    const caPerdu = facturesImpayees * 149;

    // SAV récurrents fournisseur : nombre de tickets pour le même VIN > 1
    let savRecurrents = 0;
    try {
      const groups = await SavTicket.aggregate([
        { $match: { 'vehicule.vin': { $exists: true, $ne: null, $ne: '' } } },
        { $group: { _id: '$vehicule.vin', count: { $sum: 1 } } },
        { $match: { count: { $gt: 1 } } },
        { $count: 'recurrents' },
      ]);
      savRecurrents = (groups[0] && groups[0].recurrents) || 0;
    } catch (_) {}

    // Chart 12 mois : ouverts vs clos par mois
    const monthsBack = 12;
    const start = new Date();
    start.setMonth(start.getMonth() - (monthsBack - 1));
    start.setDate(1); start.setHours(0, 0, 0, 0);
    const monthly = await SavTicket.aggregate([
      { $match: { createdAt: { $gte: start } } },
      {
        $group: {
          _id: { y: { $year: '$createdAt' }, m: { $month: '$createdAt' } },
          ouverts: { $sum: 1 },
          clos: {
            $sum: { $cond: [{ $in: ['$statut', STATUTS_CLOS] }, 1, 0] },
          },
        },
      },
      { $sort: { '_id.y': 1, '_id.m': 1 } },
    ]);
    const labels = [];
    const ouvertsArr = [];
    const closArr = [];
    for (let i = 0; i < monthsBack; i++) {
      const d = new Date(start);
      d.setMonth(start.getMonth() + i);
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      labels.push(`${String(m).padStart(2, '0')}/${String(y).slice(2)}`);
      const found = monthly.find((x) => x._id.y === y && x._id.m === m);
      ouvertsArr.push(found ? found.ouverts : 0);
      closArr.push(found ? found.clos : 0);
    }

    // Compteurs par équipe (tickets actifs)
    const byTeamAgg = await SavTicket.aggregate([
      { $match: { statut: { $in: STATUTS_ACTIFS } } },
      { $group: { _id: '$assignedTeam', count: { $sum: 1 } } },
    ]);
    const by_team = { atelier: 0, logistique: 0, commercial: 0, compta: 0, sav_general: 0 };
    byTeamAgg.forEach((g) => { if (g._id && by_team[g._id] !== undefined) by_team[g._id] = g.count; });

    // Compteurs par motif
    const byMotifAgg = await SavTicket.aggregate([
      { $match: { statut: { $in: STATUTS_ACTIFS } } },
      { $group: { _id: '$motifSav', count: { $sum: 1 } } },
    ]);
    const by_motif = {};
    byMotifAgg.forEach((g) => { if (g._id) by_motif[g._id] = g.count; });

    return ok(res, {
      ouverts: ouverts || 0,
      en_attente_doc: enAttenteDoc || 0,
      en_analyse: enAnalyse || 0,
      sla_depasse: slaDepasse || 0,
      total_analyses: total || 0,
      taux_defaut_produit: tauxDefautProduit,
      ca_recupere: caRecupere,
      ca_perdu: caPerdu,
      avg_resolution_days: avgResolutionDays,
      sav_recurrents: savRecurrents,
      mes_tickets: mesTickets || 0,
      awaiting_client: awaitingClient || 0,
      by_team,
      by_motif,
      chart: { labels, ouverts: ouvertsArr, clos: closArr },
    });
  } catch (err) {
    return fail(res, err.message, 500);
  }
});

router.use('/public', publicRouter); // monté manuellement par app.js
router.use('/admin', adminRouter);

module.exports = {
  publicRouter,
  adminRouter,
};
