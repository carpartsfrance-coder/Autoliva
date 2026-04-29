/*
 * SAV — Inbound Email Processing
 * Handles incoming emails forwarded by MailerSend inbound routing.
 * Reply-to addresses follow the pattern: sav+{ticketNumero}@{domain}
 *
 * Webhook: POST /api/sav/public/inbound-email
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SavTicket = require('../models/SavTicket');
const brand = require('../config/brand');

const LOG_DIR = path.join(__dirname, '..', '..', '..', 'logs');
const LOG_FILE = path.join(LOG_DIR, 'sav-emails.log');

function ensureLogDir() {
  try { if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (_) {}
}
ensureLogDir();

function log(line) {
  try {
    fs.appendFile(LOG_FILE, `${new Date().toISOString()} [sav-inbound] ${line}\n`, () => {});
  } catch (_) {}
}

// ============================================================
// Address helpers
// ============================================================

/**
 * Build the reply-to address for a given ticket numero.
 * E.g. sav+SAV-2026-0042@carpartsfrance.fr
 */
function buildReplyToAddress(ticketNumero) {
  const domain = (process.env.SAV_INBOUND_DOMAIN || brand.DOMAIN).trim();
  return `sav+${ticketNumero}@${domain}`;
}

/**
 * Extract the ticket numero from a reply-to address.
 * Accepts formats like: sav+SAV-2026-0042@carpartsfrance.fr
 * Returns null if no match.
 */
function extractTicketNumero(toAddress) {
  if (!toAddress || typeof toAddress !== 'string') return null;
  const addr = toAddress.trim().toLowerCase();
  // Match sav+XXXX@ pattern
  const match = addr.match(/^sav\+([^@]+)@/i);
  if (match && match[1]) return match[1].toUpperCase();
  return null;
}

// ============================================================
// Email quote stripping
// ============================================================

/**
 * Remove quoted reply text from an email body.
 * Handles common patterns from Gmail, Outlook, Apple Mail, Thunderbird, etc.
 */
function stripEmailQuotes(text) {
  if (!text || typeof text !== 'string') return '';

  const lines = text.split('\n');
  const cleanLines = [];
  let hitSeparator = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Stop at common separator patterns
    if (
      /^-{3,}$/.test(trimmed) ||                                        // ---
      /^_{10,}$/.test(trimmed) ||                                        // ________________________________
      /^On .+ wrote:$/i.test(trimmed) ||                                 // On Mon, 1 Jan 2026, X wrote:
      /^Le .+ a écrit\s*:$/i.test(trimmed) ||                            // Le 1 janv. 2026, X a écrit :
      /^From:/i.test(trimmed) ||                                         // From: header
      /^Envoyé\s*:/i.test(trimmed) ||                                    // Envoyé : (Outlook FR)
      /^De\s*:/i.test(trimmed) ||                                        // De : (Outlook FR)
      /^Sent:/i.test(trimmed) ||                                         // Sent: (Outlook EN)
      /^>+\s*On .+ wrote:/i.test(trimmed) ||                             // > On ... wrote:
      /^-{2,}\s*Original Message\s*-{2,}/i.test(trimmed) ||              // -- Original Message --
      /^-{2,}\s*Message d'origine\s*-{2,}/i.test(trimmed)                // -- Message d'origine --
    ) {
      hitSeparator = true;
      break;
    }

    // Skip lines starting with > (quoted text)
    if (/^>/.test(trimmed)) continue;

    cleanLines.push(line);
  }

  return cleanLines.join('\n').trim();
}

// ============================================================
// Webhook signature verification
// ============================================================

function verifyWebhookSignature(req) {
  const secret = (process.env.MAILERSEND_INBOUND_SECRET || '').trim();
  if (!secret) {
    // No secret configured — skip verification (dev/test mode)
    return true;
  }

  const signature = req.headers['x-mailersend-signature']
    || req.headers['signature']
    || '';
  if (!signature) {
    log('WARN signature header missing');
    return false;
  }

  try {
    const rawBody = typeof req.rawBody === 'string'
      ? req.rawBody
      : (typeof req.body === 'string' ? req.body : JSON.stringify(req.body));
    const expected = crypto
      .createHmac('sha256', secret)
      .update(rawBody)
      .digest('hex');
    return crypto.timingSafeEqual(
      Buffer.from(signature, 'utf8'),
      Buffer.from(expected, 'utf8')
    );
  } catch (err) {
    log(`ERROR signature verification failed: ${err.message}`);
    return false;
  }
}

// ============================================================
// Main webhook handler
// ============================================================

/**
 * Doctrine : aucune réponse client par email n'est acceptée. Toute conversation SAV
 * doit passer par l'espace client (`/compte/sav` connecté) ou l'espace de suivi invité
 * (`/sav/suivi/<numero>` avec magic link).
 *
 * Ce handler reçoit toujours les emails entrants (webhook MailerSend) mais :
 *  1. Ne persiste PAS le contenu de l'email comme message du ticket.
 *  2. Note dans le ticket (en interne) qu'un email a été reçu et auto-reply envoyé.
 *  3. Renvoie au client un email d'auto-reply expliquant qu'il faut utiliser l'espace SAV
 *     (avec son magic link ré-utilisable).
 *  4. Anti-boucle : on garde un cooldown par expéditeur (Map en mémoire) pour éviter
 *     d'auto-reply en rafale si le client renvoie plusieurs emails.
 */

// Anti-boucle : pas plus d'1 auto-reply par 30 min par adresse
const AUTOREPLY_COOLDOWN_MS = 30 * 60 * 1000;
const lastAutoReplyByAddr = new Map();

function shouldSendAutoReply(senderEmailLower) {
  const last = lastAutoReplyByAddr.get(senderEmailLower);
  if (last && Date.now() - last < AUTOREPLY_COOLDOWN_MS) return false;
  lastAutoReplyByAddr.set(senderEmailLower, Date.now());
  return true;
}

async function sendAutoReply(ticket, senderEmail) {
  try {
    const { sendEmail } = require('./emailService');
    const { buildGuestLink } = require('../controllers/savGuestController');
    const guestLink = buildGuestLink(ticket) || `${brand.SITE_URL}/sav/suivi`;
    const html = `
      <div style="font-family:Arial,sans-serif;max-width:560px;margin:0 auto;padding:24px;color:#0f172a;">
        <h2 style="margin:0 0 12px 0;font-size:18px;">Votre message n'a pas été ajouté au dossier</h2>
        <p style="font-size:14px;line-height:1.6;color:#334155;">
          Merci pour votre réponse concernant le dossier SAV <strong>${ticket.numero}</strong>.
        </p>
        <p style="font-size:14px;line-height:1.6;color:#334155;">
          Pour des raisons de sécurité et de traçabilité, nous ne traitons pas les réponses envoyées par email.
          L'intégralité de votre conversation SAV se déroule dans votre espace personnel.
        </p>
        <p style="margin:24px 0;text-align:center;">
          <a href="${guestLink}" style="display:inline-block;padding:14px 28px;background:#ec1313;color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:15px;">
            Accéder à mon espace SAV
          </a>
        </p>
        <p style="font-size:13px;color:#64748b;text-align:center;">
          Ce lien est personnel et vous donne un accès direct à votre dossier sans création de compte.
          Vous pourrez y consulter l'historique, ajouter des pièces jointes et répondre à notre équipe.
        </p>
      </div>
    `;
    return await sendEmail({
      toEmail: senderEmail,
      subject: `Action requise — utilisez votre espace SAV (${ticket.numero})`,
      html,
      text: `Bonjour,\n\nNous ne traitons pas les réponses par email. Merci de répondre directement dans votre espace SAV : ${guestLink}\n\nL'équipe SAV ${brand.NAME}.`,
    });
  } catch (e) {
    log(`ERROR sending auto-reply: ${e.message}`);
    return { ok: false, error: e.message };
  }
}

async function processInboundEmail(req) {
  const body = req.body || {};

  // 1. Verify webhook signature (if configured)
  if (!verifyWebhookSignature(req)) {
    log('REJECTED invalid webhook signature');
    return { ok: false, reason: 'invalid_signature' };
  }

  // 2. Extract data from the webhook payload
  const data = body.data || body;

  const senderEmail = extractSenderEmail(data);
  if (!senderEmail) {
    log('WARN no sender email found in payload');
    return { ok: false, reason: 'no_sender' };
  }

  const recipients = extractRecipients(data);
  const subject = data.subject || data.headers?.subject || '';

  // 3. Find ticket number from recipients or subject
  let ticketNumero = null;
  for (const addr of recipients) {
    ticketNumero = extractTicketNumero(addr);
    if (ticketNumero) break;
  }
  if (!ticketNumero && subject) {
    const subjectMatch = subject.match(/(SAV-\d{4}-\d{4,})/i);
    if (subjectMatch) ticketNumero = subjectMatch[1].toUpperCase();
  }

  if (!ticketNumero) {
    log(`WARN no ticket numero found. recipients=${recipients.join(',')} subject=${subject}`);
    return { ok: false, reason: 'no_ticket_numero' };
  }

  const ticket = await SavTicket.findOne({ numero: ticketNumero });
  if (!ticket) {
    log(`WARN ticket not found: ${ticketNumero}`);
    return { ok: false, reason: 'ticket_not_found', numero: ticketNumero };
  }

  const senderLower = senderEmail.toLowerCase().trim();

  // 4. Note interne dans le ticket : on garde la trace de la tentative
  const senderInfo = ticket.client && ticket.client.email && ticket.client.email.toLowerCase() === senderLower
    ? `client (${senderLower})`
    : `expéditeur externe (${senderLower})`;
  ticket.addMessage(
    'systeme',
    'interne',
    `Email reçu de ${senderInfo} — non ingéré (doctrine in-app). Auto-reply envoyé pour rediriger vers l'espace SAV.`
  );
  await ticket.save();

  // 5. Auto-reply (avec cooldown anti-boucle)
  let autoReplyResult = null;
  if (shouldSendAutoReply(senderLower)) {
    autoReplyResult = await sendAutoReply(ticket, senderEmail);
  } else {
    log(`COOLDOWN auto-reply skipped for ${senderLower} (sent within last 30min)`);
    autoReplyResult = { ok: false, reason: 'cooldown' };
  }

  log(`REJECTED-INGESTION ${ticketNumero} from=${senderLower} autoReply=${autoReplyResult && autoReplyResult.ok ? 'sent' : (autoReplyResult && autoReplyResult.reason) || 'failed'}`);

  return {
    ok: true,
    numero: ticketNumero,
    ingested: false,
    autoReplySent: !!(autoReplyResult && autoReplyResult.ok),
  };
}

// ============================================================
// Payload extraction helpers (accommodate various MailerSend formats)
// ============================================================

function extractSenderEmail(data) {
  // MailerSend may provide sender in different fields
  if (data.from && typeof data.from === 'string') return data.from;
  if (data.from && data.from.email) return data.from.email;
  if (data.sender && typeof data.sender === 'string') return data.sender;
  if (data.sender && data.sender.email) return data.sender.email;
  if (data.from_email) return data.from_email;
  // Check envelope
  if (data.envelope && data.envelope.from) return data.envelope.from;
  // Check headers
  if (data.headers) {
    if (data.headers.from) {
      const match = data.headers.from.match(/<([^>]+)>/);
      return match ? match[1] : data.headers.from;
    }
  }
  return null;
}

function extractRecipients(data) {
  const addrs = [];

  // to field
  if (Array.isArray(data.to)) {
    for (const r of data.to) {
      if (typeof r === 'string') addrs.push(r);
      else if (r && r.email) addrs.push(r.email);
      else if (r && r.address) addrs.push(r.address);
    }
  } else if (data.to && typeof data.to === 'string') {
    addrs.push(data.to);
  } else if (data.to && data.to.email) {
    addrs.push(data.to.email);
  }

  // cc field
  if (Array.isArray(data.cc)) {
    for (const r of data.cc) {
      if (typeof r === 'string') addrs.push(r);
      else if (r && r.email) addrs.push(r.email);
      else if (r && r.address) addrs.push(r.address);
    }
  }

  // recipients field (alternative format)
  if (Array.isArray(data.recipients)) {
    for (const r of data.recipients) {
      if (typeof r === 'string') addrs.push(r);
      else if (r && r.email) addrs.push(r.email);
      else if (r && r.address) addrs.push(r.address);
    }
  }

  // envelope.to
  if (data.envelope && Array.isArray(data.envelope.to)) {
    for (const addr of data.envelope.to) addrs.push(addr);
  }

  return addrs;
}

// ============================================================
// Exports
// ============================================================

module.exports = {
  buildReplyToAddress,
  extractTicketNumero,
  stripEmailQuotes,
  processInboundEmail,
};
