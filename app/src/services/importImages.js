'use strict';

/**
 * Téléchargement des images fournies par l'import JSON (/admin/api/products/import,
 * champ `images`). Chaque URL est récupérée côté serveur puis stockée comme un
 * média normal (GridFS → /media/{id}), exactement comme un upload manuel.
 *
 * Règles (cf. SPEC-import-images-stock) :
 *   - https uniquement, anti-SSRF (rejet IP privées / localhost), ≤ 3 redirections
 *   - formats jpg / png / webp uniquement, ≤ 10 Mo/image, ≤ 10 images, timeout 15 s
 *   - échec d'une URL → warning, jamais fatal
 *   - idempotence : une URL déjà téléchargée (metadata.sourceUrl) est réutilisée
 *   - les URLs DÉJÀ hébergées (relatives, ou /media//images de notre domaine) sont
 *     conservées telles quelles (pas de re-téléchargement).
 */

const dns = require('dns').promises;
const net = require('net');
const mongoose = require('mongoose');
const mediaStorage = require('./mediaStorage');

const MAX_IMAGES = 10;
const MAX_BYTES = 10 * 1024 * 1024; // 10 Mo
const TIMEOUT_MS = 15 * 1000;
const MAX_REDIRECTS = 3;

const CT_TO_EXT = { 'image/jpeg': 'jpeg', 'image/jpg': 'jpeg', 'image/png': 'png', 'image/webp': 'webp' };
const EXT_RE = /\.(jpe?g|png|webp)(?:[?#].*)?$/i;
// Domaines "maison" : leurs URLs sont déjà hébergées → pas de re-téléchargement.
const OWN_HOSTS = new Set(['autoliva.com', 'www.autoliva.com', 'carpartsfrance.fr', 'www.carpartsfrance.fr']);

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    const p = ip.split('.').map(Number);
    if (p[0] === 10) return true;
    if (p[0] === 127) return true;
    if (p[0] === 0) return true;
    if (p[0] === 169 && p[1] === 254) return true;          // link-local
    if (p[0] === 172 && p[1] >= 16 && p[1] <= 31) return true;
    if (p[0] === 192 && p[1] === 168) return true;
    if (p[0] === 100 && p[1] >= 64 && p[1] <= 127) return true; // CGNAT
    return false;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase().replace(/^\[|\]$/g, '');
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fe80')) return true;                   // link-local
    if (v.startsWith('fc') || v.startsWith('fd')) return true; // ULA
    const m = v.match(/(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/);    // IPv4-mapped
    if (m) return isPrivateIp(m[1]);
    return false;
  }
  return true; // inconnu → on refuse par prudence
}

async function assertPublicHost(hostname) {
  const lc = String(hostname || '').toLowerCase();
  if (!lc) throw new Error('hôte vide');
  if (lc === 'localhost' || lc.endsWith('.localhost') || lc.endsWith('.local') || lc.endsWith('.internal')) {
    throw new Error('hôte interne interdit');
  }
  if (net.isIP(lc)) {
    if (isPrivateIp(lc)) throw new Error('IP privée interdite');
    return;
  }
  const addrs = await dns.lookup(lc, { all: true });
  if (!addrs || !addrs.length) throw new Error('résolution DNS vide');
  for (const a of addrs) {
    if (isPrivateIp(a.address)) throw new Error('IP privée interdite');
  }
}

function pickExt(contentType, url) {
  if (CT_TO_EXT[contentType]) return CT_TO_EXT[contentType];
  const m = String(url || '').match(EXT_RE);
  if (!m) return null;
  const e = m[1].toLowerCase();
  return e === 'jpg' ? 'jpeg' : e;
}

/** Une URL déjà hébergée chez nous (relative, ou /media//images d'un domaine maison) ? */
function isAlreadyHosted(url) {
  if (url.startsWith('/')) return true; // chemin relatif → servi tel quel
  try {
    const u = new URL(url);
    if (OWN_HOSTS.has(u.hostname.toLowerCase()) && /^\/(media|images|uploads)\//.test(u.pathname)) return true;
  } catch (_) { /* ignore */ }
  return false;
}

/** Télécharge une URL https en buffer image (redirections manuelles, SSRF revérifié à chaque saut). */
async function fetchImageBuffer(rawUrl) {
  let url = rawUrl;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    let parsed;
    try { parsed = new URL(url); } catch (_) { throw new Error('URL invalide'); }
    if (parsed.protocol !== 'https:') throw new Error('schéma non https');
    await assertPublicHost(parsed.hostname);

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
    let resp;
    try {
      resp = await fetch(url, { redirect: 'manual', signal: ctrl.signal, headers: { 'User-Agent': 'AutolivaImport/1.0' } });
    } catch (e) {
      throw new Error(e && e.name === 'AbortError' ? 'timeout' : `réseau (${e && e.message ? e.message : 'erreur'})`);
    } finally {
      clearTimeout(timer);
    }

    if (resp.status >= 300 && resp.status < 400) {
      const loc = resp.headers.get('location');
      if (!loc) throw new Error('redirection sans Location');
      if (hop === MAX_REDIRECTS) throw new Error('trop de redirections');
      url = new URL(loc, url).toString();
      continue;
    }
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);

    const ct = (resp.headers.get('content-type') || '').split(';')[0].trim().toLowerCase();
    const cl = parseInt(resp.headers.get('content-length') || '0', 10);
    if (cl && cl > MAX_BYTES) throw new Error('image > 10 Mo');
    if (ct && !CT_TO_EXT[ct]) throw new Error(`format non supporté (${ct})`);

    const buf = Buffer.from(await resp.arrayBuffer());
    if (!buf.length) throw new Error('réponse vide');
    if (buf.length > MAX_BYTES) throw new Error('image > 10 Mo');

    const ext = pickExt(ct, rawUrl);
    if (!ext) throw new Error('format non supporté');
    return { buffer: buf, contentType: ct && CT_TO_EXT[ct] ? ct : `image/${ext === 'jpeg' ? 'jpeg' : ext}`, ext };
  }
  throw new Error('trop de redirections');
}

/** Cherche un média déjà téléchargé depuis cette URL (idempotence). */
async function findExistingMediaUrl(sourceUrl) {
  try {
    const db = mongoose.connection && mongoose.connection.db;
    if (!db) return null;
    const doc = await db.collection('media.files').findOne(
      { 'metadata.sourceUrl': sourceUrl },
      { projection: { _id: 1 } }
    );
    if (doc && doc._id) return `/media/${String(doc._id)}`;
  } catch (_) { /* ignore */ }
  return null;
}

/**
 * Télécharge les images de l'import et renvoie les URLs /media/ résultantes.
 * @param {string[]} urls
 * @param {object} [opts] { label, sku }
 * @returns {Promise<{imageUrl,galleryUrls,galleryTypes,warnings,count}>}
 */
async function downloadImportImages(urls, opts = {}) {
  const list = (Array.isArray(urls) ? urls : [])
    .map((u) => (typeof u === 'string' ? u.trim() : ''))
    .filter(Boolean);
  const warnings = [];
  const out = [];

  if (list.length > MAX_IMAGES) {
    warnings.push(`images: ${list.length} fournies, seules les ${MAX_IMAGES} premières sont traitées.`);
  }
  const capped = list.slice(0, MAX_IMAGES);

  for (let i = 0; i < capped.length; i += 1) {
    const u = capped[i];
    try {
      if (isAlreadyHosted(u)) { out.push(u); continue; }
      if (!/^https:\/\//i.test(u)) { warnings.push(`images[${i}]: schéma non https`); continue; }

      const reuse = await findExistingMediaUrl(u);
      if (reuse) { out.push(reuse); continue; }

      const { buffer, contentType, ext } = await fetchImageBuffer(u);
      const base = mediaStorage.slugifyForMedia(opts.label || 'produit') || 'image';
      const saved = await mediaStorage.saveBuffer({
        buffer,
        filename: `${base}-${i + 1}.${ext}`,
        mimeType: contentType,
        metadata: { scope: 'product-import', sourceUrl: u, sku: opts.sku || '' },
      });
      out.push(saved.url);
    } catch (e) {
      warnings.push(`images[${i}]: ${e && e.message ? e.message : 'échec'}`);
    }
  }

  return {
    imageUrl: out[0] || '',
    galleryUrls: out,
    galleryTypes: out.map(() => 'image'),
    warnings,
    count: out.length,
  };
}

module.exports = { downloadImportImages, MAX_IMAGES, MAX_BYTES, isPrivateIp, isAlreadyHosted };
