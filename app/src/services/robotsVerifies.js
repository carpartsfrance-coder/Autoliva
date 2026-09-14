'use strict';

/**
 * Robots d'exploration VÉRIFIÉS : Googlebot, Storebot-Google, AdsBot-Google,
 * Bingbot — et l'adresse réelle du visiteur derrière Cloudflare.
 *
 * ── Pourquoi (plan de reprise SEO du 14/09/2026, action A4.3) ────────────────
 *
 * Le limiteur des sitemaps et des flux Merchant (30 demandes / 10 min) pouvait
 * répondre 429 à Google, qui traite un 429 comme une erreur serveur et ralentit
 * son exploration — au moment précis où l'on veut qu'il relise le site. Deux
 * défauts se cumulaient :
 *   1. la clé était req.ip. Render est servi derrière Cloudflare : req.ip peut
 *      y être l'adresse du nœud Cloudflare, partagée par tous les visiteurs qui
 *      passent par lui. Un scraper suffisait à épuiser le quota de Googlebot.
 *      L'adresse du visiteur est dans CF-Connecting-IP (ou True-Client-IP),
 *      que Cloudflare pose lui-même ;
 *   2. aucune exception pour les moteurs — volontairement, parce que n'importe
 *      qui peut écrire « Googlebot » dans son User-Agent.
 *
 * La vérification que Google et Bing documentent : résolution INVERSE (l'IP
 * donne un nom en googlebot.com, google.com ou search.msn.com), puis résolution
 * DIRECTE de ce nom, qui doit redonner la même IP. Un faux Googlebot échoue à
 * l'une des deux.
 *
 * ── Garde-fous ───────────────────────────────────────────────────────────────
 *
 * - Seules les requêtes qui SE DÉCLARENT l'un de ces robots sont vérifiées : un
 *   visiteur ordinaire ne coûte aucune résolution DNS.
 * - Résultat mis en cache par adresse : 24 h si vérifié, 1 h si refusé, 5 min
 *   si le DNS a échoué. Googlebot revient des centaines de fois par jour
 *   depuis les mêmes adresses.
 * - L'attente est bornée (1,5 s). Au-delà, la requête passe sous la limite
 *   normale — jamais bloquée pour autant — et la résolution, qui continue en
 *   arrière-plan, remplit le cache pour la suivante.
 * - Résolveur c-ares (dns.resolve*, dns.reverse) et non dns.lookup : ce dernier
 *   occupe un fil du pool libuv (4 par défaut), qu'un DNS lent bloquerait pour
 *   les lectures de fichiers de tout le site.
 * - googleusercontent.com est EXCLU : c'est aussi le nom inverse des machines
 *   virtuelles Google Cloud, que n'importe qui peut louer.
 */

const dns = require('dns').promises;
const net = require('net');
const { ipKeyGenerator } = require('express-rate-limit');

const DOMAINES_GOOGLE = ['googlebot.com', 'google.com'];
const DOMAINES_BING = ['search.msn.com'];

/* « Googlebot » couvre aussi Googlebot-Image, -Video, -News. AdsBot-Google et
   Storebot-Google ne contiennent PAS « Googlebot » : il faut les nommer. */
const FAMILLES = [
  { nom: 'Googlebot', ua: /googlebot/i, groupe: 'google', domaines: DOMAINES_GOOGLE },
  { nom: 'Storebot-Google', ua: /storebot-google/i, groupe: 'google', domaines: DOMAINES_GOOGLE },
  { nom: 'AdsBot-Google', ua: /adsbot-google/i, groupe: 'google', domaines: DOMAINES_GOOGLE },
  { nom: 'Bingbot', ua: /bingbot/i, groupe: 'bing', domaines: DOMAINES_BING },
];

/** La famille de robot que ce User-Agent DÉCLARE, ou null. Rien de vérifié. */
function robotDeclare(userAgent) {
  const ua = String(userAgent || '');
  if (!ua) return null;
  return FAMILLES.find((f) => f.ua.test(ua)) || null;
}

/** Forme canonique d'une IP, pour comparer ce que renvoient les DNS. */
function normaliserIp(valeur) {
  let ip = String(valeur || '').trim();
  if (!ip) return '';
  if (ip.startsWith('[') && ip.endsWith(']')) ip = ip.slice(1, -1);
  /* IPv4 vue en IPv6 (::ffff:66.249.66.1) : c'est l'IPv4. */
  const v4 = ip.match(/^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  if (v4) ip = v4[1];
  const version = net.isIP(ip);
  if (version === 4) return ip;
  if (version === 6) {
    /* L'analyseur d'URL de Node écrit l'IPv6 sous sa forme compressée
       canonique : 2001:4860:0:0::1 et 2001:4860::1 deviennent identiques. */
    try { return new URL(`http://[${ip}]/`).hostname.slice(1, -1).toLowerCase(); } catch (e) { return ip.toLowerCase(); }
  }
  return '';
}

/* Première adresse valable d'un en-tête (une liste « a, b » est possible). */
function premiereIp(valeur) {
  if (Array.isArray(valeur)) valeur = valeur[0];
  return normaliserIp(String(valeur || '').split(',')[0]);
}

/**
 * Adresse du visiteur. CF-Connecting-IP d'abord : Cloudflare la pose et
 * écrase toute valeur envoyée par le client. True-Client-IP ensuite (même
 * rôle, offres Cloudflare Enterprise). req.ip en dernier recours (local,
 * tests, ou si Cloudflare disparaissait).
 */
function ipDuVisiteur(req) {
  const h = (req && req.headers) || {};
  return premiereIp(h['cf-connecting-ip'])
    || premiereIp(h['true-client-ip'])
    || normaliserIp(req && (req.ip || (req.socket && req.socket.remoteAddress)));
}

/** Clé de limiteur : l'adresse du visiteur, regroupée par /56 en IPv6 (un
 *  abonné IPv6 dispose d'un bloc entier : sans regroupement, il changerait
 *  d'adresse à chaque requête pour échapper à la limite). */
function cleLimiteur(req) {
  const ip = ipDuVisiteur(req);
  return ip ? ipKeyGenerator(ip, 56) : 'ip-inconnue';
}

function nomAppartient(nom, domaines) {
  const n = String(nom || '').toLowerCase().replace(/\.$/, '');
  /* « .google.com » avec le point : evilgoogle.com et googlebot.com.pirate.net
     ne passent pas. */
  return domaines.some((d) => n.endsWith('.' + d));
}

/**
 * Crée un vérificateur. Les résolveurs sont injectables pour les tests ; par
 * défaut, ceux de Node (c-ares).
 */
function creerVerificateur({
  reverse = (ip) => dns.reverse(ip),
  resolve4 = (nom) => dns.resolve4(nom),
  resolve6 = (nom) => dns.resolve6(nom),
  delaiMaxMs = 1500,
  ttlVerifieMs = 24 * 60 * 60 * 1000,
  ttlRefuseMs = 60 * 60 * 1000,
  ttlErreurMs = 5 * 60 * 1000,
  maxEntrees = 5000,
  maintenant = () => Date.now(),
} = {}) {
  const resolveurs = { reverse, resolve4, resolve6 };
  const cache = new Map();
  const enCours = new Map();

  function memoriser(cle, verdict) {
    const ttl = verdict === true ? ttlVerifieMs : (verdict === false ? ttlRefuseMs : ttlErreurMs);
    cache.delete(cle);
    cache.set(cle, { ok: verdict === true, expire: maintenant() + ttl });
    /* Borne mémoire : on oublie les plus anciennes (ordre d'insertion). */
    while (cache.size > maxEntrees) cache.delete(cache.keys().next().value);
  }

  /* true : vérifié ; false : ce n'est pas lui ; null : DNS en échec. */
  async function resoudre(ip, famille) {
    let noms;
    try {
      noms = await resolveurs.reverse(ip);
    } catch (err) {
      if (err && (err.code === 'ENOTFOUND' || err.code === 'ENODATA')) return false;
      return null;
    }
    const candidats = (Array.isArray(noms) ? noms : [])
      .map((n) => String(n || '').toLowerCase().replace(/\.$/, ''))
      .filter((n) => nomAppartient(n, famille.domaines));
    /* « Ce nom n'existe pas / n'a pas d'adresse » est une RÉPONSE (un faux
       nom inverse, typiquement) ; une panne DNS n'en est pas une. */
    const reponseVide = (r) => r.status === 'rejected' && r.reason && (r.reason.code === 'ENOTFOUND' || r.reason.code === 'ENODATA');
    let echec = false;
    for (const nom of candidats) {
      const [v4, v6] = await Promise.allSettled([resolveurs.resolve4(nom), resolveurs.resolve6(nom)]);
      if (v4.status === 'rejected' && v6.status === 'rejected' && !(reponseVide(v4) && reponseVide(v6))) { echec = true; continue; }
      const adresses = [
        ...(v4.status === 'fulfilled' && Array.isArray(v4.value) ? v4.value : []),
        ...(v6.status === 'fulfilled' && Array.isArray(v6.value) ? v6.value : []),
      ].map(normaliserIp);
      if (adresses.includes(ip)) return true;
    }
    return echec ? null : false;
  }

  /**
   * L'adresse `ip` appartient-elle vraiment à la famille déclarée ? Jamais
   * plus de `delaiMaxMs` d'attente : au-delà, false (limite normale).
   */
  async function estVerifie(ipBrute, famille) {
    const ip = normaliserIp(ipBrute);
    if (!ip || !famille) return false;
    const cle = `${famille.groupe}|${ip}`;
    const connu = cache.get(cle);
    if (connu && connu.expire > maintenant()) return connu.ok;

    let promesse = enCours.get(cle);
    if (!promesse) {
      promesse = resoudre(ip, famille)
        .catch(() => null)
        .then((verdict) => { memoriser(cle, verdict); return verdict === true; })
        .finally(() => enCours.delete(cle));
      enCours.set(cle, promesse);
    }

    let minuteur;
    const delai = new Promise((resolve) => {
      minuteur = setTimeout(() => resolve(false), delaiMaxMs);
      if (minuteur.unref) minuteur.unref();
    });
    try {
      return await Promise.race([promesse, delai]);
    } finally {
      clearTimeout(minuteur);
    }
  }

  return {
    estVerifie,
    /* Pour les tests : remplacer les résolveurs, vider le cache. */
    definirResolveurs(nouveaux) { Object.assign(resolveurs, nouveaux || {}); },
    viderCache() { cache.clear(); enCours.clear(); },
    tailleCache() { return cache.size; },
  };
}

const verificateur = creerVerificateur();

/**
 * La requête vient-elle d'un Googlebot / Storebot-Google / AdsBot-Google /
 * Bingbot VÉRIFIÉ ? Sert de `skip` au limiteur des routes d'exploration.
 */
async function estRobotVerifie(req) {
  const famille = robotDeclare(req && req.headers && req.headers['user-agent']);
  if (!famille) return false;
  return verificateur.estVerifie(ipDuVisiteur(req), famille);
}

module.exports = {
  FAMILLES,
  robotDeclare,
  normaliserIp,
  ipDuVisiteur,
  cleLimiteur,
  creerVerificateur,
  estRobotVerifie,
  verificateur,
};
