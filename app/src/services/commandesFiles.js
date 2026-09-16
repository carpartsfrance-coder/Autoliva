'use strict';

/**
 * Files de traitement des commandes (admin /admin/commandes).
 *
 * La page était faite pour CHERCHER une commande ; elle est désormais faite
 * pour en TRAITER une série. Chaque commande en cours appartient à une file —
 * « qu'est-ce que je traite maintenant ? » — et porte UNE action suivante,
 * déduite de son statut et de l'approvisionnement de sa pièce.
 *
 * Ce module ne touche ni la base ni la requête : il décide, à partir d'une
 * commande (objet lean), de sa file, de son retard et de son action suivante.
 * La liste, les compteurs, l'endpoint d'avancement et le JavaScript de la page
 * s'appuient tous sur lui — une seule vérité, testée dans
 * tests/unit/commandes-files.test.js.
 *
 * Trois écarts assumés avec la maquette (design_handoff_admin_commandes),
 * dictés par les données réelles du 16/09/2026 :
 *
 *   - Une commande en « Étiquette créée » dont l'appro n'a jamais été
 *     renseignée (27 en production) a forcément sa pièce : elle va dans « À
 *     expédier », pas dans « Appro à vérifier » où on lui demanderait si la
 *     pièce est en stock.
 *   - Une commande livrée dont l'ancienne pièce (consigne) n'est pas revenue
 *     ne propose pas « Terminer » : clore le dossier cacherait un retour dû.
 *     Elle ne reste pas non plus dans « En transit » : le colis est arrivé, la
 *     suite se joue dans « Consignes en attente ». En production, c'étaient
 *     144 des 182 commandes de la file, qui noyaient les 38 à traiter.
 *   - Le service de clonage seul (pas de pièce à sourcer) ne passe pas par les
 *     files d'appro ; il rejoint « À expédier » quand le clonage est fait.
 */

const sourcingStatus = require('../config/sourcingStatus');

const JOUR_MS = 24 * 60 * 60 * 1000;

const FILES = [
  { id: 'a_verifier', label: 'Appro à vérifier', icon: 'help' },
  { id: 'a_commander', label: 'À commander', icon: 'shopping_cart' },
  { id: 'commandee', label: 'À recevoir', icon: 'pending' },
  { id: 'expedier', label: 'À expédier', icon: 'inventory_2' },
  { id: 'transit', label: 'En transit', icon: 'local_shipping' },
  { id: 'all', label: 'Toutes', icon: 'list' },
];
const IDS_FILES = FILES.map((f) => f.id);

/* États d'approvisionnement : libellé, prochaine étape, seuil de retard (jours).
   Couleur + icône : jamais la couleur seule. */
const APPRO = {
  a_verifier: { label: 'Stock à vérifier', suite: 'Vérifier le stock', limite: 1, icon: 'help', ton: 'neutre' },
  a_commander: { label: 'À commander', suite: 'Passer commande fournisseur', limite: 2, icon: 'shopping_cart', ton: 'rose' },
  commandee: { label: 'Commandée (fournisseur)', suite: 'Attente réception', limite: 7, icon: 'pending', ton: 'ambre' },
  en_stock: { label: 'En stock / reçue', suite: 'Préparer l’expédition', limite: null, icon: 'check_circle', ton: 'vert' },
};

const AVANT_EXPEDITION = sourcingStatus.PRESHIP_STATUSES; // paid, processing, label_created

/* Les actions qu'un clic peut appliquer depuis la liste. `message` complète
   « CP2026-000512 → … » dans la notification. */
const ACTIONS = {
  en_stock: { label: 'Oui', icon: 'check_circle', message: 'pièce en stock, en préparation' },
  a_commander: { label: 'À commander', icon: 'shopping_cart', message: 'pièce à commander' },
  commandee: { label: 'Commandée', icon: 'shopping_cart_checkout', message: 'commandée au fournisseur' },
  recue: { label: 'Reçue atelier', icon: 'move_to_inbox', message: 'reçue à l’atelier' },
  expediee: { label: 'Expédiée', icon: 'send', message: 'expédiée' },
  livree: { label: 'Livrée', icon: 'task_alt', message: 'livrée' },
  terminer: { label: 'Terminer', icon: 'done_all', message: 'terminée' },
};
const IDS_ACTIONS = Object.keys(ACTIONS);

function estServiceClonage(order) {
  return !!order && order.orderType === 'standalone_cloning';
}

/** Un numéro de suivi exploitable pour l'envoi au client (pas l'étiquette de
 *  récupération d'une pièce à cloner). */
function aSuiviEnvoi(order) {
  const envois = order && Array.isArray(order.shipments) ? order.shipments : [];
  return envois.some((s) => {
    if (!s || !String(s.trackingNumber || '').trim()) return false;
    return !/r[ée]cup[ée]ration clonage/i.test(String(s.label || ''));
  });
}

/** L'ancienne pièce (échange standard) est attendue en retour. */
function retourAttendu(order) {
  return !!order && order.orderType === 'exchange' && ['pending', 'overdue'].includes(order.returnStatus);
}

/* Une fois l'étiquette faite, la pièce est forcément là. */
const PIECE_LA = ['label_created', 'shipped', 'delivered', 'completed'];

/**
 * Appro telle qu'elle compte pour les files. Une commande étiquetée, expédiée
 * ou livrée dont l'appro n'a jamais été renseignée (la plupart en production)
 * vaut « en stock » : sans pièce, pas d'étiquette. Un choix explicite (à
 * commander, commandée) est toujours respecté.
 */
function approEffectif(order) {
  const brut = order && order.sourcing ? order.sourcing.status : null;
  const appro = sourcingStatus.normalizeStatus(brut);
  if (order && PIECE_LA.includes(order.status) && appro === 'a_verifier') return 'en_stock';
  return appro;
}

/** Files auxquelles la commande appartient, « all » compris. */
function files(order) {
  const liste = [];
  if (!order) return liste;
  if (AVANT_EXPEDITION.includes(order.status)) {
    if (estServiceClonage(order)) {
      if (order.cloningStatus === 'cloning_done' || order.status === 'label_created') liste.push('expedier');
    } else {
      const appro = approEffectif(order);
      liste.push(appro === 'en_stock' ? 'expedier' : appro);
    }
  } else if (order.status === 'shipped' || (order.status === 'delivered' && !retourAttendu(order))) {
    liste.push('transit');
  }
  liste.push('all');
  return liste;
}

function dateValide(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** Dernier passage à ce statut, d'après l'historique. */
function dateDuStatut(order, statut) {
  const historique = order && Array.isArray(order.statusHistory) ? order.statusHistory : [];
  for (let i = historique.length - 1; i >= 0; i--) {
    const h = historique[i];
    if (h && h.status === statut) {
      const d = dateValide(h.changedAt);
      if (d) return d;
    }
  }
  return null;
}

function dateDernierEnvoi(order) {
  const envois = order && Array.isArray(order.shipments) ? order.shipments : [];
  let plusRecente = null;
  for (const s of envois) {
    const d = dateValide(s && s.createdAt);
    if (d && (!plusRecente || d > plusRecente)) plusRecente = d;
  }
  return plusRecente;
}

/**
 * Seuil de retard de l'étape en cours, en jours, ou null si l'étape ne peut
 * pas être en retard. Un seuil unique ne marche pas : une pièce fournisseur à
 * 5 jours est normale, une étiquette non partie depuis 5 jours ne l'est pas.
 */
function limiteJours(order) {
  if (!order) return null;
  if (order.status === 'label_created') return 1;
  if (order.status === 'shipped') return 6;
  if (!['paid', 'processing'].includes(order.status)) return null;
  if (estServiceClonage(order)) return null;
  const appro = approEffectif(order);
  if (appro === 'commandee') {
    const prevu = Number(order.sourcing && order.sourcing.expectedDays);
    return Number.isFinite(prevu) && prevu > 0 ? prevu : APPRO.commandee.limite;
  }
  return APPRO[appro].limite;
}

/** Début de l'étape en cours : c'est de là que l'âge se compte. */
function debutEtape(order) {
  if (!order) return null;
  const creation = dateValide(order.createdAt);
  if (order.status === 'label_created' || order.status === 'shipped') {
    return dateDuStatut(order, order.status) || dateDernierEnvoi(order) || creation;
  }
  const payee = dateDuStatut(order, 'paid') || creation;
  const s = order.sourcing || {};
  const appro = approEffectif(order);
  if (appro === 'commandee') return dateValide(s.orderedAt) || dateValide(s.updatedAt) || payee;
  if (appro === 'a_commander') return dateValide(s.updatedAt) || payee;
  return payee;
}

/**
 * { enRetard, jours } — `jours` est le DÉPASSEMENT du seuil, pas l'âge : une
 * commande expédiée depuis 8 jours avec un seuil à 6 affiche « Retard 2j ».
 */
function retard(order, maintenant = new Date()) {
  const limite = limiteJours(order);
  const debut = debutEtape(order);
  if (limite === null || !debut) return { enRetard: false, jours: 0 };
  const age = Math.floor((maintenant.getTime() - debut.getTime()) / JOUR_MS);
  return age > limite ? { enRetard: true, jours: age - limite } : { enRetard: false, jours: 0 };
}

/**
 * L'action suivante, déduite du couple statut + appro.
 *   { id, label, icon, style, besoin }
 *   id      — action applicable en un clic (voir ACTIONS), ou null ;
 *   style   — 'fonce' (traitement) ou 'doux' (clôture) ;
 *   besoin  — 'decision' (la colonne Appro pose la question), 'etiquette'
 *             (saisie de l'étiquette et du suivi), 'suivi' (expédiée bloquée
 *             sans numéro de suivi), 'retour' (consigne pas revenue) ou null.
 * null quand il n'y a rien à faire depuis la liste (payée pas encore, annulée…).
 */
function actionSuivante(order) {
  if (!order) return null;
  const a = (id, extra = {}) => ({ id, label: ACTIONS[id].label, icon: ACTIONS[id].icon, style: 'fonce', besoin: null, ...extra });

  if (order.status === 'delivered') {
    if (retourAttendu(order)) return { id: null, label: 'Retour attendu', icon: 'assignment_return', style: 'doux', besoin: 'retour' };
    return a('terminer', { style: 'doux' });
  }
  if (order.status === 'shipped') return a('livree');
  if (order.status === 'label_created') return a('expediee', { besoin: aSuiviEnvoi(order) ? null : 'suivi' });
  if (!['paid', 'processing'].includes(order.status)) return null;

  const etiquette = { id: null, label: 'Ajouter étiquette', icon: 'label', style: 'fonce', besoin: 'etiquette' };
  if (estServiceClonage(order)) return order.cloningStatus === 'cloning_done' ? etiquette : null;

  const appro = approEffectif(order);
  if (appro === 'a_verifier') return { id: null, label: 'Pièce en stock ?', icon: 'inventory', style: 'fonce', besoin: 'decision' };
  if (appro === 'a_commander') return a('commandee');
  if (appro === 'commandee') return a('recue');
  return etiquette;
}

/** Actions qu'on peut appliquer MAINTENANT à cette commande, sans saisie. */
function actionsPossibles(order) {
  const suivante = actionSuivante(order);
  if (!suivante) return [];
  if (suivante.besoin === 'decision') return ['en_stock', 'a_commander'];
  return suivante.id && !suivante.besoin ? [suivante.id] : [];
}

/**
 * État de la commande après l'action : { status, sourcingStatus }. Le passage
 * en préparation ne vaut que depuis « payée » : une commande déjà en
 * préparation ou étiquetée ne recule pas.
 */
function etatApres(order, actionId) {
  const status = order.status;
  const appro = approEffectif(order);
  const enPreparation = status === 'paid' ? 'processing' : status;
  switch (actionId) {
    case 'en_stock': return { status: enPreparation, sourcingStatus: 'en_stock' };
    case 'a_commander': return { status, sourcingStatus: 'a_commander' };
    case 'commandee': return { status: enPreparation, sourcingStatus: 'commandee' };
    case 'recue': return { status: enPreparation, sourcingStatus: 'en_stock' };
    case 'expediee': return { status: 'shipped', sourcingStatus: appro };
    case 'livree': return { status: 'delivered', sourcingStatus: appro };
    case 'terminer': return { status: 'completed', sourcingStatus: appro };
    default: return { status, sourcingStatus: appro };
  }
}

/** Files où irait la commande après l'action — pour la faire sortir de la
 *  file à l'écran sans attendre le serveur. */
function filesApres(order, actionId) {
  const apres = etatApres(order, actionId);
  return files({
    ...order,
    status: apres.status,
    sourcing: { ...(order.sourcing || {}), status: apres.sourcingStatus },
  });
}

/** Ligne d'alerte sous la cellule Appro — uniquement pour l'appro, jamais pour
 *  un retard d'expédition (c'est la pastille de statut qui le porte).
 *
 *  La maquette ajoutait « Appro non renseignée à la commande » quand aucun
 *  fournisseur n'était saisi : en production, c'était TOUTES les lignes de la
 *  file, en rouge — une alerte partout ne signale plus rien. Retirée. */
function alerteAppro(order, maintenant = new Date()) {
  if (!order || !AVANT_EXPEDITION.includes(order.status) || estServiceClonage(order)) return '';
  if (approEffectif(order) !== 'commandee') return '';
  const r = retard(order, maintenant);
  return r.enRetard ? `Fournisseur en retard · ${r.jours}j` : '';
}

/** Compteurs des files : { [fileId]: { total, enRetard } }. */
function compter(commandes, maintenant = new Date()) {
  const compteurs = {};
  for (const id of IDS_FILES) compteurs[id] = { total: 0, enRetard: 0 };
  for (const order of commandes || []) {
    const r = retard(order, maintenant);
    for (const id of files(order)) {
      compteurs[id].total += 1;
      if (r.enRetard) compteurs[id].enRetard += 1;
    }
  }
  return compteurs;
}

/** Phrase sous le titre : « 3 prêtes à expédier · aucun retard fournisseur ». */
function resume(commandes, maintenant = new Date()) {
  let aExpedier = 0;
  let fournisseurEnRetard = 0;
  for (const order of commandes || []) {
    const f = files(order);
    if (f.includes('expedier')) aExpedier += 1;
    if (f.includes('commandee') && retard(order, maintenant).enRetard) fournisseurEnRetard += 1;
  }
  const expedier = `${aExpedier} prête${aExpedier > 1 ? 's' : ''} à expédier`;
  const fournisseur = fournisseurEnRetard
    ? `${fournisseurEnRetard} pièce${fournisseurEnRetard > 1 ? 's' : ''} fournisseur en retard`
    : 'aucun retard fournisseur';
  return `${expedier} · ${fournisseur}`;
}

module.exports = {
  FILES,
  IDS_FILES,
  APPRO,
  ACTIONS,
  IDS_ACTIONS,
  AVANT_EXPEDITION,
  approEffectif,
  files,
  limiteJours,
  debutEtape,
  retard,
  actionSuivante,
  actionsPossibles,
  etatApres,
  filesApres,
  alerteAppro,
  aSuiviEnvoi,
  retourAttendu,
  compter,
  resume,
};
