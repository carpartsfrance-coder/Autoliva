#!/usr/bin/env node
// ---------------------------------------------------------------------------
// migrate-sav-files-to-db.js
//
// Migre tous les fichiers SAV stockés sur disque (`/uploads/sav/...`,
// `/uploads/sav-cgv/...`, `/uploads/sav-reports/...`) vers MongoDB GridFS
// (bucket `savFiles`), puis réécrit les URLs dans :
//   - SavTicket.documentsList[].url
//   - SavTicket.documents.{factureMontage, confirmationReglageBase,
//                         photoCompteur, bonGarantie}
//   - SavTicket.documents.{photosObd[], photosVisuelles[]}
//   - SavTicket.analyse.rapport
//   - SavTicket.analyse.photosBanc[]
//   - SavTicket.cgvAcceptance.pdfUrl
//   - SavTicket.diagnosticEnrichi.{photosAvant,Pendant,Apres}[].url
//   - SavTicket.diagnosticEnrichi.{videoUrl, courbeBancUrl, pdfUrl}
//   - SavTicket.preuveQualite.{videoTest, screenshotBanc, certificatReconditionnement}
//   - SavProcedure.fileUrl
//
// Les fichiers existants en GridFS (URL déjà au format `/sav-files/<id>`)
// sont sautés. Les URLs externes (http(s)://) sont préservées telles quelles.
//
// Usage :
//   node scripts/migrate-sav-files-to-db.js              # dry-run par défaut
//   node scripts/migrate-sav-files-to-db.js --apply      # applique réellement
//   node scripts/migrate-sav-files-to-db.js --apply --delete-source
//                                                        # supprime aussi les
//                                                        # fichiers du disque
//                                                        # après migration OK
// ---------------------------------------------------------------------------

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const fs = require('fs');
const https = require('https');
const http = require('http');
const mongoose = require('mongoose');

const SavTicket = require('../src/models/SavTicket');
const SavProcedure = require('../src/models/SavProcedure');
const savFileStorage = require('../src/services/savFileStorage');

const APPLY = process.argv.includes('--apply');
const DELETE_SOURCE = process.argv.includes('--delete-source');

// Fallback HTTP(S) : si --remote=https://… est passé et que le fichier est
// introuvable sur disque, on tente de le télécharger depuis cette base URL.
function getRemoteBase() {
  const arg = process.argv.find((a) => a.startsWith('--remote='));
  if (arg) return arg.slice('--remote='.length).replace(/\/+$/, '');
  return process.env.SAV_MIGRATE_REMOTE_BASE
    ? process.env.SAV_MIGRATE_REMOTE_BASE.replace(/\/+$/, '')
    : null;
}
const REMOTE_BASE = getRemoteBase();

const ROOT = path.resolve(__dirname, '..', '..'); // racine projet (au-dessus de /app)

function fetchBuffer(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https://') ? https : http;
    const req = lib.get(url, (res) => {
      // Suivi redirection simple
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        res.resume();
        return resolve(fetchBuffer(new URL(res.headers.location, url).toString()));
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve(Buffer.concat(chunks)));
      res.on('error', reject);
    });
    req.setTimeout(30_000, () => { req.destroy(new Error('timeout')); });
    req.on('error', reject);
  });
}

const stats = {
  ticketsScanned: 0,
  ticketsTouched: 0,
  filesUploaded: 0,
  filesAlreadyMigrated: 0,
  filesMissing: 0,
  filesExternal: 0,
  proceduresScanned: 0,
  proceduresMigrated: 0,
  errors: [],
};

function log(...args) { console.log('[migrate-sav]', ...args); }

function resolveDiskPath(url) {
  if (!url || typeof url !== 'string') return null;
  if (!url.startsWith('/uploads/')) return null;
  // /uploads/sav/SAV-2026-0008/foo.jpg → <ROOT>/uploads/sav/SAV-2026-0008/foo.jpg
  return path.join(ROOT, url.replace(/^\//, ''));
}

function guessMime(filename) {
  const ext = (filename || '').toLowerCase().split('.').pop();
  const map = {
    pdf: 'application/pdf', jpg: 'image/jpeg', jpeg: 'image/jpeg',
    png: 'image/png', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif',
    heic: 'image/heic', heif: 'image/heif', mp4: 'video/mp4', webm: 'video/webm',
    mov: 'video/quicktime', txt: 'text/plain', csv: 'text/csv',
    json: 'application/json', html: 'text/html',
  };
  return map[ext] || 'application/octet-stream';
}

function inferKindFromUrl(url) {
  if (/\/uploads\/sav-cgv\//.test(url)) return 'cgv_pdf';
  if (/\/uploads\/sav-reports\//.test(url)) return 'rapport_pdf';
  if (/\/uploads\/sav\/_procedures\//.test(url)) return 'procedure';
  return 'legacy_disk';
}

function inferTicketNumeroFromUrl(url) {
  const m = url.match(/\/uploads\/sav\/(SAV-[^\/]+)\//);
  if (m) return m[1];
  const m2 = url.match(/\/uploads\/sav-(?:cgv|reports)\/(SAV-[^./]+)/);
  if (m2) return m2[1];
  return null;
}

/**
 * Migre une URL : si elle est sur disque, upload en GridFS et renvoie la
 * nouvelle URL `/sav-files/<id>`. Sinon, renvoie l'URL d'origine inchangée.
 */
async function migrateUrl(url, ctx = {}) {
  if (!url || typeof url !== 'string') return url;

  // Déjà migré
  if (url.startsWith('/sav-files/')) {
    stats.filesAlreadyMigrated++;
    return url;
  }

  // URL externe (http/https) → on garde
  if (/^https?:\/\//i.test(url)) {
    stats.filesExternal++;
    return url;
  }

  const diskPath = resolveDiskPath(url);
  let buffer = null;
  let source = null;
  if (diskPath && fs.existsSync(diskPath)) {
    buffer = fs.readFileSync(diskPath);
    source = 'disk';
  } else if (REMOTE_BASE) {
    // Fallback : télécharge depuis le serveur de prod
    try {
      buffer = await fetchBuffer(REMOTE_BASE + url);
      source = 'remote';
    } catch (e) {
      stats.filesMissing++;
      log(`  ⚠ HTTP introuvable (${e.message}) :`, url);
      return url;
    }
  } else {
    stats.filesMissing++;
    log('  ⚠ fichier introuvable sur disque :', url);
    return url;
  }

  const filename = path.basename(url);
  const mime = ctx.mime || guessMime(filename);
  const kind = ctx.kind || inferKindFromUrl(url);
  const ticketNumero = ctx.ticketNumero || inferTicketNumeroFromUrl(url);

  if (!APPLY) {
    log(`  [dry/${source}] ${url}  →  GridFS (${buffer.length} o, kind=${kind}, ticket=${ticketNumero || '∅'})`);
    stats.filesUploaded++;
    return '/sav-files/<dryrun>';
  }

  try {
    const stored = await savFileStorage.saveBuffer({
      buffer,
      filename,
      mime,
      metadata: {
        ticketNumero,
        kind,
        uploadedBy: 'migration',
        migratedFrom: url,
        migratedFromSource: source,
        migratedAt: new Date(),
      },
    });
    stats.filesUploaded++;
    log(`  ✓ [${source}] ${url}  →  ${stored.url}`);
    if (DELETE_SOURCE && source === 'disk' && diskPath) {
      try { fs.unlinkSync(diskPath); } catch (_) {}
    }
    return stored.url;
  } catch (err) {
    stats.errors.push({ url, error: err.message });
    log(`  ✗ erreur upload ${url} :`, err.message);
    return url;
  }
}

async function migrateArray(arr, ctx) {
  if (!Array.isArray(arr)) return { changed: false, value: arr };
  let changed = false;
  const out = [];
  for (const v of arr) {
    if (typeof v === 'string') {
      const nv = await migrateUrl(v, ctx);
      if (nv !== v) changed = true;
      out.push(nv);
    } else if (v && typeof v === 'object' && v.url) {
      const nv = await migrateUrl(v.url, ctx);
      if (nv !== v.url) { v.url = nv; changed = true; }
      out.push(v);
    } else {
      out.push(v);
    }
  }
  return { changed, value: out };
}

async function migrateTicket(ticket) {
  let touched = false;
  const ctx = { ticketNumero: ticket.numero };

  // documentsList[]
  if (Array.isArray(ticket.documentsList)) {
    for (const d of ticket.documentsList) {
      if (!d || !d.url) continue;
      const nu = await migrateUrl(d.url, { ticketNumero: ticket.numero, kind: d.kind, mime: d.mime });
      if (nu !== d.url) { d.url = nu; touched = true; }
    }
  }

  // documents.* (legacy)
  if (ticket.documents) {
    const single = ['factureMontage', 'confirmationReglageBase', 'photoCompteur', 'bonGarantie'];
    for (const key of single) {
      const v = ticket.documents[key];
      if (typeof v === 'string' && v) {
        const nu = await migrateUrl(v, { ticketNumero: ticket.numero, kind: 'legacy_' + key });
        if (nu !== v) { ticket.documents[key] = nu; touched = true; }
      }
    }
    for (const key of ['photosObd', 'photosVisuelles']) {
      const r = await migrateArray(ticket.documents[key], { ticketNumero: ticket.numero, kind: 'legacy_' + key });
      if (r.changed) { ticket.documents[key] = r.value; touched = true; }
    }
  }

  // analyse
  if (ticket.analyse) {
    if (typeof ticket.analyse.rapport === 'string' && ticket.analyse.rapport) {
      const nu = await migrateUrl(ticket.analyse.rapport, { ticketNumero: ticket.numero, kind: 'rapport_pdf', mime: 'application/pdf' });
      if (nu !== ticket.analyse.rapport) { ticket.analyse.rapport = nu; touched = true; }
    }
    const r = await migrateArray(ticket.analyse.photosBanc, { ticketNumero: ticket.numero, kind: 'photo_banc' });
    if (r.changed) { ticket.analyse.photosBanc = r.value; touched = true; }
  }

  // cgvAcceptance.pdfUrl
  if (ticket.cgvAcceptance && typeof ticket.cgvAcceptance.pdfUrl === 'string' && ticket.cgvAcceptance.pdfUrl) {
    const nu = await migrateUrl(ticket.cgvAcceptance.pdfUrl, { ticketNumero: ticket.numero, kind: 'cgv_pdf', mime: 'application/pdf' });
    if (nu !== ticket.cgvAcceptance.pdfUrl) { ticket.cgvAcceptance.pdfUrl = nu; touched = true; }
  }

  // diagnosticEnrichi
  if (ticket.diagnosticEnrichi) {
    for (const key of ['photosAvant', 'photosPendant', 'photosApres']) {
      const r = await migrateArray(ticket.diagnosticEnrichi[key], { ticketNumero: ticket.numero, kind: 'diag_' + key });
      if (r.changed) { ticket.diagnosticEnrichi[key] = r.value; touched = true; }
    }
    for (const key of ['videoUrl', 'courbeBancUrl', 'pdfUrl']) {
      const v = ticket.diagnosticEnrichi[key];
      if (typeof v === 'string' && v) {
        const nu = await migrateUrl(v, { ticketNumero: ticket.numero, kind: 'diag_' + key });
        if (nu !== v) { ticket.diagnosticEnrichi[key] = nu; touched = true; }
      }
    }
  }

  // preuveQualite
  if (ticket.preuveQualite) {
    for (const key of ['videoTest', 'screenshotBanc', 'certificatReconditionnement']) {
      const v = ticket.preuveQualite[key];
      if (typeof v === 'string' && v) {
        const nu = await migrateUrl(v, { ticketNumero: ticket.numero, kind: 'preuve_' + key });
        if (nu !== v) { ticket.preuveQualite[key] = nu; touched = true; }
      }
    }
  }

  if (touched) {
    stats.ticketsTouched++;
    if (APPLY) {
      try { await ticket.save(); } catch (e) {
        stats.errors.push({ ticket: ticket.numero, error: e.message });
        log(`  ✗ save ticket ${ticket.numero} :`, e.message);
      }
    }
  }
}

async function main() {
  const uri = process.env.MONGODB_URI || process.env.MONGO_URL;
  if (!uri) throw new Error('MONGODB_URI absent dans .env');

  log('Connexion MongoDB…');
  await mongoose.connect(uri);
  log('✓ connecté à', mongoose.connection.name);

  if (!APPLY) log('⚠ MODE DRY-RUN — passez --apply pour appliquer réellement');
  if (APPLY && DELETE_SOURCE) log('⚠ DELETE-SOURCE activé — les fichiers disque seront supprimés après upload');

  // --- Tickets ---
  log('\n== Migration des tickets SAV ==');
  const cursor = SavTicket.find({}).cursor();
  for await (const ticket of cursor) {
    stats.ticketsScanned++;
    if (stats.ticketsScanned % 50 === 0) log(`  ... ${stats.ticketsScanned} tickets parcourus`);
    await migrateTicket(ticket);
  }

  // --- Procédures (bibliothèque admin) ---
  log('\n== Migration des procédures SAV ==');
  const procs = await SavProcedure.find({});
  for (const p of procs) {
    stats.proceduresScanned++;
    if (typeof p.fileUrl === 'string' && p.fileUrl) {
      const nu = await migrateUrl(p.fileUrl, { ticketNumero: null, kind: 'procedure', mime: p.mime });
      if (nu !== p.fileUrl) {
        p.fileUrl = nu;
        if (APPLY) {
          try { await p.save(); stats.proceduresMigrated++; } catch (e) {
            stats.errors.push({ procedure: String(p._id), error: e.message });
          }
        } else {
          stats.proceduresMigrated++;
        }
      }
    }
  }

  log('\n== Résumé ==');
  log(JSON.stringify(stats, null, 2));

  await mongoose.disconnect();
  process.exit(stats.errors.length ? 1 : 0);
}

main().catch((err) => {
  console.error('[migrate-sav] FATAL', err);
  process.exit(2);
});
