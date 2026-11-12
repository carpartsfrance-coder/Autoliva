'use strict';

/**
 * Horodatage anti double-envoi des formulaires de devis (moteurs, boîtes,
 * ponts) — en COOKIE, plus en session.
 *
 * ── Pourquoi (diagnostic du 08/2026) ────────────────────────────────────────
 *
 * Les trois landings écrivaient `req.session.moteurFormTs = Date.now()` à
 * chaque AFFICHAGE de la page. Or ce sont les pages d'atterrissage Google Ads,
 * donc parmi les plus visitées du site : chaque clic, chaque robot, persistait
 * une session de 30 jours dans MongoDB. Avec `accountType` et `preferredLang`,
 * c'était l'un des trois robinets derrière les 1,9 million de sessions dont
 * 92 % vides — que le cron des paniers abandonnés relisait chaque heure.
 *
 * Ce que le mécanisme protège réellement : refuser un POST arrivé moins de
 * 800 ms après l'affichage ou après un envoi précédent (double-clic, robot
 * qui soumet instantanément). Un simple cookie porte cette information sans
 * rien écrire en base. Il n'est pas signé : un robot qui voudrait le forger
 * peut tout aussi bien attendre 800 ms — la protection est de même force
 * qu'avant, elle ne coûte simplement plus une session.
 *
 * Compatibilité : `lire()` retombe sur l'ancienne valeur de session si le
 * cookie est absent, pour les visiteurs dont la session date d'avant ce
 * changement.
 */

const NOM_COOKIE = 'devis_form_ts';
const DUREE_MS = 60 * 60 * 1000; // 1 h : largement le temps de remplir un formulaire

/** Pose l'horodatage « page affichée / formulaire envoyé » sur la réponse. */
function poser(res) {
  if (!res || typeof res.cookie !== 'function') return;
  res.cookie(NOM_COOKIE, String(Date.now()), {
    httpOnly: true,
    sameSite: 'lax',
    maxAge: DUREE_MS,
    path: '/',
  });
}

/** Lit l'horodatage (cookie d'abord, session pour les anciennes sessions). Retourne un nombre ou null. */
function lire(req) {
  const brut = req && req.headers && typeof req.headers.cookie === 'string' ? req.headers.cookie : '';
  for (const part of brut.split(';')) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() !== NOM_COOKIE) continue;
    const n = Number(part.slice(eq + 1).trim());
    if (Number.isFinite(n) && n > 0) return n;
  }
  const ancien = req && req.session && req.session.moteurFormTs;
  return typeof ancien === 'number' && ancien > 0 ? ancien : null;
}

module.exports = { poser, lire, NOM_COOKIE };
