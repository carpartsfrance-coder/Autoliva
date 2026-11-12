'use strict';

/**
 * Connecteur **Comptoir** (getcomptoir.fr) — « Vendez partout. Comptez ici. »
 *
 * Pousse chaque commande encaissée vers Comptoir, qui sert de tableau de bord
 * unique des ventes toutes places de marché confondues.
 *
 * Guide officiel : https://getcomptoir.fr/guide-connecteur.html
 *
 *   POST <endpoint>              (défaut https://getcomptoir.fr/api/ingest/orders)
 *   Authorization: Bearer <clé>
 *   { externalId, amount, status, date, customerName, productName }
 *
 * Seul `amount` est obligatoire côté Comptoir ; on envoie tout ce qu'on a.
 *
 * ── DEUX PROPRIÉTÉS DE LEUR API QUI DICTENT TOUTE LA CONCEPTION ICI ─────────
 *
 * 1. ANTI-DOUBLON par `externalId` : renvoyer la même commande est sans effet
 *    (réponse 200 avec `duplicate: true`). Un réessai est donc TOUJOURS sûr —
 *    d'où le rattrapage périodique (src/jobs/syncComptoirOrders.js) plutôt
 *    qu'un envoi « au fil de l'eau » qu'un incident réseau perdrait en silence.
 *
 * 2. CRÉATION SEULEMENT : cette même protection empêche de METTRE À JOUR une
 *    commande déjà envoyée. Le statut transmis est donc figé à l'instant de
 *    l'envoi. On envoie au PAIEMENT (statut `preparation`) : une commande
 *    livrée plus tard n'apparaîtra pas « livree » côté Comptoir, mais elle
 *    sera comptée — ce qui est l'objet de l'outil. Un renvoi ultérieur ne
 *    corrigerait rien, inutile d'essayer.
 *
 * ── ACTIVATION ─────────────────────────────────────────────────────────────
 * Tant que `COMPTOIR_API_KEY` est absente, TOUT est no-op : aucun appel,
 * aucune écriture, aucune erreur. Déployable avant même d'avoir créé le
 * connecteur côté Comptoir.
 *
 * Variables d'env (Render) :
 *   COMPTOIR_API_KEY    clé affichée UNE SEULE FOIS à la création du connecteur
 *                       (app Comptoir → Connecteurs → + Connecteur personnalisé)
 *   COMPTOIR_ENDPOINT   URL complète, si Comptoir en affiche une autre que le défaut
 *   COMPTOIR_BULK_ENDPOINT  idem pour l'envoi groupé (défaut : <endpoint>/bulk)
 *   COMPTOIR_TIMEOUT_MS délai d'attente réseau (défaut 8000)
 */

const DEFAULT_ENDPOINT = 'https://getcomptoir.fr/api/ingest/orders';
const DEFAULT_TIMEOUT_MS = 8000;

function env(k) {
  return typeof process.env[k] === 'string' ? process.env[k].trim() : '';
}

function getApiKey() {
  return env('COMPTOIR_API_KEY');
}

function getEndpoint() {
  return env('COMPTOIR_ENDPOINT') || DEFAULT_ENDPOINT;
}

/* Envoi groupé : c'est le SEUL appel qui met à jour une vente déjà connue
   (guide Comptoir du 18/09/2026). L'appel unitaire, lui, ignore un renvoi. */
function getBulkEndpoint() {
  return env('COMPTOIR_BULK_ENDPOINT') || `${getEndpoint().replace(/\/+$/, '')}/bulk`;
}

function getTimeoutMs() {
  const n = parseInt(env('COMPTOIR_TIMEOUT_MS'), 10);
  return Number.isFinite(n) && n >= 1000 ? n : DEFAULT_TIMEOUT_MS;
}

/** Sans clé API, le connecteur n'existe pas : tout no-op. */
function isConfigured() {
  return getApiKey().length > 0;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Statuts
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Statuts Autoliva → les trois seuls statuts de Comptoir.
 *
 * `draft` et `pending_payment` n'y figurent pas volontairement : une commande
 * non payée n'a rien à faire dans un compteur de ventes (cf. isEncaissee).
 */
const STATUS_MAP = {
  paid: 'preparation',
  processing: 'preparation',
  label_created: 'preparation',
  shipped: 'livree',
  delivered: 'livree',
  completed: 'livree',
  cancelled: 'retour',
  refunded: 'retour',
  partially_refunded: 'retour',
};

function mapStatus(status) {
  return STATUS_MAP[String(status || '').trim()] || 'preparation';
}

/** Statuts de paiement qui valent « argent encaissé » (cf. adminController). */
const PAID_PAYMENT_STATUSES = new Set(['paid', 'captured', 'completed']);

/**
 * La commande représente-t-elle une vente réellement encaissée ?
 *
 * On se fie à `paymentStatus` (posé par Mollie/Scalapay/l'admin) et non au
 * statut commercial : un brouillon passé en « processing » à la main sans
 * encaissement ne doit pas gonfler le compteur.
 */
function isEncaissee(order) {
  if (!order) return false;
  const p = String(order.paymentStatus || '').trim().toLowerCase();
  return PAID_PAYMENT_STATUSES.has(p);
}

/* ──────────────────────────────────────────────────────────────────────────
 * Pays
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Les adresses portent un nom de pays EN FRANÇAIS (« Belgique »), Comptoir
 * attend « FR » ou « France » : on envoie le code ISO à 2 lettres, qui ne
 * dépend d'aucune orthographe.
 *
 * Les départements d'outre-mer partent en FR : ce sont des ventes françaises,
 * et rien ne garantit que Comptoir connaisse « RE » ou « GP ». Un pays inconnu
 * n'est PAS envoyé — mieux vaut une colonne vide qu'un pays faux.
 */
const PAYS_ISO = {
  france: 'FR', guadeloupe: 'FR', martinique: 'FR', guyane: 'FR', 'la reunion': 'FR',
  reunion: 'FR', mayotte: 'FR', 'saint-martin': 'FR', 'saint-barthelemy': 'FR',
  'nouvelle-caledonie': 'FR', 'polynesie francaise': 'FR', monaco: 'MC',
  belgique: 'BE', luxembourg: 'LU', suisse: 'CH', allemagne: 'DE', autriche: 'AT',
  espagne: 'ES', italie: 'IT', 'pays-bas': 'NL', portugal: 'PT', irlande: 'IE',
  'royaume-uni': 'GB', pologne: 'PL', 'republique tcheque': 'CZ', slovaquie: 'SK',
  hongrie: 'HU', roumanie: 'RO', bulgarie: 'BG', grece: 'GR', croatie: 'HR',
  slovenie: 'SI', suede: 'SE', danemark: 'DK', finlande: 'FI', norvege: 'NO',
  lituanie: 'LT', lettonie: 'LV', estonie: 'EE', malte: 'MT', chypre: 'CY',
  andorre: 'AD', maroc: 'MA', algerie: 'DZ', tunisie: 'TN',
};

/** « La Réunion » → « la reunion » : accents et casse ne doivent rien changer. */
function normaliserPays(valeur) {
  return String(valeur == null ? '' : valeur)
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Code ISO du pays de LIVRAISON (à défaut, de facturation). '' si inconnu. */
function paysCommande(order) {
  const candidats = [
    order && order.shippingAddress && order.shippingAddress.country,
    order && order.billingAddress && order.billingAddress.country,
  ];
  for (const brut of candidats) {
    const cle = normaliserPays(brut);
    if (!cle) continue;
    if (/^[a-z]{2}$/.test(cle)) return cle.toUpperCase();  // déjà un code ISO
    if (PAYS_ISO[cle]) return PAYS_ISO[cle];
  }
  return '';
}

/* ──────────────────────────────────────────────────────────────────────────
 * Payload
 * ────────────────────────────────────────────────────────────────────────── */

function trimStr(v, max) {
  const s = String(v == null ? '' : v).trim();
  return max ? s.slice(0, max) : s;
}

/** Libellé produit : le premier article, en signalant qu'il y en a d'autres. */
function buildProductName(order) {
  const items = Array.isArray(order && order.items) ? order.items.filter(Boolean) : [];
  if (!items.length) return '';
  const first = trimStr(items[0].name, 180);
  if (items.length === 1) return first;
  return trimStr(`${first} (+${items.length - 1} autre${items.length > 2 ? 's' : ''})`, 200);
}

/** Date de la vente : l'encaissement s'il est connu, sinon la création. */
function saleDate(order) {
  const d = (order && (order.molliePaidAt || order.scalapayCapturedAt || order.createdAt)) || null;
  const dt = d ? new Date(d) : null;
  return dt && !Number.isNaN(dt.getTime()) ? dt : new Date();
}

/**
 * Construit le corps de la requête. Pur (aucun accès réseau ni base) : c'est
 * ce que les tests unitaires vérifient.
 */
function buildPayload(order) {
  const payload = {
    externalId: trimStr(order && order.number, 120),
    amount: Math.round(Number((order && order.totalCents) || 0)) / 100,
    status: mapStatus(order && order.status),
    date: saleDate(order).toISOString(),
  };

  const customerName = trimStr(
    (order && order.billingAddress && order.billingAddress.fullName)
      || (order && order.shippingAddress && order.shippingAddress.fullName)
      || '',
    160
  );
  if (customerName) payload.customerName = customerName;

  const productName = buildProductName(order);
  if (productName) payload.productName = productName;

  /* Alimente la colonne « Pays » de Comptoir (champ ajouté le 18/09/2026). */
  const country = paysCommande(order);
  if (country) payload.country = country;

  /* Quantité du PREMIER article — celui qui donne son nom à la fiche côté
     Comptoir. Envoyer la somme de toutes les lignes associerait la quantité
     d'articles qu'on ne nomme pas au produit qu'on nomme. */
  const first = Array.isArray(order && order.items) ? order.items.filter(Boolean)[0] : null;
  const qty = first ? Math.round(Number(first.quantity)) : NaN;
  if (Number.isFinite(qty) && qty > 0) payload.quantity = qty;

  return payload;
}

/* ──────────────────────────────────────────────────────────────────────────
 * Envoi HTTP (aucune écriture en base — voir syncOrder)
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * @returns {Promise<{ok:boolean, skipped?:boolean, status?:number, duplicate?:boolean,
 *                     note?:string, error?:string}>}
 * Ne jette jamais : un incident Comptoir ne doit pas casser un encaissement.
 */
async function pushOrder(order) {
  if (!isConfigured()) return { ok: false, skipped: true, error: 'COMPTOIR_API_KEY absente' };
  if (!order) return { ok: false, error: 'commande absente' };

  const payload = buildPayload(order);
  if (!Number.isFinite(payload.amount) || payload.amount <= 0) {
    /* Comptoir répond 400 sur un montant nul : autant ne pas l'appeler, et
       surtout ne pas empiler des réessais qui échoueront toujours. */
    return { ok: false, error: `montant invalide (${payload.amount})`, permanent: true };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getTimeoutMs());

  try {
    const res = await fetch(getEndpoint(), {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${getApiKey()}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    const raw = await res.text();
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch (_) { /* réponse non JSON */ }

    if (res.status >= 200 && res.status < 300) {
      return {
        ok: true,
        status: res.status,
        duplicate: !!(body && body.duplicate),
        note: trimStr(body && body.note, 300),
      };
    }

    /* 400 (montant/date invalides) et 401 (clé morte) ne passeront jamais en
       réessayant : on le dit, le rattrapage arrêtera de les reprendre. */
    const permanent = res.status === 400 || res.status === 401;
    const message = trimStr((body && (body.error || body.message)) || raw, 300)
      || `HTTP ${res.status}`;
    return { ok: false, status: res.status, error: message, permanent };
  } catch (err) {
    const message = err && err.name === 'AbortError'
      ? `délai dépassé (${getTimeoutMs()} ms)`
      : trimStr(err && err.message, 300) || 'erreur réseau';
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/* ──────────────────────────────────────────────────────────────────────────
 * Envoi + marquage en base
 * ────────────────────────────────────────────────────────────────────────── */

const MAX_ATTEMPTS = 5;

/**
 * Envoie une commande à Comptoir et trace le résultat sur la commande
 * (`order.comptoir`), de sorte qu'elle ne soit jamais envoyée deux fois et
 * qu'un échec reste visible dans `lastError` — pas avalé par un `.catch()`.
 *
 * Idempotent : appelable depuis le paiement ET depuis le rattrapage.
 *
 * @param {string|object} orderOrId commande ou identifiant
 * @param {{force?:boolean}} [options] force : renvoyer même si déjà marquée envoyée
 */
async function syncOrder(orderOrId, options = {}) {
  if (!isConfigured()) return { ok: false, skipped: true, reason: 'non_configure' };

  const Order = require('../models/Order');
  const id = orderOrId && orderOrId._id ? orderOrId._id : orderOrId;
  if (!id) return { ok: false, skipped: true, reason: 'id_absent' };

  const order = await Order.findById(id).lean();
  if (!order) return { ok: false, skipped: true, reason: 'introuvable' };

  const state = order.comptoir || {};
  if (state.sentAt && !options.force) return { ok: true, skipped: true, reason: 'deja_envoyee' };
  if (!isEncaissee(order)) return { ok: false, skipped: true, reason: 'non_encaissee' };
  if (order.deletedAt) return { ok: false, skipped: true, reason: 'supprimee' };

  const result = await pushOrder(order);

  if (result.ok) {
    await Order.updateOne({ _id: order._id }, {
      $set: {
        'comptoir.sentAt': new Date(),
        'comptoir.externalId': buildPayload(order).externalId,
        'comptoir.duplicate': !!result.duplicate,
        'comptoir.lastAttemptAt': new Date(),
        'comptoir.lastError': '',
        /* Statut connu de Comptoir à cet instant : la suite ne renverra que
           s'il change (voir syncStatuses). */
        'comptoir.statusSentFor': buildPayload(order).status,
        'comptoir.countrySentFor': paysCommande(order),
        'comptoir.statusSyncedAt': new Date(),
        'comptoir.statusAttempts': 0,
        'comptoir.statusError': '',
        /* Un envoi qui passe efface le verdict « définitif » d'un échec
           antérieur : sans ça, une commande poussée après une clé corrigée
           gardait `permanentError: true` et sortait du rattrapage pour de bon
           (vécu le 09/09/2026 — backfill lancé une première fois avec un
           placeholder de clé, donc 251 commandes en 401 puis renvoyées). */
        'comptoir.permanentError': false,
      },
      $inc: { 'comptoir.attempts': 1 },
    });
    console.log(`[comptoir] ${order.number} envoyée${result.duplicate ? ' (déjà connue de Comptoir)' : ''}`);
    return { ok: true, duplicate: !!result.duplicate, note: result.note };
  }

  if (result.skipped) return { ok: false, skipped: true, reason: 'non_configure' };

  await Order.updateOne({ _id: order._id }, {
    $set: {
      'comptoir.lastAttemptAt': new Date(),
      'comptoir.lastError': trimStr(result.error, 300),
      'comptoir.permanentError': !!result.permanent,
    },
    $inc: { 'comptoir.attempts': 1 },
  });
  console.error(`[comptoir] échec ${order.number} : ${result.error}`);
  return { ok: false, error: result.error, permanent: !!result.permanent };
}

/* ──────────────────────────────────────────────────────────────────────────
 * Mise à jour des statuts (envoi groupé)
 * ────────────────────────────────────────────────────────────────────────── */

/** Comptoir refuse au-delà de 500 commandes par appel. */
const BULK_MAX = 500;

/** Statut Comptoir déjà connu pour une vente : l'envoi initial valait « preparation ». */
function statutChezComptoir(order) {
  return trimStr((order && order.comptoir && order.comptoir.statusSentFor) || '') || 'preparation';
}

/**
 * Cette vente est-elle telle que Comptoir la connaît ? On compare ce qui peut
 * changer après l'envoi : le statut, et le pays (champ apparu le 18/09/2026,
 * donc vide sur tout l'historique — d'où un renvoi unique qui le remplit).
 */
function aJourChezComptoir(order) {
  const paysAttendu = paysCommande(order);
  const paysConnu = trimStr((order && order.comptoir && order.comptoir.countrySentFor) || '');
  return mapStatus(order && order.status) === statutChezComptoir(order) && paysAttendu === paysConnu;
}

/**
 * POST groupé. Ne jette jamais.
 * @returns {Promise<{ok:boolean, status?:number, body?:object, error?:string, permanent?:boolean}>}
 */
async function pushOrdersBulk(payloads) {
  if (!isConfigured()) return { ok: false, skipped: true, error: 'COMPTOIR_API_KEY absente' };
  const lot = (Array.isArray(payloads) ? payloads : []).slice(0, BULK_MAX);
  if (!lot.length) return { ok: true, body: null };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), getTimeoutMs());
  try {
    const res = await fetch(getBulkEndpoint(), {
      method: 'POST',
      headers: { Authorization: `Bearer ${getApiKey()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ orders: lot }),
      signal: controller.signal,
    });
    const raw = await res.text();
    let body = null;
    try { body = raw ? JSON.parse(raw) : null; } catch (_) { /* réponse non JSON */ }
    if (res.status >= 200 && res.status < 300) return { ok: true, status: res.status, body };
    const permanent = res.status === 400 || res.status === 401 || res.status === 404;
    return {
      ok: false,
      status: res.status,
      error: trimStr((body && (body.error || body.message)) || raw, 300) || `HTTP ${res.status}`,
      permanent,
    };
  } catch (err) {
    const message = err && err.name === 'AbortError'
      ? `délai dépassé (${getTimeoutMs()} ms)`
      : trimStr(err && err.message, 300) || 'erreur réseau';
    return { ok: false, error: message };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Identifiants refusés par Comptoir dans une réponse groupée.
 *
 * Leur guide annonce un décompte (créées / mises à jour / inchangées / en
 * échec) sans en fixer la forme exacte, et leur code a déjà été en avance sur
 * leur doc (09/09/2026). On lit donc ce qu'on trouve :
 *   - une liste d'échecs détaillée  → on ne réessaie que ceux-là ;
 *   - un simple compteur non nul    → on ne peut pas distinguer, tout le lot
 *     est réessayé à l'heure suivante (le renvoi est sans risque) ;
 *   - rien                          → tout est passé.
 * @returns {Set<string>|null} null = échecs non identifiables
 */
function echecsDuLot(body) {
  if (!body || typeof body !== 'object') return new Set();
  const listes = [body.failed, body.errors, body.failures, body.results, body.orders]
    .filter((v) => Array.isArray(v));
  const refuses = new Set();
  let detaillee = false;
  for (const liste of listes) {
    for (const item of liste) {
      if (!item || typeof item !== 'object') continue;
      const id = trimStr(item.externalId || item.external_id || item.reference || item.id);
      if (!id) continue;
      detaillee = true;
      const enEchec = item.error || item.failed === true || item.ok === false
        || /fail|error|invalid|refus/i.test(String(item.status || item.result || ''));
      if (enEchec) refuses.add(id);
    }
  }
  if (detaillee) return refuses;
  const compteur = Number(body.failed);
  if (Number.isFinite(compteur) && compteur > 0) return null;
  return refuses;
}

/**
 * Met à jour chez Comptoir le statut des ventes déjà envoyées qui ont bougé
 * depuis (livrée, retour).
 *
 * Jusqu'au 18/09/2026 c'était impossible : leur API ignorait un renvoi, et
 * toutes nos ventes restaient « préparation » chez eux. Leur envoi groupé met
 * désormais à jour une vente de même `externalId`.
 *
 * Un renvoi étant sans effet de bord, la prudence va dans un seul sens : en
 * cas de doute on réessaie, jamais on ne marque à tort « à jour ».
 *
 * @param {{limit?:number, windowDays?:number, force?:boolean}} [options]
 *   force : renvoyer TOUTES les ventes, même celles qu'on croit à jour. Passage
 *   quotidien recommandé par Comptoir — il rattrape ce que leur côté aurait
 *   perdu sans nous le dire, et une vente bloquée par ses réessais.
 */
async function syncStatuses({ limit = 2000, windowDays = 365, force = false } = {}) {
  if (!isConfigured()) return { skipped: true, reason: 'non_configure' };

  const Order = require('../models/Order');
  const since = new Date(Date.now() - windowDays * 86400000);
  const filtre = {
    'comptoir.sentAt': { $exists: true, $ne: null },
    createdAt: { $gte: since },
    deletedAt: null,
  };
  /* Un renvoi complet ignore le compteur d'échecs : c'est justement le passage
     qui doit rattraper une vente bloquée. */
  if (!force) {
    filtre.$or = [
      { 'comptoir.statusAttempts': { $lt: MAX_ATTEMPTS } },
      { 'comptoir.statusAttempts': { $exists: false } },
    ];
  }
  const envoyees = await Order.find(filtre)
    .select('_id number status paymentStatus totalCents items billingAddress shippingAddress createdAt molliePaidAt scalapayCapturedAt comptoir')
    .sort({ updatedAt: -1 })
    .limit(Math.max(1, limit))
    .lean();

  const aRenvoyer = envoyees.filter((o) => isEncaissee(o) && (force || !aJourChezComptoir(o)));
  const out = { candidates: envoyees.length, changed: aRenvoyer.length, updated: 0, errors: 0, force: !!force };
  if (!aRenvoyer.length) return out;

  /* Leur limite est de 500 commandes par appel : au-delà, on envoie par
     paquets. Un paquet en échec n'empêche pas les suivants. */
  for (let i = 0; i < aRenvoyer.length; i += BULK_MAX) {
    const paquet = aRenvoyer.slice(i, i + BULK_MAX);
    await envoyerPaquet(Order, paquet, out);
  }
  console.log('[comptoir-statuts]', JSON.stringify(out));
  return out;
}

/** Un paquet (≤ 500) : envoi, puis marquage de ce que Comptoir a accepté. */
async function envoyerPaquet(Order, aRenvoyer, out) {
  const resultat = await pushOrdersBulk(aRenvoyer.map(buildPayload));
  const maintenant = new Date();

  if (!resultat.ok) {
    out.errors += aRenvoyer.length;
    out.error = resultat.error;
    await Order.updateMany({ _id: { $in: aRenvoyer.map((o) => o._id) } }, {
      $set: { 'comptoir.statusError': trimStr(resultat.error, 300) },
      $inc: { 'comptoir.statusAttempts': 1 },
    });
    console.error('[comptoir-statuts] échec du lot :', resultat.error);
    return;
  }

  const refuses = echecsDuLot(resultat.body);
  const passees = refuses ? aRenvoyer.filter((o) => !refuses.has(buildPayload(o).externalId)) : [];
  const echouees = aRenvoyer.filter((o) => !passees.includes(o));

  for (const o of passees) {
    /* Statut confirmé : on remet aussi le compteur d'échecs à zéro — un succès
       doit toujours effacer un verdict d'échec (leçon du 09/09/2026). */
    await Order.updateOne({ _id: o._id }, {
      $set: {
        'comptoir.statusSentFor': mapStatus(o.status),
        'comptoir.countrySentFor': paysCommande(o),
        'comptoir.statusSyncedAt': maintenant,
        'comptoir.statusAttempts': 0,
        'comptoir.statusError': '',
      },
    });
  }
  if (echouees.length) {
    await Order.updateMany({ _id: { $in: echouees.map((o) => o._id) } }, {
      $set: { 'comptoir.statusError': refuses ? 'refusée par Comptoir' : 'échecs non détaillés par Comptoir' },
      $inc: { 'comptoir.statusAttempts': 1 },
    });
  }

  out.updated += passees.length;
  out.errors += echouees.length;
  console.log('[comptoir-statuts] paquet de', aRenvoyer.length, '→', passees.length, 'acceptée(s) · réponse :', trimStr(JSON.stringify(resultat.body), 300));
}

/**
 * Déclenche un envoi sans attendre — pour les chemins de paiement, où l'on ne
 * veut pas faire patienter le client derrière un appel à Comptoir.
 *
 * Le rattrapage horaire reprendra la commande si l'appel échoue : rien n'est
 * perdu, contrairement à un `.catch(() => {})` muet.
 */
function syncOrderInBackground(orderOrId) {
  if (!isConfigured()) return;
  Promise.resolve()
    .then(() => syncOrder(orderOrId))
    .catch((err) => {
      console.error('[comptoir] erreur inattendue :', err && err.message ? err.message : err);
    });
}

module.exports = {
  DEFAULT_ENDPOINT,
  BULK_MAX,
  isConfigured,
  getEndpoint,
  getBulkEndpoint,
  mapStatus,
  paysCommande,
  isEncaissee,
  buildPayload,
  buildProductName,
  pushOrder,
  pushOrdersBulk,
  syncStatuses,
  syncOrder,
  syncOrderInBackground,
  MAX_ATTEMPTS,
};
