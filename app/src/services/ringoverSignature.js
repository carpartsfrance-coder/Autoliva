'use strict';

/**
 * Vérification de la signature des webhooks Ringover.
 *
 * Ringover signe ses événements d'appel avec une « webhook key » (visible sur
 * la page de configuration des webhooks du dashboard). Deux versions coexistent
 * et on accepte les deux, puisqu'on ne maîtrise pas celle qui sera active :
 *
 *   V1 (défaut aujourd'hui) — JWT signé HS512. Le contenu signé est la
 *   concaténation de l'URL du webhook et du corps JSON brut. En-tête
 *   `X-Ringover-Webhook-Signature`. (`Authorization` porte le même JWT mais est
 *   déprécié : on ne le lit pas.)
 *
 *   V3 (sur demande, futur défaut) — Base64(HMAC-SHA256(clé, message)) où le
 *   message est METHODE + URL + CORPS + HORODATAGE, dans cet ordre exact.
 *   En-têtes `X-Ringover-Webhook-Signature-V3` et
 *   `X-Ringover-Request-Signature-V3-Timestamp`.
 *
 * ⚠ L'événement `ivr_response_code` N'EST PAS SIGNÉ — la documentation le dit
 * explicitement et recommande une URL secrète. C'est pourquoi la signature ne
 * remplace pas le secret dans l'URL : elle s'y ajoute quand elle est présente.
 *
 * IMPORTANT : la vérification porte sur le CORPS BRUT, pas sur l'objet
 * re-sérialisé. `JSON.stringify(JSON.parse(x))` ne redonne pas `x` (ordre des
 * clés, espaces, précision des flottants) et invaliderait toute signature.
 */

const crypto = require('crypto');

const TOLERANCE_S = 300; // 5 min : rejette les rejeux tardifs (V3 seulement)

function b64urlToBuf(s) {
  return Buffer.from(String(s).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
}

function egal(a, b) {
  const x = Buffer.from(String(a), 'utf8');
  const y = Buffer.from(String(b), 'utf8');
  if (x.length !== y.length) return false;
  return crypto.timingSafeEqual(x, y);
}

/** JWT HS512 : on vérifie la signature nous-mêmes, sans dépendance. */
function verifieV1(jwt, cle, url, corpsBrut) {
  const parts = String(jwt || '').split('.');
  if (parts.length !== 3) return false;
  const [entete, charge, sig] = parts;

  const attendu = crypto.createHmac('sha512', cle)
    .update(entete + '.' + charge)
    .digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  if (!egal(sig, attendu)) return false;

  /* L'algorithme doit être celui annoncé : sinon un jeton « alg: none » ou
     RS256 passerait la comparaison ci-dessus dans certaines implémentations. */
  try {
    const h = JSON.parse(b64urlToBuf(entete).toString('utf8'));
    if (String(h.alg).toUpperCase() !== 'HS512') return false;
  } catch (_) { return false; }

  /* Le JWT porte l'URL et le corps signés : on s'assure qu'ils correspondent
     bien à la requête reçue, sinon une signature valide d'un autre endpoint
     serait rejouable ici. */
  try {
    const c = JSON.parse(b64urlToBuf(charge).toString('utf8'));
    if (c.url && url && String(c.url) !== String(url)) return false;
    if (c.payload !== undefined) {
      const attenduCorps = typeof c.payload === 'string' ? c.payload : JSON.stringify(c.payload);
      if (attenduCorps && corpsBrut && attenduCorps !== corpsBrut) {
        /* Les deux sérialisations peuvent différer sans que ce soit une
           attaque ; on compare alors les objets. */
        try {
          if (JSON.stringify(JSON.parse(attenduCorps)) !== JSON.stringify(JSON.parse(corpsBrut))) return false;
        } catch (_) { return false; }
      }
    }
  } catch (_) { return false; }

  return true;
}

/** V3 : Base64(HMAC-SHA256(clé, "POST" + url + corps + horodatage)). */
function verifieV3(sig, horodatage, cle, url, corpsBrut, methode) {
  const ts = parseInt(String(horodatage || ''), 10);
  if (!Number.isFinite(ts)) return false;
  const age = Math.abs(Math.floor(Date.now() / 1000) - ts);
  if (age > TOLERANCE_S) return false;                    // anti-rejeu

  const message = String(methode || 'POST') + url + corpsBrut + String(horodatage);
  const attendu = crypto.createHmac('sha256', cle).update(message, 'utf8').digest('base64');
  return egal(sig, attendu);
}

/**
 * @param {string} [opts.cle] Clé à utiliser. Par défaut `RINGOVER_WEBHOOK_KEY`,
 *   celle de la section « Call Event ». Les sections « Contact Call » et
 *   « Contact search » de Ringover ont CHACUNE leur propre clé, affichée sous
 *   leur propre bloc — d'où ce paramètre.
 *
 * @returns {{ verifiee: boolean, version: string, raison?: string }}
 *   verifiee=false avec version='' signifie « aucune signature présente » —
 *   c'est le cas normal pour `ivr_response_code`, pas une erreur.
 */
function verifier({ headers, corpsBrut, url, methode, cle: cleFournie } = {}) {
  const cle = String(cleFournie || process.env.RINGOVER_WEBHOOK_KEY || '').trim();
  const h = headers || {};
  const v1 = h['x-ringover-webhook-signature'];
  const v3 = h['x-ringover-webhook-signature-v3'];
  const ts = h['x-ringover-request-signature-v3-timestamp'];

  if (!v1 && !v3) return { verifiee: false, version: '' };
  if (!cle) return { verifiee: false, version: v3 ? 'v3' : 'v1', raison: 'cle_absente' };

  if (v3) {
    return verifieV3(v3, ts, cle, url, corpsBrut, methode)
      ? { verifiee: true, version: 'v3' }
      : { verifiee: false, version: 'v3', raison: 'signature_invalide' };
  }
  return verifieV1(v1, cle, url, corpsBrut)
    ? { verifiee: true, version: 'v1' }
    : { verifiee: false, version: 'v1', raison: 'signature_invalide' };
}

module.exports = { verifier, TOLERANCE_S };
