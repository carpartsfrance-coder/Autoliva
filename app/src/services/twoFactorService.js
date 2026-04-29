/*
 * 2FA TOTP — implémentation RFC 6238 pure-Node (sans dépendance externe).
 * Compatible Google Authenticator / Authy / 1Password / Bitwarden.
 *
 * - generateSecret() : retourne un secret base32 (160 bits)
 * - otpauthUrl({secret, label, issuer}) : URI à mettre dans un QR
 * - verify(secret, code, window=1) : vérifie un code TOTP avec ±window slot
 * - generateBackupCodes(count=8) : codes de secours alphanumériques
 */

const crypto = require('crypto');
const brand = require('../config/brand');

// ---------- Base32 (RFC 4648) ----------
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32Encode(buf) {
  let bits = 0, value = 0, output = '';
  for (let i = 0; i < buf.length; i++) {
    value = (value << 8) | buf[i];
    bits += 8;
    while (bits >= 5) {
      output += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) output += ALPHABET[(value << (5 - bits)) & 31];
  return output;
}

function base32Decode(str) {
  const clean = String(str || '').toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0, value = 0;
  const out = [];
  for (let i = 0; i < clean.length; i++) {
    const idx = ALPHABET.indexOf(clean[i]);
    if (idx === -1) continue;
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

// ---------- TOTP ----------
function hotp(secretBuf, counter) {
  const buf = Buffer.alloc(8);
  // 64-bit big endian
  for (let i = 7; i >= 0; i--) {
    buf[i] = counter & 0xff;
    counter = Math.floor(counter / 256);
  }
  const hmac = crypto.createHmac('sha1', secretBuf).update(buf).digest();
  const offset = hmac[hmac.length - 1] & 0xf;
  const bin =
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff);
  return String(bin % 1000000).padStart(6, '0');
}

function generateSecret() {
  return base32Encode(crypto.randomBytes(20)); // 160 bits
}

function otpauthUrl({ secret, label, issuer = brand.NAME_SHORT }) {
  const params = new URLSearchParams({
    secret,
    issuer,
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  const safeLabel = encodeURIComponent(`${issuer}:${label || 'admin'}`);
  return `otpauth://totp/${safeLabel}?${params.toString()}`;
}

function verify(secret, code, window = 1) {
  if (!secret || !code) return false;
  const cleanCode = String(code).replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleanCode)) return false;
  const buf = base32Decode(secret);
  const counter = Math.floor(Date.now() / 1000 / 30);
  for (let w = -window; w <= window; w++) {
    if (hotp(buf, counter + w) === cleanCode) return true;
  }
  return false;
}

function generateBackupCodes(count = 8) {
  const codes = [];
  for (let i = 0; i < count; i++) {
    const raw = crypto.randomBytes(5).toString('hex').toUpperCase();
    codes.push(raw.slice(0, 4) + '-' + raw.slice(4, 8));
  }
  return codes;
}

function consumeBackupCode(storedCodes, attempt) {
  const norm = String(attempt || '').toUpperCase().replace(/\s+/g, '');
  const idx = (storedCodes || []).indexOf(norm);
  if (idx === -1) return { ok: false, remaining: storedCodes || [] };
  const remaining = storedCodes.slice();
  remaining.splice(idx, 1);
  return { ok: true, remaining };
}

module.exports = {
  generateSecret,
  otpauthUrl,
  verify,
  generateBackupCodes,
  consumeBackupCode,
};
